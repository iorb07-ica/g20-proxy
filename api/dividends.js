const yahooFinance = require('yahoo-finance2').default;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=3600');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, from } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol obrigatorio' });

  const startDate = from ? new Date(from) : new Date('2010-01-01');
  const endDate   = new Date();

  try {
    const result = await yahooFinance.chart(symbol, {
      period1:  startDate,
      period2:  endDate,
      interval: '1mo',
      events:   'div'
    }, { validateResult: false });

    const divs = result?.events?.dividends
      ? Object.values(result.events.dividends)
      : [];

    const normalized = divs.map(d => ({
      date:   new Date(d.date * 1000).toISOString().split('T')[0],
      amount: d.amount
    })).sort((a, b) => a.date.localeCompare(b.date));

    return res.json({
      symbol,
      count:     normalized.length,
      dividends: normalized
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
