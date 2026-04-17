// api/dividends.js — Vercel Serverless Function
// Busca dividendos US via Yahoo Finance + Finnhub (ex-date e payDate corretos)
// Uso: /api/dividends?symbol=AAPL&from=2023-01-01

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, from } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol obrigatório' });

  const fromDate = from
    ? (/^\d{4}-\d{2}-\d{2}$/.test(from) ? from : new Date(parseInt(from) * 1000).toISOString().split('T')[0])
    : new Date(Date.now() - 10 * 365 * 86400000).toISOString().split('T')[0];

  const period1 = Math.floor(new Date(fromDate).getTime() / 1000);
  const period2 = Math.floor((Date.now() + 365 * 86400000) / 1000);

  // ── Yahoo Finance: histórico de dividendos ──
  const yahooUrls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${period1}&period2=${period2}&events=div`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${period1}&period2=${period2}&events=div`,
  ];

  let yahooData = null;
  for (const url of yahooUrls) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
      });
      if (r.ok) { yahooData = await r.json(); break; }
    } catch {}
  }

  const yahooEvents = yahooData?.chart?.result?.[0]?.events?.dividends || {};

  // Mapa de dividendos Yahoo: key = data aproximada
  const dividendMap = {};
  Object.values(yahooEvents).forEach(ev => {
    const date = new Date(ev.date * 1000).toISOString().split('T')[0];
    if (date >= fromDate) {
      dividendMap[date] = {
        date:         date,
        amount:       ev.amount,
        payment_date: date, // será atualizado pelo Finnhub se disponível
        ex_date:      date,
        value:        ev.amount,
        type:         'Dividendo',
        source:       'Yahoo'
      };
    }
  });

  // ── Finnhub: ex-date e payDate corretos ──
  const finnhubToken = process.env.FINNHUB_API_KEY;
  if (finnhubToken) {
    try {
      const finnhubUrl = `https://finnhub.io/api/v1/stock/dividend2?symbol=${encodeURIComponent(symbol)}&token=${finnhubToken}`;
      const fr = await fetch(finnhubUrl, { headers: { 'Accept': 'application/json' } });
      if (fr.ok) {
        const fd = await fr.json();
        const finnhubDivs = fd?.data || fd || [];
        if (Array.isArray(finnhubDivs)) {
          finnhubDivs.forEach(d => {
            const exDate  = (d.exDate  || d.ex_date  || '').substring(0, 10);
            const payDate = (d.payDate || d.pay_date || d.paymentDate || exDate).substring(0, 10);
            const amount  = parseFloat(d.amount || d.value || 0);

            if (!exDate || !amount) return;
            if (exDate < fromDate) return;

            // Tenta casar com Yahoo pelo valor próximo
            const yahooDivMatch = Object.values(dividendMap).find(y =>
              Math.abs(parseFloat(y.amount) - amount) < 0.001 &&
              Math.abs(new Date(y.date) - new Date(exDate)) < 5 * 86400000
            );

            if (yahooDivMatch) {
              // Atualiza com datas corretas do Finnhub
              yahooDivMatch.ex_date      = exDate;
              yahooDivMatch.payment_date = payDate;
              yahooDivMatch.date         = exDate;
              yahooDivMatch.source       = 'Finnhub';
            } else {
              // Dividendo só no Finnhub (futuro declarado)
              dividendMap[exDate] = {
                date:         exDate,
                amount:       amount,
                payment_date: payDate,
                ex_date:      exDate,
                value:        amount,
                type:         'Dividendo',
                source:       'Finnhub'
              };
            }
          });
        }
      }
    } catch {}
  }

  const dividends = Object.values(dividendMap)
    .sort((a, b) => b.date.localeCompare(a.date));

  return res.json({ dividends });
}
