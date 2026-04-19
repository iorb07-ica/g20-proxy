// api/dividends.js — Vercel Serverless Function
// Busca dividendos US via Polygon.io com cache Upstash Redis (24h)
// Sem fallback Yahoo — Polygon é a fonte definitiva para US
// Uso: /api/dividends?symbol=AAPL&from=2023-01-01
// Debug: adicionar &debug=1

const CACHE_TTL = 86400; // 24 horas

// ────────────────────────────────────────────────────
// Upstash REST API helpers — formato Pipeline (validado)
// ────────────────────────────────────────────────────
async function redisGet(url, token, key) {
  try {
    const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!r.ok) return null;
    const d = await r.json();
    if (!d.result) return null;
    try {
      return JSON.parse(d.result);
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

async function redisSet(url, token, key, value, debugInfo) {
  try {
    // Upstash REST Pipeline API — formato 100% garantido para valores grandes
    const serialized = JSON.stringify(value);
    if (debugInfo) debugInfo.saveSize = serialized.length;

    const r = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify([
        ['SET', key, serialized, 'EX', String(CACHE_TTL)]
      ])
    });

    if (debugInfo) debugInfo.saveStatus = r.status;

    if (!r.ok) {
      if (debugInfo) {
        const errText = await r.text().catch(() => '');
        debugInfo.saveError = errText.slice(0, 300);
      }
      return false;
    }

    const result = await r.json();
    if (debugInfo) debugInfo.saveResult = JSON.stringify(result).slice(0, 200);

    return Array.isArray(result) && result[0] && result[0].result === 'OK';
  } catch (e) {
    if (debugInfo) debugInfo.saveException = e.message;
    return false;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'X-Cache-Status, X-Cache-Count');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, from, debug } = req.query;
  const isDebug = debug === '1' || debug === 'true';
  const debugInfo = { steps: [] };

  if (!symbol) return res.status(400).json({ error: 'symbol obrigatório' });

  const polygonKey = process.env.POLYGON_API_KEY;
  const redisUrl   = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  debugInfo.hasRedis = !!(redisUrl && redisToken);

  const fromDate = from
    ? (/^\d{4}-\d{2}-\d{2}$/.test(from) ? from : new Date(parseInt(from) * 1000).toISOString().split('T')[0])
    : new Date(Date.now() - 10 * 365 * 86400000).toISOString().split('T')[0];
  debugInfo.fromDate = fromDate;

  const cacheKey = `dividends:${symbol}`;

  // ────────────────────────────────────────────────────
  // Cache LOOKUP
  // ────────────────────────────────────────────────────
  if (redisUrl && redisToken) {
    const cached = await redisGet(redisUrl, redisToken, cacheKey);
    if (cached && cached.dividends && Array.isArray(cached.dividends)) {
      debugInfo.steps.push('cache hit: ' + cached.dividends.length + ' registros');
      res.setHeader('X-Cache-Status', 'HIT');
      res.setHeader('X-Cache-Count', String(cached.dividends.length));
      const filtered = cached.dividends.filter(d => d.date >= fromDate);
      if (isDebug) return res.json({ _debug: debugInfo, dividends: filtered, source: 'cache' });
      return res.json({ dividends: filtered, source: 'cache' });
    }
    debugInfo.steps.push('cache miss');
    res.setHeader('X-Cache-Status', 'MISS');
  } else {
    res.setHeader('X-Cache-Status', 'DISABLED');
  }

  // ────────────────────────────────────────────────────
  // Polygon.io
  // ────────────────────────────────────────────────────
  if (!polygonKey) {
    debugInfo.steps.push('POLYGON_API_KEY ausente');
    if (isDebug) return res.json({ _debug: debugInfo, dividends: [] });
    return res.json({ dividends: [] });
  }

  try {
    const startDate  = new Date(Date.now() - 10 * 365 * 86400000).toISOString().split('T')[0];
    const futureDate = new Date(Date.now() + 365 * 86400000).toISOString().split('T')[0];

    const url = `https://api.polygon.io/v3/reference/dividends?ticker=${encodeURIComponent(symbol)}&ex_dividend_date.gte=${startDate}&ex_dividend_date.lte=${futureDate}&limit=100&apiKey=${polygonKey}`;

    debugInfo.steps.push('calling Polygon...');
    const startTime = Date.now();
    const pr = await fetch(url, { headers: { 'Accept': 'application/json' } });
    debugInfo.polygonDuration = (Date.now() - startTime) + 'ms';
    debugInfo.polygonStatus = pr.status;

    if (!pr.ok) {
      debugInfo.steps.push('Polygon HTTP ' + pr.status);
      throw new Error('Polygon HTTP ' + pr.status);
    }

    const pd = await pr.json();
    const results = pd.results || [];
    debugInfo.polygonResultCount = results.length;

    if (!results.length) {
      debugInfo.steps.push('Polygon retornou 0 dividendos');
      if (isDebug) return res.json({ _debug: debugInfo, dividends: [] });
      return res.json({ dividends: [] });
    }

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

    debugInfo.dividendsCount = dividends.length;
    debugInfo.steps.push('success: ' + dividends.length + ' dividendos processados');

    // ────────────────────────────────────────────────────
    // Cache SAVE
    // ────────────────────────────────────────────────────
    if (redisUrl && redisToken && dividends.length > 0) {
      const saved = await redisSet(redisUrl, redisToken, cacheKey, { dividends }, debugInfo);
      debugInfo.steps.push('cache save: ' + (saved ? 'OK' : 'FAIL'));
    }

    const filtered = dividends.filter(d => d.date >= fromDate);
    debugInfo.afterFilter = filtered.length;

    if (isDebug) return res.json({ _debug: debugInfo, dividends: filtered });
    return res.json({ dividends: filtered });

  } catch (err) {
    debugInfo.error = err.message;
    debugInfo.steps.push('CATCH: ' + err.message);
    if (isDebug) return res.status(200).json({ _debug: debugInfo, dividends: [] });
    return res.json({ dividends: [] });
  }
}
