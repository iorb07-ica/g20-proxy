// api/_cors.js — Porteiro de origem do proxy G20
// Centraliza a verificação de "de onde veio a requisição".
// Só libera requisições vindas dos domínios da plataforma G20.
//
// Como usar em cada endpoint:
//   import { aplicarCors } from './_cors.js';
//   export default async function handler(req, res){
//     if (aplicarCors(req, res)) return;   // bloqueou ou respondeu o preflight
//     ...resto do endpoint...
//   }

// Domínios autorizados a usar o proxy.
// Para adicionar um domínio próprio no futuro, basta incluir aqui.
const ORIGENS_PERMITIDAS = [
  'https://iorb07-ica.github.io',
  'http://localhost:3000',   // testes locais (opcional, pode remover)
  'http://127.0.0.1:5500',   // Live Server do VS Code (opcional, pode remover)
];

// Métodos liberados por padrão (a maioria dos endpoints é GET).
// O ai-import usa POST, então passamos os métodos por parâmetro quando preciso.
export function aplicarCors(req, res, metodos = 'GET,OPTIONS') {
  const origin = req.headers.origin || '';

  // Origem reconhecida → devolve ela mesma no header (libera o browser).
  // Origem desconhecida → não devolve header de liberação (browser bloqueia).
  if (ORIGENS_PERMITIDAS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', metodos);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Preflight (o browser pergunta "posso?") — responde e encerra.
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return true; // sinaliza ao handler que já terminou
  }

  // Bloqueio de verdade: requisição sem origem permitida é barrada.
  // (Requisições server-to-server não mandam Origin; se quiser permitir
  //  ferramentas internas, trate aqui. Para o site, sempre vem Origin.)
  if (!ORIGENS_PERMITIDAS.includes(origin)) {
    res.status(403).json({ error: 'Origem não autorizada' });
    return true; // sinaliza bloqueio
  }

  return false; // liberado, segue o fluxo normal
}
