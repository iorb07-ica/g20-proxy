// api/dividends-br.js — Vercel Serverless Function
// Busca dividendos BR direto da B3 (gratuito, oficial)
// Retorna: payment_date, ex_date (lastDatePrior = data-com), value, type
// Uso: /api/dividends-br?symbol=HGLG11&from=2024-01-01

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

// Detecta se é FII pelo sufixo 11
function isFII(ticker) {
  return /\d{2}$/.test(ticker) && ticker.endsWith('11');
}

// Converte data BR "DD/MM/YYYY" para "YYYY-MM-DD"
function toISO(dateBR) {
  if (!dateBR) return null;
  const [d, m, y] = dateBR.split('/');
  if (!d || !m || !y) return null;
  return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
}

// Normaliza valor "1,10000000000" → 1.1
function parseRate(rate) {
  if (!rate) return 0;
  return parseFloat(rate.replace(',', '.'));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  if (req.method === 'OPTIONS') return res.status(200).end();

  let { symbol, from } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol obrigatório' });

  // Remove sufixo .SA se vier
  symbol = symbol.replace(/\.SA$/i, '').toUpperCase();

  const fromDate = from
    ? (/^\d{4}-\d{2}-\d{2}$/.test(from) ? from : new Date(parseInt(from) * 1000).toISOString().split('T')[0])
    : new Date(Date.now() - 10 * 365 * 86400000).toISOString().split('T')[0];

  const redisUrl   = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const cacheKey   = `dividends-br:${symbol}`;

  // ── Tenta cache Upstash ──
  if (redisUrl && redisToken) {
    const cached = await redisGet(redisUrl, redisToken, cacheKey);
    if (cached) {
      const filtered = cached.filter(d => d.payment_date >= fromDate);
      return res.json(filtered);
    }
  }

  // ── Busca direto na B3 ──
  try {
    const identifier = symbol.substring(0, 4);
    const typeFund   = isFII(symbol) ? 27 : 3;

    const params = JSON.stringify({ cnpj: '', identifierFund: identifier, typeFund });
    const b64    = Buffer.from(params).toString('base64');
    const b3Url  = `https://sistemaswebb3-listados.b3.com.br/fundsProxy/fundsCall/GetListedSupplementFunds/${b64}`;

    const r = await fetch(b3Url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://www.b3.com.br/',
        'Origin': 'https://www.b3.com.br'
      }
    });

    if (!r.ok) throw new Error('B3 HTTP ' + r.status);

    const data = await r.json();
    const cashDividends = data.cashDividends || [];

    if (!cashDividends.length) throw new Error('sem dados B3');

    // Filtra apenas o isinCode principal do ticker (evita duplicatas de PETR3/PETR4)
    // O isinCode com o ticker correto contém as letras do symbol
    const dividends = cashDividends
      .filter(d => {
        // Para ações, filtra pelo isinCode que corresponde ao ticker específico
        // PETR4 → isinCode contém "CNPR" (preferencial), PETR3 → "CNOR" (ordinária)
        if (!isFII(symbol)) {
          const lastChar = symbol.slice(-1);
          if (lastChar === '3') return d.isinCode.includes('NOR') || d.isinCode.includes('ON');
          if (lastChar === '4') return d.isinCode.includes('NPR') || d.isinCode.includes('PN');
          if (lastChar === '11') return true;
        }
        return true;
      })
      .map(d => {
        const payDate = toISO(d.paymentDate);
        const exDate  = toISO(d.lastDatePrior);
        const valor   = parseRate(d.rate);
        const tipo    = d.label || 'Dividendo';

        if (!payDate || !valor) return null;

        return {
          payment_date: payDate,
          ex_date:      exDate || payDate,
          value:        valor,
          type:         tipo,
          relatedTo:    d.relatedTo || '',
          approvedOn:   toISO(d.approvedOn),
          source:       'B3'
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.payment_date.localeCompare(a.payment_date));

    // Salva no cache (sem filtro de from)
    if (redisUrl && redisToken && dividends.length > 0) {
      await redisSet(redisUrl, redisToken, cacheKey, dividends);
    }

    // Retorna filtrado pelo from
    const filtered = dividends.filter(d => d.payment_date >= fromDate);
    return res.json(filtered);

  } catch (err) {
    // Fallback: Yahoo Finance
    return fetchYahooFallback(symbol, fromDate, res);
  }
}

async function fetchYahooFallback(symbol, fromDate, res) {
  const tickerSA = symbol + '.SA';
  const period1  = Math.floor(new Date(fromDate).getTime() / 1000);
  const period2  = Math.floor((Date.now() + 365 * 86400000) / 1000);

  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(tickerSA)}?interval=1d&period1=${period1}&period2=${period2}&events=div`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(tickerSA)}?interval=1d&period1=${period1}&period2=${period2}&events=div`,
  ];

  let data = null;
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
      if (r.ok) { data = await r.json(); break; }
    } catch {}
  }

  if (!data) return res.json([]);

  const events = data?.chart?.result?.[0]?.events?.dividends || {};
  const dividends = Object.values(events)
    .map(ev => {
      const date = new Date(ev.date * 1000).toISOString().split('T')[0];
      if (date < fromDate) return null;
      return {
        payment_date: date,
        ex_date:      date,
        value:        ev.amount,
        type:         'Dividendo',
        source:       'Yahoo'
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.payment_date.localeCompare(a.payment_date));

  return res.json(dividends);
}
