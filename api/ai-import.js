// api/ai-import.js — Proxy para a API da Anthropic (usa chave secreta)
// PROTEGIDO: só aceita requisições vindas do domínio da plataforma G20.
// Sem isso, qualquer pessoa que descobrisse a URL gastaria seu crédito Anthropic.

import { aplicarCors } from './_cors.js';

// Teto de segurança para não estourar custo numa única chamada.
const MAX_TOKENS_TETO = 4096;
const MAX_BODY_BYTES  = 100 * 1024; // 100 KB de prompt já é bastante

export default async function handler(req, res) {
  // Porteiro: libera só origem do G20; responde preflight; bloqueia o resto.
  if (aplicarCors(req, res, 'POST,OPTIONS')) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Body inválido' });
  }

  // Limite de tamanho — evita prompts gigantes (caros) ou abuso.
  try {
    const tamanho = Buffer.byteLength(JSON.stringify(body), 'utf8');
    if (tamanho > MAX_BODY_BYTES) {
      return res.status(413).json({ error: 'Requisição muito grande' });
    }
  } catch {
    return res.status(400).json({ error: 'Body inválido' });
  }

  // Teto no max_tokens — limita o custo máximo por chamada.
  if (typeof body.max_tokens === 'number') {
    body.max_tokens = Math.min(body.max_tokens, MAX_TOKENS_TETO);
  } else {
    body.max_tokens = 1024;
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();
    // Repassa o status real da Anthropic (não mascara erros como 200).
    return res.status(response.status).json(data);
  } catch (e) {
    return res.status(502).json({ error: 'Falha ao contatar a IA' });
  }
}
