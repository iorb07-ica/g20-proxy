// Proxy splits/inplits Yahoo Finance — sem dependências externas
// Retorna histórico completo de splits desde uma data

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=86400'); // cache 24h
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, from } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol obrigatorio' });

  const startTs = from ? Math.floor(new Date(from).getTime()/1000) : 978307200; // 2001
  const endTs   = Math.floor(Date.now()/1000);

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1mo&period1=${startTs}&period2=${endTs}&events=splits`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json'
      }
    });
    const d = await r.json();
    const rawSplits = d?.chart?.result?.[0]?.events?.splits || {};

    const splits = Object.values(rawSplits).map(s => ({
      date:        new Date(s.date * 1000).toISOString().split('T')[0],
      numerator:   s.numerator,   // novo número de ações
      denominator: s.denominator, // número antigo de ações
      ratio:       s.numerator / s.denominator // ex: 10 = split 10:1; 0.1 = inplit 1:10
    })).sort((a, b) => a.date.localeCompare(b.date));

    return res.json({ symbol, count: splits.length, splits });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
