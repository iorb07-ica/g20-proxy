// api/history-monthly.js — Vercel Serverless Function
// Busca histórico mensal de um ativo no Yahoo Finance
// Retorna objeto { "2024-01": 28.50, "2024-02": 31.20, ... }
// Uso: /api/history-monthly?symbol=PETR4.SA&from=2022-01
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, from } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol obrigatório' });

  // Define período: from = "YYYY-MM" ou usa 10 anos atrás como padrão
  const fromDate = from
    ? new Date(from + '-01')
    : new Date(new Date().setFullYear(new Date().getFullYear() - 10));

  const period1 = Math.floor(fromDate.getTime() / 1000);
  const period2 = Math.floor(Date.now() / 1000);

  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1mo&period1=${period1}&period2=${period2}`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1mo&period1=${period1}&period2=${period2}`,
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

  if (!data) return res.json({ symbol, prices: {} });

  const result = data?.chart?.result?.[0];
  if (!result) return res.json({ symbol, prices: {} });

  const timestamps = result.timestamp || [];
  const closes     = result.indicators?.quote?.[0]?.close || [];

  // Monta objeto { "YYYY-MM": preço }
  const prices = {};
  timestamps.forEach((ts, i) => {
    if (closes[i] == null || closes[i] <= 0) return;
    const d   = new Date(ts * 1000);
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    prices[key] = +closes[i].toFixed(4);
  });

  return res.json({ symbol, prices });
}
