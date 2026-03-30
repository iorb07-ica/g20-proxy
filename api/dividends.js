// Proxy dividendos Yahoo Finance — sem dependências externas

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=3600');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, from } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol obrigatorio' });

  const startTs = from ? Math.floor(new Date(from).getTime()/1000) : 978307200;
  const endTs   = Math.floor(Date.now()/1000);

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1mo&period1=${startTs}&period2=${endTs}&events=div`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json'
      }
    });
    const d = await r.json();
    const rawDivs = d?.chart?.result?.[0]?.events?.dividends || {};
    
    const dividends = Object.values(rawDivs).map(dv => ({
      date:   new Date(dv.date * 1000).toISOString().split('T')[0],
      amount: dv.amount
    })).sort((a, b) => a.date.localeCompare(b.date));

    return res.json({ symbol, count: dividends.length, dividends });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
