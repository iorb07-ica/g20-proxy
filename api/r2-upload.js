// api/r2-upload.js — Vercel Serverless Function
// Recebe o arquivo de áudio do admin e faz upload para o Cloudflare R2
// O token CF fica seguro no servidor — nunca exposto no frontend
// Uso: POST /api/r2-upload (multipart/form-data com campo 'file')

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://iorb07-ica.github.io');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const accountId   = process.env.CF_ACCOUNT_ID;
  const token       = process.env.CF_R2_TOKEN;
  const bucket      = process.env.CF_R2_BUCKET;
  const publicUrl   = process.env.CF_R2_PUBLIC_URL;

  if (!accountId || !token || !bucket) {
    return res.status(500).json({ error: 'R2 não configurado' });
  }

  try {
    // Lê o body como buffer raw
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    // Extrai o Content-Type para repassar ao R2
    const contentType = req.headers['content-type'] || 'audio/mpeg';

    // Gera nome único para o arquivo
    const ext      = contentType.includes('mp4') || contentType.includes('m4a') ? 'm4a'
                   : contentType.includes('wav') ? 'wav'
                   : contentType.includes('ogg') ? 'ogg'
                   : contentType.includes('aac') ? 'aac'
                   : 'mp3';
    const filename = `premium_${Date.now()}.${ext}`;

    // Upload para R2 via API S3-compatible
    const r2Url = `https://${accountId}.r2.cloudflarestorage.com/${bucket}/${filename}`;

    const upload = await fetch(r2Url, {
      method:  'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  contentType,
        'Content-Length': String(body.length),
      },
      body: body,
    });

    if (!upload.ok) {
      const errText = await upload.text().catch(() => '');
      console.error('[r2-upload] R2 error:', upload.status, errText);
      return res.status(500).json({ error: 'Upload falhou: ' + upload.status });
    }

    const audioUrl = `${publicUrl}/${filename}`;
    return res.status(200).json({ url: audioUrl, filename });

  } catch (e) {
    console.error('[r2-upload] Erro:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
