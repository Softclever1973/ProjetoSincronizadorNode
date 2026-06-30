const express      = require('express');
const router       = express.Router();
const { pool, withTenantConnection, query } = require('../db');
const authJwt      = require('../middleware/authJwt');
const { requireRole } = require('../middleware/checkRole');

function checkSchema(req, res, next) {
  if (!req.userSchemas.includes(req.params.schema))
    return res.status(403).json({ erro: 'acesso negado' });
  next();
}

const guard = [authJwt, checkSchema, requireRole('gerente', 'dono')];

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
const CP_SORTABLE = new Set(['data_vencimento','fornecedor','descricao','categoria','valor','status']);

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
      `SELECT status FROM ${s}.a_receber WHERE srv_id = $1`, [id]
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
         id_forma_de_pagamento = $7,
         parcela              = COALESCE($8, parcela),
         observacao           = COALESCE($9, observacao),
         id_loja              = $10
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

    // Quando uma CR de pedido é marcada como recebida, sincroniza com PEDIDOS_PARCELAS_PAGAMENTOS
    if (r && r.status === 'recebido' && r.observacao) {
      const match = r.observacao.match(/^pedido:(\d+):(\d+)$/);
      if (match) {
        const idPedido = parseInt(match[1]);
        const parcela  = parseInt(match[2]);
        try {
          await pool.query(
            `ALTER TABLE ${s}.pedidos_parcelas_pagamentos ADD COLUMN IF NOT EXISTS status TEXT`
          );
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
    const { rowCount } = await pool.query(
      `DELETE FROM ${s}.a_receber WHERE srv_id = $1`, [id]
    );
    if (rowCount === 0) return res.status(404).json({ erro: 'Registro não encontrado' });
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
  const { status, data_inicio, data_fim, q, categoria, sortCol, sortDir } = req.query;
  const page     = Math.max(1, parseInt(req.query.page     || '1'));
  const pageSize = Math.min(100, parseInt(req.query.pageSize || '50'));
  const filtroLoja = req.query.filtroLoja !== undefined ? parseInt(req.query.filtroLoja) : null;
  const orderCol = CP_SORTABLE.has(sortCol) ? sortCol : 'data_vencimento';
  const orderDir = sortDir === 'DESC' ? 'DESC' : 'ASC';

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
         ORDER BY ${orderCol} ${orderDir}, id DESC
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
    // Impede reativação de registro cancelado
    const { rows: [atual] } = await pool.query(
      `SELECT status FROM ${s}.financeiro_contas_pagar WHERE id = $1`, [id]
    );
    if (!atual) return res.status(404).json({ erro: 'Registro não encontrado' });
    if (atual.status === 'cancelado' && status && status !== 'cancelado') {
      return res.status(422).json({ erro: 'Registro cancelado não pode ter o status alterado.' });
    }

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

// ── POST /api/:schema/financeiro/parcelas-pedido ─────────────────────────────
// Cria registros em A_RECEBER a partir das parcelas de um pedido.
// Acessível a qualquer usuário autenticado (sem restrição de role).

router.post('/:schema/financeiro/parcelas-pedido', authJwt, checkSchema, async (req, res) => {
  const s = req.params.schema;
  const { id_pedido, parcelas } = req.body;
  if (!id_pedido || !Array.isArray(parcelas) || parcelas.length === 0)
    return res.status(400).json({ erro: 'id_pedido e parcelas são obrigatórios' });
  try {
    const { rows: pedRows } = await pool.query(
      `SELECT id_cliente, nome_cliente, id_loja FROM ${s}.pedidos WHERE id_pedido = $1 LIMIT 1`,
      [id_pedido]
    );
    const ped = pedRows[0] || {};

    let id_cliente_srv = null;
    if (ped.id_cliente) {
      const { rows: c } = await pool.query(
        `SELECT srv_id FROM ${s}.clientes WHERE id_cliente = $1 LIMIT 1`,
        [ped.id_cliente]
      );
      id_cliente_srv = c[0]?.srv_id ?? null;
    }

    await pool.query(`CREATE SEQUENCE IF NOT EXISTS ${s}.seq_srv_id_a_receber START WITH 1`);
    await pool.query(`
      SELECT setval('${s}.seq_srv_id_a_receber',
        GREATEST(
          (SELECT last_value FROM ${s}.seq_srv_id_a_receber),
          (SELECT COALESCE(MAX(srv_id), 0) FROM ${s}.a_receber)
        )
      )
    `);

    const criados = [];
    for (const p of parcelas) {
      const obs = `pedido:${id_pedido}:${p.parcela}`;
      const existing = await pool.query(
        `SELECT srv_id FROM ${s}.a_receber WHERE observacao = $1 LIMIT 1`, [obs]
      );
      if (existing.rows.length > 0) continue;

      const { rows: [{ next_id }] } = await pool.query(
        `SELECT nextval('${s}.seq_srv_id_a_receber') AS next_id`
      );
      await pool.query(
        `INSERT INTO ${s}.srv_id_map (tabela, id_local, srv_id)
         VALUES ('A_RECEBER', $1, $2) ON CONFLICT (tabela, id_local) WHERE filial_id IS NULL DO NOTHING`,
        [`web:${next_id}`, next_id]
      );
      const desc = `Pedido #${id_pedido} - Parcela ${p.parcela}`;
      const { rows: [r] } = await pool.query(
        `INSERT INTO ${s}.a_receber
           (srv_id, descricao, id_cliente, valor, vencimento, status,
            id_forma_de_pagamento, parcela, observacao, id_loja)
         VALUES ($1,$2,$3,$4,$5,'pendente',$6,$7,$8,$9)
         RETURNING srv_id AS id, descricao, valor, vencimento AS data_vencimento, status, parcela`,
        [next_id, desc, id_cliente_srv, p.valor, p.data_vencimento,
         p.id_forma_de_pagamento ? Number(p.id_forma_de_pagamento) : null,
         p.parcela, obs, ped.id_loja || null]
      );
      if (r) criados.push(r);
    }
    res.status(201).json({ criados });
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
