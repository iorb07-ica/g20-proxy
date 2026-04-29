// ════════════════════════════════════════════════════════════════════
// /api/news.js — G20 Masterclass News Aggregator
// Busca manchetes de múltiplos portais financeiros via RSS
// e filtra/relevância pros tickers da carteira do usuário
// ════════════════════════════════════════════════════════════════════
//
// Uso: GET /api/news?tickers=PETR4,VALE3,AAPL&limit=20
//      GET /api/news (sem filtros — retorna todas)
//
// Sources:
//   - InfoMoney (BR) — https://www.infomoney.com.br/feed/
//   - Valor (BR)     — https://valor.globo.com/rss/financas/
//   - Brazil Journal — https://braziljournal.com/feed/
//   - MoneyTimes (BR)— https://www.moneytimes.com.br/feed/
//   - CNBC (US/Markets) — https://www.cnbc.com/id/100003114/device/rss/rss.html
//   - Reuters Business — https://www.reutersagency.com/feed/?best-topics=business-finance
//   - Yahoo Finance Top — https://finance.yahoo.com/news/rssindex
//
// Cache: 10 min (in-memory) pra evitar martelar os feeds
// Timeout por feed: 5s (não trava se um cair)

// Cache simples in-memory (resetado quando função é re-instanciada)
let _cache = { ts: 0, data: null };
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min

// Lista de feeds RSS (label, url, lang)
const FEEDS = [
  { id: 'infomoney',     label: 'InfoMoney',      lang: 'pt-BR', url: 'https://www.infomoney.com.br/feed/',           icon: '📊' },
  { id: 'valor',         label: 'Valor',          lang: 'pt-BR', url: 'https://valor.globo.com/rss/financas/',         icon: '📰' },
  { id: 'brazil_journal',label: 'Brazil Journal', lang: 'pt-BR', url: 'https://braziljournal.com/feed/',               icon: '📰' },
  { id: 'moneytimes',    label: 'MoneyTimes',     lang: 'pt-BR', url: 'https://www.moneytimes.com.br/feed/',           icon: '💰' },
  { id: 'cnbc',          label: 'CNBC',           lang: 'en',    url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', icon: '🌎' },
  { id: 'yahoo_finance', label: 'Yahoo Finance',  lang: 'en',    url: 'https://finance.yahoo.com/news/rssindex',       icon: '🌐' }
];

// Parser XML manual (sem dependências externas — Vercel function leve)
function parseRssItems(xml) {
  const items = [];
  // Regex pra capturar cada <item>...</item>
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    items.push({
      title:       extractTag(block, 'title'),
      link:        extractTag(block, 'link'),
      description: extractTag(block, 'description'),
      pubDate:     extractTag(block, 'pubDate'),
      category:    extractAllTags(block, 'category').join(', ')
    });
  }
  return items;
}

function extractTag(xml, tag) {
  // Tenta CDATA primeiro
  const cdataRegex = new RegExp('<' + tag + '[^>]*><\\!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/' + tag + '>', 'i');
  const cdataMatch = xml.match(cdataRegex);
  if (cdataMatch) return cdataMatch[1].trim();

  // Tenta tag normal
  const normalRegex = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i');
  const normalMatch = xml.match(normalRegex);
  if (normalMatch) return normalMatch[1].trim().replace(/<[^>]+>/g, ''); // remove HTML interno
  return '';
}

function extractAllTags(xml, tag) {
  const result = [];
  const regex = new RegExp('<' + tag + '[^>]*>(?:<\\!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/' + tag + '>', 'gi');
  let m;
  while ((m = regex.exec(xml)) !== null) result.push(m[1].trim().replace(/<[^>]+>/g, ''));
  return result;
}

// Fetch RSS com timeout
async function fetchFeed(feed, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(feed.url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'G20-Masterclass/1.0 (+https://iorb07-ica.github.io/plataforma-g20)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*'
      }
    });
    clearTimeout(timer);
    if (!r.ok) {
      console.warn('[news]', feed.id, 'status:', r.status);
      return [];
    }
    const xml = await r.text();
    const items = parseRssItems(xml);
    return items.map(it => ({
      ...it,
      source:     feed.label,
      sourceId:   feed.id,
      sourceIcon: feed.icon,
      lang:       feed.lang
    }));
  } catch (e) {
    console.warn('[news]', feed.id, 'erro:', e.message);
    clearTimeout(timer);
    return [];
  }
}

