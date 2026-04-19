// api/bonuses.js — Vercel Serverless Function
// Proxy para bonificacoes do DadosMercado (evita CORS)
// Uso: /api/bonuses?ticker=LREN3
// Cache Redis (Upstash) TTL 7 dias (bonificacoes sao eventos raros)

const CACHE_TTL = 604800; // 7 dias

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

  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: 'ticker obrigatorio' });

  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const cacheKey = `bonus:${ticker.toUpperCase()}`;

  // Tenta cache primeiro
  const cached = await redisGet(cacheKey);
  if (cached) {
    res.setHeader('X-Cache-Status', 'HIT');
    return res.json(cached);
  }

  const url = `https://api.dadosdemercado.com.br/v1/companies/${ticker.toUpperCase()}/bonuses`;
  try {
    const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) return res.status(r.status).json({ error: 'HTTP ' + r.status });
    const data = await r.json();

    // Salva no cache
    await redisSet(cacheKey, data);
    res.setHeader('X-Cache-Status', redisUrl ? 'MISS' : 'DISABLED');
    return res.json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
