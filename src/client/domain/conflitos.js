const { saoIguais, isColunaIgnorada } = require('./auditoria');

// Controle de sync que difere entre filial e matriz por natureza, nunca é conflito.
const COLUNAS_CONTROLE = new Set(['SRV_ID']);

const _vazio = v => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

/**
 * Colunas em que local e servidor divergem de verdade, descontando as diferenças que o
 * próprio sincronizador cria: ID_LOJA vazio no local (o push preenche com a loja),
 * sinal de quantidade (colunasAbsolutas/normalizarSinal) e colunas que só existem num lado.
 * FKs traduzidas (SRV_ID → PK local) devem chegar já traduzidas em `servidor`.
 */
function camposDivergentes(local, servidor, { idLoja = null, configTabela = null } = {}) {
  if (!local || !servidor) return [];
  const absolutas = new Set([
    ...(configTabela?.colunasAbsolutas || []),
    ...(configTabela?.normalizarSinal ? [configTabela.normalizarSinal.coluna] : []),
  ]);

  return Object.keys(servidor).filter(c => {
    if (!(c in local) || isColunaIgnorada(c) || COLUNAS_CONTROLE.has(c)) return false;
    const vl = local[c], vs = servidor[c];
    if (c === 'ID_LOJA' && _vazio(vl) && idLoja != null && String(vs) === String(idLoja)) return false;
    if (absolutas.has(c) && typeof vl === 'number' && typeof vs === 'number') return Math.abs(vl) !== Math.abs(vs);
    return !saoIguais(vl, vs);
  });
}

module.exports = { camposDivergentes };
