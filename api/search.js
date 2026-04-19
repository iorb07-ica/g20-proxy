// Proxy busca de ativos — Yahoo Finance search
// GET /api/search?q=apple ou /api/search?q=PETR
// Cache Redis (Upstash) TTL 30 dias (autocomplete de tickers = quase estatico)

const CACHE_TTL = 2592000; // 30 dias

// ──────────────────────────────────────
// Helpers Redis (Upstash REST API)
// ──────────────────────────────────────
async function redisGet(key) {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const d = await r.json();
    if (!d || d.result == null) return null;
    return JSON.parse(d.result);
  } catch { return null; }
}

async function redisSet(key, value) {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return false;
  try {
    await fetch(`${url}/set/${encodeURIComponent(key)}?EX=${CACHE_TTL}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(value)
    });
    return true;
  } catch { return false; }
}

function detectTipo(q) {
  const sym = q.symbol || '';
  const type = (q.quoteType || '').toUpperCase();
  const exch = (q.exchange || '').toUpperCase();

  if (type === 'CRYPTOCURRENCY') return 'Cripto';
  if (type === 'ETF') return 'ETF';
  if (type === 'MUTUALFUND') return 'ETF';

  // B3: termina em numero
  if (/\d$/.test(sym) && (exch.includes('SAO') || exch === 'BZ')) {
    if (sym.endsWith('11')) return 'FII';
    return 'Acao';
  }

  // REIT
  const reits = ['O','SPG','VNQ','NNN','STAG','WPC','VICI','AMT','PLD','PSA','EXR','AVB','EQR'];
  if (reits.includes(sym)) return 'REIT';

  // Stock US padrao
  if (type === 'EQUITY') return 'Stock';

  return 'Stock';
}

// ──────────────────────────────────────
// Handler principal
// ──────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'X-Cache-Status, X-Cache-Count');
  res.setHeader('Cache-Control', 's-maxage=3600');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { q } = req.query;
  if (!q || q.length < 1) return res.json({ results: [] });

  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  // Normaliza a query pra chave (case-insensitive)
  const cacheKey = `search:${q.toLowerCase().trim()}`;

  // Tenta cache primeiro
  const cached = await redisGet(cacheKey);
  if (cached) {
    res.setHeader('X-Cache-Status', 'HIT');
    return res.json(cached);
  }

  try {
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0&listsCount=0`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json'
      }
    });
    const d = await r.json();
    const quotes = d?.quotes || [];

    const results = quotes
      .filter(q => q.symbol && q.quoteType !== 'OPTION' && q.quoteType !== 'FUTURE')
      .slice(0, 8)
      .map(q => ({
        symbol:   q.symbol,
        name:     q.longname || q.shortname || q.symbol,
        exchange: q.exchange || '',
        type:     q.quoteType || '',
        g20tipo: detectTipo(q)
      }));

    const payload = { results };

    // Salva no cache
    await redisSet(cacheKey, payload);
    res.setHeader('X-Cache-Status', redisUrl ? 'MISS' : 'DISABLED');
    return res.json(payload);
  } catch (err) {
    return res.status(500).json({ error: err.message, results: [] });
  }
};
