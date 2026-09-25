// G20 Proxy — /api/push-notify.js
// Recebe {uid, title, body, url, tag} e envia push para o dispositivo do aluno
// Requer variáveis de ambiente no Vercel:
//   VAPID_PUBLIC_KEY   → chave pública VAPID
//   VAPID_PRIVATE_KEY  → chave privada VAPID (nunca expor no frontend)
//   VAPID_EMAIL        → mailto:seu@email.com
//   FIREBASE_SERVICE_ACCOUNT → JSON da service account do Firebase (stringify)

const webpush = require('web-push');
const admin   = require('firebase-admin');

// ─── Firebase Admin (inicializa uma vez) ────────────────────────────────────

if (!admin.apps.length) {
  try {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
    admin.initializeApp({
      credential: admin.credential.cert(sa)
    });
  } catch(e) {
    console.error('[push-notify] Firebase init error:', e.message);
  }
}

// ─── VAPID ──────────────────────────────────────────────────────────────────

webpush.setVapidDetails(
  process.env.VAPID_EMAIL || 'mailto:contato@g20masterclass.com.br',
  process.env.VAPID_PUBLIC_KEY  || '',
  process.env.VAPID_PRIVATE_KEY || ''
);

// ─── Handler principal ──────────────────────────────────────────────────────

// ─── Segurança ──────────────────────────────────────────────────────────────
// Antes, qualquer pessoa que chamasse este endereço (script, terminal) podia
// mandar push para TODOS os alunos, com qualquer texto e link. Agora:
//   - exige o token de login do Firebase (Authorization: Bearer <idToken>);
//   - aluno só envia para ELE MESMO (é o que o dashboard faz: topo, CDI...);
//   - enviar para outro aluno ou para todos ('__all__') só o admin;
//   - o link da notificação só pode apontar para a própria plataforma.
const ORIGEM = 'https://iorb07-ica.github.io';
const BASE_PLATAFORMA = ORIGEM + '/plataforma-g20/';

function linkSeguro(url) {
  const padrao = BASE_PLATAFORMA + 'dashboard.html';
  if (!url || typeof url !== 'string') return padrao;
  if (url.startsWith(BASE_PLATAFORMA)) return url;
  if (/^[a-z0-9\-]+\.html([?#].*)?$/i.test(url)) return BASE_PLATAFORMA + url; // relativo
  return padrao;
}
function texto(v, max) { return String(v == null ? '' : v).slice(0, max); }

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', ORIGEM);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const dados = req.body || {};
  const uid = dados.uid;
  const title = texto(dados.title, 120);
  const body  = texto(dados.body, 400);
  const tag   = texto(dados.tag, 80);
  const url   = linkSeguro(dados.url);
  const icon  = undefined; // ícone sempre o oficial da plataforma

  if (!uid) return res.status(400).json({ error: 'uid obrigatório' });

  // Quem está chamando?
  const m = String(req.headers.authorization || '').match(/^Bearer (.+)$/);
  if (!m) return res.status(401).json({ error: 'Não autenticado' });
  let chamador;
  try {
    chamador = await admin.auth().verifyIdToken(m[1]);
  } catch (e) {
    return res.status(401).json({ error: 'Token inválido' });
  }

  try {
    const db = admin.firestore();

    if (uid !== chamador.uid) {
      const perfil = await db.collection('users').doc(chamador.uid).get();
      const ehAdmin = perfil.exists && perfil.data().role === 'admin';
      if (!ehAdmin) return res.status(403).json({ error: 'Sem permissão para notificar outros usuários' });
    }

    // Broadcast para todos os alunos (uid === '__all__') ou para um uid específico
    if (uid === '__all__') {
      // Busca todos os documentos com pushSubscription
      const snap = await db.collection('users')
        .where('pushEnabled', '==', true)
        .limit(200)
        .get();

      if (snap.empty) return res.status(200).json({ sent: 0, message: 'Nenhum aluno com push ativo' });

      const payload = JSON.stringify({
        title: title || 'G20 Masterclass',
        body:  body  || '',
        url:   url   || 'https://iorb07-ica.github.io/plataforma-g20/dashboard.html',
        tag:   tag   || 'g20-broadcast',
        icon:  icon  || 'https://iorb07-ica.github.io/plataforma-g20/assets/icon-192.png'
      });

      let sent = 0, failed = 0;
      const sends = snap.docs.map(async (doc) => {
        const sub = doc.data().pushSubscription;
        if (!sub || !sub.endpoint) return;
        try {
          await webpush.sendNotification(sub, payload);
          sent++;
        } catch(e) {
          failed++;
          // Se a subscription expirou, remove do Firestore
          if (e.statusCode === 410 || e.statusCode === 404) {
            await doc.ref.update({ pushSubscription: admin.firestore.FieldValue.delete(), pushEnabled: false });
          }
        }
      });
      await Promise.all(sends);
      return res.status(200).json({ sent, failed });

    } else {
      // Push para um único aluno
      const doc = await db.collection('users').doc(uid).get();
      if (!doc.exists) return res.status(404).json({ error: 'Usuário não encontrado' });

      const sub = doc.data().pushSubscription;
      if (!sub || !sub.endpoint) return res.status(200).json({ sent: 0, message: 'Sem subscription ativa' });

      const payload = JSON.stringify({
        title: title || 'G20 Masterclass',
        body:  body  || '',
        url:   url   || 'https://iorb07-ica.github.io/plataforma-g20/dashboard.html',
        tag:   tag   || 'g20-notif-' + Date.now(),
        icon:  icon  || 'https://iorb07-ica.github.io/plataforma-g20/assets/icon-192.png'
      });

      try {
        await webpush.sendNotification(sub, payload);
        return res.status(200).json({ sent: 1 });
      } catch(e) {
        // Subscription expirada — limpa do Firestore
        if (e.statusCode === 410 || e.statusCode === 404) {
          await doc.ref.update({ pushSubscription: admin.firestore.FieldValue.delete(), pushEnabled: false });
          return res.status(200).json({ sent: 0, message: 'Subscription expirada — removida' });
        }
        throw e;
      }
    }

  } catch(e) {
    console.error('[push-notify] Erro:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
