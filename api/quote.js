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

  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function fetchQuote(sym, attempt = 0) {
    const urls = [
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`,
      `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`,
      // fallback: v7 quoteSummary
      `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(sym)}`,
      `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(sym)}`,
    ];

    for (let i = 0; i < urls.length; i++) {
      try {
        const r = await fetch(urls[i], { headers: HEADERS });
        if (!r.ok) {
          // Se 429 (rate limit), aguarda e tenta de novo
          if (r.status === 429 && attempt < 2) {
            await sleep(500 * (attempt + 1));
            return fetchQuote(sym, attempt + 1);
          }
          continue;
        }
        const data = await r.json();

        // Tenta v8/chart
        const meta = data?.chart?.result?.[0]?.meta;
        if (meta?.regularMarketPrice) {
          const prev = meta.chartPreviousClose || meta.previousClose || meta.regularMarketPrice;
          return {
            symbol:                     meta.symbol || sym,
            name:                       meta.longName || meta.shortName || sym,
            price:                      meta.regularMarketPrice,
            change:                     meta.regularMarketPrice - prev,
            changePercent:              prev ? ((meta.regularMarketPrice - prev) / prev * 100) : 0,
            prevClose:                  prev,
            currency:                   meta.currency || 'USD',
            dividendRate:               meta.dividendRate || null,
            dividendDate:               meta.dividendDate || null,
            exDividendDate:             meta.exDividendDate || null,
            trailingAnnualDividendRate: meta.trailingAnnualDividendRate || null,
            timestamp:                  Date.now(),
          };
        }

        // Tenta v7/quote
        const q = data?.quoteResponse?.result?.[0];
        if (q?.regularMarketPrice) {
          const prev = q.regularMarketPreviousClose || q.regularMarketPrice;
          return {
            symbol:                     q.symbol || sym,
            name:                       q.longName || q.shortName || sym,
            price:                      q.regularMarketPrice,
            change:                     q.regularMarketChange || (q.regularMarketPrice - prev),
            changePercent:              q.regularMarketChangePercent || 0,
            prevClose:                  prev,
            currency:                   q.currency || 'USD',
            dividendRate:               q.dividendRate || null,
            dividendDate:               q.dividendDate || null,
            exDividendDate:             q.exDividendDate || null,
            trailingAnnualDividendRate: q.trailingAnnualDividendRate || null,
            timestamp:                  Date.now(),
          };
        }
      } catch {}
    }

    // Último recurso: retry com delay
    if (attempt < 2) {
      await sleep(300 * (attempt + 1));
      return fetchQuote(sym, attempt + 1);
    }

    return null;
  }

  if (symbols.length === 1) {
    const q = await fetchQuote(symbols[0]);
    if (!q) return res.status(404).json({ error: 'não encontrado', symbol: symbols[0] });
    return res.json(q);
  }

  // Múltiplos símbolos — processa em paralelo com fallback individual
  const results = {};
  await Promise.all(symbols.map(async sym => {
    const q = await fetchQuote(sym);
    if (q) results[sym] = q;
  }));
  return res.json(results);
}
