const { pool } = require('#server/infrastructure/db.js');

const ONLINE_MS = 2 * 60 * 1000;

const _atividade  = new Map(); // userId -> { ultimo, nome, schema, ip, userAgent }
const _revogacoes = new Map(); // userId -> ms de public.usuarios.sessao_revogada_em

async function carregarRevogacoes() {
  const { rows } = await pool.query(
    'SELECT id, sessao_revogada_em FROM public.usuarios WHERE sessao_revogada_em IS NOT NULL'
  );
  _revogacoes.clear();
  for (const r of rows) _revogacoes.set(r.id, new Date(r.sessao_revogada_em).getTime());
}

// iat do JWT é em segundos (arredondado pra baixo): <= derruba também o que foi emitido no mesmo segundo.
function sessaoRevogada(userId, iat) {
  const revogadaEm = _revogacoes.get(userId);
  return revogadaEm != null && iat != null && iat * 1000 <= revogadaEm;
}

async function revogarSessoes(userId) {
  const { rows: [u] } = await pool.query(
    'UPDATE public.usuarios SET sessao_revogada_em = NOW() WHERE id = $1 RETURNING sessao_revogada_em',
    [userId]
  );
  if (!u) return false;
  _revogacoes.set(userId, new Date(u.sessao_revogada_em).getTime());
  _atividade.delete(userId);
  return true;
}

function registrarAtividade(req) {
  const schema = /^\/api\/([a-z_][a-z0-9_]*)\//.exec(req.originalUrl || '')?.[1] || null;
  const anterior = _atividade.get(req.userId);
  _atividade.set(req.userId, {
    ultimo:    Date.now(),
    nome:      req.userName,
    schema:    schema || anterior?.schema || null,
    ip:        req.ip,
    userAgent: req.headers['user-agent'] || null,
  });
}

function listarOnline() {
  const limite = Date.now() - ONLINE_MS;
  const lista = [];
  for (const [id, a] of _atividade) {
    if (a.ultimo < limite) { _atividade.delete(id); continue; }
    lista.push({ id, ...a });
  }
  return lista.sort((x, y) => y.ultimo - x.ultimo);
}

module.exports = { carregarRevogacoes, sessaoRevogada, revogarSessoes, registrarAtividade, listarOnline };
