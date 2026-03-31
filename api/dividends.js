// api/dividends.js — Vercel Serverless Function
// Proxy para dividendos BR do DadosMercado (evita CORS e 401)
// Uso: /api/dividends?ticker=LREN3

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: 'ticker obrigatório' });

  const url = `https://api.dadosdemercado.com.br/v1/companies/${ticker.toUpperCase()}/dividends`;
  try {
    const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) return res.status(r.status).json({ error: 'HTTP ' + r.status });
    const data = await r.json();
    return res.json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
