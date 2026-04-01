// api/dividends-br.js — Vercel Serverless Function
// Busca dividendos históricos de ativos BR via Yahoo Finance chart events
// Uso: /api/dividends-br?symbol=LREN3.SA&from=1609459200

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, from } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol obrigatório' });

  const period1 = from || Math.floor((Date.now() - 10 * 365 * 86400000) / 1000);
  const period2 = Math.floor(Date.now() / 1000);

  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${period1}&period2=${period2}&events=div`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${period1}&period2=${period2}&events=div`,
  ];

  let data = null;
  for (const url of urls) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
      });
      if (r.ok) { data = await r.json(); break; }
    } catch {}
  }

  if (!data) return res.json([]);

  const result = data?.chart?.result?.[0];
  if (!result) return res.json([]);

  // Yahoo retorna dividendos em result.events.dividends
  const events = result?.events?.dividends || {};
  const dividends = [];

  Object.values(events).forEach(ev => {
    const date = new Date(ev.date * 1000).toISOString().split('T')[0];
    dividends.push({
      payment_date: date,
      ex_date: date,
      value: ev.amount,
      type: 'Dividendo'
    });
  });

  // Ordena por data decrescente
  dividends.sort((a, b) => b.payment_date.localeCompare(a.payment_date));

  return res.json(dividends);
}
