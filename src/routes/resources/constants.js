/**
 * Constantes e validações de negócio para as rotas de tabelas.
 * Centraliza tudo que era module-level em tabelas.js (monolítico).
 */

/** Valida nomes de tabelas, colunas e PKs vindos de parâmetros HTTP. */
const NOME_VALIDO = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Tabelas transacionais que exigem filtro obrigatório de ID_LOJA para gerente/vendedor. */
const TABELAS_FILTRO_LOJA = new Set([
  'PEDIDOS', 'PEDIDOS_ITENS', 'PEDIDOS_PARCELAS_PAGAMENTOS', 'CLIENTES',
]);

/** Colunas de controle de sincronização que nunca devem ser exibidas ao usuário. */
const COLS_OCULTAS = new Set([
  'ID_ULTIMA_ATUALIZACAO_MATRIZ', 'ID_ULTIMA_ATUALIZACAO_WEB',
  'ID_ULTIMA_ATT_IFOOD', 'DATA_INCLUSAO_SIRIUS', 'DATA_ALTERACAO_SIRIUS', 'ULTIMA_ALTERACAO',
]);

/** Colunas candidatas à data de negócio do pedido, em ordem de preferência. */
const COLS_DATA_PEDIDO = Object.freeze(['DATA_DO_PEDIDO', 'DATA_HORA', 'DATA_EMISSAO']);

/** Chaves aceitas em PUT /admin/sync-config. */
const CHAVES_PERMITIDAS = Object.freeze(new Set(['filtro_filial_clientes', 'venda_saldo_negativo']));

/** Colunas candidatas ao nome do vendedor em VENDEDORES, em ordem de preferência. */
const NAME_CANDIDATES = Object.freeze(['NOME_VENDEDOR', 'NOME', 'RAZAO_SOCIAL', 'DESCRICAO']);

/** Colunas de PEDIDOS permitidas para ordenação direta (sem subquery ou alias). */
const SORT_COLS_DIRETOS = Object.freeze(
  new Set(['ID_PEDIDO', 'ID_CLIENTE', 'NOME_CLIENTE', 'DATA_DO_PEDIDO', 'STATUS', 'ID_LOJA'])
);

/**
 * Definição plana de colunas para o JOIN de pedidos-completo.
 * src: alias da tabela ('p'=PEDIDOS, 'pi'=PEDIDOS_ITENS, 'pr'=PRODUTOS, 'pp'=PEDIDOS_PARCELAS_PAGAMENTOS).
 * Colunas ausentes no banco são silenciosamente ignoradas.
 */
const COLS_FLAT = Object.freeze([
  // IDs — agrupados no início, coluna compacta
  { col: 'ID_PEDIDO',          src: 'p',  grupo: 'IDs' },
  { col: 'ID_PEDIDO_ITEM',     src: 'pi', grupo: 'IDs' },
  { col: 'ID_PRODUTO',         src: 'pi', grupo: 'IDs' },
  { col: 'PARCELA',            src: 'pp', grupo: 'IDs' },
  { col: 'ID_CLIENTE',         src: 'p',  grupo: 'IDs' },
  { col: 'ID_VENDEDOR',        src: 'p',  grupo: 'IDs' },
  { col: 'ID_LOJA',            src: 'p',  grupo: 'IDs' },
  // Dados — ordem pedida pelo usuário
  { col: 'NOME_PRODUTO',       src: 'pr', grupo: 'Dados' },
  { col: 'NOME',               src: 'pr', grupo: 'Dados' },
  { col: 'DESCRICAO',          src: 'pr', grupo: 'Dados' },
  { col: 'DESCRICAO_PRODUTO',  src: 'pr', grupo: 'Dados' },
  { col: 'QUANTIDADE',         src: 'pi', grupo: 'Dados' },
  { col: 'VALOR_UNITARIO',     src: 'pi', grupo: 'Dados' },
  { col: 'PRECO_UNITARIO',     src: 'pi', grupo: 'Dados' },
  { col: 'VALOR',              src: 'pp', grupo: 'Dados' },
  { col: 'TIPO_OPERACAO',      src: 'p',  grupo: 'Dados' },
  { col: 'NOME_CLIENTE',       src: 'p',  grupo: 'Dados' },
  { col: 'NOME_VENDEDOR',      src: 'p',  grupo: 'Dados' },
  { col: 'DATA_DO_PEDIDO',     src: 'p',  grupo: 'Dados' },
  { col: 'HORA_DO_PEDIDO',     src: 'p',  grupo: 'Dados' },
  { col: 'STATUS',             src: 'p',  grupo: 'Dados' },
]);

