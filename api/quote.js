// Proxy para Yahoo Finance — sem dependências externas
// Usa fetch nativo do Node 18+

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=300');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol obrigatorio' });

  const symbols = symbol.split(',').map(s => s.trim());
  const results = {};

  await Promise.all(symbols.map(async (sym) => {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`;
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json'
        }
      });
      const d = await r.json();
      const meta = d?.chart?.result?.[0]?.meta || {};
      const price = meta.regularMarketPrice || 0;
      const prev  = meta.chartPreviousClose || meta.previousClose || price;

      results[sym] = {
        symbol:        meta.symbol || sym,
        name:          meta.longName || meta.shortName || sym,
        price:         price,
        change:        price - prev,
        changePercent: prev ? ((price - prev) / prev * 100) : 0,
        prevClose:     prev,
        currency:      meta.currency || 'USD',
        timestamp:     Date.now()
      };
    } catch (e) {
      results[sym] = { error: e.message };
    }
  }));

  if (symbols.length === 1) return res.json(results[symbols[0]]);
  return res.json(results);
};
