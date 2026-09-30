// api/consultoria.js — Agendar, cancelar e administrar consultorias com segurança
//
// TODA regra de negócio vale aqui no servidor; a página só reflete.
//
// Regras (definidas pelo Israel, set/2026):
//  R2  Aluno só cancela com pelo menos 24h de antecedência. Com menos de 24h a
//      sessão conta como utilizada. O admin cancela a qualquer momento e decide
//      se devolve o crédito.
//  R3  Antecedência mínima para agendar: 24h.
//  R4  Ilimitado: definido SOMENTE pelo admin (users/{uid}.consultoriaIlimitada).
//      Compatibilidade: creditosConsultoria >= 99 continua valendo como ilimitado
//      até o Israel converter pelo painel.
//  R6  Link do Google Meet ÚNICO por sessão, criado no Google Agenda do Israel.
//      Se não for possível criar, o agendamento fica com "link pendente" e o
//      admin é avisado. Nunca há link fixo compartilhado.
//  R7  Por aluno: no máximo 1 sessão por dia e intervalo mínimo de 15 dias entre
//      sessões (confirmadas, futuras ou passadas, não canceladas).
//  R8  Horários vêm SÓ da agenda configurada pelo admin; sem agenda, nada é
//      oferecido.
//  Fuso: horário de Brasília (UTC-3, sem horário de verão desde 2019).
//
// Unicidade do horário: cada horário reservado ganha um documento com ID fixo em
// consultoria/ocupados/horarios/{AAAA-MM-DD_HH-MM}, SEM dado nenhum do aluno.
// Ele impede duas reservas no mesmo horário e deixa a página mostrar os
// horários ocupados sem expor quem reservou.
//
// Variáveis de ambiente (Vercel) para o Meet automático:
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
//   GOOGLE_CALENDAR_ID (opcional, padrão "primary")
// Sem elas, os agendamentos funcionam com "link pendente" e o admin gera o link
// pelo painel.

import admin from 'firebase-admin';
import { aplicarCors } from './_cors.js';

const ILIMITADO_LEGADO = 99;
const H24 = 24 * 60 * 60 * 1000;
const D15 = 15 * 24 * 60 * 60 * 1000;
const DURACAO_MIN = 60;

if (!admin.apps.length) {
  try {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}')) });
  } catch (e) {
    console.error('[consultoria] Firebase init error:', e.message);
  }
}

function erro(status, msg) { const e = new Error(msg); e.status = status; return e; }
function tsBrasilia(data, hora) { return Date.parse(data + 'T' + hora + ':00-03:00'); }
function slotId(data, hora) { return data + '_' + String(hora).replace(':', '-'); }
function ehIlimitado(ud) { return ud.consultoriaIlimitada === true || Number(ud.creditosConsultoria || 0) >= ILIMITADO_LEGADO; }
function dataBR(data) { const p = String(data).split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }
function dataBRDeTs(ts) { return new Date(ts - 3 * 3600 * 1000).toISOString().slice(0, 10).split('-').reverse().join('/'); }
function validarData(data, hora) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || !/^\d{2}:\d{2}$/.test(hora)) throw erro(400, 'Data ou horário inválido.');
}

/* ─────────────────────────── Google Agenda / Meet ─────────────────────────── */
async function googleToken() {
  const id = process.env.GOOGLE_CLIENT_ID, sec = process.env.GOOGLE_CLIENT_SECRET, rt = process.env.GOOGLE_REFRESH_TOKEN;
  if (!id || !sec || !rt) return null;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: id, client_secret: sec, refresh_token: rt, grant_type: 'refresh_token' }),
  });
  if (!r.ok) throw new Error('OAuth Google ' + r.status);
  return (await r.json()).access_token;
}
function calendarioId() { return encodeURIComponent(process.env.GOOGLE_CALENDAR_ID || 'primary'); }

