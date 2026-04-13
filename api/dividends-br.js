// api/dividends-br.js — Vercel Serverless Function
// Busca dividendos históricos E futuros de ativos BR via Yahoo Finance
// Uso: /api/dividends-br?symbol=LREN3.SA&from=2020-01-01

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, from } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol obrigatório' });

  // Converte from (YYYY-MM-DD ou timestamp Unix) para Unix timestamp
  let period1;
  if (from) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      period1 = Math.floor(new Date(from).getTime() / 1000);
    } else {
      period1 = parseInt(from);
    }
  } else {
    period1 = Math.floor((Date.now() - 10 * 365 * 86400000) / 1000);
  }

  // Estende period2 para 1 ano no futuro para pegar dividendos declarados
  const period2 = Math.floor((Date.now() + 365 * 86400000) / 1000);

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

  dividends.sort((a, b) => b.payment_date.localeCompare(a.payment_date));
  return res.json(dividends);
}
