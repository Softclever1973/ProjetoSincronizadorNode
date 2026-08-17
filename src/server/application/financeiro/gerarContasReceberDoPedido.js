const { pool } = require('../../infrastructure/db');

/**
 * Garante que existam registros em A_RECEBER para as parcelas de pagamento de um
 * pedido — mas só quando o pedido já está com STATUS = 'R' (Realizado). Pagamento
 * não é pré-requisito para "Realizado": este é o único gate.
 *
 * Idempotente: pula parcelas que já têm um A_RECEBER correspondente (dedup via
 * observacao = 'pedido:<id_pedido>:<parcela>'). Seguro de chamar repetidamente —
 * ex.: quando o pedido já era 'R' e novas parcelas são geradas depois.
 *
 * @param {string} schema
 * @param {number|string} idPedido
 * @returns {Promise<{ criados: object[] }>}
 */
async function gerarContasReceberDoPedido(schema, idPedido) {
  const { rows: pedRows } = await pool.query(
    `SELECT status, id_cliente, id_loja, id_vendedor FROM ${schema}.pedidos WHERE id_pedido = $1 LIMIT 1`,
    [idPedido]
  );
  const ped = pedRows[0];
  if (!ped || ped.status !== 'R') return { criados: [] };

  let id_cliente_srv = null;
  if (ped.id_cliente) {
    const { rows: c } = await pool.query(
      `SELECT srv_id FROM ${schema}.clientes WHERE id_cliente = $1 LIMIT 1`,
      [ped.id_cliente]
    );
    id_cliente_srv = c[0]?.srv_id ?? null;
  }

  const { rows: parcelas } = await pool.query(
    `SELECT parcela, valor, data_para_pagamento, id_forma_de_pagamento
     FROM ${schema}.pedidos_parcelas_pagamentos WHERE id_pedido = $1 ORDER BY parcela`,
    [idPedido]
  ).catch(() => ({ rows: [] }));
  if (!parcelas.length) return { criados: [] };

  await pool.query(`CREATE SEQUENCE IF NOT EXISTS ${schema}.seq_srv_id_a_receber START WITH 1`);
  await pool.query(`
    SELECT setval(
      '${schema}.seq_srv_id_a_receber',
      GREATEST(
        (SELECT last_value FROM ${schema}.seq_srv_id_a_receber),
        (SELECT COALESCE(MAX(srv_id), 0) FROM ${schema}.a_receber)
      )
    )
  `);

  const criados = [];
  for (const p of parcelas) {
    const obs = `pedido:${idPedido}:${p.parcela}`;
    const existing = await pool.query(
      `SELECT srv_id FROM ${schema}.a_receber WHERE observacao = $1 LIMIT 1`, [obs]
    );
    if (existing.rows.length > 0) continue;

    const { rows: [{ next_id }] } = await pool.query(
      `SELECT nextval('${schema}.seq_srv_id_a_receber') AS next_id`
    );
    await pool.query(
      `INSERT INTO ${schema}.srv_id_map (tabela, id_local, srv_id)
       VALUES ('A_RECEBER', $1, $2) ON CONFLICT (tabela, id_local) WHERE filial_id IS NULL DO NOTHING`,
      [`web:${next_id}`, next_id]
    );
    const desc = `Pedido #${idPedido} - Parcela ${p.parcela}`;
    const { rows: [r] } = await pool.query(
      `INSERT INTO ${schema}.a_receber
         (srv_id, descricao, id_cliente, id_pedido, valor, vencimento, status,
          id_forma_de_pagamento, parcela, observacao, id_loja, id_vendedor)
       VALUES ($1,$2,$3,$4,$5,$6,'Pendente',$7,$8,$9,$10,$11)
       RETURNING srv_id AS id, descricao, valor, vencimento AS data_vencimento, status, parcela`,
      [next_id, desc, id_cliente_srv, idPedido, p.valor, p.data_para_pagamento,
       p.id_forma_de_pagamento ? Number(p.id_forma_de_pagamento) : null,
       p.parcela, obs, ped.id_loja || null, ped.id_vendedor || null]
    );
    if (r) criados.push(r);
  }
  return { criados };
}

module.exports = { gerarContasReceberDoPedido };
