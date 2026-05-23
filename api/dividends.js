// api/dividends.js — Consolidado (substitui dividends.js + dividends-br.js + provents-si.js)
// Routing via _src query param (injetado pelo vercel.json rewrite):
//   _src=si  (ou default BR)  → Statusinvest + B3 fallback
//   _src=br                   → B3 direto
//   _src=us  (ou default US)  → Polygon.io
// Uso direto: /api/dividends?symbol=AAPL  ou  /api/dividends?symbol=PETR4.SA

const CACHE_TTL_DIV = 86400; // 24h

// ── Redis helpers ──────────────────────────────────────────────────────────
async function redisGet(key) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const tok = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !tok) return null;
  try {
    const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${tok}` } });
    if (!r.ok) return null;
    const d = await r.json();
    if (!d.result) return null;
    return JSON.parse(d.result);
  } catch { return null; }
}

async function redisSet(key, value) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const tok = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !tok) return false;
  try {
    const r = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['SET', key, JSON.stringify(value), 'EX', String(CACHE_TTL_DIV)]])
    });
    if (!r.ok) return false;
    const res = await r.json();
    return Array.isArray(res) && res[0]?.result === 'OK';
  } catch { return false; }
}

// ── Helpers comuns ────────────────────────────────────────────────────────
function toISO(dateBR) {
  if (!dateBR) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateBR)) return dateBR;
  const [d, m, y] = dateBR.split('/');
  if (!d || !m || !y) return null;
  return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
}

function brToISO(s) {
  if (!s || typeof s !== 'string') return null;
  const parts = s.split('/');
  if (parts.length !== 3) return null;
  const [d, m, y] = parts;
  return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
}

function isFII(symbol) {
  return /\d{2}$/.test(symbol) && (symbol.endsWith('11') || symbol.endsWith('12'));
}

function isBR(symbol) {
  return symbol.endsWith('.SA') || /^[A-Z]{4}[0-9]{1,2}$/.test(symbol);
}

function normalizeType(et) {
  const up = String(et || '').toUpperCase();
  if (up.includes('JCP') || up.includes('JUROS')) return 'JCP';
  if (up.includes('REND'))  return 'Rendimento';
  if (up.includes('BONIF')) return 'Bonificacao';
  if (up.includes('AMORT')) return 'Amortizacao';
  return 'Dividendo';
}

function detectAssetType(symbol) {
  symbol = symbol.toUpperCase();
  if (/^[A-Z]{4}(11|12)$/.test(symbol)) return 'fii';
  return 'acao';
}

// ── SOURCE: Polygon (US) ──────────────────────────────────────────────────
async function fetchPolygon(symbol, fromDate, isDebug, debugInfo) {
  const polygonKey = process.env.POLYGON_API_KEY;
  const cacheKey   = `dividends:${symbol}`;

  const cached = await redisGet(cacheKey);
  if (cached?.dividends && Array.isArray(cached.dividends)) {
    if (debugInfo) debugInfo.steps.push('cache hit: ' + cached.dividends.length + ' registros');
    return { dividends: cached.dividends.filter(d => d.date >= fromDate), source: 'cache' };
  }

  if (!polygonKey) return { dividends: [] };

  const startDate  = new Date(Date.now() - 10 * 365 * 86400000).toISOString().split('T')[0];
  const futureDate = new Date(Date.now() + 365 * 86400000).toISOString().split('T')[0];
  const url = `https://api.polygon.io/v3/reference/dividends?ticker=${encodeURIComponent(symbol)}&ex_dividend_date.gte=${startDate}&ex_dividend_date.lte=${futureDate}&limit=100&apiKey=${polygonKey}`;

  const pr = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!pr.ok) throw new Error('Polygon HTTP ' + pr.status);
  const pd = await pr.json();
  const results = pd.results || [];

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

  if (dividends.length > 0) await redisSet(cacheKey, { dividends });
  return { dividends: dividends.filter(d => d.date >= fromDate) };
}

