/**
 * Configuração de todas as tabelas que o cliente sincroniza da matriz.
 *
 * Cada entrada define:
 *   nome      — nome da tabela no banco
 *   pk        — coluna da chave primária (usada no MATCHING do UPDATE OR INSERT)
 *   temDelete — se deve buscar registros deletados no servidor
 *   endpoint  — rota do servidor (padrão: TSMSincronizacao/RegistrosParaAtualizar)
 *               sobrescreva quando a rota for diferente (ex: Produtos)
 *
 * Ordem importa: tabelas referenciadas por FK devem vir antes das dependentes.
 */
const TABELAS = [
  // --- Auxiliares ---
  { nome: 'UNIDADES',                        pk: 'UNIDADE',                          temDelete: true,  grupo: 'Auxiliares' },
  { nome: 'AUX_CLASSIFICACOES_FISCAIS',      pk: 'ID_AUX_CLASSIFICACAO_FISCAL',      temDelete: true,  grupo: 'Auxiliares' },
  { nome: 'AUX_CODIFICACAO_GRUPOS',          pk: 'SIGLA_GRUPO',                      temDelete: true,  grupo: 'Auxiliares' },
  { nome: 'AUX_ESPECIES_EMBALAGENS',         pk: 'ID_AUX_ESPECIE_EMBALAGEM',         temDelete: true,  grupo: 'Auxiliares' },
  { nome: 'AUX_GENERICA',                    pk: ['SUB_TABELA', 'ID_SUB_TABELA'],    temDelete: false, grupo: 'Auxiliares' },
  { nome: 'AUX_PAISES_BACEN',                pk: 'ID_AUX_PAIS_BACEN',                temDelete: true,  grupo: 'Auxiliares' },
  { nome: 'AUX_PARCELAS_PAGAMENTOS',         pk: 'ID_AUX_PARCELA_PAGAMENTO',         temDelete: true,  grupo: 'Auxiliares' },
  { nome: 'AUX_SITUACOES_TRIBUTARIAS',       pk: 'ID_SITUACAO_TRIBUTARIA',           temDelete: true,  grupo: 'Auxiliares' },
  { nome: 'AUX_SUB_GRUPOS',                  pk: 'ID_AUX_SUB_GRUPO',                 temDelete: true,  grupo: 'Auxiliares' },
  { nome: 'AUX_MOEDAS',                      pk: 'SIGLA_MOEDA',                      temDelete: true,  grupo: 'Auxiliares' },

  // --- Cadastros base ---
  { nome: 'CENTROS_DE_CUSTO',                pk: 'CODIGO_CENTRO_DE_CUSTO',           temDelete: true,  grupo: 'Cadastros' },
  { nome: 'CLASSIFICACOES',                  pk: 'ID_CLASSIFICACAO',                 temDelete: true,  grupo: 'Cadastros' },
  { nome: 'CODIGOS_REGIMES_TRIBUTARIOS',     pk: 'ID_CODIGO_REGIME_TRIBUTARIO',      temDelete: true,  grupo: 'Cadastros' },
  { nome: 'CONTAS',                          pk: 'REDUZIDO',                         temDelete: true,  grupo: 'Cadastros' },
  { nome: 'DEPARTAMENTOS',                   pk: 'SIGLA_DEPARTAMENTO',               temDelete: true,  grupo: 'Cadastros' },
  { nome: 'LISTA_PRECOS',                    pk: 'ID_LISTA',                         temDelete: true,  grupo: 'Cadastros' },
  { nome: 'TIPOS_PRODUTOS',                  pk: 'ID_TIPO_PRODUTO',                  temDelete: true,  grupo: 'Cadastros' },

  // --- Produtos ---
  {
    nome: 'PRODUTOS',
    pk: 'ID_PRODUTO',
    temDelete: true,
    endpoint: 'TSMProdutos/ProdutosParaAtualizar',
    grupo: 'Produtos',
  },
  { nome: 'PRODUTOS_GRADES',                 pk: 'ID_PRODUTO_GRADE',                 temDelete: true,  grupo: 'Produtos' },
  { nome: 'PRODUTOS_X_LISTA',               pk: 'ID_PRODUTO_X_LISTA',               temDelete: true,  grupo: 'Produtos' },

  // --- Clientes ---
  { nome: 'CLIENTES',                        pk: 'ID_CLIENTE',                       temDelete: true,  grupo: 'Clientes' },
  { nome: 'CLIENTES_X_ENTREGA',              pk: 'ID_CLIENTE_X_ENTREGA',             temDelete: true,  grupo: 'Clientes' },
  { nome: 'ENDERECOS_DE_RETIRADA',           pk: 'ID_ENDERECO_DE_RETIRADA',          temDelete: true,  grupo: 'Clientes' },

  // --- Fornecedores ---
  { nome: 'FORNECEDORES',                    pk: 'ID_FORNECEDOR',                    temDelete: true,  grupo: 'Fornecedores' },
  { nome: 'FORN_CONTATOS_ADICIONAIS',        pk: 'ID_FORN_CONTATO_ADICIONAL',        temDelete: true,  grupo: 'Fornecedores' },
  { nome: 'FORMAS_DE_PAGAMENTOS_SISPAG',     pk: 'ID_FORMA_DE_PAGAMENTO_SISPAG',     temDelete: true,  grupo: 'Fornecedores' },

  // --- Transportadores ---
  { nome: 'TRANSPORTADORES',                 pk: 'ID_TRANSPORTADOR',                 temDelete: true,  grupo: 'Transportadores' },
  { nome: 'TRANSP_CONTATOS_ADICIONAIS',      pk: 'ID_TRANS_CONTATO_ADICIONAL',       temDelete: true,  grupo: 'Transportadores' },
  { nome: 'TRANSPORTADORES_PLACAS',          pk: 'ID_TRANSPORTADOR_PLACA',           temDelete: true,  grupo: 'Transportadores' },

  // --- Vendedores / Representantes ---
  { nome: 'VENDEDORES',                      pk: 'ID_VENDEDOR',                      temDelete: true,  grupo: 'Vendedores' },
  { nome: 'REPRESENTANTES',                  pk: 'ID_REPRESENTANTE',                 temDelete: true,  grupo: 'Vendedores' },
  { nome: 'SUPERVISORES',                    pk: 'ID_SUPERVISOR',                    temDelete: true,  grupo: 'Vendedores' },

  // --- Kits ---
  { nome: 'KITS_PRODUTOS',                   pk: 'ID_KIT_PRODUTO',                   temDelete: true,  grupo: 'Kits' },
  { nome: 'KITS_ITENS_PROD',                 pk: 'ID_KIT_ITEM_PROD',                 temDelete: true,  grupo: 'Kits' },
  { nome: 'KITS_ITENS_SUB_PROD',             pk: 'ID_KIT_ITEM_SUB_PROD',             temDelete: true,  grupo: 'Kits' },

  // --- Sync4Market (comentado — tabelas não existem neste banco) ---
  // { nome: 'SYNC_4M_PRODUTOS',             pk: 'ID_4M_PRODUTO',                    temDelete: true,  grupo: 'Sync4Market' },
  // { nome: 'SYNC_4M_PROD_CANAIS',          pk: 'ID_4M_PROD_CANAL',                 temDelete: true,  grupo: 'Sync4Market' },
  // { nome: 'SYNC_4M_PROD_IMGS',            pk: 'ID_4M_PROD_IMG',                   temDelete: true,  grupo: 'Sync4Market' },
  // { nome: 'SYNC_4M_PROMOCOES',            pk: 'ID_4M_PROMOCAO',                   temDelete: true,  grupo: 'Sync4Market' },
];

module.exports = TABELAS;
