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

// ── Correções (public.verificacoes_correcoes) ──

async function listarCorrecoes(verificacaoId) {
  const { rows } = await pool.query(
    'SELECT * FROM public.verificacoes_correcoes WHERE verificacao_id = $1 ORDER BY id', [verificacaoId]);
  return rows;
}

// Pedir de novo a mesma chave substitui a correção anterior (lado, status e erro).
async function gravarCorrecao({ verificacaoId, schema, idLoja, tabela, chave, tipoChave, lado, status, erro, solicitadoPor }) {
  const { rows } = await pool.query(
    `INSERT INTO public.verificacoes_correcoes
       (verificacao_id, schema_name, id_loja, tabela, chave, tipo_chave, lado, status, erro, solicitado_por, concluido_em)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CASE WHEN $8 IN ('feita', 'erro') THEN NOW() END)
     ON CONFLICT (verificacao_id, tabela, chave) DO UPDATE SET
       lado = EXCLUDED.lado, status = EXCLUDED.status, erro = EXCLUDED.erro, solicitado_por = EXCLUDED.solicitado_por,
       solicitado_em = NOW(), iniciado_em = NULL, concluido_em = EXCLUDED.concluido_em
     RETURNING *`,
    [verificacaoId, schema, idLoja, tabela, chave, tipoChave, lado, status, erro ?? null, solicitadoPor ?? null]);
  return rows[0];
}

// Entrega ao client as correções "manter loja" desta loja (marca como executando).
async function proximasCorrecoes(schema, idLoja, limite = 100) {
  const { rows } = await pool.query(
    `UPDATE public.verificacoes_correcoes SET status = 'executando', iniciado_em = NOW()
     WHERE id IN (
       SELECT id FROM public.verificacoes_correcoes
       WHERE schema_name = $1 AND id_loja = $2 AND lado = 'loja'
         AND (status = 'pendente' OR (status = 'executando' AND iniciado_em < NOW() - make_interval(mins => $3)))
       ORDER BY id LIMIT $4 FOR UPDATE SKIP LOCKED)
     RETURNING id, tabela, chave, tipo_chave`, [schema, idLoja, REENTREGAR_APOS_MIN, limite]);
  return rows.sort((a, b) => a.id - b.id);
}

// O client só fecha correção da própria loja que esteja em execução.
async function concluirCorrecao(id, schema, idLoja, erro = null) {
  await pool.query(
    `UPDATE public.verificacoes_correcoes SET status = $4, erro = $5, concluido_em = NOW()
     WHERE id = $1 AND schema_name = $2 AND id_loja = $3 AND status = 'executando'`,
    [id, schema, idLoja, erro ? 'erro' : 'feita', erro]);
}

module.exports = {
  criar, listar, buscar, proximoPendente, emExecucao, gravarTabela, concluir,
  listarCorrecoes, gravarCorrecao, proximasCorrecoes, concluirCorrecao,
};
