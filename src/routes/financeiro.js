const express      = require('express');
const router       = express.Router();
const { pool, withTenantConnection, query } = require('../db');
const authJwt      = require('../middleware/authJwt');
const { requireRole } = require('../middleware/checkRole');
const { requirePlanFeature } = require('../middleware/requirePlanFeature');
const { registrarAuditLog, gerarContasReceberDoPedido } = require('./resources/helpers');

function checkSchema(req, res, next) {
  if (!req.userSchemas.includes(req.params.schema))
    return res.status(403).json({ erro: 'acesso negado' });
  next();
}

const guard = [authJwt, checkSchema, requireRole('gerente', 'dono'), requirePlanFeature('financeiro')];

// ── GET /api/:schema/financeiro/contas-receber ────────────────────────────────

const CR_SORT_MAP = {
  data_vencimento: 'ar.vencimento',
  nome_cliente:    'c.razao_social',
  descricao:       'ar.descricao',
  parcela:         'ar.parcela',
  valor:           'ar.valor',
  status:          'ar.status',
  srv_id:          'ar.srv_id',
};
const CP_SORT_MAP = {
  data_vencimento: 'ap.vencimento',
  fornecedor:      'ap.credor',
  descricao:       'ap.descricao',
  valor:           'ap.valor',
  status:          'ap.status',
  srv_id:          'ap.srv_id',
};

