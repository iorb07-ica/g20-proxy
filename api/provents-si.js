// api/provents-si.js — Vercel Serverless Function
// Busca dividendos via Statusinvest (scraping do endpoint JSON interno)
// Cobertura: ações + FIIs + ETFs, histórico desde 2016 (10+ anos)
// Fornece: payment_date + ex_date separados, tipo (DIV/JCP/Rendimento)
// Uso: /api/provents-si?symbol=MXRF11&from=2019-01-01
// Debug: adicionar &debug=1

const CACHE_TTL = 86400; // 24 horas

// ────────────────────────────────────────────────────
// Upstash REST API helpers — formato correto
// ────────────────────────────────────────────────────
async function redisGet(url, token, key) {
  try {
    const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!r.ok) return null;
    const d = await r.json();
    // d.result vem como string (valor salvo) ou null
    if (!d.result) return null;
    // Parseia o JSON salvo (que era um array de dividendos)
    try {
      return JSON.parse(d.result);
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

async function redisSet(url, token, key, value) {
  try {
    // Upstash REST: body é o valor DIRETO (não envelopado em objeto)
    // TTL vai como query param ?EX=segundos
    const r = await fetch(`${url}/set/${encodeURIComponent(key)}?EX=${CACHE_TTL}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(value) // Valor direto como body
    });
    return r.ok;
  } catch {
    return false;
  }
}

// Detecta tipo de ativo pelo ticker para escolher a rota correta
function detectAssetType(symbol) {
  symbol = symbol.toUpperCase();
  // FIIs: 4 letras + 11 ou 12 (ex: MXRF11, HGLG11)
  if (/^[A-Z]{4}(11|12)$/.test(symbol)) return 'fii';
  // ETFs conhecidos (geralmente terminam em 11 mas são ETFs)
  // Por enquanto tratamos como FII (rota companytickerprovents)
  // Ações: 4 letras + 3 ou 4 (ex: PETR4, VALE3)
  if (/^[A-Z]{4}[34]$/.test(symbol)) return 'acao';
  // Unit (ações com 11): SANB11, TAEE11 — difícil distinguir de FII
  // Heurística: se termina em 11 mas é ação/unit, o ticker geralmente começa com
  // empresa conhecida. Tratamos como 'acao' se não for FII conhecido.
  if (/^[A-Z]{4}11$/.test(symbol)) return 'acao'; // Unit
  return 'acao'; // default
}

// Converte "dd/MM/yyyy" -> "yyyy-MM-dd"
function brToISO(dateBR) {
  if (!dateBR || typeof dateBR !== 'string') return null;
  const parts = dateBR.split('/');
  if (parts.length !== 3) return null;
  const [d, m, y] = parts;
  if (!d || !m || !y) return null;
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

// Normaliza tipo de provento
function normalizeType(et) {
  if (!et) return 'Dividendo';
  const up = String(et).toUpperCase();
  if (up.includes('JCP') || up.includes('JUROS')) return 'JCP';
  if (up.includes('REND')) return 'Rendimento';
  if (up.includes('BONIF')) return 'Bonificacao';
  if (up.includes('AMORT')) return 'Amortizacao';
  return 'Dividendo';
}

async function fetchStatusinvest(symbol, assetType, debugInfo) {
  // Endpoints descobertos:
  // FII: https://statusinvest.com.br/fii/companytickerprovents?ticker=MXRF11&chartProventsType=2
  // Ação: https://statusinvest.com.br/acao/companytickerprovents?ticker=PETR4&chartProventsType=2
  const path = assetType === 'fii' ? 'fii' : 'acao';
  const url = `https://statusinvest.com.br/${path}/companytickerprovents?ticker=${encodeURIComponent(symbol)}&chartProventsType=2`;

  debugInfo.siUrl = url;
  debugInfo.siAssetType = assetType;

  const startTime = Date.now();
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      'Referer': `https://statusinvest.com.br/${path === 'fii' ? 'fundos-imobiliarios' : 'acoes'}/${symbol.toLowerCase()}`,
      'X-Requested-With': 'XMLHttpRequest'
    }
  });
  debugInfo.siDuration = (Date.now() - startTime) + 'ms';
  debugInfo.siStatus = r.status;

  if (!r.ok) {
    const body = await r.text().catch(() => '');
    debugInfo.siErrorBody = body.slice(0, 300);
    throw new Error('Statusinvest HTTP ' + r.status);
  }

  const data = await r.json();
  debugInfo.siDataKeys = data ? Object.keys(data) : [];

  const rawList = (data && data.assetEarningsModels) ? data.assetEarningsModels : [];
  debugInfo.siRawCount = rawList.length;

  return rawList;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  if (req.method === 'OPTIONS') return res.status(200).end();

  let { symbol, from, debug } = req.query;
  const isDebug = debug === '1' || debug === 'true';
  const debugInfo = { steps: [] };

  if (!symbol) return res.status(400).json({ error: 'symbol obrigatorio' });

  // Normaliza: remove .SA, uppercase
  symbol = String(symbol).replace(/\.SA$/i, '').toUpperCase().trim();
  debugInfo.symbol = symbol;

  const assetType = detectAssetType(symbol);
  debugInfo.detectedType = assetType;

  const fromDate = from
    ? (/^\d{4}-\d{2}-\d{2}$/.test(from) ? from : new Date(parseInt(from) * 1000).toISOString().split('T')[0])
    : new Date(Date.now() - 15 * 365 * 86400000).toISOString().split('T')[0];
  debugInfo.fromDate = fromDate;

  const redisUrl   = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const cacheKey   = `provents-si:${symbol}`;
  debugInfo.hasRedis = !!(redisUrl && redisToken);

  // ────────────────────────────────────────────────────
  // Cache LOOKUP
  // ────────────────────────────────────────────────────
  if (redisUrl && redisToken) {
    const cached = await redisGet(redisUrl, redisToken, cacheKey);
    if (cached && Array.isArray(cached)) {
      debugInfo.steps.push('cache hit: ' + cached.length + ' registros');
      res.setHeader('X-Cache-Status', 'HIT');
      res.setHeader('X-Cache-Count', String(cached.length));
      const filtered = cached.filter(d => d.payment_date >= fromDate);
      if (isDebug) return res.json({ _debug: debugInfo, data: filtered });
      return res.json(filtered);
    }
    debugInfo.steps.push('cache miss');
    res.setHeader('X-Cache-Status', 'MISS');
  } else {
    res.setHeader('X-Cache-Status', 'DISABLED');
  }

  // ────────────────────────────────────────────────────
  // Statusinvest fetch
  // ────────────────────────────────────────────────────
  try {
    debugInfo.steps.push('calling Statusinvest...');
    let rawList = await fetchStatusinvest(symbol, assetType, debugInfo);

    // Se deu lista vazia e tentamos FII, tenta como ação (alguns UNITs confundem)
    if (rawList.length === 0 && assetType === 'fii') {
      debugInfo.steps.push('fii vazio, tentando como acao...');
      rawList = await fetchStatusinvest(symbol, 'acao', debugInfo);
    }
    // Se tentamos ação e deu vazio, tenta como FII
    if (rawList.length === 0 && assetType === 'acao') {
      debugInfo.steps.push('acao vazio, tentando como fii...');
      rawList = await fetchStatusinvest(symbol, 'fii', debugInfo);
    }

    if (rawList.length === 0) {
      debugInfo.steps.push('sem dados Statusinvest');
      if (isDebug) return res.json({ _debug: debugInfo, data: [] });
      return res.json([]);
    }

    const dividends = rawList
      .map(d => {
        const payDate = brToISO(d.pd);
        const exDate  = brToISO(d.ed);
        const valor   = parseFloat(d.v) || 0;
        if (!payDate || !valor) return null;

        return {
          payment_date: payDate,
          ex_date:      exDate || payDate,
          value:        valor,
          type:         normalizeType(d.et || d.etd),
          adjusted:     !!d.adj,
          source:       'Statusinvest'
        };
      })
      .filter(Boolean)
      // Dedup por data+valor+tipo (proteção extra)
      .filter((d, i, arr) => {
        const k = d.payment_date + '|' + d.value.toFixed(6) + '|' + d.type;
        return arr.findIndex(x => (x.payment_date + '|' + x.value.toFixed(6) + '|' + x.type) === k) === i;
      })
      .sort((a, b) => b.payment_date.localeCompare(a.payment_date));

    debugInfo.dividendsCount = dividends.length;
    if (dividends.length > 0) {
      debugInfo.oldestDividend = dividends[dividends.length - 1].payment_date;
      debugInfo.newestDividend = dividends[0].payment_date;
    }
    debugInfo.steps.push('success: ' + dividends.length + ' dividendos processados');

    // ────────────────────────────────────────────────────
    // Cache SAVE
    // ────────────────────────────────────────────────────
    if (redisUrl && redisToken && dividends.length > 0) {
      const saved = await redisSet(redisUrl, redisToken, cacheKey, dividends);
      debugInfo.steps.push('cache save: ' + (saved ? 'OK' : 'FAIL'));
    }

    const filtered = dividends.filter(d => d.payment_date >= fromDate);
    debugInfo.afterFilter = filtered.length;

    if (isDebug) return res.json({ _debug: debugInfo, data: filtered });
    return res.json(filtered);

  } catch (err) {
    debugInfo.error = err.message;
    debugInfo.steps.push('CATCH: ' + err.message);
    if (isDebug) return res.status(200).json({ _debug: debugInfo, data: [] });
    return res.json([]);
  }
}
