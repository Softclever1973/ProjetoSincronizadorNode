const { withConnection } = require('./db');

const DDL = [
  `CREATE SEQUENCE IF NOT EXISTS seq_atualizacao_matriz`,

  `CREATE TABLE IF NOT EXISTS filiais_bloqueadas (
    id_filial_bloqueada INTEGER PRIMARY KEY
  )`,

  `CREATE TABLE IF NOT EXISTS registros_deletados (
    id_registro_deletado SERIAL        PRIMARY KEY,
    nome_da_tabela       VARCHAR(64)   NOT NULL,
    id_registros         VARCHAR(255)  NOT NULL
  )`,
];

async function initializeDatabase() {
  await withConnection(async (client) => {
    for (const ddl of DDL) {
      await client.query(ddl);
    }
  });
  console.log('Banco: infraestrutura de sync verificada/criada.');
}

module.exports = { initializeDatabase };
