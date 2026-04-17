// api/dividends-yahoo.js — Vercel Serverless Function
// Busca dividendos históricos US via Yahoo Finance (endpoint público undocumented)
// Usado para preencher lacunas que o Polygon grátis (2 anos) não cobre
// Uso: /api/dividends-yahoo?symbol=AAPL&from=2017-01-01&to=2024-04-01

module.exports = async function handler(req, res) {
  // CORS liberado pra chamadas do browser
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { symbol, from, to } = req.query;

  if (!symbol) {
    return res.status(400).json({ error: 'symbol é obrigatório' });
  }

  try {
    // Converte datas em unix timestamp (segundos)
    const hoje = Math.floor(Date.now() / 1000);
    const umAnoEmSegundos = 365 * 24 * 60 * 60;

    // Default: últimos 30 anos até hoje
    const period1 = from
      ? Math.floor(new Date(from).getTime() / 1000)
      : hoje - (30 * umAnoEmSegundos);

    const period2 = to
      ? Math.floor(new Date(to).getTime() / 1000)
      : hoje;

    // Endpoint "undocumented" mas estável do Yahoo Finance
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
                `?period1=${period1}&period2=${period2}&interval=1d&events=div`;

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json,text/plain,*/*',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    if (!response.ok) {
      return res.status(response.status).json({
        error: `Yahoo Finance retornou ${response.status}`,
        dividends: []
      });
    }

    const data = await response.json();

    // Estrutura do Yahoo:
    // data.chart.result[0].events.dividends = { "1487635200": { amount: 0.57, date: 1487635200 }, ... }
    const result = data && data.chart && data.chart.result && data.chart.result[0];
    const dividendsObj = result && result.events && result.events.dividends;

    if (!dividendsObj) {
      return res.status(200).json({
        dividends: [],
        symbol: symbol,
        source: 'Yahoo',
        message: 'Nenhum dividendo encontrado no período'
      });
    }

    // Converte objeto do Yahoo em array normalizado
    const dividends = Object.values(dividendsObj).map(function(div) {
      const dataStr = new Date(div.date * 1000).toISOString().split('T')[0];
      const amount = parseFloat(div.amount) || 0;

      return {
        date: dataStr,
        ex_date: dataStr,
        payment_date: dataStr,
        record_date: dataStr,
        amount: amount,
        value: amount,
        type: 'Dividendo',
        frequency: 4,
        source: 'Yahoo'
      };
    });

    // Ordena por data crescente
    dividends.sort(function(a, b) {
      return a.date.localeCompare(b.date);
    });

    return res.status(200).json({
      dividends: dividends,
      symbol: symbol,
      source: 'Yahoo',
      count: dividends.length,
      period: {
        from: new Date(period1 * 1000).toISOString().split('T')[0],
        to: new Date(period2 * 1000).toISOString().split('T')[0]
      }
    });

  } catch (err) {
    console.error('[dividends-yahoo] Erro:', err);
    return res.status(500).json({
      error: err.message || 'Erro interno',
      dividends: []
    });
  }
};
