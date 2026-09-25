// api/migrar.js — Traz a carteira do aluno da plataforma antiga (valorize.herokuapp.com)
//
// Fluxo:
//  1. O aluno, logado na plataforma nova, informa o e-mail e a senha que usava na antiga.
//  2. Este servidor faz login na plataforma antiga como ele, busca a carteira
//     (/api/wallet/transactions/false/all) e devolve as COMPRAS e VENDAS já convertidas
//     para o formato da Minha Carteira. Quem grava é a própria página, depois da prévia.
//
// Segurança:
//  - Exige o token de login da plataforma nova (aluno aprovado ou admin).
//  - A senha da plataforma antiga é usada só nesta chamada: não é gravada nem registrada em log.
//  - Limite de tentativas por aluno (evita uso do servidor para "testar senhas").
//  - Nada é gravado aqui além do contador de tentativas.
//
// O que NÃO vem: dividendos (D), JCP (J), rendimentos (R), grupamentos (G) e
// desdobramentos (S). A Minha Carteira já calcula tudo isso a partir das compras;
// importar esses lançamentos contaria em dobro. Lançamentos excluídos (inativos)
// ou não executados também ficam de fora.
//
// Dólar: para ativos em USD, usa o câmbio oficial (PTAX, Banco Central) da data de cada compra.

import admin from 'firebase-admin';
import { aplicarCors } from './_cors.js';

const API_ANTIGA = 'https://valorize.herokuapp.com/api';
const LIMITE_TENTATIVAS = 10;          // por aluno, por hora
const US = ['Stock', 'REIT', 'ETF', 'Cripto', 'UCITs'];

if (!admin.apps.length) {
  try {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}')) });
  } catch (e) {
    console.error('[migrar] Firebase init error:', e.message);
  }
}

function erro(status, msg) { const e = new Error(msg); e.status = status; return e; }

// Cabeçalhos iguais aos que a própria página antiga envia (algumas APIs
// recusam pedidos que não parecem vir do navegador).
const CABECALHOS = {
  'Accept': 'application/json, text/plain, */*',
  'Content-Type': 'application/json',
  'Origin': 'https://valorize.herokuapp.com',
  'Referer': 'https://valorize.herokuapp.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
};

async function comTempo(url, opts, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms || 20000);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); }
  finally { clearTimeout(t); }
}

