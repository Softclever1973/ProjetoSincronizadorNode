/**
 * Rotas administrativas do tenant.
 * GET  /api/:schema/admin/sync-config
 * PUT  /api/:schema/admin/sync-config
 * GET  /api/:schema/filiais
 */

const express = require('express');
const router  = express.Router();

const authJwt             = require('../../middleware/authJwt');
const { requireRole }     = require('../../middleware/checkRole');
const { checkSchema }     = require('../../middleware/checkSchema');
const { withTenantConnection, query, execute, isMissingTableError } = require('../../db');
const { NOME_VALIDO, CHAVES_PERMITIDAS } = require('./constants');

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
    await withTenantConnection(schema, db =>
      execute(db,
        `INSERT INTO sync_config (chave, valor) VALUES ($1, $2)
         ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor`,
        [chave, valor || null]
      )
    );
    res.json({ ok: true });
  } catch (e) {
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

module.exports = router;
