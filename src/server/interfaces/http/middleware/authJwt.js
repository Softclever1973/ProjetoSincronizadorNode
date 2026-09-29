const jwt            = require('jsonwebtoken');
const tokenBlacklist = require('#server/infrastructure/cache/tokenBlacklist.js');
const sessoes        = require('#server/infrastructure/cache/sessoesCache.js');

function authJwt(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer '))
    return res.status(401).json({ erro: 'token ausente' });

  const token = header.slice(7);

  if (tokenBlacklist.revogado(token))
    return res.status(401).json({ erro: 'token revogado' });

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ erro: 'token inválido ou expirado' });
  }

  // Desconectado pelo superadmin: tokens emitidos antes da revogação deixam de valer.
  if (sessoes.sessaoRevogada(payload.id, payload.iat))
    return res.status(401).json({ erro: 'sessão encerrada pelo administrador' });

  req.userId         = payload.id;
  req.userName       = payload.nome        || null;
  req.userSchemas    = payload.schemas     || [];
  req.userRoles      = payload.roles       || {};
  req.userLojas      = payload.lojas       || {};
  req.userVendedores = payload.vendedores  || {};
  req.userPlanos     = payload.planos      || {};
  req.isSuperAdmin   = payload.isSuperAdmin === true;

  sessoes.registrarAtividade(req);
  next();
}

module.exports = authJwt;