// ── Tipo de ativo: categoria da plataforma antiga → tipo da Minha Carteira ──
function tipoNovo(categoria, bolsa) {
  const c = String(categoria || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const b3 = /bvmf|b3|bovespa|sao paulo/i.test(String(bolsa || ''));
  if (c.includes('cripto') || c.includes('crypto')) return 'Cripto';
  if (c.includes('fiagro')) return 'FIAGRO';
  if (c.includes('infra')) return 'FIInfra';
  if (c.includes('imobili') || c === 'fii' || c === 'fiis') return 'FII';
  if (c.includes('reit')) return 'REIT';
  if (c.includes('stock')) return 'Stock';
  if (c.includes('ucit')) return 'UCITs';
  if (c.includes('etf')) return b3 ? 'Acao' : 'ETF';     // ETF da B3 entra como ativo em reais
  if (c.includes('bdr')) return 'Acao';
  if (c.includes('aco')) return 'Acao';
  return b3 ? 'Acao' : 'Stock';
}

function tickerNovo(simbolo, tipo) {
  let t = String(simbolo || '').trim().toUpperCase();
  if (tipo === 'Cripto') t = t.replace(/[-/](USD|USDT|BRL)$/, '');
  return t;
}

function num(v) { const n = parseFloat(String(v == null ? '' : v).replace(',', '.')); return isFinite(n) ? n : 0; }

// ── PTAX (Banco Central) para o período das compras em dólar ──
function fmtBCB(iso) { const [y, m, d] = iso.split('-'); return m + '-' + d + '-' + y; }
async function ptaxPeriodo(inicio, fim) {
  const ini = new Date(inicio + 'T12:00:00Z'); ini.setUTCDate(ini.getUTCDate() - 7); // cobre fim de semana/feriado
  const url = 'https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/' +
    "CotacaoDolarPeriodo(dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)?" +
    "@dataInicial='" + fmtBCB(ini.toISOString().slice(0, 10)) + "'&@dataFinalCotacao='" + fmtBCB(fim) +
    "'&$top=10000&$format=json&$select=cotacaoVenda,dataHoraCotacao";
  const r = await comTempo(url, {}, 15000);
  if (!r.ok) throw new Error('PTAX ' + r.status);
  const j = await r.json();
  const mapa = {};
  (j.value || []).forEach(v => { mapa[String(v.dataHoraCotacao).slice(0, 10)] = v.cotacaoVenda; });
  return Object.keys(mapa).sort().map(d => [d, mapa[d]]);
}
function ptaxNaData(lista, data) {
  let v = null;
  for (let i = 0; i < lista.length; i++) { if (lista[i][0] <= data) v = lista[i][1]; else break; }
  return v;
}

export default async function handler(req, res) {
  if (aplicarCors(req, res, 'POST,OPTIONS')) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  try {
    // ── Aluno da plataforma nova ──
    const m = String(req.headers.authorization || '').match(/^Bearer (.+)$/);
    if (!m) throw erro(401, 'Faça login novamente.');
    const aluno = await admin.auth().verifyIdToken(m[1]).catch(() => { throw erro(401, 'Sessão expirada. Faça login novamente.'); });
    const db = admin.firestore();
    const perfil = await db.collection('users').doc(aluno.uid).get();
    const pd = perfil.exists ? perfil.data() : {};
    if (pd.role !== 'admin' && pd.aprovado !== true) throw erro(403, 'Seu acesso ainda não foi liberado.');

    // ── Limite de tentativas (10 por hora) ──
    const hora = new Date().toISOString().slice(0, 13);
    const tRef = db.collection('migracao_tentativas').doc(aluno.uid + '_' + hora);
    const tentativas = await db.runTransaction(async (t) => {
      const s = await t.get(tRef);
      const n = (s.exists ? s.data().n : 0) + 1;
      t.set(tRef, { uid: aluno.uid, hora, n }, { merge: true });
      return n;
    });
    if (tentativas > LIMITE_TENTATIVAS) throw erro(429, 'Muitas tentativas. Aguarde uma hora e tente de novo.');

    // ── Login na plataforma antiga ──
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const email = String(body.email || '').trim();
    const senha = String(body.senha || '');
    if (!email || !senha) throw erro(400, 'Informe o e-mail e a senha da plataforma antiga.');

    // Mesmo formato da tela de login antiga: { email, password }
    let token = null, mensagem = '';
    const r = await comTempo(API_ANTIGA + '/login', {
      method: 'POST', headers: CABECALHOS, body: JSON.stringify({ email, password: senha }),
    }, 25000).catch(() => null);
    if (r) {
      const j = await r.json().catch(() => ({}));
      if (j && j.token) token = j.token;
      else mensagem = (j && (j.message || j.error)) || ('status ' + r.status);
    } else mensagem = 'sem resposta';
    if (!token) throw erro(401, 'Não foi possível entrar na plataforma antiga com esse e-mail e senha.' + (mensagem ? ' (' + mensagem + ')' : ''));

    // ── Carteira do aluno na plataforma antiga ──
    const rw = await comTempo(API_ANTIGA + '/wallet/transactions/false/all', {
      headers: { ...CABECALHOS, Authorization: 'Bearer ' + token },
    }, 30000).catch(() => null);
    if (!rw || !rw.ok) throw erro(502, 'A plataforma antiga não respondeu. Tente de novo em instantes.');
    const dados = await rw.json().catch(() => ({}));
    const todos = Object.values((dados && dados.wallet) || {}).flat();

    // Ativos com grupamento (G) ou desdobramento (S): na plataforma antiga, a compra
    // original desses ativos fica marcada como "inativa" e o evento passa a representá-la.
    // Essas compras NÃO foram excluídas pelo aluno: importamos a compra original e a
    // Minha Carteira aplica o evento sozinha (como faz com qualquer compra antiga).
    // Cada evento preserva o valor total da compra que ele substituiu
    // (ex.: 30 × 2,94 = 88,20 → grupamento 3 × 29,40 = 88,20). Usamos isso para
    // ligar a compra inativa ao seu evento; inativa SEM evento correspondente
    // é compra excluída pelo aluno e fica de fora.
    const eventos = [];
    todos.forEach(x => {
      const t = String(x.type || '').toUpperCase();
      if ((t === 'G' || t === 'S') && x.inactive !== true) {
        eventos.push({ ativo: String(x.idStock || x.symbol), total: Math.abs(num(x.total)), usado: false });
      }
    });
    function ligadaAEvento(x) {
      const ativo = String(x.idStock || x.symbol);
      const total = Math.abs(num(x.total)) || Math.abs(num(x.amount) * num(x.price));
      const ev = eventos.find(e => !e.usado && e.ativo === ativo && total > 0 &&
                                   Math.abs(e.total - total) <= Math.max(0.05, total * 0.005));
      if (ev) { ev.usado = true; return true; }
      return false;
    }

    const resumo = { total: todos.length, compras: 0, vendas: 0, proventos: 0, eventos: 0, excluidos: 0, invalidos: 0, ajustadasPorEvento: 0 };
    const itens = [];
    todos.forEach(x => {
      const tipoOp = String(x.type || '').toUpperCase();
      if (x.executed === false) { resumo.excluidos++; return; }
      if (x.inactive === true) {
        const ajustada = (tipoOp === 'C' || tipoOp === 'V') && ligadaAEvento(x);
        if (!ajustada) { resumo.excluidos++; return; }
        resumo.ajustadasPorEvento++;
      }
      if (tipoOp === 'D' || tipoOp === 'J' || tipoOp === 'R') { resumo.proventos++; return; }
      if (tipoOp !== 'C' && tipoOp !== 'V') { resumo.eventos++; return; }

      const tipo = tipoNovo(x.category, x.exchange);
      const qtd = Math.abs(num(x.amount));
      let preco = num(x.price);
      if (!(preco > 0) && qtd > 0) preco = Math.abs(num(x.total)) / qtd;
      const data = String(x.date || '').slice(0, 10);
      const ticker = tickerNovo(x.symbol, tipo);
      if (!ticker || !(qtd > 0) || !(preco > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(data)) { resumo.invalidos++; return; }

      if (tipoOp === 'C') resumo.compras++; else resumo.vendas++;
      itens.push({
        idV1: String(x.idWalletTansaction || x.idWalletTransaction || ''),
        ticker, tipo, op: tipoOp, qtd, preco,
        moeda: US.includes(tipo) ? 'USD' : 'BRL',
        data,
        corretora: x.broker || '',
        nome: x.name || '',
      });
    });

    // ── PTAX da data de cada compra em dólar ──
    const usd = itens.filter(i => i.moeda === 'USD');
    if (usd.length) {
      try {
        const datas = usd.map(i => i.data).sort();
        const lista = await ptaxPeriodo(datas[0], datas[datas.length - 1]);
        usd.forEach(i => { const v = ptaxNaData(lista, i.data); if (v) i.fxRate = v; });
      } catch (e) {
        console.warn('[migrar] PTAX indisponível:', e.message); // a página usa o câmbio atual
      }
    }

    itens.sort((a, b) => a.data.localeCompare(b.data));
    return res.status(200).json({ ok: true, resumo, itens });
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error('[migrar]', e.message);
    return res.status(status).json({ error: status === 500 ? 'Erro interno. Tente de novo.' : e.message });
  }
}
