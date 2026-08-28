/** Mapeia tabelas do tenant (rota genérica /api/:schema/tabelas/:tabela) para o módulo
 * de permissões que as governa. Tabela ausente daqui não é gateada pelo sistema de
 * módulos — preserva o comportamento atual para qualquer tabela fora deste escopo. */
const TABELA_MODULO = Object.freeze({
  PRODUTOS: 'produtos',
  CLIENTES: 'clientes',
  PEDIDOS: 'pedidos',
  PEDIDOS_ITENS: 'pedidos',
  PEDIDOS_PARCELAS_PAGAMENTOS: 'pedidos',
  FORNECEDORES: 'fornecedores',
});

module.exports = { TABELA_MODULO };
