// Proxy splits/inplits Yahoo Finance — sem dependencias externas
// Retorna historico completo de splits desde uma data
// Cache Redis (Upstash) TTL 7 dias (splits sao eventos raros)

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
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'X-Cache-Status, X-Cache-Count');
  res.setHeader('Cache-Control', 's-maxage=86400');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, from } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol obrigatorio' });

  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const cacheKey = `splits:${symbol.toUpperCase()}:${from || 'default'}`;

  // Tenta cache primeiro
  const cached = await redisGet(cacheKey);
  if (cached) {
    res.setHeader('X-Cache-Status', 'HIT');
    return res.json(cached);
  }

  const startTs = from ? Math.floor(new Date(from).getTime()/1000) : 978307200; // 2001
  const endTs   = Math.floor(Date.now()/1000);

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1mo&period1=${startTs}&period2=${endTs}&events=splits`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json'
      }
    });
    const d = await r.json();
    const rawSplits = d?.chart?.result?.[0]?.events?.splits || {};

    const splits = Object.values(rawSplits).map(s => ({
      date:        new Date(s.date * 1000).toISOString().split('T')[0],
      numerator:   s.numerator,
      denominator: s.denominator,
      ratio:       s.numerator / s.denominator
    })).sort((a, b) => a.date.localeCompare(b.date));

    const payload = { symbol, count: splits.length, splits };

    // Salva no cache
    await redisSet(cacheKey, payload);
    res.setHeader('X-Cache-Status', redisUrl ? 'MISS' : 'DISABLED');
    return res.json(payload);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
