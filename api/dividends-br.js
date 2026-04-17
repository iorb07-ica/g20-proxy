// api/dividends-br.js — Vercel Serverless Function
// Busca dividendos BR via Brapi (primária) com fallback Yahoo Finance
// Retorna: payment_date, ex_date (data-com), value, type
// Uso: /api/dividends-br?symbol=LREN3.SA&from=2020-01-01

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, from, token } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol obrigatório' });

  // Ticker sem .SA para Brapi
  const ticker = symbol.replace(/\.SA$/i, '').toUpperCase();
  const tickerSA = ticker + '.SA';

  // Data de corte
  const fromDate = from
    ? (/^\d{4}-\d{2}-\d{2}$/.test(from) ? from : new Date(parseInt(from) * 1000).toISOString().split('T')[0])
    : new Date(Date.now() - 10 * 365 * 86400000).toISOString().split('T')[0];

  // ── 1ª TENTATIVA: Brapi (retorna data-com e data pagamento separados) ──
  if (token) {
    try {
      const brapiUrl = `https://brapi.dev/api/quote/${ticker}?dividends=true&token=${token}`;
      const r = await fetch(brapiUrl, { headers: { 'Accept': 'application/json' } });
      if (r.ok) {
        const data = await r.json();
        const res0 = data?.results?.[0];
        const cashDivs = res0?.dividendsData?.cashDividends || [];

        if (cashDivs.length > 0) {
          const dividends = cashDivs
            .map(d => {
              // Brapi: paymentDate = data efetiva de pagamento
              //        approvedOn   = data-com (quando aprovado = data-com na B3)
              //        lastDatePrior = data-com direta (quando disponível)
              const payDate  = (d.paymentDate  || '').substring(0, 10);
              const exDate   = (d.lastDatePrior || d.approvedOn || d.paymentDate || '').substring(0, 10);
              const valor    = parseFloat(d.rate || 0);
              const tipo     = d.label || d.type || 'Dividendo';

              if (!payDate || !valor) return null;
              if (payDate < fromDate) return null;

              return {
                payment_date: payDate,
                ex_date:      exDate || payDate,
                value:        valor,
                type:         tipo,
                source:       'Brapi'
              };
            })
            .filter(Boolean)
            .sort((a, b) => b.payment_date.localeCompare(a.payment_date));

          if (dividends.length > 0) return res.json(dividends);
        }
      }
    } catch {}
  }

  // ── 2ª TENTATIVA: Yahoo Finance via chart API ──
  const period1 = Math.floor(new Date(fromDate).getTime() / 1000);
  const period2 = Math.floor((Date.now() + 365 * 86400000) / 1000);

  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(tickerSA)}?interval=1d&period1=${period1}&period2=${period2}&events=div`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(tickerSA)}?interval=1d&period1=${period1}&period2=${period2}&events=div`,
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
  const dividends = Object.values(events)
    .map(ev => {
      const date = new Date(ev.date * 1000).toISOString().split('T')[0];
      if (date < fromDate) return null;
      return {
        payment_date: date,
        ex_date:      date, // Yahoo não separa ex-date de pay-date para BR
        value:        ev.amount,
        type:         'Dividendo',
        source:       'Yahoo'
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.payment_date.localeCompare(a.payment_date));

  return res.json(dividends);
}
