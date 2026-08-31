const { query } = require('#server/infrastructure/db.js');

async function existePagamentoRealizado(db, idPedido) {
  const linhas = await query(db,
    `SELECT 1 FROM PEDIDOS_PARCELAS_PAGAMENTOS WHERE ID_PEDIDO = $1 AND STATUS = 'R' LIMIT 1`,
    [idPedido]
  ).catch(() => []);
  return linhas.length > 0;
}

module.exports = { existePagamentoRealizado };