// ── SOURCE: B3 FII ────────────────────────────────────────────────────────
async function fetchB3FII(symbol) {
  const identifier = symbol.substring(0, 4).toUpperCase();
  const params = JSON.stringify({ cnpj: '', identifierFund: identifier, typeFund: 27 });
  const b64    = Buffer.from(params).toString('base64');
  const url    = `https://sistemaswebb3-listados.b3.com.br/fundsProxy/fundsCall/GetListedSupplementFunds/${b64}`;
  const r = await fetch(url, { headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    Accept: 'application/json, text/plain, */*',
    Referer: 'https://www.b3.com.br/',
    Origin:  'https://www.b3.com.br'
  }});
  if (!r.ok) throw new Error('B3 FII HTTP ' + r.status);
  const data = await r.json();
  return (data?.cashDividends || []).map(d => {
    const payDate = toISO(d.paymentDate);
    const exDate  = toISO(d.lastDatePrior);
    const valor   = parseFloat(String(d.rate || 0).replace(',', '.'));
    if (!payDate || !valor) return null;
    return { payment_date: payDate, ex_date: exDate || payDate, value: valor, type: normalizeType(d.label), relatedTo: d.relatedTo || '', source: 'B3' };
  }).filter(Boolean).sort((a, b) => b.payment_date.localeCompare(a.payment_date));
}

// ── SOURCE: B3 Ação ───────────────────────────────────────────────────────
async function fetchB3Acao(symbol) {
  const params = JSON.stringify({ code: symbol.toUpperCase(), language: 'pt-br' });
  const b64    = Buffer.from(params).toString('base64');
  const url    = `https://sistemaswebb3-listados.b3.com.br/listedCompaniesProxy/CompanyCall/GetListedSupplementCompany/${b64}`;
  const r = await fetch(url, { headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    Accept: 'application/json, text/plain, */*',
    Referer: 'https://www.b3.com.br/',
    Origin:  'https://www.b3.com.br'
  }});
  if (!r.ok) throw new Error('B3 Ação HTTP ' + r.status);
  const data = await r.json();
  return (data?.cashDividends || []).map(d => {
    const payDate = toISO(d.paymentDate);
    const exDate  = toISO(d.lastDatePrior);
    const valor   = parseFloat(String(d.rate || 0).replace(',', '.'));
    if (!payDate || !valor) return null;
    return { payment_date: payDate, ex_date: exDate || payDate, value: valor, type: normalizeType(d.label), relatedTo: d.relatedTo || '', source: 'B3' };
  }).filter(Boolean).sort((a, b) => b.payment_date.localeCompare(a.payment_date));
}

// ── SOURCE: Statusinvest ──────────────────────────────────────────────────
async function fetchStatusinvest(symbol, assetType) {
  const path = assetType === 'fii' ? 'fii' : 'acao';
  const url  = `https://statusinvest.com.br/${path}/companytickerprovents?ticker=${encodeURIComponent(symbol)}&chartProventsType=2`;
  const r = await fetch(url, { headers: {
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    Accept:            'application/json, text/plain, */*',
    'Accept-Language': 'pt-BR,pt;q=0.9',
    Referer:           `https://statusinvest.com.br/${path === 'fii' ? 'fundos-imobiliarios' : 'acoes'}/${symbol.toLowerCase()}`,
    'X-Requested-With':'XMLHttpRequest'
  }});
  if (!r.ok) throw new Error('Statusinvest HTTP ' + r.status);
  const data = await r.json();
  return (data?.assetEarningsModels) ? data.assetEarningsModels : [];
}

