// api/history.js — Consolidado (substitui history.js + history-br.js + history-date.js + history-monthly.js)
// Routing via _src:
//   _src=br       → histórico diário BR (.SA suffix automático)
//   _src=date     → preço em data específica (?symbol=PETR4.SA&date=2021-02-03)
//   _src=monthly  → histórico mensal (?symbol=PETR4.SA&from=2022-01)
//   default       → histórico diário US (sem sufixo)

const CACHE_TTL_HIST = 3600; // 1 hora

async function redisGet(key) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const tok = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !tok) return null;
  try {
    const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${tok}` } });
    const d = await r.json();
    if (!d || d.result == null) return null;
    return JSON.parse(d.result);
  } catch { return null; }
}

async function redisSet(key, value) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const tok = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !tok) return false;
  try {
    await fetch(`${url}/set/${encodeURIComponent(key)}?EX=${CACHE_TTL_HIST}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(value)
    });
    return true;
  } catch { return false; }
}

const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

function closest(hist, targetDate) {
  const t = targetDate.toISOString().split('T')[0];
  const candidates = hist.filter(p => p.date <= t);
  return candidates.length ? candidates[candidates.length - 1] : null;
}

function computeRefs(hist) {
  const now = new Date();
  const d30 = new Date(now); d30.setDate(d30.getDate() - 30);
  const d3m = new Date(now); d3m.setMonth(d3m.getMonth() - 3);
  const d6m = new Date(now); d6m.setMonth(d6m.getMonth() - 6);
  const dYTD = new Date(now.getFullYear() - 1, 11, 31);
  const d5y = new Date(now); d5y.setFullYear(d5y.getFullYear() - 5);
  const lastFri = [...hist].reverse().find(p => p.dow === 5) || null;
  return {
    refSemana: lastFri,
    ref30d:    closest(hist, d30),
    ref3m:     closest(hist, d3m),
    ref6m:     closest(hist, d6m),
    refYTD:    closest(hist, dYTD),
    ref5y:     closest(hist, d5y),
  };
}

async function fetchYahooDaily(ticker, attempt = 0) {
  const now  = Math.floor(Date.now() / 1000);
  const from = now - 6 * 365 * 86400;
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&period1=${from}&period2=${now}`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&period1=${from}&period2=${now}`,
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: YAHOO_HEADERS });
      if (!r.ok) {
        if (r.status === 429 && attempt < 2) { await sleep(500 * (attempt + 1)); return fetchYahooDaily(ticker, attempt + 1); }
        continue;
      }
      const data   = await r.json();
      const result = data?.chart?.result?.[0];
      if (!result) continue;
      const tss    = result.timestamp || [];
      const closes = result.indicators?.quote?.[0]?.close || [];
      const hist   = [];
      tss.forEach((ts, i) => {
        if (closes[i] == null) return;
        const d = new Date(ts * 1000);
        hist.push({ date: d.toISOString().split('T')[0], close: closes[i], dow: d.getDay() });
      });
      hist.sort((a, b) => a.date.localeCompare(b.date));
      if (hist.length >= 5) return computeRefs(hist);
    } catch {}
  }
  if (attempt < 2) { await sleep(300 * (attempt + 1)); return fetchYahooDaily(ticker, attempt + 1); }
  return null;
}

