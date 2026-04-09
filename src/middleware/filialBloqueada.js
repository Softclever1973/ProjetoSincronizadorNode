const { query } = require('../db');

/**
 * Verifica se uma filial está bloqueada.
 * Equivalente ao TFiliaisBloqueadas.isFilialBloqueada() do Delphi.
 */
async function isFilialBloqueada(idLoja, db) {
  // A PK ID_FILIAL_BLOQUEADA armazena o número da loja diretamente
  const rows = await query(
    db,
    'SELECT ID_FILIAL_BLOQUEADA FROM FILIAIS_BLOQUEADAS WHERE ID_FILIAL_BLOQUEADA = ?',
    [idLoja]
  );
  return rows.length > 0;
}

/**
 * Middleware que bloqueia a requisição se a filial estiver bloqueada.
 * Requer que req.query.idLoja esteja presente.
 */
function filialBloqueadaMiddleware(db) {
  return async (req, res, next) => {
    const idLoja = parseInt(req.query.idLoja, 10);
    if (!idLoja) return next();

    try {
      const bloqueada = await isFilialBloqueada(idLoja, db);
      if (bloqueada) {
        return res.status(401).send();
      }
      next();
    } catch {
      next();
    }
  };
}

module.exports = { isFilialBloqueada, filialBloqueadaMiddleware };
