// api/bonuses.js — Vercel Serverless Function
// Proxy para o endpoint de bonificações do DadosMercado
// Uso: /api/bonuses?ticker=PETR4
// Necessário apenas se o CORS do DadosMercado bloquear chamadas diretas do browser.
// Teste primeiro a chamada direta — se funcionar, este arquivo não é necessário.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: 'ticker obrigatório' });

  const url = `https://api.dadosdemercado.com.br/v1/companies/${ticker.toUpperCase()}/bonuses`;

  try {
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' }
    });
    if (!response.ok) return res.status(response.status).json({ error: 'HTTP '+response.status });
    const data = await response.json();
    return res.json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
