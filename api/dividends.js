// api/dividends.js — Vercel Serverless Function
// Busca dividendos US via Polygon.io com cache Upstash Redis (24h)
// Uso: /api/dividends?symbol=AAPL&from=2023-01-01

const CACHE_TTL = 86400; // 24 horas em segundos

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

  const polygonKey  = process.env.POLYGON_API_KEY;
  const redisUrl    = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken  = process.env.UPSTASH_REDIS_REST_TOKEN;

  const fromDate = from
    ? (/^\d{4}-\d{2}-\d{2}$/.test(from) ? from : new Date(parseInt(from) * 1000).toISOString().split('T')[0])
    : new Date(Date.now() - 10 * 365 * 86400000).toISOString().split('T')[0];

  // ── Chave de cache por símbolo (ignora from — cache diário por ticker) ──
  const cacheKey = `dividends:${symbol}`;

  // ── Tenta ler do cache Upstash ──
  if (redisUrl && redisToken) {
    const cached = await redisGet(redisUrl, redisToken, cacheKey);
    if (cached) {
      // Filtra pelo from antes de retornar
      const filtered = (cached.dividends || []).filter(d => d.date >= fromDate);
      return res.json({ dividends: filtered, source: 'cache' });
    }
  }

  // ── Busca na Polygon.io ──
  if (!polygonKey) {
    // Fallback Yahoo Finance se não tiver Polygon
    return fetchYahooFallback(symbol, fromDate, res);
  }

  try {
    const futureDate = new Date(Date.now() + 365 * 86400000).toISOString().split('T')[0];
    const startDate  = new Date(Date.now() - 10 * 365 * 86400000).toISOString().split('T')[0];

    const polygonUrl = `https://api.polygon.io/v3/reference/dividends?ticker=${encodeURIComponent(symbol)}&ex_dividend_date.gte=${startDate}&ex_dividend_date.lte=${futureDate}&limit=100&apiKey=${polygonKey}`;

    const pr = await fetch(polygonUrl, { headers: { 'Accept': 'application/json' } });
    if (!pr.ok) throw new Error('Polygon HTTP ' + pr.status);

    const pd = await pr.json();
    const results = pd.results || [];

    if (!results.length) throw new Error('sem dados Polygon');

    const dividends = results.map(d => ({
      date:         d.ex_dividend_date,           // ex-date (data-com)
      amount:       d.cash_amount,
      payment_date: d.pay_date || d.ex_dividend_date, // data de pagamento
      ex_date:      d.ex_dividend_date,
      record_date:  d.record_date || null,
      declare_date: d.declaration_date || null,
      value:        d.cash_amount,
      type:         d.dividend_type === 'CD' ? 'Dividendo' : (d.dividend_type || 'Dividendo'),
      frequency:    d.frequency || null,
      source:       'Polygon'
    })).sort((a, b) => b.date.localeCompare(a.date));

    // Salva no cache (sem filtro de from — guarda tudo)
    if (redisUrl && redisToken) {
      await redisSet(redisUrl, redisToken, cacheKey, { dividends });
    }

    // Retorna filtrado pelo from
    const filtered = dividends.filter(d => d.date >= fromDate);
    return res.json({ dividends: filtered });

  } catch (err) {
    // Fallback Yahoo Finance
    return fetchYahooFallback(symbol, fromDate, res);
  }
}

async function fetchYahooFallback(symbol, fromDate, res) {
  const period1 = Math.floor(new Date(fromDate).getTime() / 1000);
  const period2 = Math.floor((Date.now() + 365 * 86400000) / 1000);

  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${period1}&period2=${period2}&events=div`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${period1}&period2=${period2}&events=div`,
  ];

  let data = null;
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
      if (r.ok) { data = await r.json(); break; }
    } catch {}
  }

  if (!data) return res.json({ dividends: [] });

  const events = data?.chart?.result?.[0]?.events?.dividends || {};
  const dividends = Object.values(events)
    .map(ev => {
      const date = new Date(ev.date * 1000).toISOString().split('T')[0];
      if (date < fromDate) return null;
      return {
        date, amount: ev.amount,
        payment_date: date, ex_date: date,
        value: ev.amount, type: 'Dividendo', source: 'Yahoo'
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.date.localeCompare(a.date));

  return res.json({ dividends });
}
