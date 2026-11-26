const express  = require('express');
const router   = express.Router();
const { pool } = require('#server/infrastructure/db.js');
const authJwt  = require('#server/interfaces/http/middleware/authJwt.js');
const { obterPermissoesEfetivas } = require('#server/infrastructure/cache/permissoesCache.js');
const { erroServidor } = require('#server/interfaces/http/erroServidor.js');

// Só leitura: criar empresa é exclusivo do superadmin (POST /superadmin/empresas).

router.get('/', authJwt, async (req, res) => {
  if (req.userSchemas.length === 0) return res.json([]);

  try {
    const placeholders = req.userSchemas.map((_, i) => `$${i + 1}`).join(', ');
    const result = await pool.query(
      `SELECT schema_name, nome, ativo, regime_tributario, plano FROM public.sync_tenants WHERE schema_name IN (${placeholders})`,
      req.userSchemas
    );
    const rows = await Promise.all(result.rows.map(async r => ({
      ...r,
      modulos: await obterPermissoesEfetivas(r.plano, req.userRoles?.[r.schema_name], r.schema_name),
    })));
    res.json(rows);
  } catch (e) {
    erroServidor(res, e);
  }
});

module.exports = router;
