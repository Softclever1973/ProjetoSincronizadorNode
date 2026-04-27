const { pool } = require('./db');

// Tabelas de controle: ficam sempre em public, fora de qualquer tenant schema
const DDL_CONTROLE = [
  `CREATE TABLE IF NOT EXISTS public.sync_tenants (
    token       TEXT    PRIMARY KEY,
    schema_name TEXT    NOT NULL,
    nome        TEXT,
    ativo       BOOLEAN NOT NULL DEFAULT TRUE
  )`,
  `CREATE TABLE IF NOT EXISTS public.usuarios (
    id          SERIAL  PRIMARY KEY,
    email       TEXT    UNIQUE NOT NULL,
    senha_hash  TEXT    NOT NULL,
    ativo       BOOLEAN NOT NULL DEFAULT TRUE
  )`,
  `CREATE TABLE IF NOT EXISTS public.usuarios_empresas (
    id_usuario  INTEGER NOT NULL REFERENCES public.usuarios(id),
    schema_name TEXT    NOT NULL REFERENCES public.sync_tenants(schema_name),
    PRIMARY KEY (id_usuario, schema_name)
  )`,
];

// DDL criado dentro do schema de cada empresa (sequence + tabelas de infraestrutura de sync)
function ddlTenant(schema) {
  return [
    `CREATE SCHEMA IF NOT EXISTS ${schema}`,
    `CREATE SEQUENCE IF NOT EXISTS ${schema}.seq_atualizacao_matriz`,
    `CREATE TABLE IF NOT EXISTS ${schema}.filiais_bloqueadas (
      id_filial_bloqueada INTEGER PRIMARY KEY
    )`,
    `CREATE TABLE IF NOT EXISTS ${schema}.registros_deletados (
      id_registro_deletado SERIAL        PRIMARY KEY,
      nome_da_tabela       VARCHAR(64)   NOT NULL,
      id_registros         VARCHAR(255)  NOT NULL
    )`,
  ];
}

async function initializeDatabase() {
  const client = await pool.connect();
  try {
    for (const ddl of DDL_CONTROLE) {
      await client.query(ddl);
    }
  } finally {
    client.release();
  }
  console.log('Banco: public.sync_tenants verificada/criada.');
}

async function initializeTenantSchema(schemaName) {
  const client = await pool.connect();
  try {
    for (const ddl of ddlTenant(schemaName)) {
      await client.query(ddl);
    }
  } finally {
    client.release();
  }
  console.log(`Banco: schema '${schemaName}' verificado/criado.`);
}

module.exports = { initializeDatabase, initializeTenantSchema };
