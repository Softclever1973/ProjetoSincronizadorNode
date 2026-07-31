const { planoTemFeature } = require('../planos');

function requirePlanFeature(featureKey) {
  return (req, res, next) => {
    const plano = req.userPlanos?.[req.params.schema];
    if (!planoTemFeature(plano, featureKey))
      return res.status(403).json({ erro: 'recurso não disponível no plano atual' });
    next();
  };
}

module.exports = { requirePlanFeature };
