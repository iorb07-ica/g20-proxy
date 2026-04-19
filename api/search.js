// Proxy busca de ativos — VERSAO DEBUG
// Use com ?debug=1 para ver detalhes

const CACHE_TTL = 2592000;

async function redisGetDebug(key) {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return { ok: false, error: 'sem env vars', value: null };
  try {
    const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const rawText = await r.text();
    let d;
    try { d = JSON.parse(rawText); } catch (e) {
      return { ok: false, error: 'raw nao e JSON: ' + rawText.substring(0,200), value: null };
    }

    if (!d || d.result == null) return { ok: true, error: null, value: null, note: 'd.result is null' };

    const resultType = typeof d.result;
    const resultPreview = resultType === 'string'
      ? d.result.substring(0, 100)
      : JSON.stringify(d.result).substring(0, 100);

    let parsed = null;
    let parseError = null;
    try {
      parsed = typeof d.result === 'string' ? JSON.parse(d.result) : d.result;
    } catch (e) {
      parseError = e.message;
    }

    return {
      ok: true,
      error: parseError,
      value: parsed,
      resultType,
      resultPreview,
      rawLength: rawText.length
    };
  } catch (err) {
    return { ok: false, error: 'fetch failed: ' + err.message, value: null };
  }
}

async function redisSetDebug(key, value) {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return { ok: false, error: 'sem env vars' };
  try {
    const r = await fetch(`${url}/set/${encodeURIComponent(key)}?EX=${CACHE_TTL}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(value)
    });
    const rawText = await r.text();
    return { ok: r.ok, status: r.status, response: rawText.substring(0, 200) };
  } catch (err) {
    return { ok: false, error: 'fetch failed: ' + err.message };
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'X-Cache-Status, X-Cache-Count, X-Debug-Get, X-Debug-Set');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { q, debug } = req.query;
  if (!q) return res.json({ results: [] });

  const cacheKey = `search:${q.toLowerCase().trim()}`;

  if (debug === '1') {
    const getResult = await redisGetDebug(cacheKey);
    return res.json({
      cacheKey,
      getResult,
      envVarsPresent: {
        url: !!process.env.UPSTASH_REDIS_REST_URL,
        token: !!process.env.UPSTASH_REDIS_REST_TOKEN
      }
    });
  }

  const getResult = await redisGetDebug(cacheKey);
  if (getResult.ok && getResult.value) {
    res.setHeader('X-Cache-Status', 'HIT');
    return res.json(getResult.value);
  }

  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0&listsCount=0`;
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
  });
  const d = await r.json();
  const quotes = d?.quotes || [];
  const results = quotes
    .filter(q => q.symbol && q.quoteType !== 'OPTION' && q.quoteType !== 'FUTURE')
    .slice(0, 8)
    .map(q => ({
      symbol: q.symbol,
      name: q.longname || q.shortname || q.symbol,
      exchange: q.exchange || '',
      type: q.quoteType || '',
      g20tipo: 'Stock'
    }));
  const payload = { results };

  const setResult = await redisSetDebug(cacheKey, payload);
  res.setHeader('X-Cache-Status', 'MISS');
  res.setHeader('X-Debug-Get', JSON.stringify(getResult).substring(0, 200));
  res.setHeader('X-Debug-Set', JSON.stringify(setResult).substring(0, 200));
  return res.json(payload);
};
