const jwt = require('jsonwebtoken');

function authJwt(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer '))
    return res.status(401).json({ erro: 'token ausente' });

  try {
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    req.userId         = payload.id;
    req.userSchemas    = payload.schemas;
    req.userRoles      = payload.roles     || {};
    req.userLojas      = payload.lojas     || {};
    req.userVendedores = payload.vendedores || {};
    next();
  } catch {
    res.status(401).json({ erro: 'token inválido ou expirado' });
  }
}

module.exports = authJwt;
