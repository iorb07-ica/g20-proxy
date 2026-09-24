// api/history.js — Consolidado (history + history-br + history-date + history-monthly) + modo RAW
//
// Plataforma G20 (formato de refs, usado por Carteira G20, Minha Carteira e Game G20):
//   default       → refs diárias US (refSemana, ref30d, ref3m, ref6m, refYTD, ref5y)
//   _src=br       → refs diárias BR (.SA automático)          [rewrite de /api/history-br]
//   _src=date     → preço em data específica                  [rewrite de /api/history-date]
//   _src=monthly  → histórico mensal                          [rewrite de /api/history-monthly]
//   _src=daily    → série diária crua
//
// Dashboard pessoal (formato bruto do Yahoo, chart.result):
//   /api/history?symbol=VALE3.SA&range=10y[&interval=1d]   ou   _src=raw
//
// HISTÓRICO: em 31/08/26 este arquivo foi substituído só pelo modo RAW, o que apagou
// as rotas da plataforma (colunas 1W/1M/3M/6M/YTD/5Y vazias, Game G20 sem preço base).
// Esta versão junta as duas. NÃO substituir de novo por uma versão parcial.

import { aplicarCors } from './_cors.js';

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

// Busca a série DIÁRIA crua (~6 anos) — base para refs (mensal/refs) e para _src=daily
async function fetchYahooDailyHist(ticker, attempt = 0) {
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
        if (r.status === 429 && attempt < 2) { await sleep(500 * (attempt + 1)); return fetchYahooDailyHist(ticker, attempt + 1); }
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
      if (hist.length >= 5) return hist;
    } catch {}
  }
  if (attempt < 2) { await sleep(300 * (attempt + 1)); return fetchYahooDailyHist(ticker, attempt + 1); }
  return null;
}

// Mantém comportamento original: refs (refSemana/ref30d/ref3m/ref6m/refYTD/ref5y)
async function fetchYahooDaily(ticker, attempt = 0) {
  const hist = await fetchYahooDailyHist(ticker, attempt);
  return hist ? computeRefs(hist) : null;
}

async function fetchWithCache(ticker, cachePrefix) {
  const cacheKey = `${cachePrefix}${ticker.toUpperCase()}`;
  const cached = await redisGet(cacheKey);
  if (cached) return { data: cached, cacheHit: true };
  const data = await fetchYahooDaily(ticker);
  if (data) await redisSet(cacheKey, data);
  return { data, cacheHit: false };
}

// ════════════════ MODO RAW (dashboard pessoal) ════════════════
const RAW_CACHE_TTL = 21600; // 6 horas

const RANGES   = ['1d','5d','1mo','3mo','6mo','1y','2y','5y','10y','ytd','max'];
const INTERVALS = ['1d','1wk','1mo'];

