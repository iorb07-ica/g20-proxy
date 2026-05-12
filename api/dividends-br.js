// api/dividends-br.js — Vercel Serverless Function
// Fonte: B3 oficial (primário) + Yahoo Finance (histórico longo)
// Complementa o provents-si.js que já cobre Statusinvest
// Uso: /api/dividends-br?symbol=PETR4&from=2020-01-01

const CACHE_TTL = 86400; // 24 horas

// ── REDIS ─────────────────────────────────────────────────
async function redisGet(url, token, key) {
  try {
    const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!r.ok) return null;
    const d = await r.json();
    if (!d.result) return null;
    return JSON.parse(d.result);
  } catch { return null; }
}

async function redisSet(url, token, key, value) {
  try {
    const r = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['SET', key, JSON.stringify(value), 'EX', String(CACHE_TTL)]])
    });
    if (!r.ok) return false;
    const result = await r.json();
    return Array.isArray(result) && result[0]?.result === 'OK';
  } catch { return false; }
}

function toISO(dateBR) {
  if (!dateBR) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateBR)) return dateBR;
  const [d, m, y] = dateBR.split('/');
  if (!d || !m || !y) return null;
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

function isFII(symbol) {
  return symbol.endsWith('11') || symbol.endsWith('12');
}

// ── B3 OFICIAL ─────────────────────────────────────────────
async function fetchB3(symbol) {
  const identifier = symbol.substring(0, 4);
  const typeFund   = isFII(symbol) ? 27 : 3;
  const params     = JSON.stringify({ cnpj: '', identifierFund: identifier, typeFund });
  const b64        = Buffer.from(params).toString('base64');
  const url        = `https://sistemaswebb3-listados.b3.com.br/fundsProxy/fundsCall/GetListedSupplementFunds/${b64}`;

  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'application/json, text/plain, */*',
      'Referer': 'https://www.b3.com.br/',
      'Origin': 'https://www.b3.com.br'
    }
  });

  if (!r.ok) throw new Error('B3 HTTP ' + r.status);

  const data          = await r.json();
  const cashDividends = data?.cashDividends || [];
  if (!cashDividends.length) return [];

  return cashDividends.map(d => {
    const payDate = toISO(d.paymentDate);
    const exDate  = toISO(d.lastDatePrior);
    const valor   = parseFloat(String(d.rate || 0).replace(',', '.'));
    if (!payDate || !valor) return null;

    const tipoRaw = (d.label || '').toUpperCase();
    let tipo = 'Dividendo';
    if (tipoRaw.includes('JCP') || tipoRaw.includes('JUROS')) tipo = 'JCP';
    else if (tipoRaw.includes('REND'))                         tipo = 'Rendimento';
    else if (tipoRaw.includes('BONIF'))                        tipo = 'Bonificacao';

    return {
      payment_date: payDate,
      ex_date:      exDate || payDate,
      value:        valor,
      type:         tipo,
      relatedTo:    d.relatedTo || '',
      source:       'B3'
    };
  })
  .filter(Boolean)
  .sort((a, b) => b.payment_date.localeCompare(a.payment_date));
}

// ── YAHOO FINANCE ─────────────────────────────────────────
async function fetchYahoo(symbol) {
  const ticker = symbol.toUpperCase() + '.SA';
  const now    = Math.floor(Date.now() / 1000);
  const from   = now - 15 * 365 * 86400;
  const url    = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
                 `?period1=${from}&period2=${now}&interval=1d&events=dividends&includePrePost=false`;

  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json',
      'Accept-Language': 'pt-BR,pt;q=0.9'
    }
  });
  if (!r.ok) throw new Error('Yahoo HTTP ' + r.status);

  const data   = await r.json();
  const events = data?.chart?.result?.[0]?.events?.dividends;
  if (!events || typeof events !== 'object') return [];

  return Object.values(events).map(d => {
    const payDate = new Date(d.date * 1000).toISOString().split('T')[0];
    return {
      payment_date: payDate,
      ex_date:      payDate,
      value:        d.amount || 0,
      type:         'Dividendo',
      source:       'Yahoo'
    };
  })
  .filter(d => d.value > 0)
  .sort((a, b) => b.payment_date.localeCompare(a.payment_date));
}

// ── MERGE: B3 (primário) + Yahoo (histórico longo) ────────
function mergeDividends(b3, yahoo) {
  if (!b3.length)    return yahoo;
  if (!yahoo.length) return b3;

  const b3Map = {};
  b3.forEach(d => { b3Map[d.payment_date] = d; });

  const merged = [...b3];

  yahoo.forEach(y => {
    if (!b3Map[y.payment_date]) merged.push(y);
  });

  return merged.sort((a, b) => b.payment_date.localeCompare(a.payment_date));
}

// ── HANDLER ───────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'X-Cache-Status, X-Cache-Count, X-Source');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  if (req.method === 'OPTIONS') return res.status(200).end();

  let { symbol, from } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol obrigatório' });

  symbol = symbol.replace(/\.SA$/i, '').toUpperCase();

  const fromDate = from
    ? (/^\d{4}-\d{2}-\d{2}$/.test(from) ? from : new Date(parseInt(from) * 1000).toISOString().split('T')[0])
    : new Date(Date.now() - 15 * 365 * 86400000).toISOString().split('T')[0];

  const redisUrl   = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const cacheKey   = `dividends-br-v2:${symbol}`;

  // Cache lookup
  if (redisUrl && redisToken) {
    const cached = await redisGet(redisUrl, redisToken, cacheKey);
    if (cached && Array.isArray(cached)) {
      res.setHeader('X-Cache-Status', 'HIT');
      res.setHeader('X-Cache-Count', String(cached.length));
      return res.json(cached.filter(d => d.payment_date >= fromDate));
    }
    res.setHeader('X-Cache-Status', 'MISS');
  }

  // B3 + Yahoo em paralelo
  const [b3Result, yahooResult] = await Promise.allSettled([
    fetchB3(symbol),
    fetchYahoo(symbol)
  ]);

  const b3Data    = b3Result.status    === 'fulfilled' ? b3Result.value    : [];
  const yahooData = yahooResult.status === 'fulfilled' ? yahooResult.value : [];

  const dividends = mergeDividends(b3Data, yahooData);

  const source = b3Data.length && yahooData.length ? 'B3+Yahoo'
               : b3Data.length    ? 'B3'
               : yahooData.length ? 'Yahoo'
               : 'none';

  res.setHeader('X-Source',      source);
  res.setHeader('X-Cache-Count', String(dividends.length));

  if (redisUrl && redisToken && dividends.length) {
    await redisSet(redisUrl, redisToken, cacheKey, dividends);
  }

  return res.json(dividends.filter(d => d.payment_date >= fromDate));
}
