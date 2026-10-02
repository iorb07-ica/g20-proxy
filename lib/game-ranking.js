// lib/game-ranking.js — "Juiz automático" do Game G20 (out/2026)
//
// O QUE FAZ
//   Calcula o ranking das três janelas do Game (mensal, trimestral e anual) e
//   grava em game-g20-ranking/atual, o documento que o card do dashboard lê.
//   Antes, quem calculava e gravava era o navegador do primeiro aluno que
//   abria o Game no dia: um aluno que soubesse programar podia gravar um
//   placar inventado. Agora só o servidor grava (as Firestore Rules deixam
//   esse documento só para o admin; o Admin SDK passa por cima das Rules).
//
// A CONTA É A MESMA DO GAME
//   · Preço base = fechamento do último dia do período ANTERIOR
//     (mensal 2026-11 → 31/10; trimestral T4 → 30/09; anual 2027 → 31/12/2026)
//   · Rentabilidade do ativo = (preço atual − base) / base
//   · Rentabilidade do jogador = média simples dos ativos com preço
//   · Datas e ciclos no horário de Brasília (o servidor roda em UTC)
//
// QUEM CHAMA
//   · O cron diário da Vercel, via /api/backup?job=ranking (19h de Brasília)
//   · O admin, pelo botão "Atualizar ranking agora" no Game
//   Não é uma rota: fica fora de /api e não conta no limite de 12 funções.
//
// CUSTO: zero. Algumas dezenas de leituras do Firestore por execução e
// chamadas ao próprio proxy (/api/quote e /api/history) para os preços.

const PROXY = 'https://g20-proxy.vercel.app';
const ORIGEM = 'https://iorb07-ica.github.io';   // as rotas de preço só atendem esta origem
const YH_MAP = {
  'BTC':'BTC-USD','ETH':'ETH-USD','BNB':'BNB-USD','SOL':'SOL-USD','ADA':'ADA-USD',
  'DOT':'DOT-USD','HNT':'HNT-USD','SAND':'SAND-USD','MANA':'MANA-USD','LINK':'LINK-USD',
  'MATIC':'MATIC-USD','AVAX':'AVAX-USD','UNI':'UNI-USD','ATOM':'ATOM-USD','XRP':'XRP-USD',
  'BRK.B':'BRK-B','BRK.A':'BRK-A'
};
const ROT_TRI = ['', 'Jan-Mar', 'Abr-Jun', 'Jul-Set', 'Out-Dez'];
const MESES = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];

// ── Datas no horário de Brasília (UTC−3, sem horário de verão) ──────────────
function agoraBRT() { const d = new Date(Date.now() - 3 * 3600 * 1000); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, dia: d.toISOString().slice(0, 10) }; }
function ultimoDia(y, m) { return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); }   // m 1-12; dia 0 do mês seguinte
function inicioBRT(y, m) { return Date.UTC(y, m - 1, 1, 3, 0, 0); }                           // meia-noite de Brasília do dia 1

function cicloAoVivo(tipo, t) {
  if (tipo === 'mensal') {
    const nome = MESES[t.m - 1];
    return { key: t.y + '-' + String(t.m).padStart(2, '0'), label: nome.charAt(0).toUpperCase() + nome.slice(1) + ' de ' + t.y,
             base: ultimoDia(t.m === 1 ? t.y - 1 : t.y, t.m === 1 ? 12 : t.m - 1) };
  }
  if (tipo === 'trimestral') {
    const q = Math.ceil(t.m / 3), m0 = (q - 1) * 3 + 1;
    return { key: t.y + '-T' + q, label: 'T' + q + ' (' + ROT_TRI[q] + ') ' + t.y,
             base: ultimoDia(m0 === 1 ? t.y - 1 : t.y, m0 === 1 ? 12 : m0 - 1) };
  }
  return { key: String(t.y), label: 'Anual ' + t.y, base: (t.y - 1) + '-12-31' };
}
function cicloAlvo(tipo, t) {
  if (tipo === 'mensal') {
    const nm = t.m === 12 ? 1 : t.m + 1, ny = t.m === 12 ? t.y + 1 : t.y, nome = MESES[nm - 1];
    return { key: ny + '-' + String(nm).padStart(2, '0'), label: nome.charAt(0).toUpperCase() + nome.slice(1) + ' de ' + ny, prazo: inicioBRT(ny, nm) - 1000, fechado: false };
  }
  if (tipo === 'trimestral') {
    const q = Math.ceil(t.m / 3), nq = q === 4 ? 1 : q + 1, qy = q === 4 ? t.y + 1 : t.y;
    return { key: qy + '-T' + nq, label: 'T' + nq + ' (' + ROT_TRI[nq] + ') ' + qy, prazo: inicioBRT(qy, (nq - 1) * 3 + 1) - 1000, fechado: false };
  }
  return { key: String(t.y + 1), label: 'Anual ' + (t.y + 1), prazo: inicioBRT(t.y + 1, 1) - 1000, fechado: false };
}

