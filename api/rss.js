// api/rss.js — Proxy de RSS do G20Cast
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
