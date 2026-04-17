// /api/dividends-yahoo.js
// Endpoint que busca dividendos históricos no Yahoo Finance
//
// Uso:
//   /api/dividends-yahoo?symbol=AAPL&from=2017-01-01&to=2024-04-01
//
// Retorno (mesmo formato do /api/dividends do Polygon):
// {
//   "dividends": [
//     {
//       "date": "2017-02-09",        // ex-date (Yahoo só tem esta)
//       "ex_date": "2017-02-09",
//       "payment_date": "2017-02-09", // Yahoo não tem payment_date separado
//       "amount": 0.57,
//       "value": 0.57,
//       "type": "Dividendo",
//       "source": "Yahoo"
//     },
//     ...
//   ]
// }

export default async function handler(req, res) {
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

    // Default: últimos 30 anos até hoje (mais que suficiente)
    const period1 = from
      ? Math.floor(new Date(from).getTime() / 1000)
      : hoje - (30 * umAnoEmSegundos);

    const period2 = to
      ? Math.floor(new Date(to).getTime() / 1000)
      : hoje;

    // Endpoint "undocumented" mas estável do Yahoo Finance
    // events=div pede só eventos de dividendo
    // interval=1d retorna dados diários (precisa estar presente, embora não usemos os preços)
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
                `?period1=${period1}&period2=${period2}&interval=1d&events=div`;

    const response = await fetch(url, {
      headers: {
        // User-Agent real pra evitar bloqueio
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
    const result = data?.chart?.result?.[0];
    const dividendsObj = result?.events?.dividends;

    if (!dividendsObj) {
      // Sem dividendos no período — não é erro, apenas vazio
      return res.status(200).json({
        dividends: [],
        symbol: symbol,
        source: 'Yahoo',
        message: 'Nenhum dividendo encontrado no período'
      });
    }

    // Converte objeto do Yahoo em array normalizado
    const dividends = Object.values(dividendsObj).map(div => {
      const dataStr = new Date(div.date * 1000).toISOString().split('T')[0];
      const amount = parseFloat(div.amount) || 0;

      return {
        date: dataStr,
        ex_date: dataStr,
        payment_date: dataStr, // Yahoo não separa, usa a mesma data
        record_date: dataStr,
        amount: amount,
        value: amount,
        type: 'Dividendo',
        frequency: 4, // Yahoo não diz, assume trimestral (maioria US)
        source: 'Yahoo'
      };
    });

    // Ordena por data crescente
    dividends.sort((a, b) => a.date.localeCompare(b.date));

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
}
