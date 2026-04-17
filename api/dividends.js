// api/dividends.js — Vercel Serverless Function
// Busca dividendos US via Yahoo Finance
// Retorna: date (ex-date), payment_date, amount, value, type
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

  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json'
  };

  // ── Busca histórico de dividendos (ex-dates) ──
  const chartUrls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${period1}&period2=${period2}&events=div`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${period1}&period2=${period2}&events=div`,
  ];

  let chartData = null;
  for (const url of chartUrls) {
    try {
      const r = await fetch(url, { headers: HEADERS });
      if (r.ok) { chartData = await r.json(); break; }
    } catch {}
  }

  // ── Busca quote para pegar próximo exDividendDate e dividendDate (pay date) ──
  let quoteData = null;
  try {
    const qUrl = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`;
    const qr = await fetch(qUrl, { headers: HEADERS });
    if (qr.ok) quoteData = await qr.json();
  } catch {}

  const quote = quoteData?.quoteResponse?.result?.[0] || {};

  // Ex-date do próximo dividendo (timestamp Unix)
  const nextExDate = quote.exDividendDate
    ? new Date(quote.exDividendDate * 1000).toISOString().split('T')[0]
    : null;

  // Pay date do próximo dividendo (timestamp Unix)  
  const nextPayDate = quote.dividendDate
    ? new Date(quote.dividendDate * 1000).toISOString().split('T')[0]
    : null;

  // ── Monta mapa de dividendos históricos (ex-date como chave) ──
  const events = chartData?.chart?.result?.[0]?.events?.dividends || {};
  const dividendMap = {};

  Object.values(events).forEach(ev => {
    const exDate = new Date(ev.date * 1000).toISOString().split('T')[0];
    if (exDate < fromDate) return;
    dividendMap[exDate] = {
      date:         exDate,
      amount:       ev.amount,
      payment_date: exDate, // será atualizado abaixo se tivermos pay date
      ex_date:      exDate,
      value:        ev.amount,
      type:         'Dividendo',
      source:       'Yahoo'
    };
  });

  // ── Adiciona/atualiza próximo dividendo declarado ──
  if (nextExDate) {
    const hoje = new Date().toISOString().split('T')[0];
    if (nextExDate >= hoje) {
      const valor = parseFloat(quote.dividendRate || 0);
      // Frequência estimada baseada no dividendRate e trailingAnnualDividendRate
      const trailing = parseFloat(quote.trailingAnnualDividendRate || 0);
      let freqEstimada = 4; // default trimestral
      if (trailing > 0 && valor > 0) {
        const ratio = trailing / valor;
        if (ratio <= 1.5) freqEstimada = 1;
        else if (ratio <= 2.5) freqEstimada = 2;
        else if (ratio <= 6) freqEstimada = 4;
        else freqEstimada = 12;
      }
      const valorProximo = trailing > 0 ? trailing / freqEstimada : valor;

      if (valorProximo > 0) {
        const jaExiste = dividendMap[nextExDate];
        if (!jaExiste) {
          dividendMap[nextExDate] = {
            date:         nextExDate,
            amount:       valorProximo,
            payment_date: nextPayDate || nextExDate,
            ex_date:      nextExDate,
            value:        valorProximo,
            type:         'Dividendo',
            source:       'Yahoo-Next'
          };
        } else {
          // Atualiza pay date se tivermos
          if (nextPayDate) jaExiste.payment_date = nextPayDate;
        }
      }
    }
  }

  const dividends = Object.values(dividendMap)
    .sort((a, b) => b.date.localeCompare(a.date));

  return res.json({ dividends });
}
