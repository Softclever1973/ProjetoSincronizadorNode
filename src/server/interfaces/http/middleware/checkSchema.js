const { schemaTenantValido } = require('#server/domain/validacao.js');

/**
 * Middleware que garante que o schema solicitado pertence ao usuário autenticado.
 * Extraído de src/routes/resources/ para ficar consistente com authJwt.js e checkRole.js.
 */
function checkSchema(req, res, next) {
  // Vínculo antigo com schema reservado (ex.: public) não vale, mesmo estando no JWT.
  if (!schemaTenantValido(req.params.schema) || !req.userSchemas.includes(req.params.schema))
    return res.status(403).json({ erro: 'acesso negado' });
  next();
}

module.exports = { checkSchema };