// ── HANDLER ───────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'X-Cache-Status, X-Cache-Count, X-Future-Count, X-Source');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  if (req.method === 'OPTIONS') return res.status(200).end();

  let { symbol, from, _src, debug } = req.query;
  const isDebug = debug === '1';
  const debugInfo = { steps: [], _src };

  if (!symbol) return res.status(400).json({ error: 'symbol obrigatório' });

  symbol = symbol.replace(/\.SA$/i, '').toUpperCase().trim();

  const fromDate = from
    ? (/^\d{4}-\d{2}-\d{2}$/.test(from) ? from : new Date(parseInt(from) * 1000).toISOString().split('T')[0])
    : new Date(Date.now() - 15 * 365 * 86400000).toISOString().split('T')[0];

  // Auto-detect source se _src não foi injetado pelo rewrite
  if (!_src) _src = isBR(symbol) ? 'si' : 'us';

  // ── US: Polygon ──────────────────────────────────────────────────────────
  if (_src === 'us') {
    try {
      const result = await fetchPolygon(symbol, fromDate, isDebug, debugInfo);
      res.setHeader('X-Source', result.source || 'polygon');
      res.setHeader('X-Cache-Count', String(result.dividends.length));
      if (isDebug) return res.json({ _debug: debugInfo, ...result });
      return res.json(result.dividends !== undefined ? result : { dividends: result });
    } catch (err) {
      if (isDebug) return res.json({ _debug: { error: err.message }, dividends: [] });
      return res.json({ dividends: [] });
    }
  }

  // ── BR: B3 direto ────────────────────────────────────────────────────────
  if (_src === 'br') {
    const cacheKey = `dividends-br-v3:${symbol}`;
    const cached = await redisGet(cacheKey);
    if (cached && Array.isArray(cached)) {
      res.setHeader('X-Cache-Status', 'HIT');
      res.setHeader('X-Source', 'cache-b3');
      return res.json(cached.filter(d => d.payment_date >= fromDate));
    }
    res.setHeader('X-Cache-Status', 'MISS');

    let dividends = [];
    try {
      dividends = isFII(symbol) ? await fetchB3FII(symbol) : await fetchB3Acao(symbol);
    } catch (e) {
      try { dividends = isFII(symbol) ? await fetchB3Acao(symbol) : await fetchB3FII(symbol); } catch {}
    }
    if (dividends.length) await redisSet(cacheKey, dividends);
    res.setHeader('X-Cache-Count', String(dividends.length));
    res.setHeader('X-Source', 'b3');
    return res.json(dividends.filter(d => d.payment_date >= fromDate));
  }

  // ── BR: Statusinvest (primary) + B3 fallback ─────────────────────────────
  // _src === 'si' ou default BR
  const cacheKey = `provents-si:${symbol}`;
  const cached = await redisGet(cacheKey);
  if (cached && Array.isArray(cached)) {
    res.setHeader('X-Cache-Status', 'HIT');
    res.setHeader('X-Cache-Count', String(cached.length));
    const today = new Date().toISOString().split('T')[0];
    const filtered = cached.filter(d => d.payment_date >= fromDate || d.status === 'futuro' || d.payment_date > today);
    const futureCount = filtered.filter(d => d.status === 'futuro' || d.payment_date > today).length;
    res.setHeader('X-Future-Count', String(futureCount));
    return res.json(filtered);
  }
  res.setHeader('X-Cache-Status', 'MISS');

  const assetType = detectAssetType(symbol);
  let rawList = [];

  try {
    rawList = await fetchStatusinvest(symbol, assetType);
    if (!rawList.length && assetType === 'fii') rawList = await fetchStatusinvest(symbol, 'acao');
    if (!rawList.length && assetType === 'acao') rawList = await fetchStatusinvest(symbol, 'fii');
  } catch (err) {
    // Statusinvest falhou — fallback para B3
    try {
      const b3 = isFII(symbol) ? await fetchB3FII(symbol) : await fetchB3Acao(symbol);
      if (b3.length) await redisSet(cacheKey, b3);
      res.setHeader('X-Source', 'b3-fallback');
      res.setHeader('X-Cache-Count', String(b3.length));
      return res.json(b3.filter(d => d.payment_date >= fromDate));
    } catch { return res.json([]); }
  }

  if (!rawList.length) return res.json([]);

  const today = new Date().toISOString().split('T')[0];
  const dividends = rawList.map(d => {
    const payDate   = brToISO(d.pd);
    const exDate    = brToISO(d.ed);
    const valor     = parseFloat(d.v) || 0;
    const isSemData = !payDate || payDate.startsWith('9999');
    const isFuturo  = isSemData || (payDate && payDate > today);
    if (!valor) return null;
    const dataEfetiva = isSemData ? (exDate || today) : payDate;
    return { payment_date: dataEfetiva, ex_date: exDate || dataEfetiva, value: valor, type: normalizeType(d.et || d.etd), adjusted: !!d.adj, source: 'Statusinvest', status: isFuturo ? 'futuro' : 'recebido' };
  }).filter(Boolean)
    .filter((d, i, arr) => {
      const k = d.payment_date + '|' + d.value.toFixed(6) + '|' + d.type;
      return arr.findIndex(x => (x.payment_date + '|' + x.value.toFixed(6) + '|' + x.type) === k) === i;
    })
    .sort((a, b) => b.payment_date.localeCompare(a.payment_date));

  if (dividends.length) await redisSet(cacheKey, dividends);

  const futureCount = dividends.filter(d => d.status === 'futuro').length;
  res.setHeader('X-Cache-Count', String(dividends.length));
  res.setHeader('X-Future-Count', String(futureCount));
  res.setHeader('X-Source', 'statusinvest');

  const filtered = dividends.filter(d => d.payment_date >= fromDate || d.status === 'futuro' || d.payment_date > today);
  return res.json(filtered);
}
