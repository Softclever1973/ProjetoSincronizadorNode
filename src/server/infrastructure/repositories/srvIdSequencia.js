const { query, execute } = require('#server/infrastructure/db.js');

// Próximo SRV_ID de uma tabela pela sequência por tabela (a mesma do push), avançada além do maior SRV_ID existente.
async function proximoSrvIdDaTabela(db, schema, tabela) {
  const seqNome = `seq_srv_id_${tabela.toLowerCase()}`;
  await execute(db, `CREATE SEQUENCE IF NOT EXISTS "${schema}"."${seqNome}"`).catch(() => {});
  // Firebird pode reenviar registros com SRV_ID já atribuído sem avançar a sequência.
  const [seqInfo] = await query(db, `
    SELECT
      COALESCE((SELECT MAX(SRV_ID) FROM ${tabela}), 0) AS max_srv,
      (SELECT last_value FROM "${schema}"."${seqNome}") AS seq_last
  `).catch(() => [null]);
  if (seqInfo && Number(seqInfo.MAX_SRV ?? 0) >= Number(seqInfo.SEQ_LAST ?? 0)) {
    await execute(db, `SELECT setval('${schema}.${seqNome}', $1)`, [Number(seqInfo.MAX_SRV)]).catch(() => {});
  }
  const [seq] = await query(db, `SELECT nextval('${schema}.${seqNome}') AS v`);
  return seq?.V ?? null;
}

module.exports = { proximoSrvIdDaTabela };