// ── Texto e ticker de aluno nunca viram HTML ────────────────────────────────
function txt(s, def) { s = String(s == null ? '' : s).replace(/[<>&"'`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60); return s || def || ''; }
function tickerOk(t) { return /^[A-Z0-9.\-]{1,14}$/.test(String(t || '').toUpperCase()); }

function simbolo(ticker, classe, paraHistorico) {
  const t = String(ticker).trim().toUpperCase();
  if (classe === 'acao-br' || classe === 'fii' || !classe) return t + '.SA';
  if (paraHistorico) { if (YH_MAP[t]) return YH_MAP[t]; if (classe === 'cripto') return t + '-USD'; return t; }
  return t;   // /api/quote faz o mapeamento sozinho
}

async function getJSON(url) {
  const r = await fetch(url, { headers: { Origin: ORIGEM } });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url.split('?')[0]);
  return r.json();
}

// Preço de fechamento numa data (para a base). Falha vira null (ativo fica fora da média).
async function precoBase(ticker, classe, data) {
  try {
    const d = await getJSON(PROXY + '/api/history?_src=date&symbol=' + encodeURIComponent(simbolo(ticker, classe, true)) + '&date=' + data);
    const px = d && d.close != null ? parseFloat(d.close) : null;
    return px > 0 ? px : null;
  } catch (e) { return null; }
}

// Cotações atuais em lotes de 40 (a rota aceita CSV).
async function precosAtuais(lista) {   // lista: [{ticker, classe}]
  const out = {};
  for (let i = 0; i < lista.length; i += 40) {
    const lote = lista.slice(i, i + 40);
    const sym2tk = {};
    lote.forEach(a => { sym2tk[simbolo(a.ticker, a.classe, false).toUpperCase()] = a.ticker; });
    try {
      const d = await getJSON(PROXY + '/api/quote?symbol=' + encodeURIComponent(Object.keys(sym2tk).join(',')));
      if (lote.length === 1 && d && d.price != null) { out[lote[0].ticker] = parseFloat(d.price); continue; }
      Object.keys(d || {}).forEach(sym => {
        const o = d[sym]; if (!o || o.price == null) return;
        let tk = sym2tk[sym.toUpperCase()];
        if (!tk) { const b = sym.toUpperCase().replace(/\.SA$/, '').replace(/-USD$/, ''); tk = sym2tk[b] || sym2tk[b + '.SA']; }
        if (tk) out[tk] = parseFloat(o.price);
      });
    } catch (e) { /* lote sem preço: os ativos ficam fora da média */ }
  }
  return out;
}

// Executa N promessas por vez (não estoura o proxy).
async function emLotes(itens, n, fn) {
  const res = [];
  for (let i = 0; i < itens.length; i += n) res.push(...await Promise.all(itens.slice(i, i + n).map(fn)));
  return res;
}

export async function publicarRanking(admin) {
  const db = admin.firestore();
  const t = agoraBRT();
  const ref = db.collection('game-g20-ranking').doc('atual');
  const antes = await ref.get();
  const hist = (antes.exists && Array.isArray(antes.data().historico)) ? antes.data().historico : [];
  const ontem = hist.filter(h => h && h.d && h.d < t.dia).slice(-1)[0] || null;

  // 1) carteiras de cada janela
  const janelas = {};
  const nomesUid = new Set();
  const precisa = {};   // ticker -> classe
  for (const tipo of ['mensal', 'trimestral', 'anual']) {
    const viva = cicloAoVivo(tipo, t);
    const snap = await db.collectionGroup('carteiras').where('cicloKey', '==', viva.key).get();
    const jog = [];
    snap.forEach(doc => {
      const d = doc.data() || {};
      if (!d.uid || !Array.isArray(d.ativos)) return;
      const ativos = d.ativos.filter(a => a && tickerOk(a.ticker)).map(a => ({ ticker: String(a.ticker).toUpperCase(), classe: String(a.classe || '') }));
      if (!ativos.length) return;
      ativos.forEach(a => { if (!precisa[a.ticker]) precisa[a.ticker] = a.classe; });
      nomesUid.add(d.uid);
      jog.push({ uid: String(d.uid), ativos });
    });
    janelas[tipo] = { viva, alvo: cicloAlvo(tipo, t), jog };
  }

  // 2) nomes (perfil público)
  const nomes = {};
  const uids = Array.from(nomesUid);
  for (let i = 0; i < uids.length; i += 100) {
    const refs = uids.slice(i, i + 100).map(u => db.collection('networking_public').doc(u));
    if (!refs.length) continue;
    const docs = await db.getAll(...refs);
    docs.forEach(d => { if (d.exists) { const v = d.data(); nomes[d.id] = txt(v.nome || v.name, 'Aluno G20'); } });
  }

  // 3) preços: atuais (uma vez) e base (por janela, pois a data muda)
  const lista = Object.keys(precisa).map(tk => ({ ticker: tk, classe: precisa[tk] }));
  const atual = await precosAtuais(lista);

  const doc = { historico: null, origem: 'servidor' };
  const foto = { d: t.dia, mensal: {}, trimestral: {}, anual: {} };
  const resumo = {};
  for (const tipo of ['mensal', 'trimestral', 'anual']) {
    const J = janelas[tipo];
    const tks = Array.from(new Set(J.jog.flatMap(j => j.ativos.map(a => a.ticker))));
    const base = {};
    await emLotes(tks, 8, async tk => { base[tk] = await precoBase(tk, precisa[tk], J.viva.base); });

    const retornos = {};
    const jogadores = J.jog.map(j => {
      const rets = j.ativos.map(a => {
        const b = base[a.ticker], p = atual[a.ticker];
        const r = (b && p && b > 0) ? (p - b) / b * 100 : null;
        return { ticker: a.ticker, ret: r == null ? null : Math.round(r * 100) / 100 };
      });
      const com = rets.filter(x => x.ret != null);
      const rent = com.length ? com.reduce((s, x) => s + x.ret, 0) / com.length : 0;
      retornos[j.uid] = rets.sort((x, y) => (x.ret == null) - (y.ret == null) || (y.ret || 0) - (x.ret || 0));
      return { uid: j.uid, nome: nomes[j.uid] || 'Aluno G20', retorno: Math.round(rent * 100) / 100 };
    }).sort((a, b) => b.retorno - a.retorno);

    jogadores.forEach((j, i) => {
      j.pos = i + 1;
      const p0 = ontem && ontem[tipo] ? ontem[tipo][j.uid] : null;
      j.posOntem = (p0 != null) ? p0 : null;
      foto[tipo][j.uid] = j.pos;
    });
    doc[tipo] = { total: jogadores.length, alvo: J.alvo, ciclo: J.viva.label, jogadores, retornos };
    resumo[tipo] = { ciclo: J.viva.key, jogadores: jogadores.length, ativos: tks.length, semPreco: tks.filter(tk => !(base[tk] && atual[tk])).length };
  }

  doc.historico = hist.filter(h => h && h.d && h.d !== t.dia).concat([foto]).slice(-7);
  doc.atualizadoEm = admin.firestore.FieldValue.serverTimestamp();
  await ref.set(doc);
  return { ok: true, dia: t.dia, resumo };
}
