/**
 * Configuração de todas as tabelas que o cliente sincroniza da matriz.
 *
 * Cada entrada define:
 *   nome          — nome da tabela no banco
 *   pk            — coluna da chave primária (usada no MATCHING do UPDATE OR INSERT)
 *   temDelete     — se deve buscar registros deletados no servidor
 *   filtroFilial  — coluna usada para filtrar registros por filial (ex: 'ID_LOJA').
 *                   null = tabela global, todos os registros são sincronizados.
 *                   Ativar somente após confirmar que a coluna existe no banco KR.
 *   endpoint      — rota do servidor (padrão: TSMSincronizacao/RegistrosParaAtualizar)
 *                   sobrescreva quando a rota for diferente (ex: Produtos)
 *   generator     — nome do generator Firebird usado pelo Delphi para gerar PKs nesta tabela.
 *                   Preenchido apenas em tabelas onde a filial cria registros localmente.
 *                   null = tabela apenas recebida da matriz (sem criação local na filial).
 *                   Usado para avançar o generator após resolver colisão de PK, evitando
 *                   que o próximo INSERT do Delphi reutilize um ID já ocupado.
 *   colunaData    — coluna de data de negócio usada para a política de retenção de 2 anos.
 *                   Quando preenchida, o servidor filtra registros mais velhos que 2 anos
 *                   no pull, e a limpeza diária deleta esses registros da filial e do servidor.
 *                   null = tabela de cadastro/referência — sem expiração por data.
 *
 * Ordem importa: tabelas referenciadas por FK devem vir antes das dependentes.
 */
