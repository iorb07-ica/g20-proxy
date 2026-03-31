// api/history-date.js — Vercel Serverless Function
// Busca o preço de fechamento de um ativo em uma data específica via Yahoo Finance
// Uso: /api/history-date?symbol=PETR4.SA&date=2021-02-03

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, date } = req.query;
  if (!symbol || !date) {
    return res.status(400).json({ error: 'symbol e date são obrigatórios' });
  }

  // Converte date (YYYY-MM-DD) para timestamps Unix
  const targetDate = new Date(date + 'T12:00:00Z');
  // Busca janela de ±7 dias ao redor da data (cobre fins de semana e feriados)
  const period1 = Math.floor((targetDate.getTime() - 7 * 86400000) / 1000);
  const period2 = Math.floor((targetDate.getTime() + 2 * 86400000) / 1000);

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${period1}&period2=${period2}`;

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    });
    const data = await response.json();

    const result = data?.chart?.result?.[0];
    if (!result) return res.json({ close: null, date: null, error: 'sem dados' });

    const timestamps = result.timestamp || [];
    const closes     = result.indicators?.quote?.[0]?.closes || result.indicators?.quote?.[0]?.close || [];

    // Encontra o pregão mais próximo ANTERIOR ou IGUAL à data alvo
    const targetTs = Math.floor(targetDate.getTime() / 1000);
    let bestIdx = -1;
    let bestTs  = -Infinity;

    timestamps.forEach((ts, i) => {
      if (ts <= targetTs + 86400 && ts > bestTs && closes[i] != null) {
        bestTs  = ts;
        bestIdx = i;
      }
    });

    if (bestIdx === -1) return res.json({ close: null, date: null, error: 'data fora do histórico' });

    const closePrice = closes[bestIdx];
    const closeDate  = new Date(timestamps[bestIdx] * 1000).toISOString().split('T')[0];

    return res.json({ close: closePrice, date: closeDate, symbol });

  } catch (err) {
    // Fallback: query2
    try {
      const url2 = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${period1}&period2=${period2}`;
      const r2   = await fetch(url2, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const d2   = await r2.json();
      const res2 = d2?.chart?.result?.[0];
      if (!res2) return res.json({ close: null, error: 'fallback sem dados' });

      const ts2  = res2.timestamp || [];
      const cl2  = res2.indicators?.quote?.[0]?.close || [];
      const targetTs = Math.floor(targetDate.getTime() / 1000);
      let bi = -1, bt = -Infinity;
      ts2.forEach((ts, i) => { if(ts <= targetTs+86400 && ts > bt && cl2[i]!=null){ bt=ts; bi=i; } });
      if(bi === -1) return res.json({ close: null, error: 'data fora do histórico' });
      return res.json({ close: cl2[bi], date: new Date(ts2[bi]*1000).toISOString().split('T')[0], symbol });
    } catch(e2) {
      return res.status(500).json({ error: e2.message });
    }
  }
}
