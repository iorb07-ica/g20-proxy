// api/dividends-br.js — Vercel Serverless Function
// Estratégia: Statusinvest + Yahoo Finance em paralelo → merge inteligente
// Deduplicação: mesmo valor (±1%) dentro de janela de 15 dias = mesmo provento
// Sem classificação de tipo de ativo — funciona para FIIs, ações e Units automaticamente

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

// ── HELPER ────────────────────────────────────────────────
function toISO(dateBR) {
  if (!dateBR) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateBR)) return dateBR;
  const [d, m, y] = dateBR.split('/');
  if (!d || !m || !y) return null;
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

function daysDiff(dateA, dateB) {
  return Math.abs(new Date(dateA) - new Date(dateB)) / 86400000;
}

// ── STATUSINVEST ──────────────────────────────────────────
// Tenta as duas URLs em paralelo (ação e FII) — usa a que retornar dados
async function fetchStatusinvest(symbol) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Referer': `https://statusinvest.com.br/`
  };

  const urls = [
    `https://statusinvest.com.br/acao/payoutresult?search=${symbol}&type=3`,
    `https://statusinvest.com.br/fundoImobiliario/payoutresult?search=${symbol}&type=3`
  ];

  const results = await Promise.allSettled(
    urls.map(url => fetch(url, { headers }).then(r => r.ok ? r.json() : null))
  );

  // Pega a resposta com mais dados
  let list = [];
  for (const res of results) {
    if (res.status !== 'fulfilled' || !res.value) continue;
    const data    = res.value;
    const entries = Array.isArray(data) ? data : (data?.assetEarningsModels || data?.list || []);
    if (entries.length > list.length) list = entries;
  }

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

    return { payment_date: payDate, ex_date: exDate || payDate, value: valor, type: tipo, source: 'Statusinvest' };
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
    return { payment_date: payDate, ex_date: payDate, value: d.amount || 0, type: 'Dividendo', source: 'Yahoo' };
  })
  .filter(d => d.value > 0)
  .sort((a, b) => b.payment_date.localeCompare(a.payment_date));
}

// ── MERGE INTELIGENTE ─────────────────────────────────────
// Dois registros são o mesmo provento se:
//   - valores iguais com tolerância de 1%
//   - datas dentro de uma janela de 15 dias
// Nesse caso mantém apenas um, priorizando o que tem mais informação
// (Statusinvest tem ex_date e tipo corretos; Yahoo tem histórico mais longo)
function mergeIntelligente(si, yahoo) {
  // Começa com todos do Statusinvest como base
  const resultado = [...si];

  for (const y of yahoo) {
    // Verifica se já existe um registro equivalente vindo do Statusinvest
    const duplicata = resultado.find(r => {
      const valorSimilar = Math.abs(r.value - y.value) / Math.max(r.value, y.value) < 0.01;
      const dataProxima  = daysDiff(r.payment_date, y.payment_date) <= 15;
      return valorSimilar && dataProxima;
    });

    if (!duplicata) {
      // Registro novo — adiciona do Yahoo (histórico mais antigo geralmente)
      resultado.push(y);
    } else if (duplicata.source === 'Statusinvest') {
      // Já temos pelo Statusinvest — enriquece com source combinado
      duplicata.source = 'SI+Yahoo';
    }
  }

  return resultado.sort((a, b) => b.payment_date.localeCompare(a.payment_date));
}

// ── HANDLER ───────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'X-Cache-Status, X-Cache-Count, X-Source, X-SI-Count, X-Yahoo-Count');
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
  const cacheKey   = `dividends-br-v4:${symbol}`; // v4 = merge SI+Yahoo

  // Cache lookup
  if (redisUrl && redisToken) {
    const cached = await redisGet(redisUrl, redisToken, cacheKey);
    if (cached && Array.isArray(cached)) {
      res.setHeader('X-Cache-Status', 'HIT');
      res.setHeader('X-Cache-Count',  String(cached.length));
      return res.json(cached.filter(d => d.payment_date >= fromDate));
    }
    res.setHeader('X-Cache-Status', 'MISS');
  }

  // Busca Statusinvest + Yahoo em paralelo
  const [siResult, yahooResult] = await Promise.allSettled([
    fetchStatusinvest(symbol),
    fetchYahoo(symbol)
  ]);

  const siData    = siResult.status    === 'fulfilled' ? siResult.value    : [];
  const yahooData = yahooResult.status === 'fulfilled' ? yahooResult.value : [];

  res.setHeader('X-SI-Count',    String(siData.length));
  res.setHeader('X-Yahoo-Count', String(yahooData.length));

  const dividends = mergeIntelligente(siData, yahooData);

  const source = siData.length && yahooData.length ? 'SI+Yahoo'
               : siData.length    ? 'Statusinvest'
               : yahooData.length ? 'Yahoo'
               : 'none';

  res.setHeader('X-Source',      source);
  res.setHeader('X-Cache-Count', String(dividends.length));

  // Salva cache
  if (redisUrl && redisToken && dividends.length) {
    await redisSet(redisUrl, redisToken, cacheKey, dividends);
  }

  return res.json(dividends.filter(d => d.payment_date >= fromDate));
}