async function criarEventoMeet({ agId, data, hora, nome, email }) {
  const tk = await googleToken();
  if (!tk) return { pendente: true, motivo: 'Google Agenda ainda não configurado no servidor' };
  const inicio = new Date(tsBrasilia(data, hora)).toISOString();
  const fim = new Date(tsBrasilia(data, hora) + DURACAO_MIN * 60000).toISOString();
  const evento = {
    summary: 'Consultoria G20 · ' + (nome || 'Aluno'),
    description: 'Consultoria 1:1 G20 Masterclass com Israel Oreano.\nAgendada pela Plataforma G20.',
    start: { dateTime: inicio, timeZone: 'America/Sao_Paulo' },
    end: { dateTime: fim, timeZone: 'America/Sao_Paulo' },
    attendees: email ? [{ email }] : [],
    guestsCanInviteOthers: false,
    guestsCanSeeOtherGuests: false,
    conferenceData: { createRequest: { requestId: 'g20-' + agId, conferenceSolutionKey: { type: 'hangoutsMeet' } } },
    reminders: { useDefault: false, overrides: [{ method: 'email', minutes: 1440 }, { method: 'popup', minutes: 30 }] },
  };
  const r = await fetch('https://www.googleapis.com/calendar/v3/calendars/' + calendarioId() +
    '/events?conferenceDataVersion=1&sendUpdates=all', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + tk, 'Content-Type': 'application/json' },
    body: JSON.stringify(evento),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Google Agenda ' + r.status + ' ' + ((j.error && j.error.message) || ''));
  const link = j.hangoutLink ||
    ((j.conferenceData && j.conferenceData.entryPoints) || []).map(e => e.uri).find(u => /meet\.google\.com/.test(u || ''));
  if (!link) throw new Error('Evento criado sem sala do Meet');
  return { meetLink: link, eventId: j.id, eventLink: j.htmlLink || null };
}

async function cancelarEvento(eventId) {
  if (!eventId) return;
  try {
    const tk = await googleToken();
    if (!tk) return;
    await fetch('https://www.googleapis.com/calendar/v3/calendars/' + calendarioId() + '/events/' +
      encodeURIComponent(eventId) + '?sendUpdates=all', { method: 'DELETE', headers: { Authorization: 'Bearer ' + tk } });
  } catch (e) { console.error('[consultoria] cancelar evento:', e.message); }
}

