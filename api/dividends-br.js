// api/dividends-br.js — Vercel Serverless Function
// Roteamento por tipo real do ativo:
//   FII  → Statusinvest (primário, histórico completo)
//   AÇÃO → Yahoo Finance (primário, histórico 10+ anos) + B3 (fallback, ex_date/tipo precisos)
// Detecção do tipo: consulta a B3 para saber se o ativo é FII ou Ação —
//   sem lista hardcoded, funciona para qualquer ticker presente ou futuro.

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

// ── DETECÇÃO DE TIPO REAL ──────────────────────────────────
// Consulta a B3 para saber se o ativo é FII ou Ação.
// FIIs sempre têm "FII", "FUNDO", "FDO", "IMOB" ou "FIAGRO" no nome corporativo.
// Isso resolve TAEE11, SANB11, SAPR11, BPAC11, KLBN11 etc. corretamente —
// são Units (ações) que terminam em 11 mas NÃO são fundos imobiliários.
async function detectAssetType(symbol) {
  const identifier = symbol.substring(0, 4);

  try {
    const params = JSON.stringify({ cnpj: '', identifierFund: identifier, typeFund: 27 });
    const b64    = Buffer.from(params).toString('base64');
    const url    = `https://sistemaswebb3-listados.b3.com.br/fundsProxy/fundsCall/GetListedSupplementFunds/${b64}`;
    const r      = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json',
        'Referer': 'https://www.b3.com.br/'
      }
    });

    if (r.ok) {
      const data = await r.json();
      const name = (
        data?.detailFund?.companyName ||
        data?.detailFund?.fundName    ||
        data?.detailFund?.typeFund    || ''
      ).toUpperCase();

      // Palavras que identificam inequivocamente um Fundo Imobiliário
      const FII_KEYWORDS = ['FII', 'FUNDO DE INVESTIMENTO IMOBILIARIO', 'FUNDO IMOBILIARIO',
                            'FDO IMOB', 'FIAGRO', 'CRI', 'LCI'];
      if (FII_KEYWORDS.some(kw => name.includes(kw))) return 'FII';

      // B3 retornou dados mas nome não contém palavras de FII → é ação (Unit terminada em 11)
      if (data?.detailFund?.companyName) return 'ACAO';
    }
  } catch { /* silencioso — fallback abaixo */ }

  // Se não conseguiu determinar via B3:
  // Heurística de último recurso — FIIs brasileiros quase sempre terminam em 11 ou 12,
  // mas Units também. Sem confirmação da B3, trata como ACAO (mais seguro para dividendos).
  return 'ACAO';
}

// ── HELPER ────────────────────────────────────────────────
function toISO(dateBR) {
  if (!dateBR) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateBR)) return dateBR;
  const [d, m, y] = dateBR.split('/');
  if (!d || !m || !y) return null;
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

// ── STATUSINVEST (para FIIs) ───────────────────────────────
async function fetchStatusinvest(symbol) {
  const url = `https://statusinvest.com.br/acao/payoutresult?search=${symbol}&type=3`;
  const r   = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Referer': `https://statusinvest.com.br/fundos-imobiliarios/${symbol.toLowerCase()}`
    }
  });

  if (!r.ok) throw new Error('Statusinvest HTTP ' + r.status);

  const data = await r.json();
  const list = Array.isArray(data) ? data : (data?.assetEarningsModels || data?.list || []);
  if (!list.length) return [];

  return list.map(d => {
    const payDate = toISO(d.pd || d.paymentDate || d.dt);
    const exDate  = toISO(d.ed || d.lastDatePrior || d.datex);
    const valor   = parseFloat(String(d.v || d.value || d.rate || 0).replace(',', '.'));
    if (!payDate || !valor) return null;

    const tipoRaw = (d.et || d.earningType || d.type || '').toUpperCase();
    let tipo = 'Rendimento';
    if (tipoRaw.includes('JCP') || tipoRaw.includes('JUROS')) tipo = 'JCP';
    else if (tipoRaw.includes('DIV'))                          tipo = 'Dividendo';

    return {
      payment_date: payDate,
      ex_date:      exDate || payDate,
      value:        valor,
      type:         tipo,
      source:       'Statusinvest'
    };
  })
  .filter(Boolean)
  .sort((a, b) => b.payment_date.localeCompare(a.payment_date));
}

