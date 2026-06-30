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
  // Migrações idempotentes para sistema de permissões
  `ALTER TABLE public.usuarios_empresas
     ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'dono'
     CHECK (role IN ('vendedor', 'gerente', 'dono'))`,
  `ALTER TABLE public.usuarios_empresas
     ADD COLUMN IF NOT EXISTS id_loja INTEGER`,
  `ALTER TABLE public.usuarios_empresas
     ADD COLUMN IF NOT EXISTS id_vendedor INTEGER`,
  // Migração: adiciona nome ao perfil do usuário
  `ALTER TABLE public.usuarios
     ADD COLUMN IF NOT EXISTS nome TEXT`,
  `CREATE TABLE IF NOT EXISTS public.audit_log (
    id          SERIAL       PRIMARY KEY,
    id_usuario  INTEGER      REFERENCES public.usuarios(id),
    schema_name TEXT         NOT NULL,
    tabela      TEXT         NOT NULL,
    operacao    TEXT         NOT NULL CHECK (operacao IN ('INSERT', 'UPDATE', 'DELETE')),
    pk_valor    TEXT,
    dados       JSONB,
    ip_cliente  TEXT,
    criado_em   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_log_schema ON public.audit_log(schema_name)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_log_ts     ON public.audit_log(criado_em DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_log_user   ON public.audit_log(id_usuario)`,
  // Migração incremental — adiciona dados_antes se ainda não existir
  `ALTER TABLE public.audit_log ADD COLUMN IF NOT EXISTS dados_antes JSONB`,
  // Migração: regime tributário da filial (lido do param 40026 do Firebird)
  `ALTER TABLE public.sync_tenants ADD COLUMN IF NOT EXISTS regime_tributario TEXT`,
  // Migração: flag de super-admin para acesso ao painel de gestão de empresas
  `ALTER TABLE public.usuarios ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN NOT NULL DEFAULT FALSE`,
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
    `CREATE TABLE IF NOT EXISTS ${schema}.sync_config (
  chave TEXT PRIMARY KEY,
  valor TEXT
)`,
    `INSERT INTO ${schema}.sync_config (chave, valor)
 VALUES ('filtro_filial_clientes', NULL)
 ON CONFLICT (chave) DO NOTHING`,
    `INSERT INTO ${schema}.sync_config (chave, valor)
 VALUES ('venda_saldo_negativo', 'N')
 ON CONFLICT (chave) DO NOTHING`,
    `INSERT INTO ${schema}.sync_config (chave, valor)
 VALUES ('modalidade_frete', NULL)
 ON CONFLICT (chave) DO NOTHING`,
    `CREATE SEQUENCE IF NOT EXISTS ${schema}.seq_srv_id`,
    `CREATE TABLE IF NOT EXISTS ${schema}.srv_id_map (
      id        SERIAL  PRIMARY KEY,
      filial_id INTEGER,
      tabela    TEXT    NOT NULL,
      id_local  TEXT    NOT NULL,
      srv_id    INTEGER NOT NULL DEFAULT nextval('${schema}.seq_srv_id')
    )`,
    // Migrações para instalações existentes com schema antigo (filial_id NOT NULL, chave composta)
    `ALTER TABLE IF EXISTS ${schema}.srv_id_map ALTER COLUMN filial_id DROP NOT NULL`,
    `ALTER TABLE IF EXISTS ${schema}.srv_id_map DROP CONSTRAINT IF EXISTS srv_id_map_filial_id_tabela_id_local_key`,
    // Remove constraint antiga (tabela, id_local) que bloqueava filiais com mesmo id_local.
    // DROP CONSTRAINT remove a constraint e o índice de backing automaticamente.
    `ALTER TABLE IF EXISTS ${schema}.srv_id_map DROP CONSTRAINT IF EXISTS srv_id_map_tabela_id_local_key`,
    // Índice para registros vindos de filiais (filial_id sempre preenchido)
    `CREATE UNIQUE INDEX IF NOT EXISTS srv_id_map_filial_tabela_id_local_key ON ${schema}.srv_id_map (filial_id, tabela, id_local) WHERE filial_id IS NOT NULL`,
    // Índice para registros criados pela web (filial_id NULL — financeiro, etc.)
    `CREATE UNIQUE INDEX IF NOT EXISTS srv_id_map_web_tabela_id_local_key ON ${schema}.srv_id_map (tabela, id_local) WHERE filial_id IS NULL`,
    `CREATE TABLE IF NOT EXISTS ${schema}.financeiro_contas_receber (
      id               SERIAL PRIMARY KEY,
      descricao        TEXT NOT NULL,
      nome_cliente     TEXT,
      valor            NUMERIC(12,2) NOT NULL CHECK (valor > 0),
      data_vencimento  DATE NOT NULL,
      data_recebimento DATE,
      status           TEXT NOT NULL DEFAULT 'pendente'
                       CHECK (status IN ('pendente', 'recebido', 'cancelado')),
      forma_pagamento  TEXT,
      parcela          INTEGER NOT NULL DEFAULT 1,
      total_parcelas   INTEGER NOT NULL DEFAULT 1,
      observacao       TEXT,
      id_loja          INTEGER,
      criado_em        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS ${schema}.financeiro_contas_pagar (
      id               SERIAL PRIMARY KEY,
      descricao        TEXT NOT NULL,
      fornecedor       TEXT,
      categoria        TEXT,
      valor            NUMERIC(12,2) NOT NULL CHECK (valor > 0),
      data_vencimento  DATE NOT NULL,
      data_pagamento   DATE,
      status           TEXT NOT NULL DEFAULT 'pendente'
                       CHECK (status IN ('pendente', 'pago', 'cancelado')),
      forma_pagamento  TEXT,
      parcela          INTEGER NOT NULL DEFAULT 1,
      total_parcelas   INTEGER NOT NULL DEFAULT 1,
      observacao       TEXT,
      id_loja          INTEGER,
      criado_em        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `ALTER TABLE IF EXISTS ${schema}.financeiro_contas_receber ADD COLUMN IF NOT EXISTS id_a_receber NUMERIC UNIQUE`,
    `ALTER TABLE IF EXISTS ${schema}.financeiro_contas_receber DROP CONSTRAINT IF EXISTS financeiro_contas_receber_valor_check`,
    `ALTER TABLE IF EXISTS ${schema}.financeiro_contas_receber ALTER COLUMN valor DROP NOT NULL`,
    `ALTER TABLE IF EXISTS ${schema}.financeiro_contas_receber ALTER COLUMN descricao DROP NOT NULL`,
    `ALTER TABLE IF EXISTS ${schema}.financeiro_contas_receber ALTER COLUMN data_vencimento DROP NOT NULL`,
    // Backfill: popula/atualiza financeiro_contas_receber a partir dos registros em a_receber.
    // Executado em cada startup (idempotente via ON CONFLICT DO UPDATE).
    // JOIN usa c.srv_id = ar.id_cliente porque a_receber armazena o SRV_ID após tradução de FK.
    `DO $$
     DECLARE tbl_exists BOOLEAN;
     BEGIN
       SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = '${schema}' AND table_name = 'a_receber'
       ) INTO tbl_exists;
       IF tbl_exists THEN
         INSERT INTO ${schema}.financeiro_contas_receber (
           id_a_receber, descricao, nome_cliente, valor, data_vencimento,
           status, parcela, id_loja
         )
         SELECT
           ar.id_a_receber,
           ar.descricao,
           c.razao_social,
           ar.valor,
           CASE WHEN ar.vencimento IS NULL THEN NULL
                ELSE ar.vencimento::text::date END,
           CASE WHEN LOWER(COALESCE(ar.status::text,'')) IN ('recebido','recebida','realizada','realizado') THEN 'recebido'
                WHEN LOWER(COALESCE(ar.status::text,'')) IN ('cancelado','cancelada')                   THEN 'cancelado'
                ELSE 'pendente' END,
           COALESCE(NULLIF(ar.parcela::text, '')::integer, 1),
           ar.id_loja::integer
         FROM ${schema}.a_receber ar
         LEFT JOIN ${schema}.clientes c ON c.srv_id = ar.id_cliente
         WHERE ar.id_a_receber IS NOT NULL
         ON CONFLICT (id_a_receber) DO UPDATE SET
           descricao       = EXCLUDED.descricao,
           nome_cliente    = EXCLUDED.nome_cliente,
           valor           = EXCLUDED.valor,
           data_vencimento = EXCLUDED.data_vencimento,
           status          = EXCLUDED.status,
           parcela         = EXCLUDED.parcela,
           id_loja         = EXCLUDED.id_loja;
       END IF;
     EXCEPTION WHEN OTHERS THEN
       RAISE WARNING '[backfill] ${schema}.financeiro_contas_receber: %', SQLERRM;
     END $$`,
    // Garante que a_receber tem a coluna de cursor de sync (idempotente).
    `ALTER TABLE IF EXISTS ${schema}.a_receber ADD COLUMN IF NOT EXISTS id_ultima_atualizacao_matriz INTEGER`,
    // Garante trigger de seq em a_receber + backfill de registros sem cursor.
    // Idempotente: DROP IF EXISTS antes de CREATE; bloco inteiro protegido por EXCEPTION.
    `DO $$
     DECLARE tbl_exists BOOLEAN;
     BEGIN
       SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = '${schema}' AND table_name = 'a_receber'
       ) INTO tbl_exists;
       IF tbl_exists THEN
         DROP TRIGGER IF EXISTS tg_a_receber_seq ON ${schema}.a_receber;
         CREATE TRIGGER tg_a_receber_seq
           BEFORE INSERT OR UPDATE ON ${schema}.a_receber
           FOR EACH ROW EXECUTE FUNCTION ${schema}.fn_seq_atualizacao();
         UPDATE ${schema}.a_receber
           SET id_ultima_atualizacao_matriz = nextval('${schema}.seq_atualizacao_matriz')
           WHERE id_ultima_atualizacao_matriz IS NULL;
       END IF;
     EXCEPTION WHEN OTHERS THEN
       RAISE WARNING '[migration] ${schema}.a_receber seq trigger: %', SQLERRM;
     END $$`,
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
    await initializeTenantSchema(schema_name).catch(e =>
      console.error(`[migração schema] ${schema_name}: ${e.message}`)
    );
    await migrarTriggersDelecao(schema_name).catch(e =>
      console.error(`[migração deleção] ${schema_name}: ${e.message}`)
    );
  }
}

module.exports = { initializeDatabase, initializeTenantSchema, migrarTodosSchemas };
