// api/ai-import.js — Proxy para a API da Anthropic (usa chave secreta)
// Usado pelo "Analisar com IA" da Carteira G20 e da Minha Carteira.
//
// Segurança (a chave da Anthropic gera custo no cartão do Israel):
//  - Exige o token de login do Firebase (Authorization: Bearer <idToken>).
//    Só aluno aprovado ou admin usa. Antes bastava fingir a "origem".
//  - Limite de usos por aluno por dia (admin sem limite).
//  - Só os modelos usados pela plataforma são aceitos; qualquer outro vira o padrão.
//  - Só o campo "messages" é repassado (nada de system/tools/parâmetros extras),
//    então o endpoint não serve como "Claude grátis" para outros usos.
//  - Teto de tokens por chamada e de tamanho da requisição (mantidos).

import admin from 'firebase-admin';
import { aplicarCors } from './_cors.js';

const MAX_TOKENS_TETO   = 4096;
const MAX_BODY_BYTES    = 100 * 1024;      // mesmo teto de antes (100 KB)
const LIMITE_DIARIO     = 30;              // análises por aluno por dia
const MODELOS_PERMITIDOS = ['claude-haiku-4-5-20251001', 'claude-sonnet-4-5'];
const MODELO_PADRAO      = 'claude-haiku-4-5-20251001';

if (!admin.apps.length) {
  try {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}')) });
  } catch (e) {
    console.error('[ai-import] Firebase init error:', e.message);
  }
}

function hojeSP() {
  // data de hoje no fuso de São Paulo (o limite "vira" à meia-noite do Brasil)
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  // Porteiro de origem (continua valendo como primeira barreira)
  if (aplicarCors(req, res, 'POST,OPTIONS')) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  // ── Quem está chamando? ─────────────────────────────────────────────────
  const m = String(req.headers.authorization || '').match(/^Bearer (.+)$/);
  if (!m) return res.status(401).json({ error: 'Faça login novamente para usar a IA.' });
  let aluno;
  try {
    aluno = await admin.auth().verifyIdToken(m[1]);
  } catch (e) {
    return res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });
  }

  const db = admin.firestore();
  let ehAdmin = false;
  try {
    const perfil = await db.collection('users').doc(aluno.uid).get();
    const d = perfil.exists ? perfil.data() : {};
    ehAdmin = d.role === 'admin';
    if (!ehAdmin && d.aprovado !== true) {
      return res.status(403).json({ error: 'Seu acesso ainda não foi liberado.' });
    }
  } catch (e) {
    return res.status(500).json({ error: 'Não foi possível verificar seu acesso.' });
  }

  // ── Corpo da requisição ─────────────────────────────────────────────────
  const body = req.body;
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages) || !body.messages.length) {
    return res.status(400).json({ error: 'Body inválido' });
  }
  try {
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_BODY_BYTES) {
      return res.status(413).json({ error: 'Requisição muito grande' });
    }
  } catch {
    return res.status(400).json({ error: 'Body inválido' });
  }

  // ── Limite diário por aluno (admin sem limite) ──────────────────────────
  if (!ehAdmin) {
    const ref = db.collection('ai_uso').doc(aluno.uid + '_' + hojeSP());
    try {
      const estourou = await db.runTransaction(async (t) => {
        const snap = await t.get(ref);
        const usos = snap.exists ? (snap.data().usos || 0) : 0;
        if (usos >= LIMITE_DIARIO) return true;
        t.set(ref, { uid: aluno.uid, dia: hojeSP(), usos: usos + 1,
                     atualizadoEm: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        return false;
      });
      if (estourou) {
        return res.status(429).json({ error: 'Você atingiu o limite de ' + LIMITE_DIARIO + ' análises com IA por hoje. Amanhã libera de novo.' });
      }
    } catch (e) {
      return res.status(500).json({ error: 'Não foi possível registrar o uso. Tente de novo.' });
    }
  }

  // ── Pedido limpo para a Anthropic ───────────────────────────────────────
  const limpo = {
    model: MODELOS_PERMITIDOS.includes(body.model) ? body.model : MODELO_PADRAO,
    max_tokens: typeof body.max_tokens === 'number' ? Math.min(Math.max(1, body.max_tokens), MAX_TOKENS_TETO) : 1024,
    messages: body.messages,
  };

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(limpo)
    });
    const data = await response.json();
    // Repassa o status real da Anthropic (não mascara erros como 200).
    return res.status(response.status).json(data);
  } catch (e) {
    return res.status(502).json({ error: 'Falha ao contatar a IA' });
  }
}