// ── YAHOO FINANCE (para ações BR) ─────────────────────────
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

// ── B3 OFICIAL (fallback para ações) ──────────────────────
async function fetchB3(symbol) {
  const identifier = symbol.substring(0, 4);
  const params     = JSON.stringify({ cnpj: '', identifierFund: identifier, typeFund: 3 });
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

// ── MERGE Yahoo + B3 ──────────────────────────────────────
function mergeDividends(yahoo, b3) {
  if (!yahoo.length) return b3;
  if (!b3.length)    return yahoo;

  const b3Map = {};
  b3.forEach(d => { b3Map[d.payment_date] = d; });

  const merged = yahoo.map(y => {
    const b = b3Map[y.payment_date];
    if (b) return { ...y, ex_date: b.ex_date, type: b.type, source: 'Yahoo+B3' };
    return y;
  });

  b3.forEach(b => {
    if (!merged.find(m => m.payment_date === b.payment_date)) merged.push(b);
  });

  return merged.sort((a, b) => b.payment_date.localeCompare(a.payment_date));
}

// ── HANDLER ───────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'X-Cache-Status, X-Cache-Count, X-Source, X-Asset-Type');
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
  const cacheKey   = `dividends-br-v3:${symbol}`; // v3 = nova lógica com detecção de tipo

  // Cache lookup
  if (redisUrl && redisToken) {
    const cached = await redisGet(redisUrl, redisToken, cacheKey);
    if (cached?.dividends && Array.isArray(cached.dividends)) {
      res.setHeader('X-Cache-Status', 'HIT');
      res.setHeader('X-Asset-Type',   cached.assetType || 'unknown');
      res.setHeader('X-Cache-Count',  String(cached.dividends.length));
      return res.json(cached.dividends.filter(d => d.payment_date >= fromDate));
    }
    res.setHeader('X-Cache-Status', 'MISS');
  }

  // 1) Detecta tipo real (FII ou ACAO) via B3
  const assetType = await detectAssetType(symbol);
  res.setHeader('X-Asset-Type', assetType);

  let dividends = [];
  let source    = 'none';

  if (assetType === 'FII') {
    // FIIs → Statusinvest (primário) → B3 typeFund=27 (fallback)
    try {
      dividends = await fetchStatusinvest(symbol);
      source    = 'Statusinvest';
    } catch (e) {
      console.error(`[dividends-br] SI falhou para ${symbol}:`, e.message);
      try {
        const params = JSON.stringify({ cnpj: '', identifierFund: symbol.substring(0, 4), typeFund: 27 });
        const b64    = Buffer.from(params).toString('base64');
        const url    = `https://sistemaswebb3-listados.b3.com.br/fundsProxy/fundsCall/GetListedSupplementFunds/${b64}`;
        const r      = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.b3.com.br/' } });
        if (r.ok) {
          const data = await r.json();
          dividends  = (data?.cashDividends || []).map(d => {
            const payDate = toISO(d.paymentDate);
            const valor   = parseFloat(String(d.rate || 0).replace(',', '.'));
            if (!payDate || !valor) return null;
            return { payment_date: payDate, ex_date: toISO(d.lastDatePrior) || payDate, value: valor, type: 'Rendimento', source: 'B3' };
          }).filter(Boolean);
          source = 'B3';
        }
      } catch { /* sem dados */ }
    }
  } else {
    // Ações BR → Yahoo (primário) + B3 (enriquecimento/fallback)
    const [yahooResult, b3Result] = await Promise.allSettled([
      fetchYahoo(symbol),
      fetchB3(symbol)
    ]);

    const yahooData = yahooResult.status === 'fulfilled' ? yahooResult.value : [];
    const b3Data    = b3Result.status   === 'fulfilled'  ? b3Result.value    : [];

    dividends = mergeDividends(yahooData, b3Data);
    source    = yahooData.length && b3Data.length ? 'Yahoo+B3'
              : yahooData.length ? 'Yahoo' : 'B3';
  }

  res.setHeader('X-Source',      source);
  res.setHeader('X-Cache-Count', String(dividends.length));

  // Salva cache com assetType embutido para não precisar re-detectar
  if (redisUrl && redisToken && dividends.length) {
    await redisSet(redisUrl, redisToken, cacheKey, { assetType, dividends });
  }

  return res.json(dividends.filter(d => d.payment_date >= fromDate));
}
