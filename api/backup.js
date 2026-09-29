// api/backup.js — Backup semanal do Firestore para o Cloudflare R2
//
// O QUE FAZ
//   Lê todas as coleções do Firestore (incluindo a carteira e a gestão
//   financeira de cada aluno, em users/{uid}/dados/*), monta um único arquivo
//   JSON com tudo e envia para o bucket R2 'g20cast-premium', na pasta backups/.
//   Mantém os 8 backups mais recentes (2 meses) e apaga os mais antigos.
//
// QUEM PODE DISPARAR (duas portas, nada além disso)
//   1. O cron da Vercel, uma vez por semana. A Vercel manda o cabeçalho
//      Authorization: Bearer <CRON_SECRET> automaticamente. Conferimos esse
//      segredo (variável de ambiente CRON_SECRET).
//   2. Você, admin logado, pelo botão no admin-hub. O navegador manda o token
//      do Firebase; verificamos e conferimos role == 'admin'.
//   Um aluno não consegue disparar nem baixar: sem segredo e sem role admin, 403.
//
// CUSTO: zero. Usa o Admin SDK (já configurado) e o R2 (já configurado, mesmas
//   chaves do G20Cast Premium). ~1.000 a 2.000 leituras do Firestore por
//   execução, muito abaixo da cota grátis diária (50.000).
//
// VARIÁVEIS DE AMBIENTE (Vercel → Settings → Environment Variables)
//   Já existentes (reaproveitadas): FIREBASE_SERVICE_ACCOUNT, CF_ACCOUNT_ID,
//   CF_R2_ACCESS_KEY_ID, CF_R2_SECRET_ACCESS_KEY, CF_R2_BUCKET (opcional).
//   NOVA (você cria uma vez): CRON_SECRET — uma senha aleatória qualquer.

import admin from 'firebase-admin';
import { createHash, createHmac } from 'crypto';

// ── Firebase Admin (mesmo padrão das outras rotas) ──────────────────────────
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}')),
  });
}

// ── Coleções de nível raiz que entram no backup ─────────────────────────────
// 'users' é tratada à parte, porque precisamos descer nas subcoleções de cada
// aluno (dados, progresso, config, etc.). As demais são lidas inteiras.
const COLECOES_RAIZ = [
  'consultoria', 'eventos_corporativos', 'networking_public', 'cursos',
  'g20flix', 'g20cast_premium', 'aportes_g20', 'arena', 'arena_comunidades',
  'atlas_teses', 'biblioteca', 'game-g20', 'game-g20-hall', 'game-g20-ranking',
  'sugestoes', 'feedback_respostas',
];

// Subcoleções de cada aluno em users/{uid}/...
const SUBCOLECOES_ALUNO = ['dados', 'progresso', 'config', 'minhaEstante', 'stats', 'biblioteca'];

const MANTER = 8; // quantos backups guardar (8 semanas = 2 meses)

// ── Leitura recursiva de uma coleção (com subcoleções) ──────────────────────
async function lerColecao(ref, comSub) {
  const out = {};
  const snap = await ref.get();
  for (const doc of snap.docs) {
    const item = { _dados: doc.data() };
    if (comSub) {
      const subs = await doc.ref.listCollections();
      for (const sub of subs) {
        item[sub.id] = await lerColecao(sub, true);
      }
    }
    out[doc.id] = item;
  }
  return out;
}

// users/{uid}: doc + só as subcoleções conhecidas (mais barato que varrer tudo)
async function lerUsuarios(db) {
  const out = {};
  const snap = await db.collection('users').get();
  for (const doc of snap.docs) {
    const item = { _dados: doc.data() };
    for (const nome of SUBCOLECOES_ALUNO) {
      const sub = await doc.ref.collection(nome).get();
      if (!sub.empty) {
        const m = {};
        sub.forEach(d => { m[d.id] = { _dados: d.data() }; });
        item[nome] = m;
      }
    }
    out[doc.id] = item;
  }
  return out;
}

// ── Assinatura AWS SigV4 para PUT/GET/DELETE no R2 ──────────────────────────
function hmac(key, data) { return createHmac('sha256', key).update(data).digest(); }
function hex(b) { return Buffer.from(b).toString('hex'); }

function assinarR2(metodo, host, canonicalUri, query, payloadHash, accessKey, secretKey, dateStr, dateShort) {
  const region = 'auto', service = 's3';
  const canonicalHdr = 'host:' + host + '\nx-amz-content-sha256:' + payloadHash + '\nx-amz-date:' + dateStr + '\n';
  const signedHdrs = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalReq = metodo + '\n' + canonicalUri + '\n' + (query || '') + '\n' + canonicalHdr + '\n' + signedHdrs + '\n' + payloadHash;
  const credScope = dateShort + '/' + region + '/' + service + '/aws4_request';
  const strToSign = 'AWS4-HMAC-SHA256\n' + dateStr + '\n' + credScope + '\n' + hex(createHash('sha256').update(canonicalReq).digest());
  const sigKey = hmac(hmac(hmac(hmac('AWS4' + secretKey, dateShort), region), service), 'aws4_request');
  const sig = hex(hmac(sigKey, strToSign));
  return {
    Authorization: 'AWS4-HMAC-SHA256 Credential=' + accessKey + '/' + credScope + ', SignedHeaders=' + signedHdrs + ', Signature=' + sig,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': dateStr,
  };
}