// ────────────────────────────────────────────────────
// Upstash REST API — mesmo padrão do quote.js
// ────────────────────────────────────────────────────
async function rawRedisGet(url, token, key) {
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

async function rawRedisSet(url, token, key, value, debugInfo) {
  try {
    const serialized = JSON.stringify(value);
    if (debugInfo) debugInfo.saveSize = serialized.length;

    // Guarda-chuva: série de 10 anos passa de 1 MB em casos extremos e o
    // Upstash recusa. Melhor não gravar do que estourar a request.
    if (serialized.length > 900000) {
      if (debugInfo) debugInfo.saveSkipped = 'payload grande demais';
      return false;
    }

    const r = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify([
        ['SET', key, serialized, 'EX', String(RAW_CACHE_TTL)]
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

// Modo RAW (criado em 31/08/26 para o dashboard pessoal): devolve o JSON bruto do Yahoo.
// Ativado quando a chamada traz range, interval ou _src=raw. A plataforma G20 nunca envia esses parâmetros.
async function handleRaw(req, res) {

  const { symbol, range, interval, debug } = req.query;
  const isDebug = debug === '1' || debug === 'true';
  const debugInfo = { steps: [] };

  if (!symbol) return res.status(400).json({ error: 'symbol obrigatório' });

  // Este endpoint atende UM símbolo por chamada. Série é payload grande;
  // lote aqui estouraria o limite de resposta da função.
  const sym = String(symbol).split(',')[0].trim();
  if (!sym) return res.status(400).json({ error: 'symbol inválido' });

  const rng = RANGES.includes(range) ? range : '10y';
  const itv = INTERVALS.includes(interval) ? interval : '1d';
  debugInfo.symbol = sym;
  debugInfo.range  = rng;
  debugInfo.interval = itv;

  const redisUrl   = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  debugInfo.hasRedis = !!(redisUrl && redisToken);

  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function fetchHistory(attempt = 0) {
    // v8/chart é a única rota grátis confiável — mesma decisão do quote.js.
    const urls = [
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${rng}&interval=${itv}`,
      `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${rng}&interval=${itv}`,
    ];

    for (let i = 0; i < urls.length; i++) {
      try {
        const r = await fetch(urls[i], { headers: HEADERS });
        if (!r.ok) {
          if (r.status === 429 && attempt < 2) {
            await sleep(600 * (attempt + 1));
            return fetchHistory(attempt + 1);
          }
          continue;
        }
        const data = await r.json();
        const result = data?.chart?.result?.[0];
        const ts = result?.timestamp;
        const cl = result?.indicators?.quote?.[0]?.close;
        if (!Array.isArray(ts) || !ts.length || !Array.isArray(cl) || !cl.length) continue;

        // Devolve só o que o dashboard usa, no MESMO formato do Yahoo.
        // Descartar meta/events corta bastante do payload sem quebrar o parser.
        return {
          chart: {
            result: [{
              meta: {
                symbol:   result.meta?.symbol || sym,
                currency: result.meta?.currency || null,
              },
              timestamp: ts,
              indicators: { quote: [{ close: cl }] }
            }],
            error: null
          }
        };
      } catch {}
    }

    if (attempt < 2) {
      await sleep(400 * (attempt + 1));
      return fetchHistory(attempt + 1);
    }
    return null;
  }

  const cacheKey = `history:v1:${sym}:${rng}:${itv}`;

  if (redisUrl && redisToken) {
    const cached = await rawRedisGet(redisUrl, redisToken, cacheKey);
    if (cached && cached.chart) {
      debugInfo.steps.push('cache hit');
      res.setHeader('X-Cache-Status', 'HIT');
      if (isDebug) return res.json({ _debug: debugInfo, ...cached });
      return res.json(cached);
    }
  }

  debugInfo.steps.push('cache miss + yahoo fetch');
  const data = await fetchHistory();

  if (!data) {
    res.setHeader('X-Cache-Status', redisUrl ? 'MISS' : 'DISABLED');
    if (isDebug) return res.status(404).json({ _debug: debugInfo, error: 'não encontrado', symbol: sym });
    return res.status(404).json({ error: 'não encontrado', symbol: sym });
  }

  if (redisUrl && redisToken) {
    await rawRedisSet(redisUrl, redisToken, cacheKey, data, isDebug ? debugInfo : null);
  }

  res.setHeader('X-Cache-Status', redisUrl ? 'MISS' : 'DISABLED');
  if (isDebug) return res.json({ _debug: debugInfo, ...data });
  return res.json(data);
}


// ════════════════ PLATAFORMA G20 ════════════════
export default async function handler(req, res) {
  // Porteiro: libera só origem do G20; responde preflight; bloqueia o resto.
  if (aplicarCors(req, res, 'GET,OPTIONS')) return;
  res.setHeader('Access-Control-Expose-Headers', 'X-Cache-Status, X-Cache-Count');

  const { symbol, from, date, _src } = req.query;

  // Dashboard pessoal (formato bruto do Yahoo): só quando pedir range/interval ou _src=raw
  if (_src === 'raw' || req.query.range || req.query.interval) return handleRaw(req, res);

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
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

  // ── Histórico diário completo (série) ────────────────────────────────────
  // Uso: /api/history?_src=daily&symbol=AAPL[&from=YYYY-MM-DD ou YYYY-MM]
  // Retorna { symbol, prices: { 'YYYY-MM-DD': close } } — mesmo formato do mensal, granularidade diária.
  if (_src === 'daily') {
    const ticker = symbol.split(',')[0].trim();
    const cacheKey = `hist:daily:${ticker.toUpperCase()}`;
    let hist = await redisGet(cacheKey);
    const cacheHit = !!hist;
    if (!hist) {
      hist = await fetchYahooDailyHist(ticker);
      if (hist && hist.length) await redisSet(cacheKey, hist);
    }
    res.setHeader('X-Cache-Status', cacheHit ? 'HIT' : (redisUrl ? 'MISS' : 'DISABLED'));
    if (!hist || !hist.length) return res.json({ symbol: ticker, prices: {} });
    // filtro opcional por data inicial (aceita YYYY-MM-DD ou YYYY-MM) para reduzir payload
    let cut = '';
    if (from) cut = from.length === 7 ? from + '-01' : from;
    const prices = {};
    for (const p of hist) {
      if (cut && p.date < cut) continue;
      if (p.close > 0) prices[p.date] = +Number(p.close).toFixed(4);
    }
    return res.json({ symbol: ticker, prices });
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
