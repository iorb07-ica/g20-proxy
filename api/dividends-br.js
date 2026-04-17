// api/dividends-br.js — Vercel Serverless Function
// Busca dividendos BR via B3 direto (gratuito, oficial)
// Fallback: sem Yahoo — B3 é a fonte definitiva
// Uso: /api/dividends-br?symbol=HGLG11.SA&from=2020-01-01

const CACHE_TTL = 86400; // 24 horas

async function redisGet(url, token, key) {
  try {
    const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const d = await r.json();
    return d.result ? JSON.parse(d.result) : null;
  } catch { return null; }
}

async function redisSet(url, token, key, value) {
  try {
    await fetch(`${url}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: JSON.stringify(value), ex: CACHE_TTL })
    });
  } catch {}
}

function isFII(ticker) {
  return ticker.endsWith('11') || ticker.endsWith('12');
}

function toISO(dateBR) {
  if (!dateBR) return null;
  const [d, m, y] = dateBR.split('/');
  if (!d || !m || !y) return null;
  return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
}

function parseRate(rate) {
  if (!rate) return 0;
  return parseFloat(String(rate).replace(',', '.'));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  if (req.method === 'OPTIONS') return res.status(200).end();

  let { symbol, from } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol obrigatório' });

  symbol = symbol.replace(/\.SA$/i, '').toUpperCase();

  const fromDate = from
    ? (/^\d{4}-\d{2}-\d{2}$/.test(from) ? from : new Date(parseInt(from) * 1000).toISOString().split('T')[0])
    : new Date(Date.now() - 10 * 365 * 86400000).toISOString().split('T')[0];

  const redisUrl   = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const cacheKey   = `dividends-br:${symbol}`;

  // ── Cache Upstash ──
  if (redisUrl && redisToken) {
    const cached = await redisGet(redisUrl, redisToken, cacheKey);
    if (cached) {
      return res.json(cached.filter(d => d.payment_date >= fromDate));
    }
  }

  // ── B3 direto ──
  try {
    const identifier = symbol.substring(0, 4);
    const typeFund   = isFII(symbol) ? 27 : 3;
    const params     = JSON.stringify({ cnpj: '', identifierFund: identifier, typeFund });
    const b64        = Buffer.from(params).toString('base64');
    const b3Url      = `https://sistemaswebb3-listados.b3.com.br/fundsProxy/fundsCall/GetListedSupplementFunds/${b64}`;

    const r = await fetch(b3Url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://www.b3.com.br/',
        'Origin': 'https://www.b3.com.br'
      }
    });

    if (!r.ok) throw new Error('B3 HTTP ' + r.status);

    const data = await r.json();
    const cashDividends = data.cashDividends || [];
    if (!cashDividends.length) throw new Error('sem dados B3');

    const dividends = cashDividends
      .map(d => {
        const payDate = toISO(d.paymentDate);
        const exDate  = toISO(d.lastDatePrior);
        const valor   = parseRate(d.rate);
        if (!payDate || !valor) return null;

        const tipoRaw = (d.label || '').toUpperCase();
        let tipo = 'Dividendo';
        if (tipoRaw.includes('JCP') || tipoRaw.includes('JUROS')) tipo = 'JCP';
        else if (tipoRaw.includes('REND')) tipo = 'Rendimento';
        else if (tipoRaw.includes('BONIF')) tipo = 'Bonificação';

        return {
          payment_date: payDate,
          ex_date:      exDate || payDate,
          value:        valor,
          type:         tipo,
          relatedTo:    d.relatedTo || '',
          approvedOn:   toISO(d.approvedOn),
          source:       'B3'
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.payment_date.localeCompare(a.payment_date));

    // Cache
    if (redisUrl && redisToken && dividends.length > 0) {
      await redisSet(redisUrl, redisToken, cacheKey, dividends);
    }

    return res.json(dividends.filter(d => d.payment_date >= fromDate));

  } catch (err) {
    // B3 falhou — retorna vazio (não usa Yahoo)
    return res.json([]);
  }
}
