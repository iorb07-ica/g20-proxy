// api/dividends.js — Vercel Serverless Function  
// Busca dividendos US via Polygon.io com cache Upstash Redis (24h)
// Sem fallback Yahoo — Polygon é a fonte definitiva para US
// Uso: /api/dividends?symbol=AAPL&from=2023-01-01

const CACHE_TTL = 86400;

async function redisGet(url, token, key) {
  try {
    const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const d = await r.json();
    return d.result ? JSON.parse(d.result) : null;
  } catch { return null; }
}

async function redisSet(url, token, key, value) {
  try {
    await fetch(`${url}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: JSON.stringify(value), ex: CACHE_TTL })
    });
  } catch {}
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, from } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol obrigatório' });

  const polygonKey = process.env.POLYGON_API_KEY;
  const redisUrl   = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  const fromDate = from
    ? (/^\d{4}-\d{2}-\d{2}$/.test(from) ? from : new Date(parseInt(from) * 1000).toISOString().split('T')[0])
    : new Date(Date.now() - 10 * 365 * 86400000).toISOString().split('T')[0];

  const cacheKey = `dividends:${symbol}`;

  // ── Cache Upstash ──
  if (redisUrl && redisToken) {
    const cached = await redisGet(redisUrl, redisToken, cacheKey);
    if (cached) {
      const filtered = (cached.dividends || []).filter(d => d.date >= fromDate);
      return res.json({ dividends: filtered, source: 'cache' });
    }
  }

  // ── Polygon.io ──
  if (!polygonKey) return res.json({ dividends: [] });

  try {
    const startDate  = new Date(Date.now() - 10 * 365 * 86400000).toISOString().split('T')[0];
    const futureDate = new Date(Date.now() + 365 * 86400000).toISOString().split('T')[0];

    const url = `https://api.polygon.io/v3/reference/dividends?ticker=${encodeURIComponent(symbol)}&ex_dividend_date.gte=${startDate}&ex_dividend_date.lte=${futureDate}&limit=100&apiKey=${polygonKey}`;

    const pr = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!pr.ok) throw new Error('Polygon HTTP ' + pr.status);

    const pd = await pr.json();
    const results = pd.results || [];
    if (!results.length) return res.json({ dividends: [] });

    const dividends = results.map(d => ({
      date:         d.ex_dividend_date,
      amount:       d.cash_amount,
      payment_date: d.pay_date || d.ex_dividend_date,
      ex_date:      d.ex_dividend_date,
      record_date:  d.record_date   || null,
      declare_date: d.declaration_date || null,
      value:        d.cash_amount,
      type:         d.dividend_type === 'CD' ? 'Dividendo' : (d.dividend_type || 'Dividendo'),
      frequency:    d.frequency || null,
      source:       'Polygon'
    })).sort((a, b) => b.date.localeCompare(a.date));

    // Cache
    if (redisUrl && redisToken) {
      await redisSet(redisUrl, redisToken, cacheKey, { dividends });
    }

    return res.json({ dividends: dividends.filter(d => d.date >= fromDate) });

  } catch (err) {
    return res.json({ dividends: [] });
  }
}
