/**
 * Middleware que garante que o schema solicitado pertence ao usuário autenticado.
 * Extraído de src/routes/resources/ para ficar consistente com authJwt.js e checkRole.js.
 */
function checkSchema(req, res, next) {
  if (!req.userSchemas.includes(req.params.schema))
    return res.status(403).json({ erro: 'acesso negado' });
  next();
}

module.exports = { checkSchema };
