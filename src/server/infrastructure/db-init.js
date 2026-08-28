const { pool } = require('./db');

// Seed do sistema de permissões por módulo (plano × módulo, role × módulo) — reproduz
// exatamente o comportamento anterior (requireRole/requireRoleOuVendedorEm/
// requirePlanFeature('financeiro')) linha por linha, pra não regredir acesso de ninguém.
// Ver plano em C:\Users\USUARIO021\.claude\plans\jaunty-nibbling-rabbit.md.
// Fornecedores tinha, antes desta migração, EXATAMENTE o mesmo gate de financeiro
// (sidebar.js: feature 'financeiro' + roles ['gerente','dono']) — página própria, mas
// mesma regra dupla (plano Safira+/Diamante E role gerente/dono). Segue o mesmo padrão
// de financeiro nas duas matrizes abaixo, não o padrão aberto de produtos/clientes/pedidos.
const _MOD_RW_TODOS = { produtos:'rw', clientes:'rw', pedidos:'rw', fornecedores:'--', usuarios:'rw', financeiro:'--', faturamento:'rw', auditoria:'rw', configuracoes:'rw', exportacao:'--' };
// Ordem de poder (não alfabética): Lite < Bronze < Prata < Ouro < Diamante < Safira —
// mesma ordem de planos.json, que é a fonte de verdade pra exibição (listarPlanos()).
// exportacao migrou de planos.json (`features: ['exportacao']`) pra cá — mesmos dois planos.
// É do tipo 'funcao' (domain/modulos.js): não tem leitura/escrita separadas, só liberado/
// bloqueado — por isso só usa 'rw' (liberado) ou '--' (bloqueado), nunca 'r-'.
const SEED_PERMISSOES_PLANO = {
  LITE1:     _MOD_RW_TODOS,
  BRONZE1:   _MOD_RW_TODOS,
  PRATA1:    _MOD_RW_TODOS,
  OURO1:     _MOD_RW_TODOS,
  DIAMANTE1: { ..._MOD_RW_TODOS, financeiro: 'rw', fornecedores: 'rw', exportacao: 'rw' },
  SAFIRA1:   { ..._MOD_RW_TODOS, financeiro: 'rw', fornecedores: 'rw', exportacao: 'rw' },
};
// Ordem de poder (não alfabética): vendedor < gerente < dono.
// exportacao não varia por role (hoje qualquer role exporta se o plano libera) — 'rw' nos
// três, igual ao comportamento antigo de AUTH.hasFeature (sem checagem de role nenhuma).
const SEED_PERMISSOES_ROLE = {
  vendedor: { produtos:'r-', clientes:'r-', pedidos:'rw', fornecedores:'--', usuarios:'--', financeiro:'--', faturamento:'--', auditoria:'--', configuracoes:'--', exportacao:'rw' },
  gerente:  { produtos:'rw', clientes:'rw', pedidos:'rw', fornecedores:'rw', usuarios:'rw', financeiro:'rw', faturamento:'rw', auditoria:'rw', configuracoes:'--', exportacao:'rw' },
  dono:     { produtos:'rw', clientes:'rw', pedidos:'rw', fornecedores:'rw', usuarios:'rw', financeiro:'rw', faturamento:'rw', auditoria:'rw', configuracoes:'rw', exportacao:'rw' },
};

