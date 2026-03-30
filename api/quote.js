// Vercel Serverless Function — /api/quote
// Busca cotação atual de qualquer ticker (BR, US, ADRs)
// Uso: GET /api/quote?symbol=AAPL ou /api/quote?symbol=PETR4.SA

const yahooFinance = require('yahoo-finance2').default;

module.exports = async (req, res) => {
  // CORS — permite qualquer origem (GitHub Pages, localhost, etc.)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=300'); // cache 5 min na Vercel

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol obrigatório' });

  // Suporta múltiplos tickers: ?symbol=AAPL,MSFT,PETR4.SA
  const symbols = symbol.split(',').map(s => s.trim());

  try {
    const results = {};

    await Promise.all(symbols.map(async (sym) => {
      try {
        const q = await yahooFinance.quote(sym);
        results[sym] = {
          symbol:        q.symbol,
          name:          q.longName || q.shortName || sym,
          price:         q.regularMarketPrice,
          change:        q.regularMarketChange,
          changePercent: q.regularMarketChangePercent,
          prevClose:     q.regularMarketPreviousClose,
          currency:      q.currency,
          exchange:      q.exchange,
          marketState:   q.marketState,
          timestamp:     Date.now()
        };
      } catch (e) {
        results[sym] = { error: e.message };
      }
    }));

    // Se só 1 ticker, retorna objeto direto (compatibilidade)
    if (symbols.length === 1) return res.json(results[symbols[0]]);
    return res.json(results);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