function r2Ctx() {
  const accountId = process.env.CF_ACCOUNT_ID;
  const accessKey = process.env.CF_R2_ACCESS_KEY_ID;
  const secretKey = process.env.CF_R2_SECRET_ACCESS_KEY;
  const bucket = process.env.CF_R2_BUCKET || 'g20cast-premium';
  if (!accountId || !accessKey || !secretKey) throw new Error('R2 não configurado');
  const now = new Date();
  const dateStr = now.toISOString().replace(/[:-]/g, '').replace(/\.\d{3}/, '');
  return { host: accountId + '.r2.cloudflarestorage.com', bucket, accessKey, secretKey, dateStr, dateShort: dateStr.slice(0, 8) };
}

async function r2Put(key, corpoBuffer) {
  const c = r2Ctx();
  const uri = '/' + c.bucket + '/' + key;
  const payloadHash = hex(createHash('sha256').update(corpoBuffer).digest());
  const h = assinarR2('PUT', c.host, uri, '', payloadHash, c.accessKey, c.secretKey, c.dateStr, c.dateShort);
  const r = await fetch('https://' + c.host + uri, { method: 'PUT', headers: { ...h, 'Content-Type': 'application/json' }, body: corpoBuffer });
  if (!r.ok) throw new Error('R2 PUT falhou: ' + r.status + ' ' + (await r.text()).slice(0, 200));
}

async function r2List(prefix) {
  const c = r2Ctx();
  const query = 'list-type=2&prefix=' + encodeURIComponent(prefix);
  const uri = '/' + c.bucket;
  const payloadHash = hex(createHash('sha256').update('').digest());
  const h = assinarR2('GET', c.host, uri, query, payloadHash, c.accessKey, c.secretKey, c.dateStr, c.dateShort);
  const r = await fetch('https://' + c.host + uri + '?' + query, { headers: h });
  if (!r.ok) return [];
  const xml = await r.text();
  const keys = [];
  const re = /<Key>([^<]+)<\/Key>/g;
  let m;
  while ((m = re.exec(xml))) keys.push(m[1]);
  return keys;
}

async function r2Delete(key) {
  const c = r2Ctx();
  const uri = '/' + c.bucket + '/' + key;
  const payloadHash = hex(createHash('sha256').update('').digest());
  const h = assinarR2('DELETE', c.host, uri, '', payloadHash, c.accessKey, c.secretKey, c.dateStr, c.dateShort);
  const r = await fetch('https://' + c.host + uri, { method: 'DELETE', headers: h });
  return r.ok || r.status === 404;
}

// ── Handler ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // CORS: libera só o site do G20 a chamar esta rota pelo navegador (o botão
  // do admin). Sem isso, o navegador bloqueia a chamada e dá "Failed to fetch".
  const ORIGENS_PERMITIDAS = [
    'https://iorb07-ica.github.io',
    'http://localhost:3000',
    'http://127.0.0.1:5500',
  ];
  const origin = req.headers.origin || '';
  if (ORIGENS_PERMITIDAS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── Porta 1: cron da Vercel (Bearer CRON_SECRET) ──────────────────────────
  const auth = String(req.headers.authorization || '');
  const segredo = process.env.CRON_SECRET || '';
  const veioDoCron = segredo && auth === 'Bearer ' + segredo;

  // ── Porta 2: admin logado (token do Firebase + role admin) ────────────────
  let veioDoAdmin = false;
  if (!veioDoCron) {
    const m = auth.match(/^Bearer (.+)$/);
    if (!m) return res.status(401).json({ error: 'Não autenticado' });
    try {
      const dec = await admin.auth().verifyIdToken(m[1]);
      const perfil = await admin.firestore().collection('users').doc(dec.uid).get();
      if (!perfil.exists || perfil.data().role !== 'admin') {
        return res.status(403).json({ error: 'Apenas o admin pode fazer backup' });
      }
      veioDoAdmin = true;
    } catch (e) {
      return res.status(401).json({ error: 'Token inválido' });
    }
  }
  if (!veioDoCron && !veioDoAdmin) return res.status(403).json({ error: 'Sem permissão' });

  try {
    const db = admin.firestore();
    const backup = { _meta: { criadoEm: new Date().toISOString(), origem: veioDoCron ? 'cron' : 'admin', versao: 1 }, colecoes: {} };

    backup.colecoes.users = await lerUsuarios(db);
    for (const nome of COLECOES_RAIZ) {
      // cursos e game-g20 têm subcoleções; as demais, lidas rasas já bastam,
      // mas ler com subcoleção não custa caro nesse volume, então uniformizo.
      backup.colecoes[nome] = await lerColecao(db.collection(nome), true);
    }

    const corpo = Buffer.from(JSON.stringify(backup), 'utf8');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const key = 'backups/firestore-' + stamp + '.json';
    await r2Put(key, corpo);

    // Rotação: mantém os MANTER mais recentes, apaga o resto
    let apagados = 0;
    try {
      const todos = (await r2List('backups/firestore-')).sort(); // nome tem data ISO, ordena cronologicamente
      const excedente = todos.slice(0, Math.max(0, todos.length - MANTER));
      for (const k of excedente) { if (await r2Delete(k)) apagados++; }
    } catch (e) { /* rotação é best-effort; o backup já foi salvo */ }

    const resumo = {
      ok: true,
      arquivo: key,
      tamanhoKB: Math.round(corpo.length / 1024),
      alunos: Object.keys(backup.colecoes.users || {}).length,
      colecoes: Object.keys(backup.colecoes).length,
      backupsAntigosApagados: apagados,
      criadoEm: backup._meta.criadoEm,
    };
    if (veioDoCron) console.log('[backup] OK', JSON.stringify(resumo));
    return res.status(200).json(resumo);
  } catch (e) {
    console.error('[backup]', e);
    return res.status(500).json({ error: 'Falha no backup: ' + (e.message || e) });
  }
}
