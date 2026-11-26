/**
 * Escopo de loja no site: gerente/vendedor só enxergam e alteram registros da loja do vínculo
 * (JWT); o dono vê todas. "Tabela de loja" = a mesma definição da sincronização (tabelas.js:
 * filtroFilial / filtroFilialViaFK), mais CLIENTES, que o site já restringia.
 */
const TABELAS = require('#client/domain/tabelas.js');

// tabela -> { coluna: 'ID_LOJA' } | { pai, fk } (filha: loja vem do registro pai com a mesma FK)
const ESCOPO_POR_TABELA = new Map([
  ...TABELAS.filter(t => t.filtroFilial).map(t => [t.nome, { coluna: t.filtroFilial }]),
  ...TABELAS.filter(t => t.filtroFilialViaTabela).map(t => [t.nome, { pai: t.filtroFilialViaTabela, fk: t.filtroFilialViaFK }]),
  ['CLIENTES', { coluna: 'ID_LOJA' }],
]);

function escopoDaTabela(tabela) {
  return ESCOPO_POR_TABELA.get(String(tabela).toUpperCase()) ?? null;
}

// Loja que restringe o usuário: null = sem restrição (dono). Não-dono sem loja no vínculo → NaN (não enxerga nada).
function lojaObrigatoria(req, schema) {
  if (req.userRoles?.[schema] === 'dono') return null;
  const loja = Number(req.userLojas?.[schema]);
  return Number.isInteger(loja) ? loja : NaN;
}

// Condição SQL do escopo (sem alias): `ID_LOJA = $n` ou `FK IN (SELECT FK FROM PAI WHERE ID_LOJA = $n)`.
function sqlEscopo(escopo, idxParam, alias = '') {
  const p = alias ? `${alias}.` : '';
  return escopo.coluna
    ? `${p}${escopo.coluna} = $${idxParam}`
    : `${p}${escopo.fk} IN (SELECT ${escopo.fk} FROM ${escopo.pai} WHERE ID_LOJA = $${idxParam})`;
}

module.exports = { ESCOPO_POR_TABELA, escopoDaTabela, lojaObrigatoria, sqlEscopo };