// ── Regras de negócio por tabela (aplicadas no upsert do backend) ────────────
// Campo lookup é case-insensitive para tolerar frontends que enviam lowercase.

/**
 * Busca um campo no registro de forma case-insensitive.
 * Retorna undefined se o campo estiver ausente, null ou vazio.
 *
 * @param {object} registro
 * @param {string} nome — nome do campo em UPPERCASE
 * @returns {*}
 */
function campo(registro, nome) {
  const chave = Object.keys(registro).find(k => k.toUpperCase() === nome);
  const val   = chave !== undefined ? registro[chave] : undefined;
  if (val === null || val === undefined || String(val).trim() === '') return undefined;
  return val;
}

const REGRAS_TABELA = Object.freeze({
  PRODUTOS: {
    validacoes: [
      r => {
        const cest = String(campo(r, 'CODIGO_CEST') ?? '').replace(/\D/g, '');
        if (cest.length > 0 && cest.length !== 7)
          return 'CEST inválido — deve ter exatamente 7 dígitos';
        return null;
      },
      r => {
        const cst = String(campo(r, 'CST_ICMS_ECF') ?? '').trim();
        if (cst === '00' && campo(r, 'ALIQUOTA_ICMS') === undefined)
          return 'Alíquota ICMS é obrigatória quando CST ICMS é 00';
        return null;
      },
    ],
  },
  CLIENTES: {
    obrigatorios: ['RAZAO_SOCIAL', 'FANTASIA', 'PESSOA_P_CONTATO', 'E_MAIL_DANFE'],
    validacoes: [
      r => {
        const razao = String(campo(r, 'RAZAO_SOCIAL') ?? '').trim();
        if (razao.length > 60) return 'Razão Social deve ter no máximo 60 caracteres';
        if (razao && !/^[A-Za-zÀ-ÖØ-öø-ÿ0-9 &]+$/.test(razao))
          return 'Razão Social: use apenas letras, números, espaços e o caractere &';
        return null;
      },
      r => {
        const insc = String(campo(r, 'INSC_ESTADUAL') ?? '').trim();
        if (insc && !/^\d{9}$/.test(insc))
          return 'Inscrição Estadual deve conter exatamente 9 números';
        return null;
      },
      r => {
        const temCPF  = !!campo(r, 'CPF');
        const temCNPJ = !!campo(r, 'CNPJ');
        if (!temCPF && !temCNPJ) return 'Informe o CPF ou o CNPJ do cliente';
        if (temCPF  && temCNPJ)  return 'Informe apenas CPF ou CNPJ, não os dois ao mesmo tempo';
        return null;
      },
    ],
  },
  PEDIDOS: {
    obrigatorios: ['ID_CLIENTE', 'STATUS'],
  },
  PEDIDOS_ITENS: {
    obrigatorios: ['ID_PEDIDO', 'ID_PRODUTO', 'QUANTIDADE', 'VALOR_UNITARIO'],
    validacoes: [
      r => (Number(campo(r, 'QUANTIDADE'))    <= 0) ? 'Quantidade deve ser maior que zero'          : null,
      r => (Number(campo(r, 'VALOR_UNITARIO')) < 0) ? 'Valor unitário não pode ser negativo'        : null,
    ],
  },
  PEDIDOS_PARCELAS_PAGAMENTOS: {
    obrigatorios: ['ID_PEDIDO', 'PARCELA', 'VALOR'],
    validacoes: [
      r => (Number(campo(r, 'VALOR')) <= 0) ? 'Valor do pagamento deve ser maior que zero' : null,
    ],
  },
});

/**
 * Valida um registro contra as regras da tabela.
 * Retorna a mensagem de erro ou null se válido.
 *
 * @param {string} tabela
 * @param {object} registro
 * @returns {string|null}
 */
function validarRegistro(tabela, registro) {
  const regras = REGRAS_TABELA[tabela.toUpperCase()];
  if (!regras) return null;
  for (const c of (regras.obrigatorios || [])) {
    if (campo(registro, c) === undefined)
      return `O campo "${c}" é obrigatório`;
  }
  for (const fn of (regras.validacoes || [])) {
    const erro = fn(registro);
    if (erro) return erro;
  }
  return null;
}

module.exports = {
  NOME_VALIDO,
  TABELAS_FILTRO_LOJA,
  COLS_OCULTAS,
  COLS_DATA_PEDIDO,
  CHAVES_PERMITIDAS,
  NAME_CANDIDATES,
  SORT_COLS_DIRETOS,
  COLS_FLAT,
  REGRAS_TABELA,
  campo,
  validarRegistro,
};
