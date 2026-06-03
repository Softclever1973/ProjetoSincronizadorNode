const jwt            = require('jsonwebtoken');
const tokenBlacklist = require('../tokenBlacklist');

function authJwt(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer '))
    return res.status(401).json({ erro: 'token ausente' });

  const token = header.slice(7);

  if (tokenBlacklist.revogado(token))
    return res.status(401).json({ erro: 'token revogado' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.userId         = payload.id;
    req.userName       = payload.nome      || null;
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
