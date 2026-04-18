// api/dividends-yahoo.js — Vercel Serverless Function
// IMPORTANTE: apesar do nome "yahoo", este endpoint usa FMP (Financial Modeling Prep)
// como fonte — Yahoo bloqueia IPs da Vercel, FMP funciona perfeitamente.
// Nome mantido por compatibilidade com a Carteira.
//
// Fonte: FMP /stable/dividends (30+ anos de historico, 250 chamadas/dia no free)
// Cache: Redis 30 dias (dividendos historicos sao imutaveis)
// Uso: /api/dividends-yahoo?symbol=AAPL&from=2017-01-01&to=2024-04-01

const CACHE_TTL_SUCCESS = 30 * 86400;  // 30 dias
const CACHE_TTL_FAIL    = 3600;         // 1 hora para falhas

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
  const fmpKey     = process.env.FMP_API_KEY;

  if (!fmpKey) {
    return res.status(500).json({
      dividends: [],
      error: 'FMP_API_KEY nao configurada no Vercel'
    });
  }

  // Cache key por ticker (mesmo cache serve qualquer intervalo from/to)
  const cacheKey = `dividends-fmp:${symbol.toUpperCase()}`;

  // Tenta cache primeiro
  if (redisUrl && redisToken) {
    const cached = await redisGet(redisUrl, redisToken, cacheKey);
    if (cached) {
      const filtered = filtrarPorIntervalo(cached.dividends || [], from, to);
      return res.json({
        dividends: filtered,
        symbol: symbol,
        source: 'cache',
        cached_at: cached.cached_at,
        total_cached: (cached.dividends || []).length
      });
    }
  }

  // Busca no FMP
  try {
    const url = `https://financialmodelingprep.com/stable/dividends?symbol=${encodeURIComponent(symbol)}&apikey=${fmpKey}`;
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' }
    });

    if (!response.ok) {
      return res.json({
        dividends: [],
        error: `FMP HTTP ${response.status}`,
        symbol: symbol
      });
    }

    const raw = await response.json();

    // FMP retorna array direto (nao e um objeto com "historical")
    if (!Array.isArray(raw)) {
      // Se veio objeto com erro do FMP
      if (raw && raw['Error Message']) {
        return res.json({
          dividends: [],
          error: 'FMP: ' + raw['Error Message'],
          symbol: symbol
        });
      }
      return res.json({ dividends: [], symbol: symbol, source: 'FMP', message: 'Nenhum dividendo encontrado' });
    }

    // Normaliza formato para o mesmo que a Carteira espera
    const dividends = raw.map(d => ({
      date:         d.date,                                  // ex-dividend date
      amount:       parseFloat(d.adjDividend || d.dividend || 0),
      payment_date: d.paymentDate || d.date,
      ex_date:      d.date,
      record_date:  d.recordDate || d.date,
      declare_date: d.declarationDate || null,
      value:        parseFloat(d.adjDividend || d.dividend || 0),
      type:         'Dividendo',
      frequency:    typeof d.frequency === 'string' ? d.frequency : 4,
      source:       'FMP'
    })).filter(d => d.amount > 0)
       .sort((a, b) => b.date.localeCompare(a.date));

    // Salva no cache
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
      source: 'FMP',
      total_fetched: dividends.length
    });

  } catch (err) {
    return res.json({
      dividends: [],
      error: err.message,
      symbol: symbol
    });
  }
}
