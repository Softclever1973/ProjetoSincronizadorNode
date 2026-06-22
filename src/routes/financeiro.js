const express      = require('express');
const router       = express.Router();
const { pool }     = require('../db');
const authJwt      = require('../middleware/authJwt');
const { requireRole } = require('../middleware/checkRole');

function checkSchema(req, res, next) {
  if (!req.userSchemas.includes(req.params.schema))
    return res.status(403).json({ erro: 'acesso negado' });
  next();
}

const guard = [authJwt, checkSchema, requireRole('gerente', 'dono')];

// ── GET /api/:schema/financeiro/contas-receber ────────────────────────────────

router.get('/:schema/financeiro/contas-receber', ...guard, async (req, res) => {
  const s = req.params.schema;
  const { status, data_inicio, data_fim, q } = req.query;
  const page     = Math.max(1, parseInt(req.query.page     || '1'));
  const pageSize = Math.min(100, parseInt(req.query.pageSize || '50'));
  const filtroLoja = req.query.filtroLoja !== undefined ? parseInt(req.query.filtroLoja) : null;

  const conds = ['TRUE'];
  const params = [];

  if (status && status !== 'todos') {
    if (status === 'vencido') {
      conds.push(`status = 'pendente' AND data_vencimento < CURRENT_DATE`);
    } else {
      params.push(status);
      conds.push(`status = $${params.length}`);
    }
  }
  if (data_inicio) { params.push(data_inicio); conds.push(`data_vencimento >= $${params.length}`); }
  if (data_fim)    { params.push(data_fim);    conds.push(`data_vencimento <= $${params.length}`); }
  if (q)           { params.push(`%${q}%`);    conds.push(`(descricao ILIKE $${params.length} OR nome_cliente ILIKE $${params.length})`); }
  if (filtroLoja !== null && !isNaN(filtroLoja)) { params.push(filtroLoja); conds.push(`id_loja = $${params.length}`); }

  const where = conds.join(' AND ');

  try {
    const [rows, total] = await Promise.all([
      pool.query(
        `SELECT * FROM ${s}.financeiro_contas_receber WHERE ${where}
         ORDER BY data_vencimento ASC, id DESC
         LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
        params
      ),
      pool.query(`SELECT COUNT(*)::INTEGER AS total FROM ${s}.financeiro_contas_receber WHERE ${where}`, params),
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
          status, forma_pagamento, parcela, total_parcelas, observacao, id_loja } = req.body;

  if (!descricao || !valor || !data_vencimento)
    return res.status(400).json({ erro: 'descricao, valor e data_vencimento são obrigatórios' });

  try {
    const { rows: [r] } = await pool.query(
      `INSERT INTO ${s}.financeiro_contas_receber
         (descricao, nome_cliente, valor, data_vencimento, data_recebimento,
          status, forma_pagamento, parcela, total_parcelas, observacao, id_loja)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [descricao, nome_cliente || null, valor, data_vencimento, data_recebimento || null,
       status || 'pendente', forma_pagamento || null, parcela || 1, total_parcelas || 1,
       observacao || null, id_loja || null]
    );
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
    const { rows: [r], rowCount } = await pool.query(
      `UPDATE ${s}.financeiro_contas_receber SET
         descricao        = COALESCE($1, descricao),
         nome_cliente     = $2,
         valor            = COALESCE($3, valor),
         data_vencimento  = COALESCE($4, data_vencimento),
         data_recebimento = $5,
         status           = COALESCE($6, status),
         forma_pagamento  = $7,
         parcela          = COALESCE($8, parcela),
         total_parcelas   = COALESCE($9, total_parcelas),
         observacao       = $10,
         id_loja          = $11
       WHERE id = $12 RETURNING *`,
      [descricao || null, nome_cliente ?? null, valor || null, data_vencimento || null,
       data_recebimento ?? null, status || null, forma_pagamento ?? null,
       parcela || null, total_parcelas || null, observacao ?? null, id_loja ?? null, id]
    );
    if (rowCount === 0) return res.status(404).json({ erro: 'Registro não encontrado' });
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
    const { rowCount } = await pool.query(
      `DELETE FROM ${s}.financeiro_contas_receber WHERE id = $1`, [id]
    );
    if (rowCount === 0) return res.status(404).json({ erro: 'Registro não encontrado' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ── GET /api/:schema/financeiro/contas-pagar ──────────────────────────────────

router.get('/:schema/financeiro/contas-pagar', ...guard, async (req, res) => {
  const s = req.params.schema;
  const { status, data_inicio, data_fim, q, categoria } = req.query;
  const page     = Math.max(1, parseInt(req.query.page     || '1'));
  const pageSize = Math.min(100, parseInt(req.query.pageSize || '50'));
  const filtroLoja = req.query.filtroLoja !== undefined ? parseInt(req.query.filtroLoja) : null;

  const conds = ['TRUE'];
  const params = [];

  if (status && status !== 'todos') {
    if (status === 'vencido') {
      conds.push(`status = 'pendente' AND data_vencimento < CURRENT_DATE`);
    } else {
      params.push(status);
      conds.push(`status = $${params.length}`);
    }
  }
  if (data_inicio) { params.push(data_inicio); conds.push(`data_vencimento >= $${params.length}`); }
  if (data_fim)    { params.push(data_fim);    conds.push(`data_vencimento <= $${params.length}`); }
  if (q)           { params.push(`%${q}%`);    conds.push(`(descricao ILIKE $${params.length} OR fornecedor ILIKE $${params.length} OR categoria ILIKE $${params.length})`); }
  if (categoria)   { params.push(categoria);   conds.push(`categoria = $${params.length}`); }
  if (filtroLoja !== null && !isNaN(filtroLoja)) { params.push(filtroLoja); conds.push(`id_loja = $${params.length}`); }

  const where = conds.join(' AND ');

  try {
    const [rows, total] = await Promise.all([
      pool.query(
        `SELECT * FROM ${s}.financeiro_contas_pagar WHERE ${where}
         ORDER BY data_vencimento ASC, id DESC
         LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
        params
      ),
      pool.query(`SELECT COUNT(*)::INTEGER AS total FROM ${s}.financeiro_contas_pagar WHERE ${where}`, params),
    ]);
    res.json({ registros: rows.rows, total: total.rows[0].total, page, pageSize });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ── POST /api/:schema/financeiro/contas-pagar ─────────────────────────────────

router.post('/:schema/financeiro/contas-pagar', ...guard, async (req, res) => {
  const s = req.params.schema;
  const { descricao, fornecedor, categoria, valor, data_vencimento, data_pagamento,
          status, forma_pagamento, parcela, total_parcelas, observacao, id_loja } = req.body;

  if (!descricao || !valor || !data_vencimento)
    return res.status(400).json({ erro: 'descricao, valor e data_vencimento são obrigatórios' });

  try {
    const { rows: [r] } = await pool.query(
      `INSERT INTO ${s}.financeiro_contas_pagar
         (descricao, fornecedor, categoria, valor, data_vencimento, data_pagamento,
          status, forma_pagamento, parcela, total_parcelas, observacao, id_loja)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [descricao, fornecedor || null, categoria || null, valor, data_vencimento,
       data_pagamento || null, status || 'pendente', forma_pagamento || null,
       parcela || 1, total_parcelas || 1, observacao || null, id_loja || null]
    );
    res.status(201).json(r);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ── PATCH /api/:schema/financeiro/contas-pagar/:id ───────────────────────────

router.patch('/:schema/financeiro/contas-pagar/:id', ...guard, async (req, res) => {
  const s   = req.params.schema;
  const id  = parseInt(req.params.id);
  const { descricao, fornecedor, categoria, valor, data_vencimento, data_pagamento,
          status, forma_pagamento, parcela, total_parcelas, observacao, id_loja } = req.body;

  try {
    const { rows: [r], rowCount } = await pool.query(
      `UPDATE ${s}.financeiro_contas_pagar SET
         descricao       = COALESCE($1, descricao),
         fornecedor      = $2,
         categoria       = $3,
         valor           = COALESCE($4, valor),
         data_vencimento = COALESCE($5, data_vencimento),
         data_pagamento  = $6,
         status          = COALESCE($7, status),
         forma_pagamento = $8,
         parcela         = COALESCE($9, parcela),
         total_parcelas  = COALESCE($10, total_parcelas),
         observacao      = $11,
         id_loja         = $12
       WHERE id = $13 RETURNING *`,
      [descricao || null, fornecedor ?? null, categoria ?? null, valor || null,
       data_vencimento || null, data_pagamento ?? null, status || null,
       forma_pagamento ?? null, parcela || null, total_parcelas || null,
       observacao ?? null, id_loja ?? null, id]
    );
    if (rowCount === 0) return res.status(404).json({ erro: 'Registro não encontrado' });
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
    const { rowCount } = await pool.query(
      `DELETE FROM ${s}.financeiro_contas_pagar WHERE id = $1`, [id]
    );
    if (rowCount === 0) return res.status(404).json({ erro: 'Registro não encontrado' });
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
      WHERE DATA_MOV >= '${mes}-01' AND DATA_MOV < ('${mes}-01'::DATE + INTERVAL '1 month')
        ${filtroLoja !== null && !isNaN(filtroLoja) ? `AND ID_LOJA = ${filtroLoja}` : ''}
      GROUP BY DATA_MOV::DATE
    ` : '';

    const { rows } = await pool.query(`
      WITH base AS (
        SELECT
          data_recebimento AS data,
          SUM(valor) AS entradas,
          0::NUMERIC AS saidas
        FROM ${s}.financeiro_contas_receber
        WHERE status = 'recebido'
          AND data_recebimento >= '${mes}-01'
          AND data_recebimento < ('${mes}-01'::DATE + INTERVAL '1 month')
          ${lojaWhereCR}
        GROUP BY data_recebimento

        UNION ALL

        SELECT
          data_pagamento AS data,
          0::NUMERIC AS entradas,
          SUM(valor) AS saidas
        FROM ${s}.financeiro_contas_pagar
        WHERE status = 'pago'
          AND data_pagamento >= '${mes}-01'
          AND data_pagamento < ('${mes}-01'::DATE + INTERVAL '1 month')
          ${lojaWhereCR}
        GROUP BY data_pagamento

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

module.exports = router;
