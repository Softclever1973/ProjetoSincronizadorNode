/**
 * Resposta de erro sem vazar detalhe interno (SQL, schema, host do banco): o erro completo vai
 * só para o log, com um ID que também aparece na resposta — use-o para achar no log.
 * Passam para o usuário só mensagens nossas (isValidation/isForbidden) e erros de dado do
 * Postgres, traduzidos (classe 22 = valor inválido, 23 = restrição).
 */
const MENSAGENS_PG = {
  '23505': 'Já existe um registro com esse valor.',
  '23503': 'O registro está ligado a outro cadastro (referência inexistente ou em uso).',
  '23502': 'Campo obrigatório não preenchido.',
  '23514': 'Valor não permitido para o campo.',
  '22001': 'Texto maior que o tamanho permitido.',
  '22003': 'Número fora do limite permitido.',
  '22007': 'Data em formato inválido.',
  '22008': 'Data fora do intervalo permitido.',
  '22P02': 'Valor em formato inválido.',
};

const ehErroDeDado = e => /^2[23]/.test(String(e?.code || ''));

function novoIdErro() {
  return `SRV-${Date.now().toString(36).slice(-6).toUpperCase()}${Math.floor(Math.random() * 36).toString(36).toUpperCase()}`;
}

// Loga e devolve { status, mensagem, id } seguros para o cliente.
function erroSeguro(e, rota) {
  if (e?.isForbidden) return { status: 403, mensagem: e.message };
  if (e?.isValidation) return { status: 400, mensagem: e.message };
  const id = novoIdErro();
  console.error(`[${id}] ${rota}:`, e?.stack || e?.message || e);
  if (ehErroDeDado(e)) return { status: /^23(505|503)$/.test(e.code) ? 409 : 400, mensagem: MENSAGENS_PG[e.code] || 'Dado inválido.', id };
  return { status: 500, mensagem: 'Erro interno do servidor.', id };
}

// Método + caminho, sem query string (no sync ela leva o token).
const rotaDaRequisicao = req => (req ? `${req.method} ${req.baseUrl || ''}${req.path || ''}` : '?');

// chave: 'erro' (site) ou 'message' (rotas do sync/TSM*, formato herdado do DataSnap).
function erroServidor(res, e, rota, chave = 'erro') {
  const { status, mensagem, id } = erroSeguro(e, rota || rotaDaRequisicao(res.req));
  if (res.headersSent) return;
  res.status(status).json(id ? { [chave]: mensagem, id } : { [chave]: mensagem });
}

// Erro de validação nosso: a mensagem pode ir para o usuário.
const erroValidacao = mensagem => Object.assign(new Error(mensagem), { isValidation: true });

module.exports = { erroServidor, erroSeguro, erroValidacao, ehErroDeDado };
