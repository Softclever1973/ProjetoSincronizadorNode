/**
 * Rota de audit log do tenant.
 * GET /api/:schema/audit-log
 */

const express = require('express');
const router  = express.Router();

const authJwt         = require('../../middleware/authJwt');
const { requireRole } = require('../../middleware/checkRole');
const { checkSchema } = require('../../middleware/checkSchema');
const { pool }        = require('../../db');

/* ── GET /api/:schema/audit-log ── */
router.get('/:schema/audit-log', authJwt, checkSchema, requireRole('gerente', 'dono'), async (req, res) => {
  const { schema } = req.params;
  const pageSize   = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 50));
  const page       = Math.max(1, parseInt(req.query.page) || 1);
  const offset     = (page - 1) * pageSize;
  const tabela     = req.query.tabela?.trim().toUpperCase() || '';
  const operacao   = req.query.operacao?.trim().toUpperCase() || '';
  const dataInicio = req.query.dataInicio?.trim() || '';
  const dataFim    = req.query.dataFim?.trim()    || '';
  const idLojaUsuario = req.userLojas?.[schema] ?? null;

  const conds  = ['al.schema_name = $1'];
  const params = [schema];

  if (tabela) { params.push(tabela); conds.push(`al.tabela = $${params.length}`); }
  if (operacao && ['INSERT', 'UPDATE', 'DELETE'].includes(operacao)) {
    params.push(operacao); conds.push(`al.operacao = $${params.length}`);
  }
  if (dataInicio) { params.push(dataInicio); conds.push(`al.criado_em >= $${params.length}`); }
  if (dataFim)    { params.push(dataFim + ' 23:59:59'); conds.push(`al.criado_em <= $${params.length}`); }

  // Não-donos só veem entradas de audit que pertençam à sua loja.
  // O filtro é aplicado em SQL para que o COUNT e a paginação sejam consistentes.
  // Inclui registros onde dados é NULL (DELETEs) ou sem ID_LOJA (tabelas globais).
  if (idLojaUsuario !== null) {
    params.push(idLojaUsuario);
    conds.push(
      `(al.dados IS NULL
        OR al.dados->>'ID_LOJA' IS NULL
        OR NULLIF(al.dados->>'ID_LOJA', '')::int = $${params.length}
        OR NULLIF(al.dados->>'id_loja', '')::int = $${params.length})`
    );
  }

  const where = conds.join(' AND ');

  try {
    const [rows, countRow] = await Promise.all([
      pool.query(
        `SELECT al.id, al.id_usuario, u.email, al.tabela, al.operacao, al.pk_valor, al.dados, al.dados_antes, al.ip_cliente, al.criado_em
         FROM public.audit_log al
         LEFT JOIN public.usuarios u ON u.id = al.id_usuario
         WHERE ${where}
         ORDER BY al.criado_em DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, pageSize, offset]
      ),
      pool.query(`SELECT COUNT(*) FROM public.audit_log al WHERE ${where}`, params),
    ]);

    res.json({ registros: rows.rows, total: parseInt(countRow.rows[0].count) });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

module.exports = router;
