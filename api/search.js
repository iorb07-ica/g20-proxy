// Proxy busca de ativos — Yahoo Finance search
// GET /api/search?q=apple ou /api/search?q=PETR

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=3600');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { q } = req.query;
  if (!q || q.length < 1) return res.json({ results: [] });

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
        // Detecta tipo G20
        g20tipo: detectTipo(q)
      }));

    return res.json({ results });
  } catch (err) {
    return res.status(500).json({ error: err.message, results: [] });
  }
};

function detectTipo(q) {
  const sym = q.symbol || '';
  const type = (q.quoteType || '').toUpperCase();
  const exch = (q.exchange || '').toUpperCase();

  if (type === 'CRYPTOCURRENCY') return 'Cripto';
  if (type === 'ETF') return 'ETF';
  if (type === 'MUTUALFUND') return 'ETF';

  // B3: termina em número
  if (/\d$/.test(sym) && (exch.includes('SAO') || exch === 'BZ')) {
    if (sym.endsWith('11')) return 'FII';
    return 'Acao';
  }

  // REIT
  const reits = ['O','SPG','VNQ','NNN','STAG','WPC','VICI','AMT','PLD','PSA','EXR','AVB','EQR'];
  if (reits.includes(sym)) return 'REIT';

  // Stock US padrão
  if (type === 'EQUITY') return 'Stock';

  return 'Stock';
}
