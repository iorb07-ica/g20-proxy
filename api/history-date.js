// api/history-date.js — Vercel Serverless Function
// Busca o preco de fechamento de um ativo em uma data especifica via Yahoo Finance
// Uso: /api/history-date?symbol=PETR4.SA&date=2021-02-03
// Cache Redis (Upstash) TTL 30 dias (data passada = imutavel)

const CACHE_TTL = 2592000; // 30 dias

// ──────────────────────────────────────
// Helpers Redis (Upstash REST API)
// ──────────────────────────────────────
async function redisGet(key) {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const d = await r.json();
    if (!d || d.result == null) return null;
    return JSON.parse(d.result);
  } catch { return null; }
}

async function redisSet(key, value) {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return false;
  try {
    await fetch(`${url}/set/${encodeURIComponent(key)}?EX=${CACHE_TTL}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(value)
    });
    return true;
  } catch { return false; }
}

// ──────────────────────────────────────
// Handler principal
// ──────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, date } = req.query;
  if (!symbol || !date) {
    return res.status(400).json({ error: 'symbol e date sao obrigatorios' });
  }

  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const cacheKey = `hist-date:${symbol.toUpperCase()}:${date}`;

  // Tenta cache primeiro
  const cached = await redisGet(cacheKey);
  if (cached) {
    res.setHeader('X-Cache-Status', 'HIT');
    return res.json(cached);
  }

  // Converte date (YYYY-MM-DD) para timestamps Unix
  const targetDate = new Date(date + 'T12:00:00Z');
  // Busca janela de +/-7 dias ao redor da data (cobre fins de semana e feriados)
  const period1 = Math.floor((targetDate.getTime() - 7 * 86400000) / 1000);
  const period2 = Math.floor((targetDate.getTime() + 2 * 86400000) / 1000);

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${period1}&period2=${period2}`;

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    });
    const data = await response.json();

    const result = data?.chart?.result?.[0];
    if (!result) {
      res.setHeader('X-Cache-Status', redisUrl ? 'MISS' : 'DISABLED');
      return res.json({ close: null, date: null, error: 'sem dados' });
    }

    const timestamps = result.timestamp || [];
    // FIX: removido 'closes' (plural) que nao existe no Yahoo - so 'close'
    const closes = result.indicators?.quote?.[0]?.close || [];

    // Encontra o pregao mais proximo ANTERIOR ou IGUAL a data alvo
    const targetTs = Math.floor(targetDate.getTime() / 1000);
    let bestIdx = -1;
    let bestTs  = -Infinity;

    timestamps.forEach((ts, i) => {
      if (ts <= targetTs + 86400 && ts > bestTs && closes[i] != null) {
        bestTs  = ts;
        bestIdx = i;
      }
    });

    if (bestIdx === -1) {
      res.setHeader('X-Cache-Status', redisUrl ? 'MISS' : 'DISABLED');
      return res.json({ close: null, date: null, error: 'data fora do historico' });
    }

    const closePrice = closes[bestIdx];
    const closeDate  = new Date(timestamps[bestIdx] * 1000).toISOString().split('T')[0];
    const payload = { close: closePrice, date: closeDate, symbol };

    // Salva no cache
    await redisSet(cacheKey, payload);
    res.setHeader('X-Cache-Status', redisUrl ? 'MISS' : 'DISABLED');
    return res.json(payload);

  } catch (err) {
    // Fallback: query2
    try {
      const url2 = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${period1}&period2=${period2}`;
      const r2   = await fetch(url2, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const d2   = await r2.json();
      const res2 = d2?.chart?.result?.[0];
      if (!res2) {
        res.setHeader('X-Cache-Status', redisUrl ? 'MISS' : 'DISABLED');
        return res.json({ close: null, error: 'fallback sem dados' });
      }

      const ts2  = res2.timestamp || [];
      const cl2  = res2.indicators?.quote?.[0]?.close || [];
      const targetTs = Math.floor(targetDate.getTime() / 1000);
      let bi = -1, bt = -Infinity;
      ts2.forEach((ts, i) => { if(ts <= targetTs+86400 && ts > bt && cl2[i]!=null){ bt=ts; bi=i; } });
      if(bi === -1) {
        res.setHeader('X-Cache-Status', redisUrl ? 'MISS' : 'DISABLED');
        return res.json({ close: null, error: 'data fora do historico' });
      }
      const payload = { close: cl2[bi], date: new Date(ts2[bi]*1000).toISOString().split('T')[0], symbol };
      await redisSet(cacheKey, payload);
      res.setHeader('X-Cache-Status', redisUrl ? 'MISS' : 'DISABLED');
      return res.json(payload);
    } catch(e2) {
      return res.status(500).json({ error: e2.message });
    }
  }
}
