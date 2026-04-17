// api/dividends-yahoo.js — Vercel Serverless Function
// Busca dividendos historicos US via Yahoo Finance (endpoint publico)
// Uso: /api/dividends-yahoo?symbol=AAPL&from=2017-01-01&to=2024-04-01

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, from, to } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol obrigatorio' });

  try {
    const hoje = Math.floor(Date.now() / 1000);
    const umAno = 365 * 86400;

    const period1 = from
      ? Math.floor(new Date(from).getTime() / 1000)
      : hoje - (30 * umAno);

    const period2 = to
      ? Math.floor(new Date(to).getTime() / 1000)
      : hoje;

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d&events=div`;

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json,text/plain,*/*'
      }
    });

    if (!response.ok) {
      return res.json({ dividends: [], error: 'Yahoo HTTP ' + response.status });
    }

    const data = await response.json();
    const result = data && data.chart && data.chart.result && data.chart.result[0];
    const dividendsObj = result && result.events && result.events.dividends;

    if (!dividendsObj) {
      return res.json({ dividends: [], symbol: symbol, source: 'Yahoo' });
    }

    const dividends = Object.values(dividendsObj).map(div => {
      const dataStr = new Date(div.date * 1000).toISOString().split('T')[0];
      const amount = parseFloat(div.amount) || 0;
      return {
        date: dataStr,
        amount: amount,
        payment_date: dataStr,
        ex_date: dataStr,
        record_date: dataStr,
        declare_date: null,
        value: amount,
        type: 'Dividendo',
        frequency: 4,
        source: 'Yahoo'
      };
    }).sort((a, b) => b.date.localeCompare(a.date));

    return res.json({ dividends: dividends, symbol: symbol, source: 'Yahoo' });

  } catch (err) {
    return res.json({ dividends: [], error: err.message });
  }
}
