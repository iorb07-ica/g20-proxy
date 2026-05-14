// api/splits.js — Vercel Serverless Function
// Fonte: Yahoo Finance (histórico completo de eventos corporativos BR/US)
// Classifica corretamente: Desdobramento, Grupamento ou Bonificação
// Uso: /api/splits?symbol=ITUB4.SA&from=2019-01-01

const CACHE_TTL = 86400; // 24h

async function redisGet(url, token, key) {
  try {
    const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
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

// ── CLASSIFICAÇÃO DE EVENTOS CORPORATIVOS ─────────────────
// Bonificações BR: a B3 usa sempre denominador redondo (100 ou 10)
// com numerador ligeiramente maior. Ex: 110/100=10%, 103/100=3%, 11/10=10%
// Desdobramentos reais: ratios inteiros ou frações simples (2:1, 3:1, 1:2, 3:2)
// Grupamentos: ratio < 1 (ex: 0.1 = grupamento 10:1)
function classifyEvent(numerator, denominator, ratio) {
  // Grupamento (inplit): ratio < 1
  if (ratio < 1) return 'grupamento';

  // Padrão de bonificação BR:
  // denominador 100 com numerador 101-199 (bonificação de 1% a 99%)
  // denominador 10 com numerador 11 (bonificação de 10%)
  // denominador 4 com numerator 5 (bonificação de 25%)
  // denominador 25 com numerador 26 (bonificação de 4%)
  const isBonificacaoBR = (
    (denominator === 100 && numerator > 100 && numerator < 200) ||
    (denominator === 10  && numerator === 11) ||
    (denominator === 4   && numerator === 5)  ||
    (denominator === 25  && numerator === 26) ||
    (denominator === 50  && numerator > 50 && numerator < 100)
  );

  if (isBonificacaoBR) return 'bonificacao';

  // Desdobramento: qualquer ratio > 1 que não seja bonificação
  return 'desdobramento';
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'X-Cache-Status');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, from } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol obrigatório' });

  const redisUrl   = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const cacheKey   = `splits-v2:${symbol}`;

  // Cache lookup
  if (redisUrl && redisToken) {
    const cached = await redisGet(redisUrl, redisToken, cacheKey);
    if (cached && Array.isArray(cached)) {
      res.setHeader('X-Cache-Status', 'HIT');
      const fromDate = from || '2000-01-01';
      return res.json({
        symbol,
        count: cached.filter(s => s.date >= fromDate).length,
        splits: cached.filter(s => s.date >= fromDate)
      });
    }
    res.setHeader('X-Cache-Status', 'MISS');
  }

  const startTs = from ? Math.floor(new Date(from).getTime() / 1000) : 978307200; // 2001
  const endTs   = Math.floor(Date.now() / 1000);

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
                `?interval=1mo&period1=${startTs}&period2=${endTs}&events=splits`;

    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json'
      }
    });

    if (!r.ok) throw new Error('Yahoo HTTP ' + r.status);

    const d = await r.json();
    const rawSplits = d?.chart?.result?.[0]?.events?.splits || {};

    const splits = Object.values(rawSplits).map(s => {
      const ratio    = s.numerator / s.denominator;
      const tipo     = classifyEvent(s.numerator, s.denominator, ratio);
      return {
        date:        new Date(s.date * 1000).toISOString().split('T')[0],
        numerator:   s.numerator,
        denominator: s.denominator,
        ratio:       ratio,
        tipo:        tipo  // 'desdobramento' | 'grupamento' | 'bonificacao'
      };
    }).sort((a, b) => a.date.localeCompare(b.date));

    // Cache save
    if (redisUrl && redisToken && splits.length > 0) {
      await redisSet(redisUrl, redisToken, cacheKey, splits);
    }

    const fromDate = from || '2000-01-01';
    return res.json({
      symbol,
      count: splits.filter(s => s.date >= fromDate).length,
      splits: splits.filter(s => s.date >= fromDate)
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