/** Monta um INSERT multi-linha com params, a partir de um objeto { chave: { modulo: nivel } }. */
function _sqlSeedPermissoes(tabela, colChave, mapa) {
  const rows = [];
  const params = [];
  let i = 1;
  for (const [chave, modulos] of Object.entries(mapa)) {
    for (const [modulo, nivel] of Object.entries(modulos)) {
      rows.push(`($${i++}, $${i++}, $${i++})`);
      params.push(chave, modulo, nivel);
    }
  }
  return { sql: `INSERT INTO public.${tabela} (${colChave}, modulo, nivel) VALUES ${rows.join(', ')} ON CONFLICT (${colChave}, modulo) DO NOTHING`, params };
}

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
  // Migração: recuperação de senha ("esqueci minha senha") — hash do token (nunca o
  // token em texto puro) + expiração; ambos NULL fora de um fluxo de reset em andamento
  `ALTER TABLE public.usuarios
     ADD COLUMN IF NOT EXISTS reset_token_hash TEXT`,
  `ALTER TABLE public.usuarios
     ADD COLUMN IF NOT EXISTS reset_token_expira TIMESTAMPTZ`,
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
  // Migração: plano de assinatura do tenant — controla acesso a features via src/server/domain/planos.json
  `ALTER TABLE public.sync_tenants ADD COLUMN IF NOT EXISTS plano TEXT NOT NULL DEFAULT 'lite'`,
  // Migração: renomeia o plano padrão antigo ('basico') para o novo nome de tier ('lite') —
  // os planos foram renomeados para a nomenclatura Lite/Bronze/Prata/Ouro/Safira/Diamante
  // (src/server/domain/planos.json). Idempotente: depois da primeira execução não há mais linhas 'basico'.
  `UPDATE public.sync_tenants SET plano = 'lite' WHERE plano = 'basico'`,
  // ADD COLUMN IF NOT EXISTS acima não reaplica o DEFAULT em bancos onde a coluna já
  // existia com o default antigo ('basico') — força explicitamente o default correto.
  `ALTER TABLE public.sync_tenants ALTER COLUMN plano SET DEFAULT 'lite'`,
  // Migração: chaves de plano alinhadas à nomenclatura já usada no PARAMETROS do Firebird
  // (BRONZE1, PRATA1, OURO1, etc.) — evita ter dois padrões de nome pro mesmo conceito de
  // plano circulando entre Firebird e Postgres. Idempotente: só afeta linhas com a chave antiga.
  `UPDATE public.sync_tenants SET plano = 'LITE1'     WHERE plano = 'lite'`,
  `UPDATE public.sync_tenants SET plano = 'BRONZE1'   WHERE plano = 'bronze'`,
  `UPDATE public.sync_tenants SET plano = 'PRATA1'    WHERE plano = 'prata'`,
  `UPDATE public.sync_tenants SET plano = 'OURO1'     WHERE plano = 'ouro'`,
  `UPDATE public.sync_tenants SET plano = 'SAFIRA1'   WHERE plano = 'safira'`,
  `UPDATE public.sync_tenants SET plano = 'DIAMANTE1' WHERE plano = 'diamante'`,
  `ALTER TABLE public.sync_tenants ALTER COLUMN plano SET DEFAULT 'LITE1'`,
  // Timestamp do último reset — client usa pra detectar e disparar o banner de limpeza local.
  `ALTER TABLE public.sync_tenants ADD COLUMN IF NOT EXISTS resetado_em TIMESTAMP`,
  // Migração: sistema unificado de permissões por módulo (plano × módulo, role × módulo),
  // substitui requireRole/requireRoleOuVendedorEm/requirePlanFeature('financeiro') hardcoded.
  `CREATE TABLE IF NOT EXISTS public.permissoes_plano (
    plano   TEXT NOT NULL,
    modulo  TEXT NOT NULL,
    nivel   TEXT NOT NULL CHECK (nivel IN ('--', 'r-', 'rw')),
    PRIMARY KEY (plano, modulo)
  )`,
  `CREATE TABLE IF NOT EXISTS public.permissoes_role (
    role    TEXT NOT NULL CHECK (role IN ('vendedor', 'gerente', 'dono')),
    modulo  TEXT NOT NULL,
    nivel   TEXT NOT NULL CHECK (nivel IN ('--', 'r-', 'rw')),
    PRIMARY KEY (role, modulo)
  )`,
  _sqlSeedPermissoes('permissoes_plano', 'plano', SEED_PERMISSOES_PLANO),
  _sqlSeedPermissoes('permissoes_role', 'role', SEED_PERMISSOES_ROLE),
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
    `INSERT INTO ${schema}.sync_config (chave, valor)
 VALUES ('forma_preenchimento_pedido', 'Pela rotina específica')
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
      typeof ddl === 'string' ? await client.query(ddl) : await client.query(ddl.sql, ddl.params);
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
