// api/dividends-yahoo.js — Vercel Serverless Function
// Busca dividendos via Yahoo Finance (público, gratuito, histórico longo 10+ anos)
// Uso: /api/dividends-yahoo?symbol=PETR4.SA&from=2019-01-01
// Debug: adicionar &debug=1 para ver detalhes

const CACHE_TTL = 86400; // 24 horas

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

// Normaliza ticker para formato Yahoo
// PETR4 -> PETR4.SA | HGLG11 -> HGLG11.SA | AAPL -> AAPL
function normalizeSymbol(symbol) {
  symbol = symbol.toUpperCase().trim();
  // Se já tem sufixo, mantém
  if (symbol.includes('.')) return symbol;
  // Tickers BR: 4 letras + 1-2 números = precisa .SA
  if (/^[A-Z]{4}\d{1,2}$/.test(symbol)) return symbol + '.SA';
  return symbol;
}

function tsToISO(ts) {
  if (!ts) return null;
  return new Date(ts * 1000).toISOString().split('T')[0];
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  if (req.method === 'OPTIONS') return res.status(200).end();

  let { symbol, from, debug } = req.query;
  const isDebug = debug === '1' || debug === 'true';
  const debugInfo = { steps: [] };

  if (!symbol) return res.status(400).json({ error: 'symbol obrigatório' });

  const yahooSymbol = normalizeSymbol(symbol);
  debugInfo.originalSymbol = symbol;
  debugInfo.yahooSymbol = yahooSymbol;

  // from: padrão = 20 anos atrás (pega TUDO que Yahoo tem)
  const fromDate = from
    ? (/^\d{4}-\d{2}-\d{2}$/.test(from) ? from : new Date(parseInt(from) * 1000).toISOString().split('T')[0])
    : new Date(Date.now() - 20 * 365 * 86400000).toISOString().split('T')[0];
  const fromTs = Math.floor(new Date(fromDate).getTime() / 1000);
  const toTs = Math.floor(Date.now() / 1000);
  debugInfo.fromDate = fromDate;
  debugInfo.period = fromTs + ' -> ' + toTs;

  const redisUrl   = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const cacheKey   = `dividends-yahoo:${yahooSymbol}`;
  debugInfo.hasRedis = !!(redisUrl && redisToken);

  // ── Cache Upstash ──
  if (redisUrl && redisToken) {
    const cached = await redisGet(redisUrl, redisToken, cacheKey);
    if (cached) {
      debugInfo.steps.push('cache hit: ' + cached.length + ' registros');
      const filtered = cached.filter(d => d.payment_date >= fromDate);
      if (isDebug) return res.json({ _debug: debugInfo, data: filtered });
      return res.json(filtered);
    }
    debugInfo.steps.push('cache miss');
  }

  // ── Yahoo Finance ──
  try {
    // Endpoint de eventos históricos do Yahoo
    // events=div traz dividendos com timestamp e amount
    const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?period1=${fromTs}&period2=${toTs}&interval=1d&events=div`;
    debugInfo.yahooUrl = yahooUrl;
    debugInfo.steps.push('calling Yahoo...');

    const startTime = Date.now();
    const r = await fetch(yahooUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    debugInfo.yahooDuration = Date.now() - startTime + 'ms';
    debugInfo.yahooStatus = r.status;

    if (!r.ok) {
      const errBody = await r.text().catch(() => '');
      debugInfo.yahooErrorBody = errBody.slice(0, 500);
      throw new Error('Yahoo HTTP ' + r.status + ': ' + errBody.slice(0, 200));
    }

    const data = await r.json();

    // Estrutura Yahoo: chart.result[0].events.dividends { timestamp: {amount, date} }
    const result = data.chart && data.chart.result && data.chart.result[0];
    if (!result) {
      throw new Error('Yahoo: sem resultado no chart');
    }

    const divEvents = result.events && result.events.dividends;
    debugInfo.hasDividendEvents = !!divEvents;
    debugInfo.yahooResponseKeys = Object.keys(result);

    if (!divEvents) {
      debugInfo.steps.push('Yahoo retornou chart mas sem events.dividends');
      if (isDebug) return res.json({ _debug: debugInfo, data: [] });
      return res.json([]);
    }

    // Converter object -> array
    const rawDivs = Object.values(divEvents);
    debugInfo.rawCount = rawDivs.length;

    const dividends = rawDivs
      .map(d => {
        const payDate = tsToISO(d.date);
        const valor = parseFloat(d.amount) || 0;
        if (!payDate || !valor) return null;

        return {
          payment_date: payDate,
          // Yahoo só retorna uma data (data de ex-dividendo, geralmente)
          // Usamos ela como ex_date e payment_date (sem separação)
          ex_date:      payDate,
          value:        valor,
          type:         'Dividendo',
          source:       'Yahoo'
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.payment_date.localeCompare(a.payment_date));

    debugInfo.dividendsCount = dividends.length;
    debugInfo.steps.push('success: ' + dividends.length + ' dividendos processados');

    // Range dos dividendos
    if (dividends.length > 0) {
      debugInfo.oldestDividend = dividends[dividends.length - 1].payment_date;
      debugInfo.newestDividend = dividends[0].payment_date;
    }

    // Cache (só se temos dados reais)
    if (redisUrl && redisToken && dividends.length > 0) {
      await redisSet(redisUrl, redisToken, cacheKey, dividends);
    }

    const filtered = dividends.filter(d => d.payment_date >= fromDate);
    debugInfo.afterFilter = filtered.length;

    if (isDebug) return res.json({ _debug: debugInfo, data: filtered });
    return res.json(filtered);

  } catch (err) {
    debugInfo.error = err.message;
    debugInfo.errorStack = err.stack ? err.stack.split('\n').slice(0, 3) : [];
    debugInfo.steps.push('CATCH: ' + err.message);

    if (isDebug) return res.status(200).json({ _debug: debugInfo, data: [] });
    return res.json([]);
  }
}
