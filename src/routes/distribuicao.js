const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { withConnection, getConnection, query, execute, closeConnection } = require('../db');
const { isFilialBloqueada } = require('../middleware/filialBloqueada');

/**
 * GET /datasnap/rest/TSMDistribuicaoDeMercadorias/ListarDistribuicaoDeMercadorias
 * Query params: token, idLoja, status, quantidadeRegistros (default 30), pagina (default 1)
 *
 * Equivalente a TSMDistribuicaoDeMercadorias.ListarDistribuicaoDeMercadorias() do Delphi.
 */
router.get('/ListarDistribuicaoDeMercadorias', auth, async (req, res) => {
  const idLoja = parseInt(req.query.idLoja, 10);
  const status = (req.query.status || '').trim();

  if (!idLoja) {
    return res.status(400).json({ message: 'o campo idLoja não foi informado!' });
  }

  if (!status) {
    return res.status(400).json({ message: 'o campo status não foi informado!' });
  }

  let qtdRegistros = parseInt(req.query.quantidadeRegistros, 10) || 30;
  if (qtdRegistros <= 0 || qtdRegistros > 30) qtdRegistros = 30;

  let pagina = parseInt(req.query.pagina, 10) || 1;
  if (pagina <= 0) pagina = 1;

  const offset = (pagina - 1) * qtdRegistros;

  const db = await getConnection();
  try {
    if (await isFilialBloqueada(idLoja, db)) {
      return res.status(401).send();
    }

    const rows = await query(
      db,
      `SELECT DML.*, DM.ID_PRODUTO, DM.CODIGO_PRODUTO, DM.DATA_DISTRIBUICAO,
              (SELECT DESCRICAO FROM PRODUTOS P WHERE P.ID_PRODUTO = DM.ID_PRODUTO) AS DESCRICAO
       FROM DISTRIB_MERCADORIAS_LOJAS DML
       INNER JOIN DISTRIBUICAO_MERCADORIAS DM
         ON DML.ID_DISTRIBUICAO_MERCADORIA = DM.ID_DISTRIBUICAO_MERCADORIA
       WHERE DML.ID_LOJA = $1 AND DML.STATUS = $2
       LIMIT $3 OFFSET $4`,
      [idLoja, status, qtdRegistros, offset]
    );

    res.json(rows);
  } catch (e) {
    res.status(400).json({
      message: `Ocorreu um erro ao tentar listar as distribuições. Erro: ${e.message}`,
    });
  } finally {
    await closeConnection(db);
  }
});

/**
 * GET /datasnap/rest/TSMDistribuicaoDeMercadorias/ListarDistribuicaoDeMercadoriasPorID
 * Query params: token, idLoja, IdDistribuicaoMercadoriasLojas
 *
 * Equivalente a TSMDistribuicaoDeMercadorias.ListarDistribuicaoDeMercadoriasPorID() do Delphi.
 */
router.get('/ListarDistribuicaoDeMercadoriasPorID', auth, async (req, res) => {
  const idLoja = parseInt(req.query.idLoja, 10);
  const idDistrib = parseInt(req.query.IdDistribuicaoMercadoriasLojas, 10);

  if (!idLoja) {
    return res.status(400).json({ message: 'o campo idLoja não foi informado!' });
  }

  if (!idDistrib) {
    return res.status(400).json({ message: 'o campo IdDistribuicaoMercadoriasLojas não foi informado!' });
  }

  try {
    const rows = await withConnection((db) =>
      query(
        db,
        `SELECT DML.*, DM.ID_PRODUTO, DM.DATA_DISTRIBUICAO,
                (SELECT DESCRICAO FROM PRODUTOS P WHERE P.ID_PRODUTO = DM.ID_PRODUTO) AS DESCRICAO
         FROM DISTRIB_MERCADORIAS_LOJAS DML
         INNER JOIN DISTRIBUICAO_MERCADORIAS DM
           ON DML.ID_DISTRIBUICAO_MERCADORIA = DM.ID_DISTRIBUICAO_MERCADORIA
         WHERE DML.ID_LOJA = $1
           AND DML.ID_DISTRIB_MERCADORIAS_LOJAS = $2
         LIMIT 1`,
        [idLoja, idDistrib]
      )
    );

    res.json(rows[0] || null);
  } catch (e) {
    res.status(400).json({
      message: `Ocorreu um erro ao buscar a distribuição. Erro: ${e.message}`,
    });
  }
});

/**
 * GET /datasnap/rest/TSMDistribuicaoDeMercadorias/QuantidadeDeRegistros
 * Query params: token, idLoja, status
 *
 * Equivalente a TSMDistribuicaoDeMercadorias.QuantidadeDeRegistros() do Delphi.
 */
router.get('/QuantidadeDeRegistros', auth, async (req, res) => {
  const idLoja = parseInt(req.query.idLoja, 10);
  const status = (req.query.status || '').trim();

  if (!idLoja) {
    return res.status(400).json({ message: 'o campo idLoja não foi informado!' });
  }

  if (!status) {
    return res.status(400).json({ message: 'o campo status não foi informado!' });
  }

  try {
    const rows = await withConnection((db) =>
      query(
        db,
        `SELECT COUNT(*) AS QUANTIDADE
         FROM DISTRIB_MERCADORIAS_LOJAS DML
         INNER JOIN DISTRIBUICAO_MERCADORIAS DM
           ON DML.ID_DISTRIBUICAO_MERCADORIA = DM.ID_DISTRIBUICAO_MERCADORIA
         WHERE DML.ID_LOJA = $1 AND DML.STATUS = $2`,
        [idLoja, status]
      )
    );

    res.json({ quantidade: rows[0]?.QUANTIDADE ?? 0 });
  } catch (e) {
    res.status(400).json({
      message: `Ocorreu um erro ao contar os registros. Erro: ${e.message}`,
    });
  }
});

/**
 * POST /datasnap/rest/TSMDistribuicaoDeMercadorias/acceptAlterarStatus
 * Query params: token
 * Body: objeto JSON com os dados da distribuição (incluindo ID e STATUS)
 *
 * Equivalente a TSMDistribuicaoDeMercadorias.acceptAlterarStatus() do Delphi.
 */
router.post('/acceptAlterarStatus', auth, async (req, res) => {
  const distribuicao = req.body;

  if (!distribuicao || Object.keys(distribuicao).length === 0) {
    return res.status(400).json({ message: 'Body não informado!' });
  }

  const idDistrib = distribuicao.idDistribMercadoriasLojas || distribuicao.ID_DISTRIB_MERCADORIAS_LOJAS;
  const novoStatus = distribuicao.status || distribuicao.STATUS;

  if (!idDistrib || !novoStatus) {
    return res.status(400).json({ message: 'Distribuição de mercadoria inválida' });
  }

  try {
    await withConnection((db) =>
      execute(
        db,
        'UPDATE DISTRIB_MERCADORIAS_LOJAS SET STATUS = $1 WHERE ID_DISTRIB_MERCADORIAS_LOJAS = $2',
        [novoStatus, idDistrib]
      )
    );

    res.json({ message: 'Status atualizado com sucesso', distribuicao });
  } catch (e) {
    res.status(400).json({
      message: `Ocorreu um erro ao tentar alterar o status da distribuição. Erro: ${e.message}`,
    });
  }
});

module.exports = router;
