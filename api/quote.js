const yahooFinance = require('yahoo-finance2').default;

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
      const q = await yahooFinance.quote(sym, {}, { validateResult: false });
      results[sym] = {
        symbol:        q.symbol,
        name:          q.longName || q.shortName || sym,
        price:         q.regularMarketPrice,
        change:        q.regularMarketChange,
        changePercent: q.regularMarketChangePercent,
        prevClose:     q.regularMarketPreviousClose,
        currency:      q.currency,
        timestamp:     Date.now()
      };
    } catch (e) {
      results[sym] = { error: e.message };
    }
  }));

  if (symbols.length === 1) return res.json(results[symbols[0]]);
  return res.json(results);
};
