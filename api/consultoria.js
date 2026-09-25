// api/consultoria.js — Agendar e cancelar consultorias com segurança
//
// Antes, a própria página do aluno gravava o agendamento e descontava/devolvia o
// crédito direto no Firestore. Como o aluno pode editar o próprio cadastro, dava
// para se dar créditos à vontade ou agendar sem descontar. E como cada aluno só
// enxerga os próprios agendamentos, dois alunos conseguiam marcar o MESMO horário.
//
// Agora o servidor faz tudo numa transação:
//  - agendar: confere login e aprovação, crédito disponível, data futura, dia não
//    bloqueado, horário existente na agenda e horário ainda livre (entre TODOS os
//    alunos); cria o agendamento e desconta 1 crédito (ilimitado = 99+ não desconta).
//  - cancelar: só o dono, só consultoria futura; marca como cancelada e devolve o crédito.
// As Firestore Rules passam a proibir o aluno de gravar créditos e agendamentos.

import admin from 'firebase-admin';
import { aplicarCors } from './_cors.js';

const MEET_LINK = 'https://meet.google.com/psx-kifx-qgc';
const ILIMITADO = 99;
const SLOTS_PADRAO = [
  { diasSemana: [1, 2, 3, 4, 5], hora: '10:00' },
  { diasSemana: [1, 2, 3, 4, 5], hora: '15:00' },
  { diasSemana: [0, 1, 2, 3, 4, 5, 6], hora: '16:00' },
];

if (!admin.apps.length) {
  try {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}')) });
  } catch (e) {
    console.error('[consultoria] Firebase init error:', e.message);
  }
}

function erro(status, msg) { const e = new Error(msg); e.status = status; return e; }

export default async function handler(req, res) {
  if (aplicarCors(req, res, 'POST,OPTIONS')) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const m = String(req.headers.authorization || '').match(/^Bearer (.+)$/);
  if (!m) return res.status(401).json({ error: 'Faça login novamente.' });

  try {
    const aluno = await admin.auth().verifyIdToken(m[1]).catch(() => { throw erro(401, 'Sessão expirada. Faça login novamente.'); });
    const db = admin.firestore();
    const userRef = db.collection('users').doc(aluno.uid);
    const itens = db.collection('consultoria').doc('agendamentos').collection('items');
    const body = (req.body && typeof req.body === 'object') ? req.body : {};

    // ── AGENDAR ─────────────────────────────────────────────────────────────
    if (body.acao === 'agendar') {
      const data = String(body.data || '');
      const hora = String(body.hora || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || !/^\d{2}:\d{2}$/.test(hora)) throw erro(400, 'Data ou horário inválido.');
      const timestamp = Date.parse(data + 'T' + hora + ':00-03:00'); // horário de Brasília
      if (!timestamp || timestamp <= Date.now()) throw erro(400, 'Escolha um horário futuro.');

      // Dia bloqueado pelo admin?
      const bloq = await db.collection('consultoria').doc('bloqueios').collection('datas').doc(data).get();
      if (bloq.exists) throw erro(409, 'Este dia não está disponível.');

      // Horário existe na agenda daquele dia da semana?
      const cfg = await db.collection('consultoria').doc('config').get();
      const slots = (cfg.exists && Array.isArray(cfg.data().slots)) ? cfg.data().slots : SLOTS_PADRAO;
      const diaSemana = new Date(data + 'T12:00:00-03:00').getUTCDay();
      const valido = slots.some(s => s && s.hora === hora && Array.isArray(s.diasSemana) && s.diasSemana.indexOf(diaSemana) !== -1);
      if (!valido) throw erro(409, 'Este horário não está na agenda.');

      const novoRef = itens.doc();
      await db.runTransaction(async (t) => {
        const u = await t.get(userRef);
        const ud = u.exists ? u.data() : {};
        if (ud.role !== 'admin' && ud.aprovado !== true) throw erro(403, 'Seu acesso ainda não foi liberado.');
        const creditos = Number(ud.creditosConsultoria || 0);
        if (creditos <= 0) throw erro(402, 'Você não tem créditos de consultoria disponíveis.');

        const ocupado = await t.get(itens.where('data', '==', data).where('hora', '==', hora));
        const ativo = ocupado.docs.some(d => d.data().status !== 'cancelado');
        if (ativo) throw erro(409, 'Este horário acabou de ser reservado por outro aluno. Escolha outro.');

        t.set(novoRef, {
          uid: aluno.uid, data, hora, timestamp,
          status: 'confirmado', meetLink: MEET_LINK, criadoEm: Date.now(),
        });
        if (creditos < ILIMITADO) {
          t.update(userRef, { creditosConsultoria: admin.firestore.FieldValue.increment(-1) });
        }
      });
      return res.status(200).json({ ok: true, id: novoRef.id });
    }

    // ── CANCELAR ────────────────────────────────────────────────────────────
    if (body.acao === 'cancelar') {
      const ref = itens.doc(String(body.id || 'x'));
      let devolveu = false;
      await db.runTransaction(async (t) => {
        const ag = await t.get(ref);
        if (!ag.exists || ag.data().uid !== aluno.uid) throw erro(404, 'Agendamento não encontrado.');
        const a = ag.data();
        if (a.status === 'cancelado') throw erro(409, 'Este agendamento já foi cancelado.');
        if (!(a.timestamp > Date.now())) throw erro(409, 'Não é possível cancelar uma consultoria que já passou.');
        const u = await t.get(userRef);
        const creditos = Number((u.exists && u.data().creditosConsultoria) || 0);
        t.update(ref, { status: 'cancelado', canceladoEm: Date.now() });
        if (creditos < ILIMITADO) {
          t.set(userRef, { creditosConsultoria: admin.firestore.FieldValue.increment(1) }, { merge: true });
        }
        devolveu = true;
      });
      return res.status(200).json({ ok: true, creditoDevolvido: devolveu });
    }

    return res.status(400).json({ error: 'Ação desconhecida' });
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error('[consultoria]', e);
    return res.status(status).json({ error: status === 500 ? 'Erro interno. Tente de novo.' : e.message });
  }
}
