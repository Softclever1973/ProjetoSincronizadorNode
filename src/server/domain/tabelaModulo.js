/** Mapeia tabelas do tenant (rota genérica /api/:schema/tabelas/:tabela) para o módulo
 * de permissões que as governa (leitura e gravação). Tabela fora daqui: leitura liberada
 * para quem é da empresa (cadastros auxiliares usados por várias telas) e gravação só
 * pelo dono, a não ser que esteja em TABELA_MODULO_ESCRITA. */
const TABELA_MODULO = Object.freeze({
  PRODUTOS: 'produtos',
  CLIENTES: 'clientes',
  PEDIDOS: 'pedidos',
  PEDIDOS_ITENS: 'pedidos',
  PEDIDOS_PARCELAS_PAGAMENTOS: 'pedidos',
  FORNECEDORES: 'fornecedores',
  MOVIMENTACOES: 'produtos_movimentacao',
  NOTAS_FISCAIS: 'notas_fiscais',
  NOTAS_FISCAIS_ITENS: 'notas_fiscais',
  LISTA_PRECOS: 'lista_precos',
  PRODUTOS_X_LISTA: 'lista_precos',
  A_RECEBER: 'financeiro',
  A_PAGAR: 'financeiro',
});

// Só a gravação é gateada: a leitura continua liberada.
const TABELA_MODULO_ESCRITA = Object.freeze({});

// Leitura liberada, gravação negada para todos: o ID nasce na loja (VENDEDORES: o Sirius usa MAX+1 no Firebird).
const TABELAS_SOMENTE_LEITURA = Object.freeze(new Set(['VENDEDORES']));

// Controle da sincronização no schema do tenant: nunca pelo CRUD genérico (nem leitura).
const TABELAS_INTERNAS = Object.freeze(new Set([
  'PARAMETROS', 'SRV_ID_MAP', 'SYNC_FILIAIS', 'FILIAIS_BLOQUEADAS', 'REGISTROS_DELETADOS',
]));

module.exports = { TABELA_MODULO, TABELA_MODULO_ESCRITA, TABELAS_SOMENTE_LEITURA, TABELAS_INTERNAS };
