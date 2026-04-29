// api/quote.js — Vercel Serverless Function
// Busca cotação de um ativo via Yahoo Finance + cache Redis (5min)
// Uso: /api/quote?symbol=PETR4.SA ou /api/quote?symbol=AAPL,MSFT
// Debug: adicionar &debug=1
//
// VERSÃO 7 (29/04/26): Adicionado pre-market / after-hours / marketState
// Campos novos no retorno:
//   - preMarketPrice, preMarketChangePercent
//   - postMarketPrice, postMarketChangePercent
//   - marketState ("PRE" | "REGULAR" | "POST" | "CLOSED" | "PREPRE" | "POSTPOST")

const CACHE_TTL = 300; // 5 minutos — cotações mudam frequente, não pode ser 24h

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
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, debug } = req.query;
  const isDebug = debug === '1' || debug === 'true';
  const debugInfo = { steps: [] };

  if (!symbol) return res.status(400).json({ error: 'symbol obrigatório' });

  const symbols = symbol.split(',').map(s => s.trim()).filter(Boolean);
  debugInfo.symbolsCount = symbols.length;

  const redisUrl   = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  debugInfo.hasRedis = !!(redisUrl && redisToken);

  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function fetchQuote(sym, attempt = 0, traceLog = null) {
    // ORDEM IMPORTANTE: v7/quote PRIMEIRO porque retorna marketState +
    // preMarketPrice + postMarketPrice. v8/chart é fallback (não tem esses campos consistentemente).
    const urls = [
      `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(sym)}`,
      `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(sym)}`,
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`,
      `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`,
    ];

    for (let i = 0; i < urls.length; i++) {
      try {
        const r = await fetch(urls[i], { headers: HEADERS });
        if (traceLog) traceLog.push(`url[${i}] status=${r.status}`);
        if (!r.ok) {
          if (r.status === 429 && attempt < 2) {
            await sleep(500 * (attempt + 1));
            return fetchQuote(sym, attempt + 1, traceLog);
          }
          continue;
        }
        const data = await r.json();

        // ────────────────────────────────────────────────
        // Ramo 1: chart API (v8) — meta fields
        // ────────────────────────────────────────────────
        const meta = data?.chart?.result?.[0]?.meta;
        if (meta?.regularMarketPrice) {
          if (traceLog) traceLog.push(`url[${i}] hit=v8/chart marketState=${meta.marketState||'undef'} hasPre=${!!meta.preMarketPrice} hasPost=${!!meta.postMarketPrice}`);
          const prev = meta.chartPreviousClose || meta.previousClose || meta.regularMarketPrice;

          // Cálculo pre/post-market a partir de meta.regularMarketPrice como referência
          // Yahoo chart API tem: meta.preMarketPrice, meta.postMarketPrice (quando disponível)
          // mas NEM SEMPRE retorna nessa rota — ramo 2 (quote API) é mais confiável pra isso
          let preMarketPrice = null, preMarketChangePercent = null;
          let postMarketPrice = null, postMarketChangePercent = null;

          if (typeof meta.preMarketPrice === 'number' && meta.preMarketPrice > 0) {
            preMarketPrice = meta.preMarketPrice;
            // Variação do pre vs. fechamento regular do dia anterior (prev)
            if (prev && prev > 0) {
              preMarketChangePercent = ((preMarketPrice - prev) / prev) * 100;
            }
          }

          if (typeof meta.postMarketPrice === 'number' && meta.postMarketPrice > 0) {
            postMarketPrice = meta.postMarketPrice;
            // Variação do post vs. fechamento regular do DIA (regularMarketPrice)
            const regular = meta.regularMarketPrice;
            if (regular && regular > 0) {
              postMarketChangePercent = ((postMarketPrice - regular) / regular) * 100;
            }
          }

          return {
            symbol:                     meta.symbol || sym,
            name:                       meta.longName || meta.shortName || sym,
            price:                      meta.regularMarketPrice,
            change:                     meta.regularMarketPrice - prev,
            changePercent:              prev ? ((meta.regularMarketPrice - prev) / prev * 100) : 0,
            prevClose:                  prev,
            currency:                   meta.currency || 'USD',
            // 52 semanas (Yahoo chart API retorna nos meta fields)
            high52:                     meta.fiftyTwoWeekHigh || null,
            low52:                      meta.fiftyTwoWeekLow || null,
            dividendRate:               meta.dividendRate || null,
            dividendDate:               meta.dividendDate || null,
            exDividendDate:             meta.exDividendDate || null,
            trailingAnnualDividendRate: meta.trailingAnnualDividendRate || null,
            // ============== NOVOS CAMPOS (v7 — 29/04/26) ==============
            // Estado do mercado: PRE / REGULAR / POST / CLOSED / PREPRE / POSTPOST
            marketState:                meta.marketState || null,
            // Pre-market (antes da abertura)
            preMarketPrice:             preMarketPrice,
            preMarketChangePercent:     preMarketChangePercent,
            // After-hours (depois do fechamento)
            postMarketPrice:            postMarketPrice,
            postMarketChangePercent:    postMarketChangePercent,
            // ============================================================
            timestamp:                  Date.now(),
          };
        }

        // ────────────────────────────────────────────────
        // Ramo 2: quote API (v7) — fields diretos no result
        // Yahoo quote API é a MAIS CONFIÁVEL pra pre/post-market
        // ────────────────────────────────────────────────
        const q = data?.quoteResponse?.result?.[0];
        if (q?.regularMarketPrice) {
          if (traceLog) traceLog.push(`url[${i}] hit=v7/quote marketState=${q.marketState||'undef'} hasPre=${!!q.preMarketPrice} hasPost=${!!q.postMarketPrice}`);
          const prev = q.regularMarketPreviousClose || q.regularMarketPrice;
          return {
            symbol:                     q.symbol || sym,
            name:                       q.longName || q.shortName || sym,
            price:                      q.regularMarketPrice,
            change:                     q.regularMarketChange || (q.regularMarketPrice - prev),
            changePercent:              q.regularMarketChangePercent || 0,
            prevClose:                  prev,
            currency:                   q.currency || 'USD',
            // 52 semanas (Yahoo quote API retorna diretamente no result)
            high52:                     q.fiftyTwoWeekHigh || null,
            low52:                      q.fiftyTwoWeekLow || null,
            dividendRate:               q.dividendRate || null,
            dividendDate:               q.dividendDate || null,
            exDividendDate:             q.exDividendDate || null,
            trailingAnnualDividendRate: q.trailingAnnualDividendRate || null,
            // ============== NOVOS CAMPOS (v7 — 29/04/26) ==============
            // Estado do mercado: PRE / REGULAR / POST / CLOSED / PREPRE / POSTPOST
            marketState:                q.marketState || null,
            // Pre-market (antes da abertura) — Yahoo retorna direto
            preMarketPrice:             (typeof q.preMarketPrice === 'number') ? q.preMarketPrice : null,
            preMarketChangePercent:     (typeof q.preMarketChangePercent === 'number') ? q.preMarketChangePercent : null,
            // After-hours (depois do fechamento) — Yahoo retorna direto
            postMarketPrice:            (typeof q.postMarketPrice === 'number') ? q.postMarketPrice : null,
            postMarketChangePercent:    (typeof q.postMarketChangePercent === 'number') ? q.postMarketChangePercent : null,
            // ============================================================
            timestamp:                  Date.now(),
          };
        }
      } catch (e) {
        if (traceLog) traceLog.push(`url[${i}] threw=${(e.message||'').slice(0,60)}`);
      }
    }

    if (attempt < 2) {
      if (traceLog) traceLog.push(`retry attempt=${attempt+1}`);
      await sleep(300 * (attempt + 1));
      return fetchQuote(sym, attempt + 1, traceLog);
    }

    return null;
  }

  // ────────────────────────────────────────────────────
  // Função que consulta cache ou Yahoo pra UM ticker
  // ────────────────────────────────────────────────────
  async function getQuoteWithCache(sym, traceOut) {
    // VERSÃO v4 (29/04/26): v7/quote prioritário + trace de debug.
    // Bumpar a versão invalida automaticamente caches da versão anterior.
    const cacheKey = `quote:v4:${sym}`;

    // Tenta cache
    if (redisUrl && redisToken) {
      const cached = await redisGet(redisUrl, redisToken, cacheKey);
      if (cached && cached.price) {
        return { data: cached, cacheHit: true };
      }
    }

    // Busca Yahoo
    const q = await fetchQuote(sym, 0, traceOut);
    if (!q) return { data: null, cacheHit: false };

    // Salva no cache
    if (redisUrl && redisToken) {
      await redisSet(redisUrl, redisToken, cacheKey, q, null);
    }

    return { data: q, cacheHit: false };
  }

  // ────────────────────────────────────────────────────
  // 1 símbolo só
  // ────────────────────────────────────────────────────
  if (symbols.length === 1) {
    const traceOut = isDebug ? [] : null;
    const { data, cacheHit } = await getQuoteWithCache(symbols[0], traceOut);
    debugInfo.steps.push(cacheHit ? 'cache hit' : 'cache miss + yahoo fetch');
    if (traceOut && traceOut.length) debugInfo.trace = traceOut;
    res.setHeader('X-Cache-Status', cacheHit ? 'HIT' : (redisUrl ? 'MISS' : 'DISABLED'));

    if (!data) {
      if (isDebug) return res.status(404).json({ _debug: debugInfo, error: 'não encontrado', symbol: symbols[0] });
      return res.status(404).json({ error: 'não encontrado', symbol: symbols[0] });
    }
    if (isDebug) return res.json({ _debug: debugInfo, ...data });
    return res.json(data);
  }

  // ────────────────────────────────────────────────────
  // Múltiplos símbolos — processa em paralelo
  // ────────────────────────────────────────────────────
  const results = {};
  let hits = 0, misses = 0;

  await Promise.all(symbols.map(async sym => {
    const { data, cacheHit } = await getQuoteWithCache(sym);
    if (data) {
      results[sym] = data;
      if (cacheHit) hits++;
      else misses++;
    }
  }));

  debugInfo.steps.push(`cache: ${hits} hits, ${misses} misses`);
  res.setHeader('X-Cache-Status', hits === symbols.length ? 'HIT' : (hits > 0 ? 'PARTIAL' : 'MISS'));
  res.setHeader('X-Cache-Count', String(hits));

  if (isDebug) return res.json({ _debug: debugInfo, ...results });
  return res.json(results);
}
