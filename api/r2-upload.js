// api/r2-upload.js — Upload para Cloudflare R2 via AWS Signature V4
// Gera um presigned URL para upload direto do browser para o R2.
// Usado só pelo admin, ao publicar episódios no G20Cast Premium.
//
// Segurança:
//  - Antes aceitava pedidos de QUALQUER site e sem login: qualquer pessoa podia
//    encher o bucket (custo) ou hospedar arquivos com o nome da G20.
//  - Agora: só a origem da plataforma, com token de login do Firebase, e só ADMIN.
//  - Só arquivos de áudio; o link de envio vale 15 minutos.

const { createHmac, createHash } = require('crypto');
const admin = require('firebase-admin');

const ORIGEM = 'https://iorb07-ica.github.io';

if (!admin.apps.length) {
  try {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}')) });
  } catch (e) {
    console.error('[r2-upload] Firebase init error:', e.message);
  }
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (origin === ORIGEM) res.setHeader('Access-Control-Allow-Origin', ORIGEM);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (origin !== ORIGEM) return res.status(403).json({ error: 'Origem não autorizada' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Só admin logado ─────────────────────────────────────────────────────
  const m = String(req.headers.authorization || '').match(/^Bearer (.+)$/);
  if (!m) return res.status(401).json({ error: 'Não autenticado' });
  try {
    const dec = await admin.auth().verifyIdToken(m[1]);
    const perfil = await admin.firestore().collection('users').doc(dec.uid).get();
    if (!perfil.exists || perfil.data().role !== 'admin') {
      return res.status(403).json({ error: 'Apenas o admin pode enviar arquivos' });
    }
  } catch (e) {
    return res.status(401).json({ error: 'Token inválido' });
  }

  const accountId = process.env.CF_ACCOUNT_ID;
  const accessKey = process.env.CF_R2_ACCESS_KEY_ID;
  const secretKey = process.env.CF_R2_SECRET_ACCESS_KEY;
  const bucket    = process.env.CF_R2_BUCKET || 'g20cast-premium';
  const publicUrl = process.env.CF_R2_PUBLIC_URL;

  if (!accountId || !accessKey || !secretKey) {
    return res.status(500).json({ error: 'R2 nao configurado — verifique as variaveis de ambiente' });
  }

  const { filename, contentType } = req.body || {};
  if (!filename || typeof filename !== 'string') return res.status(400).json({ error: 'filename obrigatorio' });
  const ct = contentType || 'audio/mpeg';
  if (!/^audio\//.test(ct)) return res.status(400).json({ error: 'Apenas arquivos de áudio' });

  const key     = 'premium_' + Date.now() + '_' + filename.slice(0, 120).replace(/[^a-zA-Z0-9._-]/g, '_');
  const region  = 'auto';
  const service = 's3';
  const expires = 900; // 15 minutos

  const now       = new Date();
  const dateStr   = now.toISOString().replace(/[:-]/g, '').replace(/\.\d{3}/, '');
  const dateShort = dateStr.slice(0, 8);

  const credential = accessKey + '/' + dateShort + '/' + region + '/' + service + '/aws4_request';

  const params = new URLSearchParams();
  params.set('X-Amz-Algorithm',     'AWS4-HMAC-SHA256');
  params.set('X-Amz-Credential',    credential);
  params.set('X-Amz-Date',          dateStr);
  params.set('X-Amz-Expires',       String(expires));
  params.set('X-Amz-SignedHeaders', 'host');

  const host         = accountId + '.r2.cloudflarestorage.com';
  const canonicalUri = '/' + bucket + '/' + key;
  const canonicalQS  = params.toString();
  const canonicalHdr = 'host:' + host + '\n';
  const signedHdrs   = 'host';
  const payloadHash  = 'UNSIGNED-PAYLOAD';

  const canonicalReq = 'PUT\n' + canonicalUri + '\n' + canonicalQS + '\n' + canonicalHdr + '\n' + signedHdrs + '\n' + payloadHash;
  const credScope    = dateShort + '/' + region + '/' + service + '/aws4_request';
  const hashCanon    = createHash('sha256').update(canonicalReq).digest('hex');
  const strToSign    = 'AWS4-HMAC-SHA256\n' + dateStr + '\n' + credScope + '\n' + hashCanon;

  function hmac(key, data) { return createHmac('sha256', key).update(data).digest(); }
  const sigKey = hmac(hmac(hmac(hmac('AWS4' + secretKey, dateShort), region), service), 'aws4_request');
  const sig    = createHmac('sha256', sigKey).update(strToSign).digest('hex');

  params.set('X-Amz-Signature', sig);

  const uploadUrl = 'https://' + host + '/' + bucket + '/' + key + '?' + params.toString();
  const fileUrl   = publicUrl + '/' + key;

  return res.status(200).json({ uploadUrl, publicUrl: fileUrl, key });
};
