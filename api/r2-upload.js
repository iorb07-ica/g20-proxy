// api/r2-upload.js — Upload para Cloudflare R2 via AWS Signature V4
// Gera um presigned URL que o browser usa para upload direto
// Uso: POST /api/r2-upload com JSON {filename, contentType}
// Retorna: {uploadUrl, publicUrl}

import { createHmac, createHash } from 'crypto';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const accountId  = process.env.CF_ACCOUNT_ID;
  const accessKey  = process.env.CF_R2_ACCESS_KEY_ID;
  const secretKey  = process.env.CF_R2_SECRET_ACCESS_KEY;
  const bucket     = process.env.CF_R2_BUCKET || 'g20cast-premium';
  const publicUrl  = process.env.CF_R2_PUBLIC_URL;

  if (!accountId || !accessKey || !secretKey) {
    return res.status(500).json({ error: 'R2 não configurado — verifique as variáveis de ambiente' });
  }

  const { filename, contentType } = req.body || {};
  if (!filename) return res.status(400).json({ error: 'filename obrigatório' });

  const key         = `premium_${Date.now()}_${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const endpoint    = `https://${accountId}.r2.cloudflarestorage.com`;
  const region      = 'auto';
  const service     = 's3';
  const expires     = 3600; // 1 hora

  // Datas para assinatura
  const now         = new Date();
  const dateStr     = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const dateShort   = dateStr.slice(0, 8);

  // Credencial
  const credential  = `${accessKey}/${dateShort}/${region}/${service}/aws4_request`;

  // Parâmetros da query
  const params = new URLSearchParams({
    'X-Amz-Algorithm':    'AWS4-HMAC-SHA256',
    'X-Amz-Credential':    credential,
    'X-Amz-Date':          dateStr,
    'X-Amz-Expires':       String(expires),
    'X-Amz-SignedHeaders': 'host',
  });

  const host         = `${accountId}.r2.cloudflarestorage.com`;
  const canonicalUri = `/${bucket}/${key}`;
  const canonicalQS  = params.toString();
  const canonicalHdr = `host:${host}\n`;
  const signedHdrs   = 'host';
  const payloadHash  = 'UNSIGNED-PAYLOAD';

  const canonicalReq = ['PUT', canonicalUri, canonicalQS, canonicalHdr, signedHdrs, payloadHash].join('\n');

  const credScope    = `${dateShort}/${region}/${service}/aws4_request`;
  const hashCanon    = createHash('sha256').update(canonicalReq).digest('hex');
  const strToSign    = ['AWS4-HMAC-SHA256', dateStr, credScope, hashCanon].join('\n');

  function hmac(key, data) { return createHmac('sha256', key).update(data).digest(); }
  const sigKey = hmac(hmac(hmac(hmac('AWS4' + secretKey, dateShort), region), service), 'aws4_request');
  const sig    = createHmac('sha256', sigKey).update(strToSign).digest('hex');

  params.set('X-Amz-Signature', sig);

  const uploadUrl = `${endpoint}/${bucket}/${key}?${params.toString()}`;
  const fileUrl   = `${publicUrl}/${key}`;

  return res.status(200).json({ uploadUrl, publicUrl: fileUrl, key });
}
