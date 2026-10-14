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
 *   depoisDeGravar(db, { registro, update, dadosAntes, schema })
 *   aposSalvar(schema, { registro, dadosAntes })
 * E, fora do handleSave, na listagem (GET /tabelas/:tabela):
 *   expressaoOrdenacao(coluna, tipoPg) → expressão SQL no lugar da coluna no ORDER BY, ou null
 */
module.exports = {
  PEDIDOS: require('./pedidos.hooks'),
  PRODUTOS: require('./produtos.hooks'),
  CLIENTES: require('./clientes.hooks'),
  MOVIMENTACOES: require('./movimentacoes.hooks'),
  PEDIDOS_ITENS: require('./pedidosItens.hooks'),
  PEDIDOS_PARCELAS_PAGAMENTOS: require('./pedidosParcelasPagamentos.hooks'),
  PRODUTOS_X_LISTA: require('./produtosXLista.hooks'),
  LISTA_PRECOS: require('./listaPrecos.hooks'),
};
