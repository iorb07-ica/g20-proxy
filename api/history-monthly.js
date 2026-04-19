// api/history-monthly.js — Vercel Serverless Function
// Busca historico mensal de um ativo no Yahoo Finance
// Retorna objeto { "2024-01": 28.50, "2024-02": 31.20, ... }
// Uso: /api/history-monthly?symbol=PETR4.SA&from=2022-01
// Cache Redis (Upstash) TTL 24h

const CACHE_TTL = 86400; // 24 horas

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
  res.setHeader('Access-Control-Expose-Headers', 'X-Cache-Status, X-Cache-Count');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, from } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol obrigatorio' });

  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const cacheKey = `hist-mon:${symbol.toUpperCase()}:${from || 'default'}`;

  // Tenta cache primeiro
  const cached = await redisGet(cacheKey);
  if (cached) {
    res.setHeader('X-Cache-Status', 'HIT');
    return res.json(cached);
  }

  // Define periodo: from = "YYYY-MM" ou usa 10 anos atras como padrao
  const fromDate = from
    ? new Date(from + '-01')
    : new Date(new Date().setFullYear(new Date().getFullYear() - 10));

  const period1 = Math.floor(fromDate.getTime() / 1000);
  const period2 = Math.floor(Date.now() / 1000);

  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1mo&period1=${period1}&period2=${period2}`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1mo&period1=${period1}&period2=${period2}`,
  ];

  let data = null;
  for (const url of urls) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
      });
      if (r.ok) { data = await r.json(); break; }
    } catch {}
  }

  if (!data) {
    res.setHeader('X-Cache-Status', redisUrl ? 'MISS' : 'DISABLED');
    return res.json({ symbol, prices: {} });
  }

  const result = data?.chart?.result?.[0];
  if (!result) {
    res.setHeader('X-Cache-Status', redisUrl ? 'MISS' : 'DISABLED');
    return res.json({ symbol, prices: {} });
  }

  const timestamps = result.timestamp || [];
  const closes     = result.indicators?.quote?.[0]?.close || [];

  // Monta objeto { "YYYY-MM": preco }
  const prices = {};
  timestamps.forEach((ts, i) => {
    if (closes[i] == null || closes[i] <= 0) return;
    const d   = new Date(ts * 1000);
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    prices[key] = +closes[i].toFixed(4);
  });

  const payload = { symbol, prices };

  // Salva no cache
  await redisSet(cacheKey, payload);
  res.setHeader('X-Cache-Status', redisUrl ? 'MISS' : 'DISABLED');
  return res.json(payload);
}
