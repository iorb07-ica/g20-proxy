// api/quote.js — Vercel Serverless Function
// Busca cotação de um ativo via Yahoo Finance
// Retorna também campos de dividendo para detectar próximo pagamento
// Uso: /api/quote?symbol=PETR4.SA ou /api/quote?symbol=AAPL,MSFT

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol obrigatório' });

  const symbols = symbol.split(',').map(s => s.trim()).filter(Boolean);

  async function fetchQuote(sym) {
    const urls = [
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`,
      `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`,
    ];
    for (const url of urls) {
      try {
        const r = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
        });
        if (!r.ok) continue;
        const data = await r.json();
        const meta = data?.chart?.result?.[0]?.meta;
        if (!meta || !meta.regularMarketPrice) continue;
        const prev = meta.chartPreviousClose || meta.previousClose || meta.regularMarketPrice;
        return {
          symbol:                       meta.symbol || sym,
          name:                         meta.longName || meta.shortName || sym,
          price:                        meta.regularMarketPrice,
          change:                       meta.regularMarketPrice - prev,
          changePercent:                prev ? ((meta.regularMarketPrice - prev) / prev * 100) : 0,
          prevClose:                    prev,
          currency:                     meta.currency || 'USD',
          // Campos de dividendo
          dividendRate:                 meta.dividendRate || null,
          dividendDate:                 meta.dividendDate || null,
          exDividendDate:               meta.exDividendDate || null,
          trailingAnnualDividendRate:   meta.trailingAnnualDividendRate || null,
          timestamp:                    Date.now(),
        };
      } catch {}
    }
    return null;
  }

  if (symbols.length === 1) {
    const q = await fetchQuote(symbols[0]);
    if (!q) return res.status(404).json({ error: 'não encontrado' });
    return res.json(q);
  }

  // Múltiplos símbolos
  const results = {};
  await Promise.all(symbols.map(async sym => {
    const q = await fetchQuote(sym);
    if (q) results[sym] = q;
  }));
  return res.json(results);
}
