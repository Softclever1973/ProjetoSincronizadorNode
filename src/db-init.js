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
    // Função chamada pelo trigger de DELETE em cada tabela sincronizada.
    // Registra automaticamente em registros_deletados para que as filiais possam
    // buscar e aplicar a deleção no próximo ciclo de pull.
    `CREATE OR REPLACE FUNCTION ${schema}.fn_registrar_delecao()
     RETURNS TRIGGER AS $$
     DECLARE
       v_pk_cols  TEXT[];
       v_pk_valor TEXT;
       v_json     JSONB;
     BEGIN
       v_json := to_jsonb(OLD);
       SELECT ARRAY_AGG(kcu.column_name::TEXT ORDER BY kcu.ordinal_position)
       INTO v_pk_cols
       FROM information_schema.key_column_usage kcu
       JOIN information_schema.table_constraints tc
         ON tc.constraint_name  = kcu.constraint_name
        AND tc.table_schema     = kcu.table_schema
        AND tc.table_name       = kcu.table_name
       WHERE kcu.table_schema   = TG_TABLE_SCHEMA
         AND kcu.table_name     = TG_TABLE_NAME
         AND tc.constraint_type = 'PRIMARY KEY';
       IF v_pk_cols IS NULL THEN
         RETURN OLD;
       END IF;
       SELECT STRING_AGG(v_json->>t.col, '|' ORDER BY t.ord)
       INTO v_pk_valor
       FROM unnest(v_pk_cols) WITH ORDINALITY AS t(col, ord);
       IF v_pk_valor IS NULL THEN
         RETURN OLD;
       END IF;
       INSERT INTO ${schema}.registros_deletados (nome_da_tabela, id_registros, criado_em)
       VALUES (UPPER(TG_TABLE_NAME), v_pk_valor, NOW());
       RETURN OLD;
     END;
     $$ LANGUAGE plpgsql`,
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

async function migrarTriggersDelecao(schemaName) {
  const client = await pool.connect();
  try {
    await client.query(`
      ALTER TABLE IF EXISTS ${schemaName}.registros_deletados
      ADD COLUMN IF NOT EXISTS criado_em TIMESTAMP DEFAULT NOW()
    `);

    await client.query(`CREATE OR REPLACE FUNCTION ${schemaName}.fn_registrar_delecao()
     RETURNS TRIGGER AS $$
     DECLARE
       v_pk_cols  TEXT[];
       v_pk_valor TEXT;
       v_json     JSONB;
     BEGIN
       v_json := to_jsonb(OLD);
       SELECT ARRAY_AGG(kcu.column_name::TEXT ORDER BY kcu.ordinal_position)
       INTO v_pk_cols
       FROM information_schema.key_column_usage kcu
       JOIN information_schema.table_constraints tc
         ON tc.constraint_name  = kcu.constraint_name
        AND tc.table_schema     = kcu.table_schema
        AND tc.table_name       = kcu.table_name
       WHERE kcu.table_schema   = TG_TABLE_SCHEMA
         AND kcu.table_name     = TG_TABLE_NAME
         AND tc.constraint_type = 'PRIMARY KEY';
       IF v_pk_cols IS NULL THEN
         RETURN OLD;
       END IF;
       SELECT STRING_AGG(v_json->>t.col, '|' ORDER BY t.ord)
       INTO v_pk_valor
       FROM unnest(v_pk_cols) WITH ORDINALITY AS t(col, ord);
       IF v_pk_valor IS NULL THEN
         RETURN OLD;
       END IF;
       INSERT INTO ${schemaName}.registros_deletados (nome_da_tabela, id_registros, criado_em)
       VALUES (UPPER(TG_TABLE_NAME), v_pk_valor, NOW());
       RETURN OLD;
     END;
     $$ LANGUAGE plpgsql`);

    const { rows: tabelas } = await client.query(`
      SELECT pt.tablename
      FROM pg_tables pt
      LEFT JOIN pg_trigger pgt
        ON pgt.tgname  = 'tg_' || pt.tablename || '_del'
       AND pgt.tgrelid = (pt.schemaname || '.' || pt.tablename)::regclass
      WHERE pt.schemaname = $1
        AND pt.tablename NOT IN ('sync_filiais', 'filiais_bloqueadas', 'registros_deletados')
        AND pgt.tgname IS NULL
    `, [schemaName]);

    if (tabelas.length === 0) {
      console.log(`[${schemaName}] Triggers de deleção: todos já instalados`);
      return;
    }

    console.log(`[${schemaName}] Instalando triggers de deleção em ${tabelas.length} tabela(s)...`);
    let criados = 0;
    for (const { tablename } of tabelas) {
      try {
        await client.query(`
          CREATE TRIGGER tg_${tablename}_del
          AFTER DELETE ON ${schemaName}.${tablename}
          FOR EACH ROW EXECUTE FUNCTION ${schemaName}.fn_registrar_delecao()
        `);
        criados++;
      } catch (e) {
        console.error(`[${schemaName}] Erro ao criar trigger para '${tablename}': ${e.message}`);
      }
    }
    console.log(`[${schemaName}] ${criados}/${tabelas.length} trigger(s) de deleção criado(s)`);
  } finally {
    client.release();
  }
}

async function migrarTodosSchemas() {
  const client = await pool.connect();
  let tenants;
  try {
    const { rows } = await client.query(
      `SELECT schema_name FROM public.sync_tenants WHERE ativo = TRUE`
    );
    tenants = rows;
  } finally {
    client.release();
  }
  for (const { schema_name } of tenants) {
    await migrarTriggersDelecao(schema_name).catch(e =>
      console.error(`[migração deleção] ${schema_name}: ${e.message}`)
    );
  }
}

module.exports = { initializeDatabase, initializeTenantSchema, migrarTodosSchemas };
