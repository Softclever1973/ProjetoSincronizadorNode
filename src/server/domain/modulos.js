/** Lista única de módulos do sistema de permissões (plano × módulo, role × módulo). */
const MODULOS = Object.freeze([
  'produtos', 'clientes', 'pedidos', 'fornecedores', 'usuarios',
  'financeiro', 'faturamento', 'auditoria', 'configuracoes',
]);

const NIVEL_VALIDO = new Set(['--', 'r-', 'rw']);

module.exports = { MODULOS, NIVEL_VALIDO };
