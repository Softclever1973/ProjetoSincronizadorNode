/**
 * Regras puras sobre a "forma" de uma tabela — inferência de tipo Postgres a partir de
 * valores reais, e a chave de negócio usada nas constraints UNIQUE de multi-filial.
 * Extraído de routes/api/helpers.js (item B13 do PLANO_REFATORACAO.md) — sem I/O, sem SQL.
 */

// Números sempre viram NUMERIC: Firebird NUMERIC(10,2) com valor 100.00 chega como
// inteiro 100 via node-firebird, e NUMERIC comporta ambos sem perda.
function inferirTipoPg(valor) {
  if (Buffer.isBuffer(valor)) return 'BYTEA';
  if (valor instanceof Date) return 'TIMESTAMP';
  if (typeof valor === 'boolean') return 'BOOLEAN';
  if (typeof valor === 'number') return 'NUMERIC';
  return 'TEXT';
}

/**
 * Colunas que compõem a chave de negócio usada na constraint UNIQUE (uq_<tabela>_bk).
 * Inclui ID_LOJA quando a tabela tem essa coluna — o ID local do Firebird (generator)
 * só é único DENTRO de uma filial; cada filial tem seu próprio generator, então duas
 * filiais podem gerar o mesmo id_local para registros diferentes. Sem ID_LOJA na chave,
 * essa constraint rejeitaria como duplicata um push legítimo vindo de outra filial.
 */
function chaveNegocioTabela(pks, colunasDisponiveis) {
  const chave = [...(Array.isArray(pks) ? pks : [pks])];
  if (colunasDisponiveis.has('ID_LOJA') && !chave.includes('ID_LOJA')) chave.push('ID_LOJA');
  return chave;
}

/**
 * Deriva a lista de colunas tipadas de um registro real (recebido via push, ou enviado por
 * um formulário web), inferindo o tipo PostgreSQL de cada valor. Usado por
 * criarTabelaSeNecessario quando a criação parte de um registro de verdade (há um registro
 * pra inferir tipo por valor, ao contrário de GarantirTabela, que usa introspecção do Firebird).
 */
function colunasTipadasDeRegistro(registro) {
  return Object.keys(registro).map(nome => ({ nome, tipoPg: inferirTipoPg(registro[nome]) }));
}

module.exports = { inferirTipoPg, chaveNegocioTabela, colunasTipadasDeRegistro };
