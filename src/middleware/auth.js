const { resolverEmpresa } = require('../empresas');

async function authMiddleware(req, res, next) {
  const empresa = await resolverEmpresa(req.query.token);
  if (!empresa) return res.status(400).json({ erro: 'token inválido!' });
  req.schemaName = empresa.schema_name;
  next();
}

module.exports = authMiddleware;
