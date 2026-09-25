// G20 Proxy — /api/passkey.js
// Login com Face ID / Touch ID / digital / Windows Hello (passkeys, padrão WebAuthn).
//
// Como funciona (resumo):
//  1. Cadastro: o aluno já logado pede "opções", o aparelho cria um par de chaves
//     protegido pela biometria e manda só a CHAVE PÚBLICA. Guardamos ela no Firestore.
//  2. Login: o aparelho assina um desafio com a chave privada (que nunca sai dele).
//     Conferimos a assinatura com a chave pública e devolvemos um token do Firebase
//     (createCustomToken), com o qual a página faz signInWithCustomToken.
//
// Segurança:
//  - Desafios assinados (HMAC) com validade de 5 min e USO ÚNICO (replay bloqueado).
//  - Verificação de usuário (biometria/PIN) OBRIGATÓRIA.
//  - Só a origem da plataforma é aceita (CORS + expectedOrigin).
//  - Cadastro, listagem e remoção exigem o token de login do próprio aluno.
//  - Conta desativada no Firebase não entra.
//  - As coleções usadas aqui (webauthn_credenciais, webauthn_usados) só são acessadas
//    por este servidor (Admin SDK). As Firestore Rules não liberam nada para o site:
//    pelo "negado por padrão", nenhum aluno lê ou grava nelas.
//
// Variáveis de ambiente: usa a FIREBASE_SERVICE_ACCOUNT que já existe (a mesma do
// push-notify). Não precisa criar nenhuma variável nova.
//
// Custo: zero. Roda no plano gratuito do Vercel; o Firestore usa poucas leituras/gravações.

import admin from 'firebase-admin';
import crypto from 'crypto';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { isoBase64URL, isoUint8Array } from '@simplewebauthn/server/helpers';

// ─── Configuração ────────────────────────────────────────────────────────────
// Se a plataforma mudar de domínio no futuro, é aqui que se troca (RP_ID e ORIGENS).
const RP_ID   = 'iorb07-ica.github.io';
const RP_NOME = 'Plataforma G20';
const ORIGENS = ['https://iorb07-ica.github.io'];

const COL_CRED  = 'webauthn_credenciais';   // docId = id da credencial (base64url)
const COL_USADO = 'webauthn_usados';        // desafios já usados (anti-replay)
const VALIDADE_MS = 5 * 60 * 1000;          // 5 minutos
const MAX_PASSKEYS_POR_ALUNO = 10;

// ─── Firebase Admin (inicializa uma vez) ────────────────────────────────────
let SA = {};
try { SA = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}'); } catch (e) { SA = {}; }
if (!admin.apps.length) {
  try {
    admin.initializeApp({ credential: admin.credential.cert(SA) });
  } catch (e) {
    console.error('[passkey] Firebase init error:', e.message);
  }
}

// Segredo para assinar os desafios, derivado da chave da service account
// (que já é secreta e só existe no Vercel). Evita criar variável nova.
const SEGREDO = crypto.createHash('sha256')
  .update(String(SA.private_key || '') + '|g20-webauthn-v1')
  .digest();

