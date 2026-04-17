// api/dividends-yahoo.js — Vercel Serverless Function
// Busca dividendos historicos US via Yahoo Finance com cache Upstash Redis (30 dias)
// Retry automatico em caso de 429 (rate limit)
// Uso: /api/dividends-yahoo?symbol=AAPL&from=2017-01-01&to=2024-04-01

const CACHE_TTL_SUCCESS = 30 * 86400;  // 30 dias para respostas bem-sucedidas
const CACHE_TTL_FAIL    = 3600;         // 1 hora para respostas vazias (evita martelar o Yahoo)

async function redisGet(url, token, key) {
  try {
    const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const d = await r.json();
    return d.result ? JSON.parse(d.result) : null;
  } catch { return null; }
}

async function redisSet(url, token, key, value, ttl) {
  try {
    await fetch(`${url}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: JSON.stringify(value), ex: ttl })
    });
  } catch {}
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function tentarYahoo(symbol, period1, period2) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d&events=div`;

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json,text/plain,*/*',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    if (!response.ok) {
      return { ok: false, status: response.status };
    }

    const data = await response.json();
    return { ok: true, data: data };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
}

function filtrarPorIntervalo(dividends, from, to) {
  if (!dividends || !dividends.length) return [];
  let filtered = dividends;
  if (from) filtered = filtered.filter(d => d.date >= from);
  if (to)   filtered = filtered.filter(d => d.date <= to);
  return filtered;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, from, to } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol obrigatorio' });

  const redisUrl   = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  const hoje = Math.floor(Date.now() / 1000);
  const umAno = 365 * 86400;

  // Sempre busca a janela MAXIMA (30 anos ate hoje) para cachear tudo de uma vez.
  const period1 = hoje - (30 * umAno);
  const period2 = hoje;

  const cacheKey = `dividends-yahoo:${symbol.toUpperCase()}`;

  // Tenta buscar do cache primeiro
  if (redisUrl && redisToken) {
    const cached = await redisGet(redisUrl, redisToken, cacheKey);
    if (cached) {
      const filtered = filtrarPorIntervalo(cached.dividends || [], from, to);
      return res.json({
        dividends: filtered,
        symbol: symbol,
        source: 'cache',
        cached_at: cached.cached_at
      });
    }
  }

  // Busca no Yahoo com retry
  let tentativas = 0;
  let ultimoErro = null;
  const maxTentativas = 3;
  const delays = [2000, 5000];

  while (tentativas < maxTentativas) {
    const resultado = await tentarYahoo(symbol, period1, period2);

    if (resultado.ok) {
      const result = resultado.data && resultado.data.chart && resultado.data.chart.result && resultado.data.chart.result[0];
      const dividendsObj = result && result.events && result.events.dividends;

      let dividends = [];
      if (dividendsObj) {
        dividends = Object.values(dividendsObj).map(div => {
          const dataStr = new Date(div.date * 1000).toISOString().split('T')[0];
          const amount = parseFloat(div.amount) || 0;
          return {
            date: dataStr,
            amount: amount,
            payment_date: dataStr,
            ex_date: dataStr,
            record_date: dataStr,
            declare_date: null,
            value: amount,
            type: 'Dividendo',
            frequency: 4,
            source: 'Yahoo'
          };
        }).sort((a, b) => b.date.localeCompare(a.date));
      }

      if (redisUrl && redisToken) {
        const ttl = dividends.length > 0 ? CACHE_TTL_SUCCESS : CACHE_TTL_FAIL;
        await redisSet(redisUrl, redisToken, cacheKey, {
          dividends: dividends,
          cached_at: new Date().toISOString()
        }, ttl);
      }

      return res.json({
        dividends: filtrarPorIntervalo(dividends, from, to),
        symbol: symbol,
        source: 'Yahoo',
        attempts: tentativas + 1
      });
    }

    ultimoErro = resultado.status;
    tentativas++;

    if (tentativas < maxTentativas) {
      await sleep(delays[tentativas - 1]);
    }
  }

  // Todas as tentativas falharam
  if (redisUrl && redisToken) {
    await redisSet(redisUrl, redisToken, cacheKey, {
      dividends: [],
      cached_at: new Date().toISOString(),
      failed: true
    }, CACHE_TTL_FAIL);
  }

  return res.json({
    dividends: [],
    error: `Yahoo bloqueou apos ${maxTentativas} tentativas (HTTP ${ultimoErro})`,
    symbol: symbol,
    will_retry_in: '1 hora'
  });
}
