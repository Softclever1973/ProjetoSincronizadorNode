const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { withConnection, getConnection, query, execute, closeConnection } = require('../db');
const { isFilialBloqueada } = require('../middleware/filialBloqueada');

/**
 * GET /datasnap/rest/TSMPedidos/getPedidos
 * Query params: token, idLoja, status, minDataCriacao, maxDataCriacao
 *
 * Equivalente a TSMPedidos.getPedidos() do Delphi.
 */
router.get('/getPedidos', auth, async (req, res) => {
  const idLoja = parseInt(req.query.idLoja, 10);
  const idPDV  = req.query.idPDV ? parseInt(req.query.idPDV, 10) : null; // eslint-disable-line no-unused-vars

  if (!idLoja) {
    return res.status(400).json({
      message: 'Ocorreu um erro ao tentar listar os registros pois o campo idLoja não foi informado',
    });
  }

  const db = await getConnection();
  try {
    if (await isFilialBloqueada(idLoja, db)) {
      return res.status(401).send();
    }

    let sql = 'SELECT * FROM PEDIDOS WHERE 1=1';
    const params = [];

    sql += ' AND ID_LOJA = ?';
    params.push(idLoja);

    if (req.query.status) {
      sql += ' AND STATUS = ?';
      params.push(req.query.status);
    }

    if (req.query.minDataCriacao) {
      sql += ' AND DATA_DO_PEDIDO >= ?';
      params.push(req.query.minDataCriacao);
    }

    if (req.query.maxDataCriacao) {
      sql += ' AND DATA_DO_PEDIDO <= ?';
      params.push(req.query.maxDataCriacao);
    }

    sql += ' ORDER BY ID_PEDIDO ASC';

    const rows = await query(db, sql, params);
    res.json(rows);
  } catch (e) {
    res.status(400).json({
      message: `Ocorreu um erro ao tentar buscar os pedidos. Erro: ${e.message}`,
    });
  } finally {
    await closeConnection(db);
  }
});

/**
 * GET /datasnap/rest/TSMPedidos/getPedidosSincronizadosByFilial
 * Query params: token, idLoja, status, minDataCriacao, maxDataCriacao
 *
 * Equivalente a TSMPedidos.getPedidosSincronizadosByFilial() do Delphi.
 * Retorna apenas o ID_PEDIDO_LOJA dos pedidos.
 */
router.get('/getPedidosSincronizadosByFilial', auth, async (req, res) => {
  const idLoja = parseInt(req.query.idLoja, 10);
  const idPDV  = req.query.idPDV ? parseInt(req.query.idPDV, 10) : null; // eslint-disable-line no-unused-vars

  if (!idLoja) {
    return res.status(400).json({
      message: 'Ocorreu um erro ao tentar listar os registros pois o campo idLoja não foi informado',
    });
  }

  try {
    let sql = 'SELECT ID_PEDIDO_LOJA FROM PEDIDOS WHERE 1=1';
    const params = [];

    sql += ' AND ID_LOJA = ?';
    params.push(idLoja);

    if (req.query.status) {
      sql += ' AND STATUS = ?';
      params.push(req.query.status);
    }

    if (req.query.minDataCriacao) {
      sql += ' AND DATA_DO_PEDIDO >= ?';
      params.push(req.query.minDataCriacao);
    }

    if (req.query.maxDataCriacao) {
      sql += ' AND DATA_DO_PEDIDO <= ?';
      params.push(req.query.maxDataCriacao);
    }

    sql += ' ORDER BY ID_PEDIDO ASC';

    const rows = await withConnection((db) => query(db, sql, params));
    res.json(rows.map((r) => ({ idPedido: r.ID_PEDIDO_LOJA })));
  } catch (e) {
    res.status(400).json({
      message: `Ocorreu um erro ao tentar buscar os pedidos. Erro: ${e.message}`,
    });
  }
});

/**
 * POST /datasnap/rest/TSMPedidos/updatePedido
 * Query params: token, sincronizarCliente (opcional, boolean)
 * Body: objeto JSON do pedido
 *
 * Equivalente a TSMPedidos.updatePedido() do Delphi.
 */
router.post('/updatePedido', auth, async (req, res) => {
  const pedido = req.body;

  if (!pedido || Object.keys(pedido).length === 0) {
    return res.status(400).json({ message: 'Body não informado!' });
  }

  const idLoja = pedido.idLoja || pedido.ID_LOJA;
  const idPDV  = pedido.idPDV  || pedido.ID_PDV  || null; // eslint-disable-line no-unused-vars

  const db = await getConnection();
  try {
    if (idLoja && await isFilialBloqueada(idLoja, db)) {
      return res.status(401).send();
    }

    // Verifica se o pedido já existe no banco
    const existente = await query(
      db,
      'SELECT ID_PEDIDO FROM PEDIDOS WHERE ID_PEDIDO = ?',
      [pedido.idPedido || pedido.ID_PEDIDO]
    );

    if (existente.length > 0) {
      // UPDATE
      await execute(
        db,
        `UPDATE PEDIDOS SET STATUS = ?, DATA_DO_PEDIDO = ?, ID_LOJA = ?
         WHERE ID_PEDIDO = ?`,
        [
          pedido.status || pedido.STATUS,
          pedido.dataLancamento || pedido.DATA_DO_PEDIDO,
          idLoja,
          pedido.idPedido || pedido.ID_PEDIDO,
        ]
      );
    } else {
      // INSERT — a lógica completa de SincronizarPedido() é complexa e específica
      // do Delphi (envolve itens, parcelas, cliente). Por ora retorna erro orientativo.
      return res.status(400).json({
        message: 'INSERT de pedido ainda não implementado nesta versão Node. Use o cliente Delphi para inserções.',
      });
    }

    res.json({ message: 'Pedido atualizado com sucesso', pedido });
  } catch (e) {
    res.status(400).json({
      message: `Ocorreu um erro ao tentar sincronizar o pedido. Erro: ${e.message}`,
    });
  } finally {
    await closeConnection(db);
  }
});

module.exports = router;
