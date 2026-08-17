const { execute: dbExecute } = require('../../infrastructure/firebird/db');
const { getColunasComputadas, getColunasFirebird } = require('../../infrastructure/firebird/db-utils');
const { COLUNAS_IGNORADAS_AUDITORIA } = require('../../domain/auditoria');

// Aplica um registro (versão do servidor, mesclado, ou servidor com PK renomeado) no
// Firebird local via UPDATE OR INSERT — usado pelos 3 dos 4 fluxos de resolução de
// conflito ('servidor', 'mesclar', 'manter_ambos') que precisam gravar localmente antes
// de (re)enviar ao servidor. 'local' não usa isso — só reenvia o que já está no Firebird.
async function aplicarRegistroLocal(db, tabela, pk, registro) {
  const computadas      = await getColunasComputadas(db, tabela);
  const colunasFirebird = await getColunasFirebird(db, tabela);
  const colunas = Object.keys(registro).filter(k =>
    registro[k] !== undefined && !COLUNAS_IGNORADAS_AUDITORIA.has(k) && !computadas.has(k) && colunasFirebird.has(k)
  );
  const placeholders = colunas.map(() => '?').join(', ');
  const valores = colunas.map(c => (registro[c] === undefined ? null : registro[c]));
  const pks = Array.isArray(pk) ? pk : [pk];
  await dbExecute(db,
    `UPDATE OR INSERT INTO ${tabela} (${colunas.join(', ')}) VALUES (${placeholders}) MATCHING (${pks.join(', ')})`,
    valores
  );
}

module.exports = { aplicarRegistroLocal };
