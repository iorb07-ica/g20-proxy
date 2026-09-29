// api/rss.js — Proxy de RSS do G20Cast + busca de ativos (Yahoo)
//
// Une duas rotas antes separadas, para caber no limite de 12 funções do
// plano Hobby da Vercel:
//   /api/rss              → feed do G20Cast (comportamento original)
//   /api/search?q=...     → busca de ativos (via rewrite para ?_src=search)
// As duas são dados públicos, sem login e sem dados de aluno.
// Busca o feed do podcast (anchor.fm) no servidor, onde não há bloqueio de CORS,
// e devolve o XML para o navegador com os headers de CORS liberados.
//
// Uso: /api/rss            → feed padrão do G20Cast
//      /api/rss?url=...    → outro feed (somente domínios na allowlist abaixo)
//
// Por que existe: os serviços de CORS público (allorigins, corsproxy, codetabs,
// rss2json) ficaram instáveis/fora do ar, deixando a página g20cast.html travada
// em "carregando...". Roteando pelo proxy próprio, o feed sempre carrega.

import { aplicarCors } from './_cors.js';

// Feed padrão (G20Cast no anchor.fm)
const FEED_PADRAO = 'https://anchor.fm/s/af896e6c/podcast/rss';

// Só estes hosts podem ser buscados (evita virar proxy aberto pra qualquer URL).
const HOSTS_PERMITIDOS = [
  'anchor.fm',
  'podcasters.spotify.com',
];

// Cache simples em memória (vale enquanto a função estiver "quente" na Vercel).
let _cache = { ts: 0, xml: null, url: null };
const TTL_MS = 10 * 60 * 1000; // 10 minutos

export default async function handler(req, res) {
  if (aplicarCors(req, res)) return; // bloqueou ou respondeu o preflight

  // Rota de busca de ativos (antiga /api/search), chegando por rewrite.
  if (req.query._src === 'search') return buscarAtivos(req, res);

  const alvo = (req.query.url && String(req.query.url)) || FEED_PADRAO;

  // Validação: só busca feeds dos hosts permitidos
  let host = '';
  try { host = new URL(alvo).hostname; } catch (e) {
    return res.status(400).json({ error: 'URL inválida' });
  }
  const liberado = HOSTS_PERMITIDOS.some(h => host === h || host.endsWith('.' + h));
  if (!liberado) {
    return res.status(403).json({ error: 'Host não permitido', host });
  }

  // Cache em memória
  if (_cache.xml && _cache.url === alvo && (Date.now() - _cache.ts) < TTL_MS) {
    res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
    res.setHeader('X-Cache-Status', 'HIT');
    return res.status(200).send(_cache.xml);
  }

  try {
    const r = await fetch(alvo, {
      headers: {
        // Alguns feeds bloqueiam requisições sem User-Agent de navegador
        'User-Agent': 'Mozilla/5.0 (compatible; G20CastBot/1.0; +https://iorb07-ica.github.io)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      },
    });

    if (!r.ok) {
      return res.status(502).json({ error: 'Feed respondeu ' + r.status });
    }

    const xml = await r.text();
    _cache = { ts: Date.now(), xml, url: alvo };

    res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
    res.setHeader('X-Cache-Status', 'MISS');
    // Cache também na borda da Vercel por 10 min (revalida em background por 1h)
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
    return res.status(200).send(xml);
  } catch (e) {
    return res.status(502).json({ error: 'Falha ao buscar o feed', detail: String(e && e.message || e) });
  }
}


// ── Busca de ativos (Yahoo Finance) — antiga /api/search ────────────────────
async function buscarAtivos(req, res) {
  const q = req.query.q;
  if (!q || String(q).length < 1) return res.json({ results: [] });
  res.setHeader('Cache-Control', 's-maxage=3600');
  try {
    const url = 'https://query1.finance.yahoo.com/v1/finance/search?q=' + encodeURIComponent(q) + '&quotesCount=8&newsCount=0&listsCount=0';
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json'
      }
    });
    const d = await r.json();
    const quotes = (d && d.quotes) || [];
    const results = quotes
      .filter(x => x.symbol && x.quoteType !== 'OPTION' && x.quoteType !== 'FUTURE')
      .slice(0, 8)
      .map(x => ({
        symbol:   x.symbol,
        name:     x.longname || x.shortname || x.symbol,
        exchange: x.exchange || '',
        type:     x.quoteType || '',
        g20tipo:  detectTipo(x)
      }));
    return res.json({ results });
  } catch (err) {
    return res.status(500).json({ error: err.message, results: [] });
  }
}

function detectTipo(q) {
  const sym = q.symbol || '';
  const type = (q.quoteType || '').toUpperCase();
  const exch = (q.exchange || '').toUpperCase();
  if (type === 'CRYPTOCURRENCY') return 'Cripto';
  if (type === 'ETF') return 'ETF';
  if (type === 'MUTUALFUND') return 'ETF';
  if (/\d$/.test(sym) && (exch.includes('SAO') || exch === 'BZ')) {
    if (sym.endsWith('11')) return 'FII';
    return 'Acao';
  }
  const reits = ['O','SPG','VNQ','NNN','STAG','WPC','VICI','AMT','PLD','PSA','EXR','AVB','EQR'];
  if (reits.includes(sym)) return 'REIT';
  if (type === 'EQUITY') return 'Stock';
  return 'Stock';
}
