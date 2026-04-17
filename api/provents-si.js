// api/provents-si.js — Proxy para StatusInvest proventos
// Uso: /api/provents-si?ticker=VALE3&type=acao
// type: acao | fii

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { ticker, type } = req.query;
  if (!ticker) return res.status(400).json({ error: 'ticker obrigatório' });

  const tipoUrl = type === 'fii' ? 'fii' : 'acao';
  const url = `https://statusinvest.com.br/${tipoUrl}/companytickerprovents?ticker=${encodeURIComponent(ticker)}&chartProventsType=2`;

  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://statusinvest.com.br/'
      }
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();

    const items = (data.assetEarningsModels || []).map(d => {
      const ed = d.ed ? d.ed.split('/').reverse().join('-') : '';
      const pd = d.pd ? d.pd.split('/').reverse().join('-') : '';
      return {
        ex_date: ed,
        payment_date: pd,
        value: d.v || 0,
        type: d.etd || d.et || 'Dividendo'
      };
    });

    return res.status(200).json(items);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
