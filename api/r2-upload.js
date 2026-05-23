// api/r2-upload.js — Upload para Cloudflare R2 via AWS Signature V4
// Gera um presigned URL para upload direto do browser para o R2

const { createHmac, createHash } = require('crypto');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const accountId = process.env.CF_ACCOUNT_ID;
  const accessKey = process.env.CF_R2_ACCESS_KEY_ID;
  const secretKey = process.env.CF_R2_SECRET_ACCESS_KEY;
  const bucket    = process.env.CF_R2_BUCKET || 'g20cast-premium';
  const publicUrl = process.env.CF_R2_PUBLIC_URL;

  if (!accountId || !accessKey || !secretKey) {
    return res.status(500).json({ error: 'R2 nao configurado — verifique as variaveis de ambiente' });
  }

  const { filename, contentType } = req.body || {};
  if (!filename) return res.status(400).json({ error: 'filename obrigatorio' });

  const ct      = contentType || 'audio/mpeg';
  const key     = 'premium_' + Date.now() + '_' + filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const region  = 'auto';
  const service = 's3';
  const expires = 3600;

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
