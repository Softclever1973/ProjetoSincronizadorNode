// Pedidos de verificação de sincronização (public.verificacoes_sync): criados no admin, atendidos pelo client.
const { pool } = require('#server/infrastructure/db.js');

// Pedido "executando" sem resposta há mais que isso volta a ser entregue (client caiu no meio).
const REENTREGAR_APOS_MIN = 30;

async function criar({ schema, idLoja, tabelas, solicitadoPor }) {
  // Um pedido aberto por loja: o novo substitui o anterior ainda não atendido.
  await pool.query(
    `UPDATE public.verificacoes_sync SET status = 'cancelada', concluido_em = NOW()
     WHERE schema_name = $1 AND id_loja = $2 AND status = 'pendente'`, [schema, idLoja]);
  const { rows } = await pool.query(
    `INSERT INTO public.verificacoes_sync (schema_name, id_loja, tabelas, solicitado_por, resultado)
     VALUES ($1, $2, $3, $4, '{"tabelas": {}}'::jsonb) RETURNING id, id_loja, status, solicitado_em`,
    [schema, idLoja, tabelas, solicitadoPor ?? null]);
  return rows[0];
}

async function listar(schema, limite = 30) {
  const { rows } = await pool.query(
    `SELECT id, id_loja, tabelas, status, solicitado_em, iniciado_em, concluido_em, erro, resultado
     FROM public.verificacoes_sync WHERE schema_name = $1 ORDER BY id DESC LIMIT $2`, [schema, limite]);
  return rows;
}

async function buscar(id) {
  const { rows } = await pool.query('SELECT * FROM public.verificacoes_sync WHERE id = $1', [id]);
  return rows[0] ?? null;
}

// Entrega ao client o pedido mais antigo da loja (marca como executando).
async function proximoPendente(schema, idLoja) {
  const { rows } = await pool.query(
    `UPDATE public.verificacoes_sync SET status = 'executando', iniciado_em = NOW()
     WHERE id = (
       SELECT id FROM public.verificacoes_sync
       WHERE schema_name = $1 AND id_loja = $2
         AND (status = 'pendente' OR (status = 'executando' AND iniciado_em < NOW() - make_interval(mins => $3)))
       ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING id, tabelas`, [schema, idLoja, REENTREGAR_APOS_MIN]);
  return rows[0] ?? null;
}

// Pedido em execução que pertence a este schema/loja (o client só escreve no próprio pedido).
async function emExecucao(id, schema, idLoja) {
  const { rows } = await pool.query(
    `SELECT id, tabelas, resultado FROM public.verificacoes_sync
     WHERE id = $1 AND schema_name = $2 AND id_loja = $3 AND status = 'executando'`, [id, schema, idLoja]);
  return rows[0] ?? null;
}

async function gravarTabela(id, tabela, dados) {
  await pool.query(
    `UPDATE public.verificacoes_sync SET resultado = jsonb_set(resultado, ARRAY['tabelas', $2::text], $3::jsonb, true)
     WHERE id = $1`, [id, tabela, JSON.stringify(dados)]);
}

async function concluir(id, erro = null) {
  await pool.query(
    `UPDATE public.verificacoes_sync SET status = $2, erro = $3, concluido_em = NOW() WHERE id = $1`,
    [id, erro ? 'erro' : 'concluida', erro]);
}

module.exports = { criar, listar, buscar, proximoPendente, emExecucao, gravarTabela, concluir };
