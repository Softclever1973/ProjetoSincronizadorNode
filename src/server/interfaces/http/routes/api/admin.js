/**
 * Rotas administrativas do tenant.
 * GET  /api/:schema/admin/sync-config
 * PUT  /api/:schema/admin/sync-config
 * GET  /api/:schema/filiais
 * GET  /api/:schema/plano
 */

const express = require('express');
const router  = express.Router();

const authJwt                  = require('../../middleware/authJwt');
const { requireRole }          = require('../../middleware/checkRole');
const { checkSchema }          = require('../../middleware/checkSchema');
const { pool, withTenantConnection, query, execute, isMissingTableError } = require('../../../../infrastructure/db');
const { NOME_VALIDO, CHAVES_PERMITIDAS } = require('../../../../domain/validacao');
const { registrarAuditLog } = require('./helpers');
const { PLANOS, PLANO_PADRAO } = require('../../../../domain/planos');

/* ── GET /api/:schema/admin/sync-config ── */
router.get('/:schema/admin/sync-config', authJwt, checkSchema, requireRole('dono'), async (req, res) => {
  const { schema } = req.params;
  try {
    const rows = await withTenantConnection(schema, db =>
      query(db, 'SELECT chave, valor FROM sync_config ORDER BY chave')
    );
    res.json(Object.fromEntries(rows.map(r => [r.CHAVE, r.VALOR])));
  } catch (e) {
    if (isMissingTableError(e)) return res.json({});
    res.status(500).json({ erro: e.message });
  }
});

/* ── PUT /api/:schema/admin/sync-config ── */
router.put('/:schema/admin/sync-config', authJwt, checkSchema, requireRole('dono'), async (req, res) => {
  const { schema } = req.params;
  const { chave, valor } = req.body;

  if (!chave || !CHAVES_PERMITIDAS.has(chave)) {
    return res.status(400).json({ erro: 'chave inválida' });
  }
  if (valor !== null && valor !== undefined && !NOME_VALIDO.test(valor)) {
    return res.status(400).json({ erro: 'valor deve ser null ou nome de coluna válido (ex: ID_LOJA)' });
  }

  try {
    let dadosAntes = null;
    await withTenantConnection(schema, async db => {
      const rows = await query(db, 'SELECT valor FROM sync_config WHERE chave = $1', [chave]);
      dadosAntes = rows.length > 0 ? { chave, valor: rows[0].VALOR } : null;
      await execute(db,
        `INSERT INTO sync_config (chave, valor) VALUES ($1, $2)
         ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor`,
        [chave, valor || null]
      );
    });
    registrarAuditLog(req, schema, 'SYNC_CONFIG', dadosAntes ? 'UPDATE' : 'INSERT', chave,
      { chave, valor: valor || null }, dadosAntes);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

/* ── GET /api/:schema/sync-flags — flags públicas sem restrição de role ── */
router.get('/:schema/sync-flags', authJwt, checkSchema, async (req, res) => {
  const { schema } = req.params;
  try {
    const rows = await withTenantConnection(schema, db =>
      query(db, `SELECT chave, valor FROM sync_config WHERE chave IN ('venda_saldo_negativo', 'modalidade_frete', 'forma_preenchimento_pedido')`)
    );
    res.json(Object.fromEntries(rows.map(r => [r.CHAVE, r.VALOR])));
  } catch (e) {
    if (isMissingTableError(e)) return res.json({});
    res.status(500).json({ erro: e.message });
  }
});

/* ── GET /api/:schema/filiais ── */
router.get('/:schema/filiais', authJwt, checkSchema, async (req, res) => {
  const { schema } = req.params;
  try {
    const rows = await withTenantConnection(schema, db =>
      query(db, 'SELECT id_loja, nome FROM sync_filiais ORDER BY id_loja')
    );
    res.json(rows.map(r => ({ id: r.ID_LOJA, nome: r.NOME || `Loja ${r.ID_LOJA}` })));
  } catch {
    res.json([]);
  }
});

// GET /api/:schema/plano — info do plano atual. Lê de sync_tenants, não do claim do JWT (evita staleness até o token renovar).
router.get('/:schema/plano', authJwt, checkSchema, async (req, res) => {
  const { schema } = req.params;
  try {
    const { rows } = await pool.query(
      'SELECT plano FROM public.sync_tenants WHERE schema_name = $1', [schema]
    );
    const plano = rows[0]?.plano || PLANO_PADRAO;
    res.json({ plano, nome: PLANOS[plano]?.nome ?? plano, features: PLANOS[plano]?.features ?? [] });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

module.exports = router;
