const { pool } = require('./db');

// Tabelas de controle: ficam sempre em public, fora de qualquer tenant schema
const DDL_CONTROLE = [
  `CREATE TABLE IF NOT EXISTS public.sync_tenants (
    token       TEXT    PRIMARY KEY,
    schema_name TEXT    NOT NULL UNIQUE,
    nome        TEXT,
    ativo       BOOLEAN NOT NULL DEFAULT TRUE
  )`,
  // Migração para instalações existentes sem a constraint UNIQUE em schema_name.
  // Um índice único satisfaz o requisito de FK do PostgreSQL.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_tenants_schema_name
   ON public.sync_tenants(schema_name)`,
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
    // Migração idempotente: adiciona criado_em para permitir limpeza de entradas antigas
    `ALTER TABLE IF EXISTS ${schema}.registros_deletados
     ADD COLUMN IF NOT EXISTS criado_em TIMESTAMP DEFAULT NOW()`,
    // Função compartilhada usada por todos os triggers de tabelas do schema.
    // Incrementa automaticamente ID_ULTIMA_ATUALIZACAO_MATRIZ em todo INSERT/UPDATE,
    // garantindo que o cliente Firebird detecte qualquer alteração direta no PostgreSQL.
    `CREATE OR REPLACE FUNCTION ${schema}.fn_seq_atualizacao()
     RETURNS TRIGGER AS $$
     BEGIN
       NEW.id_ultima_atualizacao_matriz := nextval('${schema}.seq_atualizacao_matriz');
       RETURN NEW;
     END;
     $$ LANGUAGE plpgsql`,
    `CREATE TABLE IF NOT EXISTS ${schema}.sync_filiais (
      id_loja     INTEGER   PRIMARY KEY,
      nome        TEXT,
      ultimo_sync TIMESTAMP NOT NULL DEFAULT NOW()
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
