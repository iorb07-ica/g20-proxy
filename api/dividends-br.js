// api/dividends-br.js — Vercel Serverless Function
// Fonte: B3 oficial exclusivamente (sem Yahoo)
//   FIIs/FIAGROs → GetListedSupplementFunds   (typeFund=27)
//   Ações        → GetListedSupplementCompany  (endpoint correto para empresas)
// Usado como FALLBACK quando Statusinvest (provents-si.js) falhar
// Histórico: ~12-18 meses (B3 direta não tem histórico longo)
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

// ── HELPERS ───────────────────────────────────────────────
function toISO(dateBR) {
  if (!dateBR) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateBR)) return dateBR;
  const [d, m, y] = dateBR.split('/');
  if (!d || !m || !y) return null;
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

function isFII(symbol) {
  // FIIs e FIAGROs terminam em 11 ou 12
  return /\d{2}$/.test(symbol) && (symbol.endsWith('11') || symbol.endsWith('12'));
}

function normalizeType(label) {
  const up = (label || '').toUpperCase();
  if (up.includes('JCP') || up.includes('JUROS')) return 'JCP';
  if (up.includes('REND'))                         return 'Rendimento';
  if (up.includes('BONIF'))                        return 'Bonificacao';
  if (up.includes('AMORT'))                        return 'Amortizacao';
  return 'Dividendo';
}

// ── B3: FIIs e FIAGROs ────────────────────────────────────
// Endpoint: GetListedSupplementFunds
// Payload: { cnpj: '', identifierFund: 'MXRF', typeFund: 27 }
async function fetchB3FII(symbol) {
  const identifier = symbol.substring(0, 4).toUpperCase();
  const params     = JSON.stringify({ cnpj: '', identifierFund: identifier, typeFund: 27 });
  const b64        = Buffer.from(params).toString('base64');
  const url        = `https://sistemaswebb3-listados.b3.com.br/fundsProxy/fundsCall/GetListedSupplementFunds/${b64}`;

  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Referer': 'https://www.b3.com.br/',
      'Origin': 'https://www.b3.com.br'
    }
  });

  if (!r.ok) throw new Error('B3 FII HTTP ' + r.status);

  const data          = await r.json();
  const cashDividends = data?.cashDividends || [];
  if (!cashDividends.length) return [];

  return cashDividends.map(d => {
    const payDate = toISO(d.paymentDate);
    const exDate  = toISO(d.lastDatePrior);
    const valor   = parseFloat(String(d.rate || 0).replace(',', '.'));
    if (!payDate || !valor) return null;
    return {
      payment_date: payDate,
      ex_date:      exDate || payDate,
      value:        valor,
      type:         normalizeType(d.label),
      relatedTo:    d.relatedTo || '',
      source:       'B3'
    };
  })
  .filter(Boolean)
  .sort((a, b) => b.payment_date.localeCompare(a.payment_date));
}

// ── B3: Ações ─────────────────────────────────────────────
// Endpoint: GetListedSupplementCompany
// Payload: { code: 'PETR4', language: 'pt-br' }
async function fetchB3Acao(symbol) {
  const params = JSON.stringify({ code: symbol.toUpperCase(), language: 'pt-br' });
  const b64    = Buffer.from(params).toString('base64');
  const url    = `https://sistemaswebb3-listados.b3.com.br/listedCompaniesProxy/CompanyCall/GetListedSupplementCompany/${b64}`;

  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Referer': 'https://www.b3.com.br/',
      'Origin': 'https://www.b3.com.br'
    }
  });

  if (!r.ok) throw new Error('B3 Acao HTTP ' + r.status);

  const data          = await r.json();
  const cashDividends = data?.cashDividends || [];
  if (!cashDividends.length) return [];

  return cashDividends.map(d => {
    const payDate = toISO(d.paymentDate);
    const exDate  = toISO(d.lastDatePrior);
    const valor   = parseFloat(String(d.rate || 0).replace(',', '.'));
    if (!payDate || !valor) return null;
    return {
      payment_date: payDate,
      ex_date:      exDate || payDate,
      value:        valor,
      type:         normalizeType(d.label),
      relatedTo:    d.relatedTo || '',
      source:       'B3'
    };
  })
  .filter(Boolean)
  .sort((a, b) => b.payment_date.localeCompare(a.payment_date));
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

  symbol = symbol.replace(/\.SA$/i, '').toUpperCase().trim();

  const fromDate = from
    ? (/^\d{4}-\d{2}-\d{2}$/.test(from) ? from : new Date(parseInt(from) * 1000).toISOString().split('T')[0])
    : new Date(Date.now() - 15 * 365 * 86400000).toISOString().split('T')[0];

  const redisUrl   = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const cacheKey   = `dividends-br-v3:${symbol}`;

  // Cache lookup
  if (redisUrl && redisToken) {
    const cached = await redisGet(redisUrl, redisToken, cacheKey);
    if (cached && Array.isArray(cached)) {
      res.setHeader('X-Cache-Status', 'HIT');
      res.setHeader('X-Cache-Count', String(cached.length));
      res.setHeader('X-Source', 'cache');
      return res.json(cached.filter(d => d.payment_date >= fromDate));
    }
    res.setHeader('X-Cache-Status', 'MISS');
  }

  // Chama endpoint correto conforme tipo do ativo
  let dividends = [];
  let source = 'none';

  try {
    if (isFII(symbol)) {
      dividends = await fetchB3FII(symbol);
      source = 'B3-FII';
    } else {
      dividends = await fetchB3Acao(symbol);
      source = 'B3-Acao';
    }
  } catch (err) {
    // Se o endpoint principal falhar, tenta o outro como último recurso
    try {
      if (isFII(symbol)) {
        dividends = await fetchB3Acao(symbol);
        source = 'B3-Acao-fallback';
      } else {
        dividends = await fetchB3FII(symbol);
        source = 'B3-FII-fallback';
      }
    } catch (err2) {
      console.error('B3 ambos endpoints falharam:', symbol, err.message, err2.message);
      return res.json([]);
    }
  }

  res.setHeader('X-Source',      source);
  res.setHeader('X-Cache-Count', String(dividends.length));

  if (redisUrl && redisToken && dividends.length) {
    await redisSet(redisUrl, redisToken, cacheKey, dividends);
  }

  return res.json(dividends.filter(d => d.payment_date >= fromDate));
}
