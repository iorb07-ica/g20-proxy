// api/history.js — Vercel Serverless Function
// Busca série histórica de um ativo via Yahoo Finance + cache Redis
// Uso: /api/history?symbol=VALE3.SA&range=10y
//      /api/history?symbol=USDBRL=X&range=10y&interval=1d
// Debug: adicionar &debug=1
//
// VERSÃO 1 (31/08/26): criado depois de corsproxy.io e allorigins caírem no
// mesmo dia — o dashboard dependia dos dois para TODA série histórica
// (carteira, IBOV, S&P500, câmbio), e ficou sem nenhuma.
//
// A resposta é o JSON BRUTO do Yahoo (chart.result), de propósito: o
// dashboard já sabe interpretar esse formato, e assim o mesmo parser serve
// tanto para este endpoint quanto para os proxies públicos que continuam
// como último recurso. Não inventar formato novo aqui.

import { aplicarCors } from './_cors.js';

// Série histórica muda uma vez por dia, no fechamento. 6h é folgado e derruba
// muito a chamada ao Yahoo — 17 ativos numa sessão viram 17 leituras de cache.
const CACHE_TTL = 21600; // 6 horas

const RANGES   = ['1d','5d','1mo','3mo','6mo','1y','2y','5y','10y','ytd','max'];
const INTERVALS = ['1d','1wk','1mo'];

// ────────────────────────────────────────────────────
// Upstash REST API — mesmo padrão do quote.js
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
  // Porteiro: libera só origem do G20; responde preflight; bloqueia o resto.
  if (aplicarCors(req, res, 'GET,OPTIONS')) return;
  res.setHeader('Access-Control-Expose-Headers', 'X-Cache-Status');

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
    const cached = await redisGet(redisUrl, redisToken, cacheKey);
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
    await redisSet(redisUrl, redisToken, cacheKey, data, isDebug ? debugInfo : null);
  }

  res.setHeader('X-Cache-Status', redisUrl ? 'MISS' : 'DISABLED');
  if (isDebug) return res.json({ _debug: debugInfo, ...data });
  return res.json(data);
}
