// Vercel Serverless Function — /api/dividends
// Busca histórico completo de dividendos desde uma data
// Uso: GET /api/dividends?symbol=MSFT&from=2020-01-01
// BR:  GET /api/dividends?symbol=PETR4.SA&from=2020-01-01

const yahooFinance = require('yahoo-finance2').default;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=3600'); // cache 1h (dividendos mudam pouco)

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, from } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol obrigatório' });

  const startDate = from ? new Date(from) : new Date('2010-01-01');
  const endDate   = new Date();

  try {
    // yahoo-finance2: histórico com eventos de dividendos
    const result = await yahooFinance.chart(symbol, {
      period1:  startDate,
      period2:  endDate,
      interval: '1d',
      events:   'div'
    });

    const events    = result.events || {};
    const dividends = events.dividends ? Object.values(events.dividends) : [];

    // Normaliza formato
    const normalized = dividends.map(d => ({
      date:   new Date(d.date * 1000).toISOString().split('T')[0],
      amount: d.amount
    })).sort((a, b) => a.date.localeCompare(b.date));

    return res.json({
      symbol,
      from:      startDate.toISOString().split('T')[0],
      to:        endDate.toISOString().split('T')[0],
      count:     normalized.length,
      dividends: normalized
    });

  } catch (err) {
    return res.status(500).json({ error: err.message, symbol });
  }
};