// Score de relevância para um ticker (busca em title + description)
function scoreItemForTickers(item, tickers) {
  if (!tickers || !tickers.length) return 0;
  const haystack = ((item.title || '') + ' ' + (item.description || '')).toUpperCase();
  let score = 0;
  const matches = [];
  tickers.forEach(t => {
    const tk = t.toUpperCase();
    // Match no ticker exato (com word boundary pra evitar parciais)
    const re = new RegExp('\\b' + tk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
    if (re.test(haystack)) {
      score += 100;
      matches.push(tk);
    }
    // Match no nome da empresa (mapeamento básico)
    const companyMap = {
      'PETR4':'PETROBRAS','PETR3':'PETROBRAS','VALE3':'VALE',
      'ITUB4':'ITAÚ', 'ITUB3':'ITAÚ',
      'BBAS3':'BANCO DO BRASIL','BBDC4':'BRADESCO','BBDC3':'BRADESCO',
      'MGLU3':'MAGAZINE LUIZA','VIIA3':'VIA VAREJO','COGN3':'COGNA',
      'WEGE3':'WEG','ABEV3':'AMBEV','RENT3':'LOCALIZA','LREN3':'LOJAS RENNER',
      'B3SA3':'B3','SUZB3':'SUZANO','RAIL3':'RUMO','EMBR3':'EMBRAER',
      'ELET3':'ELETROBRAS','TAEE11':'TAESA','BBSE3':'BB SEGURIDADE',
      'ITSA4':'ITAÚSA','TOTS3':'TOTVS','VULC3':'VULCABRAS',
      'AAPL':'APPLE','MSFT':'MICROSOFT','GOOGL':'GOOGLE','GOOG':'GOOGLE',
      'AMZN':'AMAZON','META':'META','NVDA':'NVIDIA','TSLA':'TESLA',
      'PLD':'PROLOGIS','STNE':'STONECO','MELI':'MERCADO LIBRE',
      'BABA':'ALIBABA','KO':'COCA-COLA','JNJ':'JOHNSON','DIS':'DISNEY',
      'NFLX':'NETFLIX','PYPL':'PAYPAL','SBUX':'STARBUCKS','SHOP':'SHOPIFY'
    };
    const company = companyMap[tk];
    if (company && haystack.includes(company)) {
      score += 50;
      if (!matches.includes(tk)) matches.push(tk);
    }
  });
  // Bonus por keywords macro relevantes
  const macroKeywords = ['IBOVESPA','IBOV','DÓLAR','SELIC','COPOM','FED','FOMC','S&P','NASDAQ','PETROLEO','MINÉRIO','OURO','DI','CDI','IPCA'];
  macroKeywords.forEach(k => { if (haystack.includes(k)) score += 5; });

  return { score, matches };
}

// Endpoint handler (Vercel serverless function)
module.exports = async (req, res) => {
  // CORS — permite chamada do GitHub Pages
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    const { tickers = '', limit = '20', forceRefresh = '0' } = req.query || {};
    const tickerList = tickers
      ? tickers.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
      : [];
    const lim = Math.max(1, Math.min(50, parseInt(limit) || 20));

    // Cache check (em memória — só reseta se Vercel reiniciar a função)
    const useCache = forceRefresh !== '1' && _cache.data && (Date.now() - _cache.ts) < CACHE_TTL_MS;
    let allItems = useCache ? _cache.data : null;

    if (!allItems) {
      // Busca todos os feeds em paralelo (mas com timeout individual)
      const results = await Promise.all(FEEDS.map(f => fetchFeed(f)));
      allItems = results.flat();
      // Filtra itens válidos
      allItems = allItems.filter(it => it.title && it.link);
      // Ordena por data desc
      allItems.sort((a, b) => {
        const da = a.pubDate ? new Date(a.pubDate).getTime() : 0;
        const db = b.pubDate ? new Date(b.pubDate).getTime() : 0;
        return db - da;
      });
      _cache = { ts: Date.now(), data: allItems };
    }

    // Aplica filtro de tickers
    let result;
    if (tickerList.length > 0) {
      // Score cada item, ordena por relevância, mantém só relevantes (score > 0)
      const scored = allItems.map(it => {
        const s = scoreItemForTickers(it, tickerList);
        return { ...it, _score: s.score, _matches: s.matches };
      });
      const relevantes = scored.filter(it => it._score > 0);
      relevantes.sort((a, b) => {
        // Primeiro por score, empate por data
        if (b._score !== a._score) return b._score - a._score;
        const da = a.pubDate ? new Date(a.pubDate).getTime() : 0;
        const db = b.pubDate ? new Date(b.pubDate).getTime() : 0;
        return db - da;
      });
      result = relevantes.slice(0, lim);
    } else {
      result = allItems.slice(0, lim);
    }

    // Formata resposta minimalista (sem campos internos)
    const formatted = result.map(it => ({
      title:       it.title,
      link:        it.link,
      description: (it.description || '').substring(0, 280),
      pubDate:     it.pubDate,
      source:      it.source,
      sourceIcon:  it.sourceIcon,
      lang:        it.lang,
      tickers:     it._matches || []
    }));

    res.status(200).json({
      ok: true,
      count: formatted.length,
      total: allItems.length,
      cached: useCache,
      cacheAge: useCache ? Math.round((Date.now() - _cache.ts) / 1000) : 0,
      filters: { tickers: tickerList, limit: lim },
      items: formatted
    });
  } catch (e) {
    console.error('[news] erro fatal:', e);
    res.status(500).json({ ok: false, error: e.message || 'erro desconhecido' });
  }
};
