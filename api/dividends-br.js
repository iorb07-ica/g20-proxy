// api/dividends-br.js — Vercel Serverless Function
// Busca dividendos BR via B3 direto (gratuito, oficial)
// Uso: /api/dividends-br?symbol=HGLG11.SA&from=2020-01-01
// Debug: adicionar &debug=1 para ver detalhes do erro

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

  let { symbol, from, debug } = req.query;
  const isDebug = debug === '1' || debug === 'true';
  const debugInfo = { steps: [] };

  if (!symbol) return res.status(400).json({ error: 'symbol obrigatório' });

  symbol = symbol.replace(/\.SA$/i, '').toUpperCase();
  debugInfo.symbol = symbol;

  const fromDate = from
    ? (/^\d{4}-\d{2}-\d{2}$/.test(from) ? from : new Date(parseInt(from) * 1000).toISOString().split('T')[0])
    : new Date(Date.now() - 10 * 365 * 86400000).toISOString().split('T')[0];
  debugInfo.fromDate = fromDate;

  const redisUrl   = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const cacheKey   = `dividends-br:${symbol}`;
  debugInfo.hasRedis = !!(redisUrl && redisToken);

  // ── Cache Upstash ──
  if (redisUrl && redisToken) {
    const cached = await redisGet(redisUrl, redisToken, cacheKey);
    if (cached) {
      debugInfo.steps.push('cache hit: ' + cached.length + ' registros');
      if (isDebug) return res.json({ _debug: debugInfo, data: cached.filter(d => d.payment_date >= fromDate) });
      return res.json(cached.filter(d => d.payment_date >= fromDate));
    }
    debugInfo.steps.push('cache miss');
  }

  // ── B3 direto ──
  try {
    const identifier = symbol.substring(0, 4);
    const typeFund   = isFII(symbol) ? 27 : 3;
    const params     = JSON.stringify({ cnpj: '', identifierFund: identifier, typeFund });
    const b64        = Buffer.from(params).toString('base64');
    const b3Url      = `https://sistemaswebb3-listados.b3.com.br/fundsProxy/fundsCall/GetListedSupplementFunds/${b64}`;

    debugInfo.b3Url = b3Url;
    debugInfo.typeFund = typeFund;
    debugInfo.identifier = identifier;
    debugInfo.steps.push('calling B3...');

    const startTime = Date.now();
    const r = await fetch(b3Url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://www.b3.com.br/',
        'Origin': 'https://www.b3.com.br'
      }
    });
    debugInfo.b3Duration = Date.now() - startTime + 'ms';
    debugInfo.b3Status = r.status;
    debugInfo.b3StatusText = r.statusText;

    if (!r.ok) {
      const errBody = await r.text().catch(() => '');
      debugInfo.b3ErrorBody = errBody.slice(0, 500);
      throw new Error('B3 HTTP ' + r.status + ': ' + errBody.slice(0, 200));
    }

    const rawText = await r.text();
    debugInfo.b3ResponseSize = rawText.length;
    debugInfo.b3ResponseSample = rawText.slice(0, 300);

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      throw new Error('B3 retornou JSON invalido: ' + e.message);
    }

    debugInfo.b3DataKeys = Object.keys(data || {});
    const cashDividends = data.cashDividends || [];
    debugInfo.cashDividendsCount = cashDividends.length;

    if (!cashDividends.length) {
      debugInfo.steps.push('B3 retornou 0 dividendos');
      throw new Error('sem dados B3');
    }

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
        else if (tipoRaw.includes('BONIF')) tipo = 'Bonificacao';

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

    debugInfo.dividendsCount = dividends.length;
    debugInfo.steps.push('success: ' + dividends.length + ' dividendos processados');

    // Cache
    if (redisUrl && redisToken && dividends.length > 0) {
      await redisSet(redisUrl, redisToken, cacheKey, dividends);
    }

    const filtered = dividends.filter(d => d.payment_date >= fromDate);
    debugInfo.afterFilter = filtered.length;

    if (isDebug) return res.json({ _debug: debugInfo, data: filtered });
    return res.json(filtered);

  } catch (err) {
    debugInfo.error = err.message;
    debugInfo.errorStack = err.stack ? err.stack.split('\n').slice(0, 3) : [];
    debugInfo.steps.push('CATCH: ' + err.message);

    if (isDebug) return res.status(200).json({ _debug: debugInfo, data: [] });
    return res.json([]);
  }
}
