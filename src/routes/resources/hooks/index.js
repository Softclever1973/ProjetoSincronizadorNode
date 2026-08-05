/**
 * Registro de hooks por tabela para handleSave() em crud.js.
 * Cada módulo exporta um subconjunto destes pontos de extensão, chamados apenas se
 * definidos (encadeados na mesma ordem em que a lógica de handleSave os invoca):
 *   aplicarCamposAutomaticos(req, registro)
 *   antesDaTransacao(db, registro)
 *   migrarSchema(db, schema, tabela, allowed)
 *   denormalizar(db, schema, registro, allowed, req)
 *   validarTransicao(db, { registro, update, dadosAntes })
 *   validarUnicidade(db, { registro, pkVals })
 *   aposSalvar(schema, { registro, dadosAntes })
 */
module.exports = {
  PEDIDOS: require('./pedidos.hooks'),
  PRODUTOS: require('./produtos.hooks'),
  CLIENTES: require('./clientes.hooks'),
  MOVIMENTACOES: require('./movimentacoes.hooks'),
  PEDIDOS_ITENS: require('./pedidosItens.hooks'),
  PEDIDOS_PARCELAS_PAGAMENTOS: require('./pedidosParcelasPagamentos.hooks'),
};