/* ─────────────────────────────── notificações ─────────────────────────────── */
// Canal pessoal já lido pelo sino da plataforma (arena_notificacoes/{uid}/items).
async function notificar(db, uid, titulo, mensagem, link) {
  try {
    await db.collection('arena_notificacoes').doc(uid).collection('items').add({
      tipo: 'consultoria', titulo, mensagem, link: link || 'consultoria.html', lido: false,
      criadoEm: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) { console.error('[consultoria] notificar:', e.message); }
}
async function notificarAdmins(db, titulo, mensagem) {
  try {
    const s = await db.collection('users').where('role', '==', 'admin').get();
    await Promise.all(s.docs.map(d => notificar(db, d.id, titulo, mensagem, 'admin-consultoria.html')));
  } catch (e) { console.error('[consultoria] notificar admins:', e.message); }
}

/* ────────────────────────────────── handler ───────────────────────────────── */
export default async function handler(req, res) {
  if (aplicarCors(req, res, 'POST,OPTIONS')) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const m = String(req.headers.authorization || '').match(/^Bearer (.+)$/);
  if (!m) return res.status(401).json({ error: 'Faça login novamente.' });

  try {
    const quem = await admin.auth().verifyIdToken(m[1]).catch(() => { throw erro(401, 'Sessão expirada. Faça login novamente.'); });
    const db = admin.firestore();
    const userRef = db.collection('users').doc(quem.uid);
    const itens = db.collection('consultoria').doc('agendamentos').collection('items');
    const ocupados = db.collection('consultoria').doc('ocupados').collection('horarios');
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const acao = String(body.acao || '');

    // ── AGENDAR (aluno) ───────────────────────────────────────────────────────
    if (acao === 'agendar') {
      const data = String(body.data || ''), hora = String(body.hora || '');
      validarData(data, hora);
      const timestamp = tsBrasilia(data, hora);
      if (!timestamp) throw erro(400, 'Data ou horário inválido.');
      if (timestamp - Date.now() < H24) throw erro(409, 'Agende com pelo menos 24 horas de antecedência.');

      const bloq = await db.collection('consultoria').doc('bloqueios').collection('datas').doc(data).get();
      if (bloq.exists) throw erro(409, 'Este dia não está disponível.');

      const cfg = await db.collection('consultoria').doc('config').get();
      const slots = (cfg.exists && Array.isArray(cfg.data().slots)) ? cfg.data().slots : [];
      if (!slots.length) throw erro(409, 'A agenda de horários ainda não foi aberta.');
      const diaSemana = new Date(data + 'T12:00:00-03:00').getUTCDay();
      const valido = slots.some(s => s && s.hora === hora && Array.isArray(s.diasSemana) && s.diasSemana.indexOf(diaSemana) !== -1);
      if (!valido) throw erro(409, 'Este horário não está na agenda.');

      const novoRef = itens.doc();
      const trava = ocupados.doc(slotId(data, hora));
      let perfil = {};
      await db.runTransaction(async (t) => {
        const u = await t.get(userRef);
        const ud = u.exists ? u.data() : {};
        perfil = ud;
        if (ud.role !== 'admin' && ud.aprovado !== true) throw erro(403, 'Seu acesso ainda não foi liberado.');
        const ilimitado = ehIlimitado(ud);
        if (!ilimitado && Number(ud.creditosConsultoria || 0) <= 0) throw erro(402, 'Você não tem créditos de consultoria disponíveis.');

        const tv = await t.get(trava);
        if (tv.exists) throw erro(409, 'Este horário acabou de ser reservado por outro aluno. Escolha outro.');
        // Reservas anteriores à trava (compatibilidade)
        const legado = await t.get(itens.where('data', '==', data).where('hora', '==', hora));
        if (legado.docs.some(d => d.data().status !== 'cancelado')) throw erro(409, 'Este horário acabou de ser reservado por outro aluno. Escolha outro.');

        // R7: 1 por dia e 15 dias de intervalo
        const meus = await t.get(itens.where('uid', '==', quem.uid));
        const conflito = meus.docs.map(d => d.data())
          .filter(a => a.status !== 'cancelado' && typeof a.timestamp === 'number')
          .find(a => Math.abs(a.timestamp - timestamp) < D15);
        if (conflito) {
          const proxima = dataBRDeTs(conflito.timestamp + D15);
          throw erro(409, 'É preciso um intervalo de 15 dias entre as suas sessões. Você já tem sessão em ' +
            dataBR(conflito.data) + '. Próxima data possível: a partir de ' + proxima + '.');
        }

        t.set(novoRef, {
          uid: quem.uid, data, hora, timestamp, status: 'confirmado',
          meetLink: null, linkPendente: true, criadoEm: Date.now(),
        });
        t.set(trava, { data, hora, timestamp, criadoEm: Date.now() });
        if (!ilimitado) t.update(userRef, { creditosConsultoria: admin.firestore.FieldValue.increment(-1) });
      });

      // Sala do Meet única (fora da transação: chamada externa)
      const nome = (perfil.profile && (perfil.profile.name || perfil.profile.nome)) || perfil.name || perfil.nome || quem.name || '';
      let meet = null, falha = null;
      try {
        meet = await criarEventoMeet({ agId: novoRef.id, data, hora, nome, email: quem.email || perfil.email || '' });
      } catch (e) { falha = e.message; console.error('[consultoria] Meet:', e.message); }
      if (meet && meet.meetLink) {
        await novoRef.update({ meetLink: meet.meetLink, eventId: meet.eventId, eventLink: meet.eventLink, linkPendente: false });
      } else {
        await novoRef.update({ linkPendente: true, linkPendenteMotivo: (meet && meet.motivo) || falha || 'desconhecido' });
      }
      const quando = dataBR(data) + ' às ' + hora + ' (horário de Brasília)';
      await notificar(db, quem.uid, 'Consultoria confirmada',
        quando + (meet && meet.meetLink ? '. O link da sala está em Consultoria e no seu e-mail.' : '. O link da sala será enviado em breve.'));
      await notificarAdmins(db, 'Nova consultoria agendada',
        (nome || 'Aluno') + ' · ' + quando + (meet && meet.meetLink ? '' : ' · LINK PENDENTE'));

      return res.status(200).json({ ok: true, id: novoRef.id, meetLink: (meet && meet.meetLink) || null, linkPendente: !(meet && meet.meetLink) });
    }

    // ── CANCELAR (aluno) ──────────────────────────────────────────────────────
    if (acao === 'cancelar') {
      const ref = itens.doc(String(body.id || 'x'));
      let a = null, devolveu = false;
      await db.runTransaction(async (t) => {
        const ag = await t.get(ref);
        if (!ag.exists || ag.data().uid !== quem.uid) throw erro(404, 'Agendamento não encontrado.');
        a = ag.data();
        if (a.status === 'cancelado') throw erro(409, 'Este agendamento já foi cancelado.');
        if (!(a.timestamp - Date.now() >= H24)) throw erro(409, 'O cancelamento só é possível com pelo menos 24 horas de antecedência.');
        const u = await t.get(userRef);
        const ud = u.exists ? u.data() : {};
        t.update(ref, { status: 'cancelado', canceladoEm: Date.now(), canceladoPor: 'aluno' });
        t.delete(ocupados.doc(slotId(a.data, a.hora)));
        if (!ehIlimitado(ud)) { t.set(userRef, { creditosConsultoria: admin.firestore.FieldValue.increment(1) }, { merge: true }); devolveu = true; }
      });
      await cancelarEvento(a.eventId);
      const quando = dataBR(a.data) + ' às ' + a.hora;
      await notificarAdmins(db, 'Consultoria cancelada pelo aluno', quando);
      return res.status(200).json({ ok: true, creditoDevolvido: devolveu });
    }

    // ── AÇÕES DO ADMIN ────────────────────────────────────────────────────────
    if (acao.indexOf('admin_') === 0) {
      const eu = await userRef.get();
      if (!eu.exists || eu.data().role !== 'admin') throw erro(403, 'Acesso restrito ao administrador.');

      if (acao === 'admin_cancelar') {
        const ref = itens.doc(String(body.id || 'x'));
        const devolver = body.devolver === true;
        let a = null, devolveu = false;
        await db.runTransaction(async (t) => {
          const ag = await t.get(ref);
          if (!ag.exists) throw erro(404, 'Agendamento não encontrado.');
          a = ag.data();
          if (a.status === 'cancelado') throw erro(409, 'Este agendamento já foi cancelado.');
          const alunoRef = db.collection('users').doc(a.uid);
          const al = await t.get(alunoRef);
          t.update(ref, { status: 'cancelado', canceladoEm: Date.now(), canceladoPor: 'admin' });
          t.delete(ocupados.doc(slotId(a.data, a.hora)));
          if (devolver && al.exists && !ehIlimitado(al.data())) {
            t.update(alunoRef, { creditosConsultoria: admin.firestore.FieldValue.increment(1) }); devolveu = true;
          }
        });
        await cancelarEvento(a.eventId);
        await notificar(db, a.uid, 'Consultoria cancelada',
          'Sua sessão de ' + dataBR(a.data) + ' às ' + a.hora + ' foi cancelada pelo Israel.' + (devolveu ? ' Seu crédito foi devolvido.' : ''));
        return res.status(200).json({ ok: true, creditoDevolvido: devolveu });
      }

      if (acao === 'admin_status') {
        const status = String(body.status || '');
        if (['confirmado', 'realizada', 'faltou'].indexOf(status) === -1) throw erro(400, 'Status inválido.');
        const ref = itens.doc(String(body.id || 'x'));
        const ag = await ref.get();
        if (!ag.exists) throw erro(404, 'Agendamento não encontrado.');
        if (ag.data().status === 'cancelado') throw erro(409, 'Agendamento cancelado.');
        await ref.update({ status, statusEm: Date.now() });
        return res.status(200).json({ ok: true });
      }

      if (acao === 'admin_link') {
        const link = String(body.meetLink || '').trim();
        if (!/^https:\/\/meet\.google\.com\/[a-z0-9-]+$/i.test(link)) throw erro(400, 'Informe um link válido do Google Meet (https://meet.google.com/...).');
        const ref = itens.doc(String(body.id || 'x'));
        const ag = await ref.get();
        if (!ag.exists) throw erro(404, 'Agendamento não encontrado.');
        await ref.update({ meetLink: link, linkPendente: false, linkPendenteMotivo: admin.firestore.FieldValue.delete() });
        const a = ag.data();
        await notificar(db, a.uid, 'Link da sua consultoria', 'A sala da sessão de ' + dataBR(a.data) + ' às ' + a.hora + ' está disponível em Consultoria.');
        return res.status(200).json({ ok: true });
      }

      if (acao === 'admin_gerar_link') {
        const ref = itens.doc(String(body.id || 'x'));
        const ag = await ref.get();
        if (!ag.exists) throw erro(404, 'Agendamento não encontrado.');
        const a = ag.data();
        if (a.status === 'cancelado') throw erro(409, 'Agendamento cancelado.');
        let aluno = {}, email = '';
        try { const al = await db.collection('users').doc(a.uid).get(); aluno = al.exists ? al.data() : {}; } catch (e) {}
        try { email = (await admin.auth().getUser(a.uid)).email || ''; } catch (e) {}
        const nome = (aluno.profile && (aluno.profile.name || aluno.profile.nome)) || aluno.name || aluno.nome || '';
        const meet = await criarEventoMeet({ agId: ag.id, data: a.data, hora: a.hora, nome, email });
        if (!meet.meetLink) throw erro(503, meet.motivo || 'Não foi possível gerar a sala.');
        await ref.update({ meetLink: meet.meetLink, eventId: meet.eventId, eventLink: meet.eventLink, linkPendente: false, linkPendenteMotivo: admin.firestore.FieldValue.delete() });
        await notificar(db, a.uid, 'Link da sua consultoria', 'A sala da sessão de ' + dataBR(a.data) + ' às ' + a.hora + ' está disponível em Consultoria e no seu e-mail.');
        return res.status(200).json({ ok: true, meetLink: meet.meetLink });
      }

      // Cria as travas de horário para agendamentos futuros feitos antes delas existirem
      if (acao === 'admin_sincronizar') {
        const s = await itens.where('timestamp', '>', Date.now()).get();
        let n = 0;
        const lote = db.batch();
        s.docs.forEach(d => {
          const a = d.data();
          if (a.status === 'cancelado' || !a.data || !a.hora) return;
          lote.set(ocupados.doc(slotId(a.data, a.hora)), { data: a.data, hora: a.hora, timestamp: a.timestamp, criadoEm: Date.now() });
          n++;
        });
        if (n) await lote.commit();
        return res.status(200).json({ ok: true, travas: n });
      }

      throw erro(400, 'Ação de admin desconhecida.');
    }

    return res.status(400).json({ error: 'Ação desconhecida' });
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error('[consultoria]', e);
    return res.status(status).json({ error: status === 500 ? 'Erro interno. Tente de novo.' : e.message });
  }
}