const TABELAS = [
  // --- Auxiliares ---
  { nome: 'UNIDADES',                        pk: 'UNIDADE',                          temDelete: true,  filtroFilial: null, grupo: 'Auxiliares',      generator: null,                            colunaData: null, defaultAtivo: true  },
  { nome: 'AUX_CLASSIFICACOES_FISCAIS',      pk: 'ID_AUX_CLASSIFICACAO_FISCAL',      temDelete: true,  filtroFilial: null, grupo: 'Auxiliares',      generator: null,                            colunaData: null, defaultAtivo: false },
  { nome: 'AUX_CODIFICACAO_GRUPOS',          pk: 'SIGLA_GRUPO',                      temDelete: true,  filtroFilial: null, grupo: 'Auxiliares',      generator: null,                            colunaData: null, defaultAtivo: false },
  { nome: 'AUX_ESPECIES_EMBALAGENS',         pk: 'ID_AUX_ESPECIE_EMBALAGEM',         temDelete: true,  filtroFilial: null, grupo: 'Auxiliares',      generator: null,                            colunaData: null, defaultAtivo: false },
  { nome: 'AUX_GENERICA',                    pk: ['SUB_TABELA', 'ID_SUB_TABELA'],    temDelete: false, filtroFilial: null, grupo: 'Auxiliares',      generator: null,                            colunaData: null, defaultAtivo: true  },
  { nome: 'AUX_PAISES_BACEN',                pk: 'ID_AUX_PAIS_BACEN',                temDelete: true,  filtroFilial: null, grupo: 'Auxiliares',      generator: null,                            colunaData: null, defaultAtivo: false },
  { nome: 'AUX_PARCELAS_PAGAMENTOS',         pk: 'ID_AUX_PARCELA_PAGAMENTO',         temDelete: true,  filtroFilial: null, grupo: 'Auxiliares',      generator: null,                            colunaData: null, defaultAtivo: false },
  { nome: 'FORMAS_DE_PAGAMENTOS',            pk: 'ID_FORMA_DE_PAGAMENTO',            temDelete: true,  filtroFilial: null, grupo: 'Auxiliares',      generator: null,                            colunaData: null, defaultAtivo: true  },
  { nome: 'AUX_SITUACOES_TRIBUTARIAS',       pk: 'ID_SITUACAO_TRIBUTARIA',           temDelete: true,  filtroFilial: null, grupo: 'Auxiliares',      generator: null,                            colunaData: null, defaultAtivo: false },
  { nome: 'AUX_SUB_GRUPOS',                  pk: 'ID_AUX_SUB_GRUPO',                 temDelete: true,  filtroFilial: null, grupo: 'Auxiliares',      generator: null,                            colunaData: null, defaultAtivo: false },
  { nome: 'AUX_MOEDAS',                      pk: 'SIGLA_MOEDA',                      temDelete: true,  filtroFilial: null, grupo: 'Auxiliares',      generator: null,                            colunaData: null, defaultAtivo: false },

  // --- Cadastros base ---
  { nome: 'CENTROS_DE_CUSTO',                pk: 'CODIGO_CENTRO_DE_CUSTO',           temDelete: true,  filtroFilial: null, grupo: 'Cadastros',       generator: null,                            colunaData: null, defaultAtivo: false },
  { nome: 'CLASSIFICACOES',                  pk: 'ID_CLASSIFICACAO',                 temDelete: true,  filtroFilial: null, grupo: 'Cadastros',       generator: null,                            colunaData: null, defaultAtivo: false },
  { nome: 'CODIGOS_REGIMES_TRIBUTARIOS',     pk: 'ID_CODIGO_REGIME_TRIBUTARIO',      temDelete: true,  filtroFilial: null, grupo: 'Cadastros',       generator: null,                            colunaData: null, defaultAtivo: false },
  { nome: 'CONTAS',                          pk: 'REDUZIDO',                         temDelete: true,  filtroFilial: null, grupo: 'Cadastros',       generator: null,                            colunaData: null, defaultAtivo: false },
  { nome: 'DEPARTAMENTOS',                   pk: 'SIGLA_DEPARTAMENTO',               temDelete: true,  filtroFilial: null, grupo: 'Cadastros',       generator: null,                            colunaData: null, defaultAtivo: false },
  { nome: 'LISTA_PRECOS',                    pk: 'ID_LISTA',                         temDelete: true,  filtroFilial: null, grupo: 'Cadastros',       generator: null,                            colunaData: null, defaultAtivo: false },
  { nome: 'TIPOS_PRODUTOS',                  pk: 'ID_TIPO_PRODUTO',                  temDelete: true,  filtroFilial: null, grupo: 'Cadastros',       generator: null,                            colunaData: null, defaultAtivo: false },

  // --- Produtos ---
  {
    nome: 'PRODUTOS',
    pk: 'ID_PRODUTO',
    temDelete: true,
    filtroFilial: null,
    endpoint: 'TSMProdutos/ProdutosParaAtualizar',
    grupo: 'Produtos',
    generator: 'NOVO_PRODUTO',
    colunaData: null,
    defaultAtivo: true,
  },
  { nome: 'PRODUTOS_GRADES',                 pk: 'ID_PRODUTO_GRADE',                 temDelete: true,  filtroFilial: null, grupo: 'Produtos',        generator: 'NOVO_PRODUTOS_GRADES',          colunaData: null, defaultAtivo: false },
  { nome: 'PRODUTOS_X_LISTA',                pk: 'ID_PRODUTO_X_LISTA',               temDelete: true,  filtroFilial: null, grupo: 'Produtos',        generator: 'NOVO_PRODUTO_X_LISTA',          colunaData: null, defaultAtivo: false },

  // --- Clientes ---
  // Candidatas a filtroFilial: 'ID_LOJA' — confirmar colunas no banco KR antes de ativar
  { nome: 'CLIENTES',                        pk: 'ID_CLIENTE',                       temDelete: true,  filtroFilial: null, grupo: 'Clientes',        generator: 'NOVO_CLIENTE',                  colunaData: null, defaultAtivo: true  },
  { nome: 'CLIENTES_X_ENTREGA',              pk: 'ID_CLIENTE_X_ENTREGA',             temDelete: true,  filtroFilial: null, grupo: 'Clientes',        generator: 'NOVO_CLIENTES_X_ENTREGA',       colunaData: null, defaultAtivo: false },
  { nome: 'ENDERECOS_DE_RETIRADA',           pk: 'ID_ENDERECO_DE_RETIRADA',          temDelete: true,  filtroFilial: null, grupo: 'Clientes',        generator: null,                            colunaData: null, defaultAtivo: false },

  // --- Fornecedores ---
  { nome: 'FORNECEDORES',                    pk: 'ID_FORNECEDOR',                    temDelete: true,  filtroFilial: null, grupo: 'Fornecedores',    generator: 'NOVO_FORNECEDOR',               colunaData: null, defaultAtivo: false },
  { nome: 'FORN_CONTATOS_ADICIONAIS',        pk: 'ID_FORN_CONTATO_ADICIONAL',        temDelete: true,  filtroFilial: null, grupo: 'Fornecedores',    generator: 'NOVO_FORN_CONTATO_ADICIONAL',   colunaData: null, defaultAtivo: false },
  { nome: 'FORMAS_DE_PAGAMENTOS_SISPAG',     pk: 'ID_FORMA_DE_PAGAMENTO_SISPAG',     temDelete: true,  filtroFilial: null, grupo: 'Fornecedores',    generator: null,                            colunaData: null, defaultAtivo: false },

  // --- Transportadores ---
  { nome: 'TRANSPORTADORES',                 pk: 'ID_TRANSPORTADOR',                 temDelete: true,  filtroFilial: null, grupo: 'Transportadores', generator: 'TRANSPORTADOR',                 colunaData: null, defaultAtivo: false },
  { nome: 'TRANSP_CONTATOS_ADICIONAIS',      pk: 'ID_TRANS_CONTATO_ADICIONAL',       temDelete: true,  filtroFilial: null, grupo: 'Transportadores', generator: 'NOVO_TRANSP_CONTATO_ADICIONAL',  colunaData: null, defaultAtivo: false },
  { nome: 'TRANSPORTADORES_PLACAS',          pk: 'ID_TRANSPORTADOR_PLACA',           temDelete: true,  filtroFilial: null, grupo: 'Transportadores', generator: 'TRANSPORTADOR_PLACA',            colunaData: null, defaultAtivo: false },

  // --- Vendedores / Representantes ---
  // Candidatas a filtroFilial: 'ID_LOJA' — confirmar colunas no banco KR antes de ativar
  { nome: 'VENDEDORES',                      pk: 'ID_VENDEDOR',                      temDelete: true,  filtroFilial: null, grupo: 'Vendedores',      generator: null,                            colunaData: null, defaultAtivo: false },
  { nome: 'REPRESENTANTES',                  pk: 'ID_REPRESENTANTE',                 temDelete: true,  filtroFilial: null, grupo: 'Vendedores',      generator: 'NOVO_REPRESENTANTE',            colunaData: null, defaultAtivo: false },
  { nome: 'SUPERVISORES',                    pk: 'ID_SUPERVISOR',                    temDelete: true,  filtroFilial: null, grupo: 'Vendedores',      generator: null,                            colunaData: null, defaultAtivo: false },

  // --- Pedidos ---
  // colunaData: 'DATA_HORA' — coluna timestamp do pedido. Ajuste se o nome diferir no seu banco.
  { nome: 'PEDIDOS',                     pk: 'ID_PEDIDO',              temDelete: true,  filtroFilial: 'ID_LOJA', filtroFilialViaFK: null,       grupo: 'Pedidos', generator: 'NOVO_PEDIDO',      colunaData: 'DATA_HORA', defaultAtivo: true },
  { nome: 'PEDIDOS_ITENS',               pk: 'ID_PEDIDO_ITEM',         temDelete: true,  filtroFilial: null,      filtroFilialViaFK: 'ID_PEDIDO', grupo: 'Pedidos', generator: 'NOVO_PEDIDO_ITEM', colunaData: null,        defaultAtivo: true },
  { nome: 'PEDIDOS_PARCELAS_PAGAMENTOS', pk: ['ID_PEDIDO', 'PARCELA'], temDelete: false, filtroFilial: null,      filtroFilialViaFK: 'ID_PEDIDO', grupo: 'Pedidos', generator: null,               colunaData: null,        defaultAtivo: true },

  // --- Kits ---
  { nome: 'KITS_PRODUTOS',                   pk: 'ID_KIT_PRODUTO',                   temDelete: true,  filtroFilial: null, grupo: 'Kits',            generator: null,                            colunaData: null, defaultAtivo: false },
  { nome: 'KITS_ITENS_PROD',                 pk: 'ID_KIT_ITEM_PROD',                 temDelete: true,  filtroFilial: null, grupo: 'Kits',            generator: null,                            colunaData: null, defaultAtivo: false },
  { nome: 'KITS_ITENS_SUB_PROD',             pk: 'ID_KIT_ITEM_SUB_PROD',             temDelete: true,  filtroFilial: null, grupo: 'Kits',            generator: null,                            colunaData: null, defaultAtivo: false },

  // --- Sync4Market (comentado — tabelas não existem neste banco) ---
  // { nome: 'SYNC_4M_PRODUTOS',             pk: 'ID_4M_PRODUTO',                    temDelete: true,  filtroFilial: null, grupo: 'Sync4Market' },
  // { nome: 'SYNC_4M_PROD_CANAIS',          pk: 'ID_4M_PROD_CANAL',                 temDelete: true,  filtroFilial: null, grupo: 'Sync4Market' },
  // { nome: 'SYNC_4M_PROD_IMGS',            pk: 'ID_4M_PROD_IMG',                   temDelete: true,  filtroFilial: null, grupo: 'Sync4Market' },
  // { nome: 'SYNC_4M_PROMOCOES',            pk: 'ID_4M_PROMOCAO',                   temDelete: true,  filtroFilial: null, grupo: 'Sync4Market' },
];

module.exports = TABELAS;
