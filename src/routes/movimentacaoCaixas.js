const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { getConnection, query, execute, closeConnection } = require('../db');
const { isFilialBloqueada } = require('../middleware/filialBloqueada');

/**
 * POST /datasnap/rest/TSMMovimetacaoCaixas/updateMovimentacaoCaixa
 * Query params: token
 * Body: objeto JSON da movimentação de caixa
 *
 * Equivalente a TSMMovimetacaoCaixas.updateMovimentacaoCaixa() do Delphi.
 * Insere a movimentação somente se ainda não existir (idempotente).
 */
router.post('/updateMovimentacaoCaixa', auth, async (req, res) => {
  const movCaixa = req.body;

  if (!movCaixa || Object.keys(movCaixa).length === 0) {
    return res.status(400).json({ message: 'Body não informado!' });
  }

  const idLoja     = movCaixa.idLoja     || movCaixa.ID_LOJA;
  const idMovCaixa = movCaixa.idMovCaixa || movCaixa.ID_MOV_CAIXA;
  const idPDV      = movCaixa.idPDV      || movCaixa.ID_PDV || null; // eslint-disable-line no-unused-vars

  if (!idMovCaixa) {
    return res.status(400).json({ message: 'Campo ID_MOV_CAIXA não informado!' });
  }

  const db = await getConnection();
  try {
    if (idLoja && await isFilialBloqueada(idLoja, db)) {
      return res.status(401).send();
    }

    // Verifica se a movimentação já existe (evita duplicata — mesmo comportamento do Delphi)
    const existente = await query(
      db,
      'SELECT ID_MOV_CAIXA FROM MOV_CAIXA WHERE ID_MOV_CAIXA = $1',
      [idMovCaixa]
    );

    if (existente.length > 0) {
      return res.json({ message: 'Movimentação já registrada!' });
    }

    // INSERT da movimentação
    await execute(
      db,
      `INSERT INTO MOV_CAIXA
         (ID_MOV_CAIXA, ID_LOJA, DATA_MOV, TIPO, VALOR, HISTORICO, ID_CONTA)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        idMovCaixa,
        idLoja,
        movCaixa.dataMov       ?? movCaixa.DATA_MOV,
        movCaixa.tipo          ?? movCaixa.TIPO,
        movCaixa.valor         ?? movCaixa.VALOR,
        movCaixa.historico     ?? movCaixa.HISTORICO,
        movCaixa.idConta       ?? movCaixa.ID_CONTA,
      ]
    );

    res.json({ message: 'Movimentação registrada com sucesso', movCaixa });
  } catch (e) {
    res.status(400).json({
      message: `Ocorreu um erro ao tentar gravar a movimentação. Erro: ${e.message}`,
    });
  } finally {
    await closeConnection(db);
  }
});

module.exports = router;
