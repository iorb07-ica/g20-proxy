// api/history-br.js — Vercel Serverless Function
// Busca histórico diário de ativo BR no Yahoo Finance
// e retorna os refs de período já calculados
// Uso: /api/history-br?symbol=VULC3.SA

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol obrigatório' });

  const now  = Math.floor(Date.now() / 1000);
  const from = now - 6 * 365 * 86400; // 6 anos — cobre o ref5y com folga
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${from}&period2=${now}`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${from}&period2=${now}`,
  ];

  let data = null;
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
      if (r.ok) { data = await r.json(); break; }
    } catch {}
  }

  if (!data) return res.json({ error: 'sem dados' });

  const result = data?.chart?.result?.[0];
  if (!result) return res.json({ error: 'sem resultado' });

  const tss    = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];

  const hist = [];
  tss.forEach((ts, i) => {
    if (closes[i] == null) return;
    const d = new Date(ts * 1000);
    hist.push({ date: d.toISOString().split('T')[0], close: closes[i], dow: d.getDay() });
  });
  hist.sort((a, b) => a.date.localeCompare(b.date));
  if (hist.length < 5) return res.json({ error: 'histórico insuficiente' });

  function closest(targetDate) {
    const t = targetDate.toISOString().split('T')[0];
    const candidates = hist.filter(p => p.date <= t);
    return candidates.length ? candidates[candidates.length - 1] : null;
  }

  const now2  = new Date();
  const d30   = new Date(now2); d30.setDate(d30.getDate() - 30);
  const d3m   = new Date(now2); d3m.setMonth(d3m.getMonth() - 3);
  const d6m   = new Date(now2); d6m.setMonth(d6m.getMonth() - 6);
  const dYTD  = new Date(now2.getFullYear() - 1, 11, 31);
  const d5y   = new Date(now2); d5y.setFullYear(d5y.getFullYear() - 5);
  const lastFri = [...hist].reverse().find(p => p.dow === 5) || null;

  return res.json({
    symbol,
    refSemana: lastFri,
    ref30d:    closest(d30),
    ref3m:     closest(d3m),
    ref6m:     closest(d6m),
    refYTD:    closest(dYTD),
    ref5y:     closest(d5y),
  });
}