router.get('/:schema/financeiro/contas-receber', ...guard, async (req, res) => {
  const s = req.params.schema;
  const { status, data_inicio, data_fim, q, sortCol, sortDir } = req.query;
  const page     = Math.max(1, parseInt(req.query.page     || '1'));
  const pageSize = Math.min(100, parseInt(req.query.pageSize || '50'));
  const filtroLoja = req.query.filtroLoja !== undefined ? parseInt(req.query.filtroLoja) : null;
  const orderCol = CR_SORT_MAP[sortCol] ?? 'ar.vencimento';
  const orderDir = sortDir === 'DESC' ? 'DESC' : 'ASC';

  const conds = ['TRUE'];
  const params = [];

  if (status && status !== 'todos') {
    if (status === 'vencido') {
      conds.push(`LOWER(ar.status::text) NOT IN ('recebido','realizada','recebida','pago','paga','cancelado','cancelada') AND ar.vencimento < CURRENT_DATE`);
    } else if (status === 'recebido') {
      conds.push(`LOWER(ar.status::text) IN ('recebido','realizada','recebida')`);
    } else if (status === 'cancelado') {
      conds.push(`LOWER(ar.status::text) LIKE 'cancelad%'`);
    } else {
      params.push(status);
      conds.push(`ar.status ILIKE $${params.length}`);
    }
  }
  if (data_inicio) { params.push(data_inicio); conds.push(`ar.vencimento >= $${params.length}`); }
  if (data_fim)    { params.push(data_fim);    conds.push(`ar.vencimento <= $${params.length}`); }
  if (q)           { params.push(`%${q}%`);    conds.push(`(ar.descricao ILIKE $${params.length} OR c.razao_social ILIKE $${params.length})`); }
  if (filtroLoja !== null && !isNaN(filtroLoja)) { params.push(filtroLoja); conds.push(`ar.id_loja = $${params.length}`); }

  const where = conds.join(' AND ');
  const joinClientes = `FROM ${s}.a_receber ar LEFT JOIN ${s}.clientes c ON c.srv_id = ar.id_cliente`;

  try {
    const [rows, total] = await Promise.all([
      pool.query(
        `SELECT
           ar.srv_id                                         AS id,
           ar.id_a_receber,
           ar.descricao,
           COALESCE(c.fantasia, c.razao_social)              AS nome_cliente,
           ar.valor,
           ar.vencimento                                     AS data_vencimento,
           ar.data_realizado                                  AS data_recebimento,
           CASE
             WHEN LOWER(ar.status::text) IN ('recebido','recebida','realizada','realizado') THEN 'recebido'
             WHEN LOWER(ar.status::text) LIKE 'cancelad%' THEN 'cancelado'
             ELSE 'pendente'
           END                                               AS status,
           ar.id_forma_de_pagamento::text                    AS forma_pagamento,
           ar.parcela,
           CASE
             WHEN ar.observacao ~ '^pedido:[0-9]+:[0-9]+$' THEN
               (SELECT COUNT(*)::INTEGER FROM ${s}.a_receber ar2
                WHERE ar2.observacao LIKE 'pedido:' || split_part(ar.observacao,':',2) || ':%')
             ELSE 1
           END                                               AS total_parcelas,
           ar.observacao,
           ar.id_loja
         ${joinClientes}
         WHERE ${where}
         ORDER BY ${orderCol} ${orderDir} NULLS LAST, ar.srv_id DESC
         LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
        params
      ),
      pool.query(
        `SELECT COUNT(*)::INTEGER AS total ${joinClientes} WHERE ${where}`,
        params
      ),
    ]);
    res.json({ registros: rows.rows, total: total.rows[0].total, page, pageSize });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ── POST /api/:schema/financeiro/contas-receber ───────────────────────────────

router.post('/:schema/financeiro/contas-receber', ...guard, async (req, res) => {
  const s = req.params.schema;
  const { descricao, nome_cliente, valor, data_vencimento, data_recebimento,
          status, forma_pagamento, parcela, total_parcelas, observacao } = req.body;
  // Gerente/vendedor: loja vem do JWT. Dono: aceita do body (selecionado no modal).
  const id_loja = req.userLojas?.[s] ?? (req.body.id_loja ? parseInt(req.body.id_loja, 10) : null);

  if (!descricao || !valor || !data_vencimento)
    return res.status(400).json({ erro: 'descricao, valor e data_vencimento são obrigatórios' });

  try {
    let id_cliente = null;
    if (nome_cliente) {
      const { rows: cli } = await pool.query(
        `SELECT srv_id FROM ${s}.clientes
         WHERE razao_social ILIKE $1 OR fantasia ILIKE $1
         LIMIT 1`,
        [nome_cliente]
      );
      id_cliente = cli[0]?.srv_id ?? null;
    }

    // O sync usa uma sequence por tabela: seq_srv_id_a_receber.
    // Criamos se não existir e avançamos para além do max atual antes de alocar.
    await pool.query(`CREATE SEQUENCE IF NOT EXISTS ${s}.seq_srv_id_a_receber START WITH 1`);
    await pool.query(`
      SELECT setval(
        '${s}.seq_srv_id_a_receber',
        GREATEST(
          (SELECT last_value FROM ${s}.seq_srv_id_a_receber),
          (SELECT COALESCE(MAX(srv_id), 0) FROM ${s}.a_receber)
        )
      )
    `);
    const { rows: [{ next_srv_id }] } = await pool.query(
      `SELECT nextval('${s}.seq_srv_id_a_receber') AS next_srv_id`
    );
    // Registra no srv_id_map com chave sintética para que o sync não reutilize este srv_id.
    await pool.query(
      `INSERT INTO ${s}.srv_id_map (tabela, id_local, srv_id)
       VALUES ('A_RECEBER', $1, $2)
       ON CONFLICT (tabela, id_local) WHERE filial_id IS NULL DO NOTHING`,
      [`web:${next_srv_id}`, next_srv_id]
    );

    const { rows: [r] } = await pool.query(
      `INSERT INTO ${s}.a_receber
         (srv_id, descricao, id_cliente, valor, vencimento, data_realizado,
          status, id_forma_de_pagamento, parcela, observacao, id_loja)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING
         srv_id AS id, descricao, valor,
         vencimento AS data_vencimento, data_realizado AS data_recebimento,
         status, id_forma_de_pagamento::text AS forma_pagamento, parcela, observacao, id_loja`,
      [next_srv_id, descricao, id_cliente, valor, data_vencimento, data_recebimento || null,
       status || 'pendente', parseInt(forma_pagamento) || null, parcela || 1,
       observacao || null, id_loja || null]
    );
    registrarAuditLog(req, s, 'A_RECEBER', 'INSERT', String(r.id), req.body, null);
    res.status(201).json(r);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ── PATCH /api/:schema/financeiro/contas-receber/:id ─────────────────────────

router.patch('/:schema/financeiro/contas-receber/:id', ...guard, async (req, res) => {
  const s   = req.params.schema;
  const id  = parseInt(req.params.id);
  const { descricao, nome_cliente, valor, data_vencimento, data_recebimento,
          status, forma_pagamento, parcela, total_parcelas, observacao, id_loja } = req.body;

  try {
    // Impede reativação de registro cancelado
    const { rows: [atual] } = await pool.query(
      `SELECT * FROM ${s}.a_receber WHERE srv_id = $1`, [id]
    );
    if (!atual) return res.status(404).json({ erro: 'Registro não encontrado' });
    if (atual.status === 'cancelado' && status && status !== 'cancelado') {
      return res.status(422).json({ erro: 'Registro cancelado não pode ter o status alterado.' });
    }

    let id_cliente = null;
    if (nome_cliente) {
      const { rows: cli } = await pool.query(
        `SELECT srv_id FROM ${s}.clientes
         WHERE razao_social ILIKE $1 OR fantasia ILIKE $1
         LIMIT 1`,
        [nome_cliente]
      );
      id_cliente = cli[0]?.srv_id ?? null;
    }

    const { rows: [r], rowCount } = await pool.query(
      `UPDATE ${s}.a_receber SET
         descricao       = COALESCE($1, descricao),
         id_cliente      = COALESCE($2, id_cliente),
         valor           = COALESCE($3, valor),
         vencimento      = COALESCE($4, vencimento),
         data_realizado       = $5,
         status               = COALESCE($6, status),
         id_forma_de_pagamento = COALESCE($7, id_forma_de_pagamento),
         parcela              = COALESCE($8, parcela),
         observacao           = COALESCE($9, observacao),
         id_loja              = COALESCE($10, id_loja)
       WHERE srv_id = $11
       RETURNING
         srv_id AS id, descricao, valor,
         vencimento AS data_vencimento, data_realizado AS data_recebimento,
         status, id_forma_de_pagamento::text AS forma_pagamento, parcela, observacao, id_loja`,
      [descricao || null, id_cliente, valor || null, data_vencimento || null,
       data_recebimento ?? null, status || null, parseInt(forma_pagamento) || null,
       parcela || null, observacao ?? null, id_loja ?? null, id]
    );
    if (rowCount === 0) return res.status(404).json({ erro: 'Registro não encontrado' });
    registrarAuditLog(req, s, 'A_RECEBER', 'UPDATE', String(id), req.body, atual);

    // Sincroniza status de CR de pedido com PEDIDOS_PARCELAS_PAGAMENTOS (em ambas as direções)
    if (r && r.observacao) {
      const match = r.observacao.match(/^pedido:(\d+):(\d+)$/);
      if (match) {
        const idPedido = parseInt(match[1]);
        const parcela  = parseInt(match[2]);
        try {
          await pool.query(
            `ALTER TABLE ${s}.pedidos_parcelas_pagamentos ADD COLUMN IF NOT EXISTS status TEXT`
          );
          if (r.status === 'recebido') {
            await pool.query(
              `UPDATE ${s}.pedidos_parcelas_pagamentos SET status = 'R' WHERE id_pedido = $1 AND parcela = $2`,
              [idPedido, parcela]
            );
            const { rows: parcs } = await pool.query(
              `SELECT status FROM ${s}.pedidos_parcelas_pagamentos WHERE id_pedido = $1`,
              [idPedido]
            );
            if (parcs.length > 0 && parcs.every(p => p.status === 'R')) {
              await pool.query(
                `UPDATE ${s}.pedidos SET status = 'R' WHERE id_pedido = $1`, [idPedido]
              );
            }
          } else {
            // Voltou para pendente (ou foi cancelada) — desfaz a marca de "parcela paga" no pedido
            await pool.query(
              `UPDATE ${s}.pedidos_parcelas_pagamentos SET status = NULL WHERE id_pedido = $1 AND parcela = $2`,
              [idPedido, parcela]
            );
          }
        } catch (syncErr) {
          console.error('[FIN-sync-parcela]', syncErr.message);
        }
      }
    }

    res.json(r);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ── DELETE /api/:schema/financeiro/contas-receber/:id ────────────────────────

router.delete('/:schema/financeiro/contas-receber/:id', ...guard, async (req, res) => {
  const s  = req.params.schema;
  const id = parseInt(req.params.id);
  try {
    const { rows: [antes] } = await pool.query(
      `SELECT * FROM ${s}.a_receber WHERE srv_id = $1`, [id]
    );
    if (!antes) return res.status(404).json({ erro: 'Registro não encontrado' });
    await pool.query(`DELETE FROM ${s}.a_receber WHERE srv_id = $1`, [id]);
    registrarAuditLog(req, s, 'A_RECEBER', 'DELETE', String(id), null, antes);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ── GET /api/:schema/financeiro/filiais ──────────────────────────────────────

router.get('/:schema/financeiro/filiais', ...guard, async (req, res) => {
  const s = req.params.schema;
  try {
    const rows = await withTenantConnection(s, (db) =>
      query(db, 'SELECT id_loja, nome FROM sync_filiais ORDER BY id_loja')
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ── GET /api/:schema/financeiro/contas-pagar ──────────────────────────────────

router.get('/:schema/financeiro/contas-pagar', ...guard, async (req, res) => {
  const s = req.params.schema;
  const { status, data_inicio, data_fim, q, sortCol, sortDir } = req.query;
  const page     = Math.max(1, parseInt(req.query.page     || '1'));
  const pageSize = Math.min(100, parseInt(req.query.pageSize || '50'));
  const filtroLoja = req.query.filtroLoja !== undefined ? parseInt(req.query.filtroLoja) : null;
  const orderCol = CP_SORT_MAP[sortCol] ?? 'ap.vencimento';
  const orderDir = sortDir === 'DESC' ? 'DESC' : 'ASC';

  const conds = ['TRUE'];
  const params = [];

  if (status && status !== 'todos') {
    if (status === 'vencido') {
      conds.push(`LOWER(ap.status::text) NOT IN ('pago','paga','realizado','realizada','cancelado','cancelada') AND ap.vencimento < CURRENT_DATE`);
    } else if (status === 'pago') {
      conds.push(`LOWER(ap.status::text) IN ('pago','paga','realizado','realizada')`);
    } else if (status === 'cancelado') {
      conds.push(`LOWER(ap.status::text) LIKE 'cancelad%'`);
    } else {
      params.push(status);
      conds.push(`ap.status ILIKE $${params.length}`);
    }
  }
  if (data_inicio) { params.push(data_inicio); conds.push(`ap.vencimento >= $${params.length}`); }
  if (data_fim)    { params.push(data_fim);    conds.push(`ap.vencimento <= $${params.length}`); }
  if (q)           { params.push(`%${q}%`);    conds.push(`(ap.descricao ILIKE $${params.length} OR ap.credor ILIKE $${params.length})`); }
  if (filtroLoja !== null && !isNaN(filtroLoja)) { params.push(filtroLoja); conds.push(`ap.id_loja = $${params.length}`); }

  const where = conds.join(' AND ');
  const fromAP = `FROM ${s}.a_pagar ap`;

  try {
    const [rows, total] = await Promise.all([
      pool.query(
        `SELECT
           ap.srv_id                      AS id,
           ap.id_a_pagar,
           ap.descricao,
           ap.credor                      AS fornecedor,
           ap.valor,
           ap.vencimento                  AS data_vencimento,
           ap.data_realizado              AS data_pagamento,
           CASE
             WHEN LOWER(ap.status::text) IN ('pago','paga','realizado','realizada') THEN 'pago'
             WHEN LOWER(ap.status::text) LIKE 'cancelad%' THEN 'cancelado'
             ELSE 'pendente'
           END                            AS status,
           ap.id_forma_de_pagamento::text AS forma_pagamento,
           ap.observacao,
           ap.id_loja
         ${fromAP}
         WHERE ${where}
         ORDER BY ${orderCol} ${orderDir} NULLS LAST, ap.srv_id DESC
         LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
        params
      ),
      pool.query(`SELECT COUNT(*)::INTEGER AS total ${fromAP} WHERE ${where}`, params),
    ]);
    res.json({ registros: rows.rows, total: total.rows[0].total, page, pageSize });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ── POST /api/:schema/financeiro/contas-pagar ─────────────────────────────────

router.post('/:schema/financeiro/contas-pagar', ...guard, async (req, res) => {
  const s = req.params.schema;
  const { descricao, fornecedor, valor, data_vencimento, data_pagamento,
          status, forma_pagamento, observacao } = req.body;
  // Gerente/vendedor: loja vem do JWT. Dono: aceita do body (selecionado no modal).
  const id_loja = req.userLojas?.[s] ?? (req.body.id_loja ? parseInt(req.body.id_loja, 10) : null);

  if (!descricao || !valor || !data_vencimento)
    return res.status(400).json({ erro: 'descricao, valor e data_vencimento são obrigatórios' });

  try {
    let id_fornecedor = null;
    if (fornecedor) {
      const { rows: forn } = await pool.query(
        `SELECT srv_id FROM ${s}.fornecedores
         WHERE razao_social ILIKE $1 OR fantasia ILIKE $1
         LIMIT 1`,
        [fornecedor]
      );
      id_fornecedor = forn[0]?.srv_id ?? null;
    }

    // O sync usa uma sequence por tabela: seq_srv_id_a_pagar.
    // Criamos se não existir e avançamos para além do max atual antes de alocar.
    await pool.query(`CREATE SEQUENCE IF NOT EXISTS ${s}.seq_srv_id_a_pagar START WITH 1`);
    await pool.query(`
      SELECT setval(
        '${s}.seq_srv_id_a_pagar',
        GREATEST(
          (SELECT last_value FROM ${s}.seq_srv_id_a_pagar),
          (SELECT COALESCE(MAX(srv_id), 0) FROM ${s}.a_pagar)
        )
      )
    `);
    const { rows: [{ next_srv_id }] } = await pool.query(
      `SELECT nextval('${s}.seq_srv_id_a_pagar') AS next_srv_id`
    );
    // Registra no srv_id_map com chave sintética para que o sync não reutilize este srv_id.
    await pool.query(
      `INSERT INTO ${s}.srv_id_map (tabela, id_local, srv_id)
       VALUES ('A_PAGAR', $1, $2)
       ON CONFLICT (tabela, id_local) WHERE filial_id IS NULL DO NOTHING`,
      [`web:${next_srv_id}`, next_srv_id]
    );

    const { rows: [r] } = await pool.query(
      `INSERT INTO ${s}.a_pagar
         (srv_id, descricao, credor, id_fornecedor, valor, vencimento, data_realizado,
          status, id_forma_de_pagamento, observacao, id_loja)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING
         srv_id AS id, descricao, credor AS fornecedor, valor,
         vencimento AS data_vencimento, data_realizado AS data_pagamento,
         status, id_forma_de_pagamento::text AS forma_pagamento, observacao, id_loja`,
      [next_srv_id, descricao, fornecedor || null, id_fornecedor, valor, data_vencimento,
       data_pagamento || null, status || 'pendente', parseInt(forma_pagamento) || null,
       observacao || null, id_loja || null]
    );
    registrarAuditLog(req, s, 'A_PAGAR', 'INSERT', String(r.id), req.body, null);
    res.status(201).json(r);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ── PATCH /api/:schema/financeiro/contas-pagar/:id ───────────────────────────

router.patch('/:schema/financeiro/contas-pagar/:id', ...guard, async (req, res) => {
  const s   = req.params.schema;
  const id  = parseInt(req.params.id);
  const { descricao, fornecedor, valor, data_vencimento, data_pagamento,
          status, forma_pagamento, observacao, id_loja } = req.body;

  try {
    // Impede reativação de registro cancelado
    const { rows: [atual] } = await pool.query(
      `SELECT * FROM ${s}.a_pagar WHERE srv_id = $1`, [id]
    );
    if (!atual) return res.status(404).json({ erro: 'Registro não encontrado' });
    const atualCancelado = String(atual.status ?? '').toLowerCase().startsWith('cancelad');
    const novoCancelado  = String(status ?? '').toLowerCase().startsWith('cancelad');
    if (atualCancelado && status && !novoCancelado) {
      return res.status(422).json({ erro: 'Registro cancelado não pode ter o status alterado.' });
    }

    let id_fornecedor = null;
    if (fornecedor) {
      const { rows: forn } = await pool.query(
        `SELECT srv_id FROM ${s}.fornecedores
         WHERE razao_social ILIKE $1 OR fantasia ILIKE $1
         LIMIT 1`,
        [fornecedor]
      );
      id_fornecedor = forn[0]?.srv_id ?? null;
    }

    const { rows: [r], rowCount } = await pool.query(
      `UPDATE ${s}.a_pagar SET
         descricao              = COALESCE($1, descricao),
         credor                 = COALESCE($2, credor),
         id_fornecedor          = COALESCE($3, id_fornecedor),
         valor                  = COALESCE($4, valor),
         vencimento             = COALESCE($5, vencimento),
         data_realizado         = $6,
         status                 = COALESCE($7, status),
         id_forma_de_pagamento  = COALESCE($8, id_forma_de_pagamento),
         observacao             = $9,
         id_loja                = COALESCE($10, id_loja)
       WHERE srv_id = $11
       RETURNING
         srv_id AS id, descricao, credor AS fornecedor, valor,
         vencimento AS data_vencimento, data_realizado AS data_pagamento,
         status, id_forma_de_pagamento::text AS forma_pagamento, observacao, id_loja`,
      [descricao || null, fornecedor || null, id_fornecedor, valor || null,
       data_vencimento || null, data_pagamento ?? null, status || null,
       parseInt(forma_pagamento) || null, observacao ?? null, id_loja ?? null, id]
    );
    if (rowCount === 0) return res.status(404).json({ erro: 'Registro não encontrado' });
    registrarAuditLog(req, s, 'A_PAGAR', 'UPDATE', String(id), req.body, atual);
    res.json(r);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ── DELETE /api/:schema/financeiro/contas-pagar/:id ──────────────────────────

router.delete('/:schema/financeiro/contas-pagar/:id', ...guard, async (req, res) => {
  const s  = req.params.schema;
  const id = parseInt(req.params.id);
  try {
    const { rows: [antes] } = await pool.query(
      `SELECT * FROM ${s}.a_pagar WHERE srv_id = $1`, [id]
    );
    if (!antes) return res.status(404).json({ erro: 'Registro não encontrado' });
    await pool.query(`DELETE FROM ${s}.a_pagar WHERE srv_id = $1`, [id]);
    registrarAuditLog(req, s, 'A_PAGAR', 'DELETE', String(id), null, antes);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ── GET /api/:schema/financeiro/fluxo-caixa ──────────────────────────────────
// Agregação diária de entradas (CR recebidos) + saídas (CP pagos) + MOV_CAIXA.

router.get('/:schema/financeiro/fluxo-caixa', ...guard, async (req, res) => {
  const s = req.params.schema;
  const mes = req.query.mes || new Date().toISOString().slice(0, 7); // YYYY-MM
  const filtroLoja = req.query.filtroLoja !== undefined ? parseInt(req.query.filtroLoja) : null;

  const lojaWhereCR = filtroLoja !== null && !isNaN(filtroLoja) ? `AND id_loja = ${filtroLoja}` : '';

  try {
    const temMovCaixa = await pool.query(`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = $1 AND table_name = 'mov_caixa'
    `, [s.toLowerCase()]);

    const movCaixaUnion = temMovCaixa.rows.length > 0 ? `
      UNION ALL
      SELECT
        COALESCE(DATA_MOV::DATE, DATE_TRUNC('month', '${mes}-01'::DATE)) AS data,
        SUM(CASE WHEN TIPO IN ('E','ENTRADA') THEN COALESCE(VALOR,0) ELSE 0 END) AS entradas,
        SUM(CASE WHEN TIPO IN ('S','SAIDA','SAÍDA') THEN COALESCE(VALOR,0) ELSE 0 END) AS saidas
      FROM ${s}.MOV_CAIXA
      WHERE DATA_MOV::DATE >= '${mes}-01'::DATE AND DATA_MOV::DATE < ('${mes}-01'::DATE + INTERVAL '1 month')
        ${filtroLoja !== null && !isNaN(filtroLoja) ? `AND ID_LOJA = ${filtroLoja}` : ''}
      GROUP BY DATA_MOV::DATE
    ` : '';

    const { rows } = await pool.query(`
      WITH base AS (
        SELECT
          data_realizado::DATE AS data,
          SUM(valor) AS entradas,
          0::NUMERIC AS saidas
        FROM ${s}.a_receber
        WHERE LOWER(COALESCE(status::text,'')) IN ('recebido','recebida','realizada','realizado')
          AND data_realizado::DATE >= '${mes}-01'::DATE
          AND data_realizado::DATE < ('${mes}-01'::DATE + INTERVAL '1 month')
          ${lojaWhereCR}
        GROUP BY data_realizado::DATE

        UNION ALL

        SELECT
          data_realizado::DATE AS data,
          0::NUMERIC AS entradas,
          SUM(valor) AS saidas
        FROM ${s}.a_pagar
        WHERE LOWER(COALESCE(status::text,'')) IN ('pago','paga','realizado','realizada')
          AND data_realizado::DATE >= '${mes}-01'::DATE
          AND data_realizado::DATE < ('${mes}-01'::DATE + INTERVAL '1 month')
          ${lojaWhereCR}
        GROUP BY data_realizado::DATE

        ${movCaixaUnion}
      ),
      agrupado AS (
        SELECT
          data,
          SUM(entradas) AS entradas,
          SUM(saidas)   AS saidas
        FROM base
        GROUP BY data
        ORDER BY data
      )
      SELECT
        data,
        entradas,
        saidas,
        SUM(entradas - saidas) OVER (ORDER BY data ROWS UNBOUNDED PRECEDING) AS saldo_acumulado
      FROM agrupado
      ORDER BY data
    `);

    res.json(rows);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ── POST /api/:schema/financeiro/parcelas-pedido ─────────────────────────────
// Gera as A_RECEBER pendentes de um pedido a partir de PEDIDOS_PARCELAS_PAGAMENTOS.
// Só cria algo se o pedido já estiver STATUS = 'R' (Realizado) — ver
// gerarContasReceberDoPedido() em resources/helpers.js. Chamado após gerar as
// parcelas no modal de Pagamento; se o pedido ainda não foi realizado, é um no-op
// seguro (o gate real acontece na transição de STATUS para 'R').
// Acessível a qualquer usuário autenticado (sem restrição de role).

router.post('/:schema/financeiro/parcelas-pedido', authJwt, checkSchema, async (req, res) => {
  const s = req.params.schema;
  const { id_pedido } = req.body;
  if (!id_pedido)
    return res.status(400).json({ erro: 'id_pedido é obrigatório' });
  try {
    const resultado = await gerarContasReceberDoPedido(s, id_pedido);
    res.status(201).json(resultado);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ── DELETE /api/:schema/financeiro/parcelas-pedido/:id_pedido/:parcela ────────
// Remove o A_RECEBER correspondente a uma parcela de pedido (se ainda pendente).

router.delete('/:schema/financeiro/parcelas-pedido/:id_pedido/:parcela', authJwt, checkSchema, async (req, res) => {
  const s   = req.params.schema;
  const obs = `pedido:${req.params.id_pedido}:${req.params.parcela}`;
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM ${s}.a_receber
       WHERE observacao = $1
         AND LOWER(status::text) NOT IN ('recebido','recebida','realizado','realizada')`,
      [obs]
    );
    res.json({ deletados: rowCount });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

module.exports = router;
