// Token lido do .env — equivalente ao TAutenticacao.VerificarSeTokenValido() do Delphi
const TOKEN_VALIDO = process.env.SYNC_TOKEN;

function authMiddleware(req, res, next) {
  const token = req.query.token;

  if (token !== TOKEN_VALIDO) {
    return res.status(400).json({ erro: 'token inválido!' });
  }

  next();
}

module.exports = authMiddleware;
