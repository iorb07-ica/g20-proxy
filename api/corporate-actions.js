// api/corporate-actions.js — Consolida splits.js + bonuses.js
// Routing via _src:
//   _src=splits  → desdobramentos, grupamentos, bonificações (Yahoo Finance)
//   _src=bonuses → bonificações DadosMercado

const CACHE_TTL = 86400; // 24h

async function redisGet(url, token, key) {
  try {
    const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const d = await r.json();
    if (!d.result) return null;
    return JSON.parse(d.result);
  } catch { return null; }
}

async function redisSet(url, token, key, value) {
  try {
    const r = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['SET', key, JSON.stringify(value), 'EX', String(CACHE_TTL)]])
    });
    if (!r.ok) return false;
    const result = await r.json();
    return Array.isArray(result) && result[0]?.result === 'OK';
  } catch { return false; }
}

function classifyEvent(numerator, denominator, ratio) {
  if (ratio < 1) return 'grupamento';
  const isBonificacaoBR = (
    (denominator === 100 && numerator > 100 && numerator < 200) ||
    (denominator === 10  && numerator === 11) ||
    (denominator === 4   && numerator === 5)  ||
    (denominator === 25  && numerator === 26) ||
    (denominator === 50  && numerator > 50 && numerator < 100)
  );
  if (isBonificacaoBR) return 'bonificacao';
  return 'desdobramento';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'X-Cache-Status');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, ticker, from, _src } = req.query;
  const redisUrl   = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  // ── Bonuses (DadosMercado) ───────────────────────────────────────────────
  if (_src === 'bonuses') {
    const sym = (ticker || symbol || '');
    if (!sym) return res.status(400).json({ error: 'ticker obrigatório' });
    const url = `https://api.dadosdemercado.com.br/v1/companies/${sym.toUpperCase()}/bonuses`;
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!r.ok) return res.status(r.status).json({ error: 'HTTP ' + r.status });
      return res.json(await r.json());
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── Splits ───────────────────────────────────────────────────────────────
  const sym = (symbol || '');
  if (!sym) return res.status(400).json({ error: 'symbol obrigatório' });

  const cacheKey = `splits-v2:${sym}`;
  if (redisUrl && redisToken) {
    const cached = await redisGet(redisUrl, redisToken, cacheKey);
    if (cached && Array.isArray(cached)) {
      res.setHeader('X-Cache-Status', 'HIT');
      const fromDate = from || '2000-01-01';
      return res.json({ symbol: sym, count: cached.filter(s => s.date >= fromDate).length, splits: cached.filter(s => s.date >= fromDate) });
    }
    res.setHeader('X-Cache-Status', 'MISS');
  }

  const startTs = from ? Math.floor(new Date(from).getTime() / 1000) : 978307200;
  const endTs   = Math.floor(Date.now() / 1000);

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1mo&period1=${startTs}&period2=${endTs}&events=splits`;
    const r   = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', Accept: 'application/json' } });
    if (!r.ok) throw new Error('Yahoo HTTP ' + r.status);

    const d         = await r.json();
    const rawSplits = d?.chart?.result?.[0]?.events?.splits || {};

    const splits = Object.values(rawSplits).map(s => {
      const ratio = s.numerator / s.denominator;
      return { date: new Date(s.date * 1000).toISOString().split('T')[0], numerator: s.numerator, denominator: s.denominator, ratio, tipo: classifyEvent(s.numerator, s.denominator, ratio) };
    }).sort((a, b) => a.date.localeCompare(b.date));

    if (redisUrl && redisToken && splits.length > 0) await redisSet(redisUrl, redisToken, cacheKey, splits);

    const fromDate = from || '2000-01-01';
    return res.json({ symbol: sym, count: splits.filter(s => s.date >= fromDate).length, splits: splits.filter(s => s.date >= fromDate) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
