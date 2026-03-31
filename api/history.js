// Proxy para Yahoo Finance — histórico para cálculo de variações
// GET /api/history?symbol=AAPL,MSFT,NVDA,PETR4.SA
// Retorna preços de fechamento para: 1W, 1M, 3M, 6M, YTD, 5Y
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=3600'); // cache 1h
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol obrigatorio' });

  const symbols = symbol.split(',').map(s => s.trim());
  const results = {};

  await Promise.all(symbols.map(async (sym) => {
    try {
      // Pede 5 anos de histórico diário — cobre todos os períodos (1W, 1M, 3M, 6M, YTD, 5Y)
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=5y`;
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json'
        }
      });
      const d = await r.json();
      const result = d?.chart?.result?.[0];
      if (!result) throw new Error('sem dados');

      const timestamps = result.timestamp || [];
      const closes = result.indicators?.quote?.[0]?.close || [];

      // Monta array de pontos {date, close, dow}
      const points = timestamps.map((ts, i) => ({
        date: new Date(ts * 1000).toISOString().split('T')[0],
        close: closes[i],
        dow: new Date(ts * 1000).getDay()
      })).filter(p => p.close != null).sort((a, b) => a.date.localeCompare(b.date));

      const today = new Date();

      // Ponto mais próximo ANTES de uma data alvo
      function closestBefore(targetDate) {
        const target = targetDate.toISOString().split('T')[0];
        const before = points.filter(p => p.date <= target);
        return before[before.length - 1] || null;
      }

      // 1W — última sexta-feira disponível
      const lastFriday = [...points].reverse().find(p => p.dow === 5) || null;

      // 1M — 30 dias corridos atrás
      const d30 = new Date(today); d30.setDate(d30.getDate() - 30);

      // 3M — exatamente 3 meses atrás
      const d3m = new Date(today); d3m.setMonth(d3m.getMonth() - 3);

      // 6M — exatamente 6 meses atrás
      const d6m = new Date(today); d6m.setMonth(d6m.getMonth() - 6);

      // YTD — último dia útil de dezembro do ano anterior
      const dYTD = new Date(today.getFullYear() - 1, 11, 31);

      // 5Y — exatamente 5 anos atrás
      const d5y = new Date(today); d5y.setFullYear(d5y.getFullYear() - 5);

      results[sym] = {
        symbol:      sym,
        refSemana:   lastFriday,
        ref30d:      closestBefore(d30),
        ref3m:       closestBefore(d3m),
        ref6m:       closestBefore(d6m),
        refYTD:      closestBefore(dYTD),
        ref5y:       closestBefore(d5y),
        totalPoints: points.length
      };

    } catch (e) {
      results[sym] = { symbol: sym, error: e.message };
    }
  }));

  if (symbols.length === 1) return res.json(results[symbols[0]]);
  return res.json(results);
};