// ─── CORS (igual ao _cors.js, mas liberando o cabeçalho Authorization) ──────
function cors(req, res) {
  const origin = req.headers.origin || '';
  if (ORIGENS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(200).end(); return true; }
  if (!ORIGENS.includes(origin)) { res.status(403).json({ error: 'Origem não autorizada' }); return true; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método não permitido' }); return true; }
  return false;
}

// ─── Desafio assinado (sem gravar nada no banco até ser usado) ──────────────
function assinarDesafio(dados) {
  const corpo = Buffer.from(JSON.stringify(dados)).toString('base64url');
  const mac = crypto.createHmac('sha256', SEGREDO).update(corpo).digest('base64url');
  return corpo + '.' + mac;
}
function lerDesafio(token, tipoEsperado) {
  if (typeof token !== 'string' || token.indexOf('.') < 0) throw erro(400, 'Desafio inválido');
  const [corpo, mac] = token.split('.');
  const esperado = crypto.createHmac('sha256', SEGREDO).update(corpo).digest('base64url');
  const a = Buffer.from(mac || ''), b = Buffer.from(esperado);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw erro(400, 'Desafio inválido');
  const dados = JSON.parse(Buffer.from(corpo, 'base64url').toString());
  if (dados.tipo !== tipoEsperado) throw erro(400, 'Desafio inválido');
  if (Date.now() > dados.exp) throw erro(400, 'O tempo para confirmar expirou. Tente de novo.');
  return dados;
}
// Marca o desafio como usado; se já foi usado, é tentativa de replay.
async function consumirDesafio(db, challenge, exp) {
  const id = crypto.createHash('sha256').update(challenge).digest('hex');
  try {
    await db.collection(COL_USADO).doc(id).create({ exp: admin.firestore.Timestamp.fromMillis(exp) });
  } catch (e) {
    throw erro(400, 'Este desafio já foi usado. Tente de novo.');
  }
}
async function limparUsados(db) {
  try {
    const velhos = await db.collection(COL_USADO)
      .where('exp', '<', admin.firestore.Timestamp.fromMillis(Date.now() - 60000))
      .limit(20).get();
    const lote = db.batch();
    velhos.forEach(d => lote.delete(d.ref));
    if (!velhos.empty) await lote.commit();
  } catch (e) { /* limpeza é opcional */ }
}

// ─── Utilidades ──────────────────────────────────────────────────────────────
function erro(status, msg) { const e = new Error(msg); e.status = status; return e; }

async function alunoDoToken(req) {
  const m = String(req.headers.authorization || '').match(/^Bearer (.+)$/);
  if (!m) throw erro(401, 'Faça login novamente.');
  try {
    return await admin.auth().verifyIdToken(m[1], true);
  } catch (e) {
    throw erro(401, 'Sessão expirada. Faça login novamente.');
  }
}

async function credenciaisDoAluno(db, uid) {
  const snap = await db.collection(COL_CRED).where('uid', '==', uid).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

function limparNome(nome) {
  return String(nome || 'Aparelho').replace(/[<>]/g, '').trim().slice(0, 60) || 'Aparelho';
}

// ─── Handler principal ───────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (cors(req, res)) return;

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const acao = body.acao;

  try {
    const db = admin.firestore();

    // ── 1. Cadastro: opções ──────────────────────────────────────────────────
    if (acao === 'registro-opcoes') {
      const aluno = await alunoDoToken(req);
      const existentes = await credenciaisDoAluno(db, aluno.uid);
      if (existentes.length >= MAX_PASSKEYS_POR_ALUNO) {
        throw erro(400, 'Limite de aparelhos atingido. Remova um antes de ativar outro.');
      }
      const options = await generateRegistrationOptions({
        rpName: RP_NOME,
        rpID: RP_ID,
        userID: isoUint8Array.fromUTF8String(aluno.uid),
        userName: aluno.email || aluno.uid,
        userDisplayName: aluno.name || aluno.email || 'Aluno G20',
        attestationType: 'none',
        timeout: 60000,
        excludeCredentials: existentes.map(c => ({ id: c.id, transports: c.transports || [] })),
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      });
      const desafio = assinarDesafio({ tipo: 'registro', uid: aluno.uid, c: options.challenge, exp: Date.now() + VALIDADE_MS });
      return res.status(200).json({ options, desafio });
    }

    // ── 2. Cadastro: verificação ─────────────────────────────────────────────
    if (acao === 'registro-verificar') {
      const aluno = await alunoDoToken(req);
      const d = lerDesafio(body.desafio, 'registro');
      if (d.uid !== aluno.uid) throw erro(400, 'Desafio de outra conta.');

      let v;
      try {
        v = await verifyRegistrationResponse({
          response: body.resposta,
          expectedChallenge: d.c,
          expectedOrigin: ORIGENS,
          expectedRPID: RP_ID,
          requireUserVerification: true,
        });
      } catch (e) {
        console.warn('[passkey] registro recusado:', e.message);
        throw erro(400, 'Não foi possível confirmar a biometria.');
      }
      if (!v.verified || !v.registrationInfo) throw erro(400, 'Não foi possível confirmar a biometria.');
      await consumirDesafio(db, d.c, d.exp);

      const cred = v.registrationInfo.credential;
      const ref = db.collection(COL_CRED).doc(cred.id);
      const ja = await ref.get();
      if (ja.exists && ja.data().uid !== aluno.uid) throw erro(409, 'Esta credencial já pertence a outra conta.');

      await ref.set({
        uid: aluno.uid,
        publicKey: isoBase64URL.fromBuffer(cred.publicKey),
        counter: cred.counter || 0,
        transports: cred.transports || body.resposta?.response?.transports || [],
        deviceType: v.registrationInfo.credentialDeviceType || '',
        backedUp: !!v.registrationInfo.credentialBackedUp,
        nome: limparNome(body.nome),
        criadoEm: admin.firestore.FieldValue.serverTimestamp(),
        usadoEm: null,
      });
      return res.status(200).json({ ok: true });
    }

    // ── 3. Login: opções (não exige login; não grava nada) ───────────────────
    if (acao === 'login-opcoes') {
      // Se o aparelho informar qual é a sua chave (credId), o pedido já sai
      // direcionado a ela: o iPhone pula a janela "Usar chave-senha" e vai
      // direto ao Face ID. O id da chave não é segredo (é só um identificador).
      const credId = typeof body.credId === 'string' && /^[A-Za-z0-9_-]{16,512}$/.test(body.credId) ? body.credId : null;
      const options = await generateAuthenticationOptions({
        rpID: RP_ID,
        userVerification: 'required',
        timeout: 60000,
        allowCredentials: credId ? [{ id: credId, transports: ['internal', 'hybrid'] }] : [],
      });
      const desafio = assinarDesafio({ tipo: 'login', c: options.challenge, exp: Date.now() + VALIDADE_MS });
      return res.status(200).json({ options, desafio });
    }

    // ── 4. Login: verificação → token do Firebase ────────────────────────────
    if (acao === 'login-verificar') {
      const d = lerDesafio(body.desafio, 'login');
      const resposta = body.resposta || {};
      if (!resposta.id) throw erro(400, 'Resposta inválida.');

      const ref = db.collection(COL_CRED).doc(String(resposta.id));
      const snap = await ref.get();
      if (!snap.exists) throw erro(404, 'Este Face ID não está mais ativo na plataforma. Entre com e-mail e senha e ative de novo no Perfil.');
      const c = snap.data();

      let v;
      try {
        v = await verifyAuthenticationResponse({
        response: resposta,
        expectedChallenge: d.c,
        expectedOrigin: ORIGENS,
        expectedRPID: RP_ID,
        requireUserVerification: true,
        credential: {
          id: snap.id,
          publicKey: isoBase64URL.toBuffer(c.publicKey),
          counter: c.counter || 0,
          transports: c.transports || [],
        },
      });
      } catch (e) {
        console.warn('[passkey] login recusado:', e.message);
        throw erro(401, 'Não foi possível confirmar a biometria.');
      }
      if (!v.verified) throw erro(401, 'Não foi possível confirmar a biometria.');

      // O userHandle devolvido pelo aparelho tem que ser o mesmo aluno
      const uh = resposta.response && resposta.response.userHandle;
      if (uh && isoUint8Array.toUTF8String(isoBase64URL.toBuffer(uh)) !== c.uid) {
        throw erro(401, 'Credencial não corresponde à conta.');
      }

      await consumirDesafio(db, d.c, d.exp);

      const usuario = await admin.auth().getUser(c.uid).catch(() => null);
      if (!usuario || usuario.disabled) throw erro(403, 'Conta indisponível.');

      await ref.update({
        counter: v.authenticationInfo.newCounter || 0,
        usadoEm: admin.firestore.FieldValue.serverTimestamp(),
      });
      const token = await admin.auth().createCustomToken(c.uid, { metodo: 'passkey' });
      limparUsados(db);
      return res.status(200).json({ token });
    }

    // ── 5. Listar aparelhos do aluno ─────────────────────────────────────────
    if (acao === 'listar') {
      const aluno = await alunoDoToken(req);
      const lista = (await credenciaisDoAluno(db, aluno.uid)).map(c => ({
        id: c.id,
        nome: c.nome || 'Aparelho',
        criadoEm: c.criadoEm && c.criadoEm.toMillis ? c.criadoEm.toMillis() : null,
        usadoEm: c.usadoEm && c.usadoEm.toMillis ? c.usadoEm.toMillis() : null,
        sincronizada: !!c.backedUp,
      }));
      lista.sort((a, b) => (b.criadoEm || 0) - (a.criadoEm || 0));
      return res.status(200).json({ lista });
    }

    // ── 6. Remover um aparelho ───────────────────────────────────────────────
    if (acao === 'remover') {
      const aluno = await alunoDoToken(req);
      const ref = db.collection(COL_CRED).doc(String(body.id || ''));
      const snap = await ref.get();
      if (!snap.exists || snap.data().uid !== aluno.uid) throw erro(404, 'Aparelho não encontrado.');
      await ref.delete();
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Ação desconhecida' });
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error('[passkey]', acao, e);
    return res.status(status).json({ error: status === 500 ? 'Erro interno. Tente de novo.' : e.message });
  }
}
