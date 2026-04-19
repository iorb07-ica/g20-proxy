// Proxy busca - VERSAO FULL TRACE
const CACHE_TTL = 2592000;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'X-Trace');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { q } = req.query;
  if (!q) return res.json({ results: [] });

  const cacheKey = `search:${q.toLowerCase().trim()}`;
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  const trace = [];

  // Passo 1: tenta GET no Redis
  trace.push('key=' + cacheKey);
  trace.push('hasUrl=' + !!url);
  trace.push('hasToken=' + !!token);

  let redisValue = null;
  try {
    const r = await fetch(`${url}/get/${encodeURIComponent(cacheKey)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    trace.push('get.status=' + r.status);
    const rawText = await r.text();
    trace.push('get.rawLen=' + rawText.length);
    trace.push('get.raw100=' + rawText.substring(0, 100).replace(/"/g, "'"));

    const d = JSON.parse(rawText);
    trace.push('get.d.hasResult=' + (d.result != null));
    trace.push('get.d.resultType=' + (typeof d.result));

    if (d.result != null) {
      if (typeof d.result === 'string') {
        redisValue = JSON.parse(d.result);
      } else {
        redisValue = d.result;
      }
      trace.push('get.parsed=OK');
    }
  } catch (e) {
    trace.push('get.ERROR=' + e.message);
  }

  // Passo 2: HIT?
  if (redisValue) {
    trace.push('HIT');
    res.setHeader('X-Trace', trace.join(' | ').substring(0, 800));
    return res.json(redisValue);
  }

  trace.push('MISS=yahoo');

  // Passo 3: busca Yahoo
  const yUrl = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0&listsCount=0`;
  const yR = await fetch(yUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
  });
  const yD = await yR.json();
  const quotes = yD?.quotes || [];
  const results = quotes
    .filter(qq => qq.symbol && qq.quoteType !== 'OPTION' && qq.quoteType !== 'FUTURE')
    .slice(0, 8)
    .map(qq => ({
      symbol: qq.symbol,
      name: qq.longname || qq.shortname || qq.symbol,
      exchange: qq.exchange || '',
      type: qq.quoteType || '',
      g20tipo: 'Stock'
    }));
  const payload = { results };

  // Passo 4: SET no Redis
  try {
    const setR = await fetch(`${url}/set/${encodeURIComponent(cacheKey)}?EX=${CACHE_TTL}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    trace.push('set.status=' + setR.status);
    const setText = await setR.text();
    trace.push('set.resp=' + setText.substring(0, 50).replace(/"/g, "'"));
  } catch (e) {
    trace.push('set.ERROR=' + e.message);
  }

  res.setHeader('X-Trace', trace.join(' | ').substring(0, 800));
  return res.json(payload);
};
