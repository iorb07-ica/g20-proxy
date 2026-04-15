// api/history.js — Vercel Serverless Function
// Busca histórico diário de ativos US no Yahoo Finance
// Suporta múltiplos tickers separados por vírgula
// Uso: /api/history?symbol=AAPL,MSFT,NVDA

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol obrigatório' });

  const tickers = symbol.split(',').map(s => s.trim()).filter(Boolean);
  const now  = Math.floor(Date.now() / 1000);
  const from = now - 6 * 365 * 86400;

  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function closest(hist, targetDate) {
    const t = targetDate.toISOString().split('T')[0];
    const candidates = hist.filter(p => p.date <= t);
    return candidates.length ? candidates[candidates.length - 1] : null;
  }

  function computeRefs(hist) {
    const now2 = new Date();
    const d30  = new Date(now2); d30.setDate(d30.getDate() - 30);
    const d3m  = new Date(now2); d3m.setMonth(d3m.getMonth() - 3);
    const d6m  = new Date(now2); d6m.setMonth(d6m.getMonth() - 6);
    const dYTD = new Date(now2.getFullYear() - 1, 11, 31);
    const d5y  = new Date(now2); d5y.setFullYear(d5y.getFullYear() - 5);
    const lastFri = [...hist].reverse().find(p => p.dow === 5) || null;
    return {
      refSemana: lastFri,
      ref30d:    closest(hist, d30),
      ref3m:     closest(hist, d3m),
      ref6m:     closest(hist, d6m),
      refYTD:    closest(hist, dYTD),
      ref5y:     closest(hist, d5y),
    };
  }

  async function fetchHist(ticker, attempt = 0) {
    const urls = [
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&period1=${from}&period2=${now}`,
      `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&period1=${from}&period2=${now}`,
    ];
    for (const url of urls) {
      try {
        const r = await fetch(url, { headers: HEADERS });
        if (!r.ok) {
          if (r.status === 429 && attempt < 2) {
            await sleep(500 * (attempt + 1));
            return fetchHist(ticker, attempt + 1);
          }
          continue;
        }
        const data = await r.json();
        const result = data?.chart?.result?.[0];
        if (!result) continue;
        const tss    = result.timestamp || [];
        const closes = result.indicators?.quote?.[0]?.close || [];
        const hist   = [];
        tss.forEach((ts, i) => {
          if (closes[i] == null) return;
          const d = new Date(ts * 1000);
          hist.push({ date: d.toISOString().split('T')[0], close: closes[i], dow: d.getDay() });
        });
        hist.sort((a, b) => a.date.localeCompare(b.date));
        if (hist.length >= 5) return computeRefs(hist);
      } catch {}
    }
    if (attempt < 2) {
      await sleep(300 * (attempt + 1));
      return fetchHist(ticker, attempt + 1);
    }
    return null;
  }

  if (tickers.length === 1) {
    const refs = await fetchHist(tickers[0]);
    if (!refs) return res.json({ error: 'sem dados', symbol: tickers[0] });
    return res.json({ symbol: tickers[0], ...refs });
  }

  const results = {};
  await Promise.all(tickers.map(async ticker => {
    const refs = await fetchHist(ticker);
    if (refs) results[ticker] = refs;
  }));

  return res.json(results);
}
