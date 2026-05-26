/**
 * Configuração de todas as tabelas que o cliente sincroniza da matriz.
 *
 * Cada entrada é criada pela factory `tabela()`, que aplica os valores padrão
 * e garante que todos os campos obrigatórios estejam presentes.
 *
 * Campos disponíveis (ver typedef TabelaConfig abaixo):
 *   nome             — nome da tabela no banco (obrigatório)
 *   pk               — PK simples (string) ou composta (string[]) (obrigatório)
 *   grupo            — grupo lógico, use as constantes GRUPOS (obrigatório)
 *   temDelete        — se deve buscar registros deletados no servidor (padrão: true)
 *   filtroFilial     — coluna para filtrar por filial (ex: 'ID_LOJA'); null = tabela global
 *                      Ativar somente após confirmar que a coluna existe no banco KR.
 *   filtroFilialViaFK — FK para uma tabela que já tem filtroFilial (ex: 'ID_PEDIDO');
 *                      null = filtro direto ou nenhum filtro
 *   endpoint         — rota do servidor; null usa TSMSincronizacao/RegistrosParaAtualizar
 *   generator        — generator Firebird para avançar após colisão de PK na filial;
 *                      null = tabela somente recebida (filial não cria registros locais)
 *   colunaData       — coluna de data de negócio para a política de retenção de 2 anos;
 *                      null = cadastro/referência sem expiração por data
 *   defaultAtivo     — se a tabela começa ativa no painel de configurações (padrão: false)
 *
 * Ordem importa: tabelas referenciadas por FK devem vir antes das dependentes.
 */

// ── Tipo ─────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} TabelaConfig
 * @property {string}           nome
 * @property {string|string[]}  pk
 * @property {string}           grupo
 * @property {boolean}          temDelete
 * @property {string|null}      filtroFilial
 * @property {string|null}      filtroFilialViaFK
 * @property {string|null}      endpoint
 * @property {string|null}      generator
 * @property {string|null}      colunaData
 * @property {boolean}          defaultAtivo
 */

// ── Constantes de grupo ───────────────────────────────────────────────────────

const GRUPOS = Object.freeze({
  AUXILIARES: 'Auxiliares',
  CADASTROS: 'Cadastros',
  PRODUTOS: 'Produtos',
  CLIENTES: 'Clientes',
  FORNECEDORES: 'Fornecedores',
  TRANSPORTADORES: 'Transportadores',
  VENDEDORES: 'Vendedores',
  PEDIDOS: 'Pedidos',
  KITS: 'Kits',
});

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Cria uma entrada de tabela aplicando os valores padrão.
 * Informe apenas os campos que diferem do padrão.
 *
 * @param {Pick<TabelaConfig, 'nome'|'pk'|'grupo'> & Partial<TabelaConfig>} config
 * @returns {TabelaConfig}
 */
function tabela({
  nome,
  pk,
  grupo,
  temDelete = true,
  filtroFilial = null,
  filtroFilialViaFK = null,
  endpoint = null,
  generator = null,
  colunaData = null,
  defaultAtivo = false,
}) {
  return { nome, pk, grupo, temDelete, filtroFilial, filtroFilialViaFK, endpoint, generator, colunaData, defaultAtivo };
}

// ── Lista de tabelas ──────────────────────────────────────────────────────────

