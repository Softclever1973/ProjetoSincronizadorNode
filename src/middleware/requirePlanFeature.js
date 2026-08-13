const { planoTemFeature } = require('../planos');
const { pool } = require('../db');

// Lê o plano de sync_tenants a cada requisição, não do claim do JWT — evita 403 indevido logo após um upgrade.
function requirePlanFeature(featureKey) {
  return async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        'SELECT plano FROM public.sync_tenants WHERE schema_name = $1', [req.params.schema]
      );
      if (!planoTemFeature(rows[0]?.plano, featureKey))
        return res.status(403).json({ erro: 'recurso não disponível no plano atual' });
      next();
    } catch (e) {
      res.status(500).json({ erro: e.message });
    }
  };
}

module.exports = { requirePlanFeature };
