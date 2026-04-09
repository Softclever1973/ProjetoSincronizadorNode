// Token fixo — equivalente ao TAutenticacao.VerificarSeTokenValido() do Delphi
const TOKEN_VALIDO = '773a5d8b-d762-4ebd-b632-d1577d78c1f2';

function authMiddleware(req, res, next) {
  const token = req.query.token;

  if (token !== TOKEN_VALIDO) {
    return res.status(400).json({ erro: 'token inválido!' });
  }

  next();
}

module.exports = authMiddleware;