/** @type {TabelaConfig[]} */
const TABELAS = [

  // ── Auxiliares ──────────────────────────────────────────────────────────────
  tabela({ nome: 'UNIDADES', pk: 'UNIDADE', grupo: GRUPOS.AUXILIARES, defaultAtivo: true }),
  tabela({ nome: 'AUX_CLASSIFICACOES_FISCAIS', pk: 'ID_AUX_CLASSIFICACAO_FISCAL', grupo: GRUPOS.AUXILIARES }),
  tabela({ nome: 'AUX_CODIFICACAO_GRUPOS', pk: 'SIGLA_GRUPO', grupo: GRUPOS.AUXILIARES, temDelete: false, defaultAtivo: true }),
  tabela({ nome: 'AUX_ESPECIES_EMBALAGENS', pk: 'ID_AUX_ESPECIE_EMBALAGEM', grupo: GRUPOS.AUXILIARES }),
  tabela({ nome: 'AUX_GENERICA', pk: ['SUB_TABELA', 'ID_SUB_TABELA'], grupo: GRUPOS.AUXILIARES, temDelete: false, defaultAtivo: true }),
  tabela({ nome: 'AUX_PAISES_BACEN', pk: 'ID_AUX_PAIS_BACEN', grupo: GRUPOS.AUXILIARES }),
  tabela({ nome: 'AUX_PARCELAS_PAGAMENTOS', pk: 'ID_AUX_PARCELA_PAGAMENTO', grupo: GRUPOS.AUXILIARES }),
  tabela({ nome: 'FORMAS_DE_PAGAMENTOS', pk: 'ID_FORMA_DE_PAGAMENTO', grupo: GRUPOS.AUXILIARES, defaultAtivo: true }),
  tabela({ nome: 'AUX_SITUACOES_TRIBUTARIAS', pk: 'ID_SITUACAO_TRIBUTARIA', grupo: GRUPOS.AUXILIARES }),
  tabela({ nome: 'AUX_SUB_GRUPOS', pk: 'ID_AUX_SUB_GRUPO', grupo: GRUPOS.AUXILIARES }),
  tabela({ nome: 'AUX_MOEDAS', pk: 'SIGLA_MOEDA', grupo: GRUPOS.AUXILIARES }),

  // ── Cadastros base ──────────────────────────────────────────────────────────
  tabela({ nome: 'CENTROS_DE_CUSTO', pk: 'CODIGO_CENTRO_DE_CUSTO', grupo: GRUPOS.CADASTROS }),
  tabela({ nome: 'CLASSIFICACOES', pk: 'ID_CLASSIFICACAO', grupo: GRUPOS.CADASTROS }),
  tabela({ nome: 'CODIGOS_REGIMES_TRIBUTARIOS', pk: 'ID_CODIGO_REGIME_TRIBUTARIO', grupo: GRUPOS.CADASTROS }),
  tabela({ nome: 'CONTAS', pk: 'REDUZIDO', grupo: GRUPOS.CADASTROS }),
  tabela({ nome: 'DEPARTAMENTOS', pk: 'SIGLA_DEPARTAMENTO', grupo: GRUPOS.CADASTROS }),
  tabela({ nome: 'LISTA_PRECOS', pk: 'ID_LISTA', grupo: GRUPOS.CADASTROS }),
  tabela({ nome: 'TIPOS_PRODUTOS', pk: 'ID_TIPO_PRODUTO', grupo: GRUPOS.CADASTROS }),

  // ── Produtos ────────────────────────────────────────────────────────────────
  tabela({
    nome: 'PRODUTOS',
    pk: 'ID_PRODUTO',
    grupo: GRUPOS.PRODUTOS,
    endpoint: 'TSMProdutos/ProdutosParaAtualizar',
    generator: 'NOVO_PRODUTO',
    defaultAtivo: true,
  }),
  tabela({ nome: 'PRODUTOS_GRADES', pk: 'ID_PRODUTO_GRADE', grupo: GRUPOS.PRODUTOS, generator: 'NOVO_PRODUTOS_GRADES' }),
  tabela({ nome: 'PRODUTOS_X_LISTA', pk: 'ID_PRODUTO_X_LISTA', grupo: GRUPOS.PRODUTOS, generator: 'NOVO_PRODUTO_X_LISTA' }),
  tabela({
    nome: 'MOVIMENTACOES',
    pk: 'ID_MOVIMENTACAO',
    grupo: GRUPOS.PRODUTOS,
    filtroFilial: 'ID_LOJA',
    generator: 'NOVA_MOVIMENTACAO',
    colunaData: 'DATA',
    defaultAtivo: true,
  }),

  // ── Clientes ────────────────────────────────────────────────────────────────
  // Candidatas a filtroFilial: 'ID_LOJA' — confirmar colunas no banco KR antes de ativar
  tabela({ nome: 'CLIENTES', pk: 'ID_CLIENTE', grupo: GRUPOS.CLIENTES, generator: 'NOVO_CLIENTE', defaultAtivo: true }),
  tabela({ nome: 'CLIENTES_X_ENTREGA', pk: 'ID_CLIENTE_X_ENTREGA', grupo: GRUPOS.CLIENTES, generator: 'NOVO_CLIENTES_X_ENTREGA' }),
  tabela({ nome: 'ENDERECOS_DE_RETIRADA', pk: 'ID_ENDERECO_DE_RETIRADA', grupo: GRUPOS.CLIENTES }),

  // ── Fornecedores ────────────────────────────────────────────────────────────
  tabela({ nome: 'FORNECEDORES', pk: 'ID_FORNECEDOR', grupo: GRUPOS.FORNECEDORES, generator: 'NOVO_FORNECEDOR' }),
  tabela({ nome: 'FORN_CONTATOS_ADICIONAIS', pk: 'ID_FORN_CONTATO_ADICIONAL', grupo: GRUPOS.FORNECEDORES, generator: 'NOVO_FORN_CONTATO_ADICIONAL' }),
  tabela({ nome: 'FORMAS_DE_PAGAMENTOS_SISPAG', pk: 'ID_FORMA_DE_PAGAMENTO_SISPAG', grupo: GRUPOS.FORNECEDORES }),

  // ── Transportadores ─────────────────────────────────────────────────────────
  tabela({ nome: 'TRANSPORTADORES', pk: 'ID_TRANSPORTADOR', grupo: GRUPOS.TRANSPORTADORES, generator: 'TRANSPORTADOR' }),
  tabela({ nome: 'TRANSP_CONTATOS_ADICIONAIS', pk: 'ID_TRANS_CONTATO_ADICIONAL', grupo: GRUPOS.TRANSPORTADORES, generator: 'NOVO_TRANSP_CONTATO_ADICIONAL' }),
  tabela({ nome: 'TRANSPORTADORES_PLACAS', pk: 'ID_TRANSPORTADOR_PLACA', grupo: GRUPOS.TRANSPORTADORES, generator: 'TRANSPORTADOR_PLACA' }),

  // ── Vendedores / Representantes ─────────────────────────────────────────────
  // Candidatas a filtroFilial: 'ID_LOJA' — confirmar colunas no banco KR antes de ativar
  tabela({ nome: 'VENDEDORES', pk: 'ID_VENDEDOR', grupo: GRUPOS.VENDEDORES, defaultAtivo: true }),
  tabela({ nome: 'REPRESENTANTES', pk: 'ID_REPRESENTANTE', grupo: GRUPOS.VENDEDORES, generator: 'NOVO_REPRESENTANTE' }),
  tabela({ nome: 'SUPERVISORES', pk: 'ID_SUPERVISOR', grupo: GRUPOS.VENDEDORES }),

  // ── Pedidos ─────────────────────────────────────────────────────────────────
  // colunaData: 'DATA_HORA' — coluna timestamp do pedido. Ajuste se o nome diferir no seu banco.
  tabela({
    nome: 'PEDIDOS',
    pk: 'ID_PEDIDO',
    grupo: GRUPOS.PEDIDOS,
    filtroFilial: 'ID_LOJA',
    generator: 'NOVO_PEDIDO',
    colunaData: 'DATA_HORA',
    defaultAtivo: true,
  }),
  tabela({
    nome: 'PEDIDOS_ITENS',
    pk: 'ID_PEDIDO_ITEM',
    grupo: GRUPOS.PEDIDOS,
    filtroFilialViaFK: 'ID_PEDIDO',
    generator: 'NOVO_PEDIDO_ITEM',
    defaultAtivo: true,
  }),
  tabela({
    nome: 'PEDIDOS_PARCELAS_PAGAMENTOS',
    pk: ['ID_PEDIDO', 'PARCELA'],
    grupo: GRUPOS.PEDIDOS,
    temDelete: false,
    filtroFilialViaFK: 'ID_PEDIDO',
    defaultAtivo: true,
  }),

  // ── Kits ────────────────────────────────────────────────────────────────────
  tabela({ nome: 'KITS_PRODUTOS', pk: 'ID_KIT_PRODUTO', grupo: GRUPOS.KITS }),
  tabela({ nome: 'KITS_ITENS_PROD', pk: 'ID_KIT_ITEM_PROD', grupo: GRUPOS.KITS }),
  tabela({ nome: 'KITS_ITENS_SUB_PROD', pk: 'ID_KIT_ITEM_SUB_PROD', grupo: GRUPOS.KITS }),

  // ── Sync4Market (desativado — tabelas não existem neste banco) ───────────────
  // tabela({ nome: 'SYNC_4M_PRODUTOS',    pk: 'ID_4M_PRODUTO',    grupo: 'Sync4Market' }),
  // tabela({ nome: 'SYNC_4M_PROD_CANAIS', pk: 'ID_4M_PROD_CANAL', grupo: 'Sync4Market' }),
  // tabela({ nome: 'SYNC_4M_PROD_IMGS',   pk: 'ID_4M_PROD_IMG',   grupo: 'Sync4Market' }),
  // tabela({ nome: 'SYNC_4M_PROMOCOES',   pk: 'ID_4M_PROMOCAO',   grupo: 'Sync4Market' }),
];

module.exports = TABELAS;
