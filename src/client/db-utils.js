const { query, execute } = require('./db');

const cacheFKRefs  = {};
const cacheCharLen = {};

async function getColumnCharLen(db, tabela, coluna) {
  const chave = `${tabela}.${coluna}`;
  if (cacheCharLen[chave] !== undefined) return cacheCharLen[chave];
  const rows = await query(db, `
    SELECT f.RDB$CHARACTER_LENGTH AS MAX_LEN
    FROM RDB$RELATION_FIELDS rf
    JOIN RDB$FIELDS f ON f.RDB$FIELD_NAME = rf.RDB$FIELD_SOURCE
    WHERE rf.RDB$RELATION_NAME = ? AND rf.RDB$FIELD_NAME = ?
  `, [tabela, coluna]);
  const len = rows[0]?.MAX_LEN ?? null;
  cacheCharLen[chave] = len;
  return len;
}

/**
 * Retorna as tabelas filhas que referenciam via FK a coluna PK informada.
 * Resultado: [{ tabela: 'MOVIMENTACOES', coluna: 'ID_PRODUTO' }, ...]
 */
async function getFKRefs(db, tabelaPai, colunaPai) {
  const chave = `${tabelaPai}.${colunaPai}`;
  if (cacheFKRefs[chave]) return cacheFKRefs[chave];

  const rows = await query(db, `
    SELECT TRIM(rc2.RDB$RELATION_NAME) AS TABELA_FILHA,
           TRIM(seg2.RDB$FIELD_NAME)   AS COLUNA_FK
    FROM RDB$RELATION_CONSTRAINTS rc1
    JOIN RDB$INDEX_SEGMENTS       seg1 ON seg1.RDB$INDEX_NAME        = rc1.RDB$INDEX_NAME
    JOIN RDB$REF_CONSTRAINTS      ref  ON ref.RDB$CONST_NAME_UQ      = rc1.RDB$CONSTRAINT_NAME
    JOIN RDB$RELATION_CONSTRAINTS rc2  ON rc2.RDB$CONSTRAINT_NAME    = ref.RDB$CONSTRAINT_NAME
    JOIN RDB$INDEX_SEGMENTS       seg2 ON seg2.RDB$INDEX_NAME        = rc2.RDB$INDEX_NAME
                                      AND seg2.RDB$FIELD_POSITION    = seg1.RDB$FIELD_POSITION
    WHERE TRIM(rc1.RDB$RELATION_NAME)   = ?
      AND TRIM(rc1.RDB$CONSTRAINT_TYPE) = 'PRIMARY KEY'
      AND TRIM(seg1.RDB$FIELD_NAME)     = ?
  `, [tabelaPai, colunaPai]);

  const refs = rows.map(r => ({ tabela: r.TABELA_FILHA.trim(), coluna: r.COLUNA_FK.trim() }));
  cacheFKRefs[chave] = refs;
  return refs;
}

/**
 * Gera um novo valor de PK que não existe na tabela.
 * - PK numérica: MAX(pk) + 1
 * - PK string:   valorAtual + '_1', '_2', ... até achar livre
 */
async function gerarNovoPK(db, tabela, pkColuna, registro) {
  const pks = Array.isArray(pkColuna) ? pkColuna : [pkColuna];
  const pkPrincipal = pks[pks.length - 1];
  const valorAtual = registro[pkPrincipal];

  const isNumerico = Number.isFinite(Number(valorAtual)) && String(valorAtual).trim() !== '';

  const constraints = pks.slice(0, -1);
  const whereBase   = constraints.map(p => `${p} = ?`).join(' AND ');
  const valoresBase = constraints.map(p => registro[p]);

  if (isNumerico) {
    let sql = `SELECT MAX(${pkPrincipal}) AS MAXIMO FROM ${tabela}`;
    if (whereBase) sql += ` WHERE ${whereBase}`;
    const rows = await query(db, sql, valoresBase);
    return (rows[0].MAXIMO || 0) + 1;
  }

  const maxLen = await getColumnCharLen(db, tabela, pkPrincipal);

  for (let i = 1; i <= 999; i++) {
    const suffix = `_${i}`;
    const base = maxLen
      ? String(valorAtual).substring(0, maxLen - suffix.length)
      : String(valorAtual).substring(0, 50 - suffix.length);
    if (base.length === 0) break;
    const candidato = `${base}${suffix}`;
    let sql = `SELECT 1 FROM ${tabela} WHERE ${pkPrincipal} = ?`;
    if (whereBase) sql += ` AND ${whereBase}`;
    const existe = await query(db, sql, [candidato, ...valoresBase]);
    if (existe.length === 0) return candidato;
  }
  throw new Error(`Não foi possível gerar novo PK para ${tabela}.${pkPrincipal}=${valorAtual}`);
}

/**
 * Renomeia o PK de um registro local com cascata de FK.
 *
 * Sem filhos FK: UPDATE simples do PK.
 * Com filhos FK: INSERT cópia com novo PK → UPDATE filhos → DELETE original.
 */
async function renomearPKLocal(db, nome, pk, registro, novoValorPK, fkRefs) {
  const pks = Array.isArray(pk) ? pk : [pk];
  const pkPrincipal = pks[pks.length - 1];
  const valorAntigo = registro[pkPrincipal];

  const whereParts  = pks.map(p => `${p} = ?`).join(' AND ');
  const whereValores = pks.map(p => registro[p]);

  if (fkRefs.length === 0) {
    await execute(db,
      `UPDATE ${nome} SET ${pkPrincipal} = ? WHERE ${whereParts}`,
      [novoValorPK, ...whereValores]
    );
    return;
  }

  const colRows = await query(db, `
    SELECT TRIM(rf.RDB$FIELD_NAME) AS COLUNA
    FROM RDB$RELATION_FIELDS rf
    LEFT JOIN RDB$FIELDS f ON f.RDB$FIELD_NAME = rf.RDB$FIELD_SOURCE
    WHERE TRIM(rf.RDB$RELATION_NAME) = ?
      AND f.RDB$COMPUTED_SOURCE IS NULL
    ORDER BY rf.RDB$FIELD_POSITION
  `, [nome]);
  const colunas = colRows.map(r => r.COLUNA.trim());

  const isNumerico = Number.isFinite(Number(novoValorPK)) && String(novoValorPK).trim() !== '';
  const pkLiteral  = isNumerico
    ? String(parseInt(novoValorPK, 10))
    : `'${String(novoValorPK).replace(/'/g, "''")}'`;

  const selectParts = colunas.map(c => (c === pkPrincipal ? pkLiteral : c)).join(', ');

  await execute(db,
    `INSERT INTO ${nome} (${colunas.join(', ')}) SELECT ${selectParts} FROM ${nome} WHERE ${pkPrincipal} = ?`,
    [valorAntigo]
  );

  for (const ref of fkRefs) {
    await execute(db,
      `UPDATE ${ref.tabela} SET ${ref.coluna} = ? WHERE ${ref.coluna} = ?`,
      [novoValorPK, valorAntigo]
    );
  }

  await execute(db, `DELETE FROM ${nome} WHERE ${whereParts}`, whereValores);
}

module.exports = { getFKRefs, gerarNovoPK, renomearPKLocal };
