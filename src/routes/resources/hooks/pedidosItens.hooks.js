/**
 * Hooks de handleSave (crud.js) específicos da tabela PEDIDOS_ITENS.
 */
const { query } = require('../../../db');
const { colunasTabela, pedidoEstaCancelado } = require('../helpers');

async function antesDaTransacao(db, registro) {
  // Pedido cancelado trava itens e parcelas — insert ou update, não só transição
  // de status do próprio PEDIDOS.
  if (await pedidoEstaCancelado(db, registro.ID_PEDIDO)) {
    throw Object.assign(
      new Error('Pedido cancelado — não é possível alterar itens ou parcelas de pagamento.'),
      { isValidation: true }
    );
  }
}

async function denormalizar(db, schema, registro, allowed) {
  if (registro.ID_PRODUTO && !registro.DESCRICAO_PRODUTO && allowed.has('DESCRICAO_PRODUTO')) {
    const colsProd = await colunasTabela(db, schema, 'PRODUTOS').catch(() => []);
    const descCol = ['DESCRICAO_PRODUTO', 'DESCRICAO', 'NOME']
      .find(c => colsProd.some(cc => cc.COLUMN_NAME === c));
    if (descCol) {
      const [prod] = await query(db,
        `SELECT ${descCol} AS DESCRICAO FROM PRODUTOS WHERE ID_PRODUTO = $1 LIMIT 1`,
        [registro.ID_PRODUTO]
      ).catch(() => []);
      if (prod?.DESCRICAO) registro.DESCRICAO_PRODUTO = prod.DESCRICAO;
    }
  }
  // A web só trabalha com QUANTIDADE (não vende por metragem/peça fracionada) —
  // QUANTIDADE_DE_PECAS espelha o mesmo valor para o ERP, que exibe os dois campos.
  if (registro.QUANTIDADE != null && registro.QUANTIDADE_DE_PECAS == null && allowed.has('QUANTIDADE_DE_PECAS'))
    registro.QUANTIDADE_DE_PECAS = registro.QUANTIDADE;
}

module.exports = { antesDaTransacao, denormalizar };