async function fetchWithCache(ticker, cachePrefix) {
  const cacheKey = `${cachePrefix}${ticker.toUpperCase()}`;
  const cached = await redisGet(cacheKey);
  if (cached) return { data: cached, cacheHit: true };
  const data = await fetchYahooDaily(ticker);
  if (data) await redisSet(cacheKey, data);
  return { data, cacheHit: false };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'X-Cache-Status, X-Cache-Count');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, from, date, _src } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol obrigatorio' });

  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;

  // ── Histórico por data específica ────────────────────────────────────────
  if (_src === 'date') {
    if (!date) return res.status(400).json({ error: 'date obrigatório para _src=date' });
    const targetDate = new Date(date + 'T12:00:00Z');
    const period1 = Math.floor((targetDate.getTime() - 7 * 86400000) / 1000);
    const period2 = Math.floor((targetDate.getTime() + 2 * 86400000) / 1000);

    const fetchDate = async (baseUrl) => {
      const r = await fetch(baseUrl, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
      const d  = await r.json();
      const result = d?.chart?.result?.[0];
      if (!result) return null;
      const tss    = result.timestamp || [];
      const closes = result.indicators?.quote?.[0]?.close || [];
      const targetTs = Math.floor(targetDate.getTime() / 1000);
      let bestIdx = -1, bestTs = -Infinity;
      tss.forEach((ts, i) => { if (ts <= targetTs + 86400 && ts > bestTs && closes[i] != null) { bestTs = ts; bestIdx = i; } });
      if (bestIdx === -1) return null;
      return { close: closes[bestIdx], date: new Date(tss[bestIdx] * 1000).toISOString().split('T')[0], symbol };
    };

    try {
      const result = await fetchDate(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${period1}&period2=${period2}`);
      if (result) return res.json(result);
      const result2 = await fetchDate(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${period1}&period2=${period2}`);
      return res.json(result2 || { close: null, date: null, error: 'sem dados' });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── Histórico mensal ─────────────────────────────────────────────────────
  if (_src === 'monthly') {
    const fromDate = from ? new Date(from + '-01') : new Date(new Date().setFullYear(new Date().getFullYear() - 10));
    const period1  = Math.floor(fromDate.getTime() / 1000);
    const period2  = Math.floor(Date.now() / 1000);

    let data = null;
    for (const q of ['query1','query2']) {
      try {
        const r = await fetch(`https://${q}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1mo&period1=${period1}&period2=${period2}`, {
          headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }
        });
        if (r.ok) { data = await r.json(); break; }
      } catch {}
    }
    if (!data) return res.json({ symbol, prices: {} });
    const result = data?.chart?.result?.[0];
    if (!result) return res.json({ symbol, prices: {} });
    const timestamps = result.timestamp || [];
    const closes     = result.indicators?.quote?.[0]?.close || [];
    const prices     = {};
    timestamps.forEach((ts, i) => {
      if (closes[i] == null || closes[i] <= 0) return;
      const d   = new Date(ts * 1000);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      prices[key] = +closes[i].toFixed(4);
    });
    return res.json({ symbol, prices });
  }

  // ── Histórico diário BR ou US ────────────────────────────────────────────
  const isBR        = _src === 'br';
  const cachePrefix = isBR ? 'hist:br:' : 'hist:us:';
  const tickers     = symbol.split(',').map(s => s.trim()).filter(Boolean);

  if (tickers.length === 1) {
    const ticker = isBR && !tickers[0].endsWith('.SA') ? tickers[0] + '.SA' : tickers[0];
    const { data, cacheHit } = await fetchWithCache(ticker, cachePrefix);
    res.setHeader('X-Cache-Status', cacheHit ? 'HIT' : (redisUrl ? 'MISS' : 'DISABLED'));
    if (!data) return res.json({ error: 'sem dados', symbol: tickers[0] });
    return res.json({ symbol: tickers[0], ...data });
  }

  const results = {};
  let hits = 0;
  await Promise.all(tickers.map(async t => {
    const ticker = isBR && !t.endsWith('.SA') ? t + '.SA' : t;
    const { data, cacheHit } = await fetchWithCache(ticker, cachePrefix);
    if (data) { results[t] = data; if (cacheHit) hits++; }
  }));

  res.setHeader('X-Cache-Status', hits === tickers.length ? 'HIT' : (hits > 0 ? 'PARTIAL' : (redisUrl ? 'MISS' : 'DISABLED')));
  res.setHeader('X-Cache-Count', String(hits));
  return res.json(results);
}
