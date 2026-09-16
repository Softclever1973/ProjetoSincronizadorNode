/**
 * Provisiona e limpa um schema PostgreSQL dedicado a testes de integração (Fase 2),
 * no MESMO Postgres de desenvolvimento já configurado em .env — sem banco separado.
 * Isolado do schema real do usuário: nenhuma tabela de negócio (pedidos, clientes, etc.)
 * do dia a dia é tocada, só o schema `empresa_teste` criado aqui.
 */
const { pool } = require('#server/infrastructure/db.js');
const { initializeTenantSchema } = require('#server/infrastructure/db-init.js');

const TEST_SCHEMA = 'empresa_teste';
const TEST_TOKEN  = 'TOKEN_TESTE_EMPRESA_TESTE'; // token fixo do cliente Firebird de teste (rota /datasnap)

// Versão mínima das tabelas de negócio que os testes de crud.js exercitam — não é o
// schema real completo (esse só existe via sync com o Firebird), só o suficiente para
// testar as regras de handleSave que dependem de Postgres de verdade (sequence, unicidade).
const DDL_TABELAS_NEGOCIO = [
  `CREATE TABLE IF NOT EXISTS pedidos (
    id_pedido INTEGER PRIMARY KEY,
    id_cliente INTEGER,
    id_loja INTEGER,
    status TEXT,
    data_do_pedido DATE,
    hora_do_pedido TEXT,
    tipo_operacao TEXT,
    data_de_emissao DATE,
    data_de_emissao_nf DATE,
    usuario TEXT,
    usuario_nome TEXT,
    autorizado_por TEXT,
    data_realizacao DATE,
    data_foi_cadastrado TIMESTAMP,
    data_ultima_atualizacao TIMESTAMP,
    id_ultima_atualizacao_matriz INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS pedidos_parcelas_pagamentos (
    id_pedido INTEGER,
    parcela INTEGER,
    valor NUMERIC(12,2),
    status TEXT,
    PRIMARY KEY (id_pedido, parcela)
  )`,
  `CREATE TABLE IF NOT EXISTS clientes (
    srv_id INTEGER PRIMARY KEY,
    id_cliente INTEGER,
    razao_social TEXT,
    fantasia TEXT,
    pessoa_p_contato TEXT,
    consumidor_final TEXT,
    cpf TEXT,
    cnpj TEXT,
    data_foi_cadastrado TIMESTAMP,
    data_ultima_atualizacao TIMESTAMP,
    id_ultima_atualizacao_matriz INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS produtos (
    srv_id INTEGER PRIMARY KEY,
    codigo TEXT,
    nome TEXT,
    data_foi_cadastrado TIMESTAMP,
    data_ultima_atualizacao TIMESTAMP,
    id_ultima_atualizacao_matriz INTEGER
  )`,
];

async function setupTestSchema() {
  await initializeTenantSchema(TEST_SCHEMA); // schema + infraestrutura padrão (sync_config, srv_id_map, seq_atualizacao_matriz, ...)
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
    for (const ddl of DDL_TABELAS_NEGOCIO) await client.query(ddl);
  } finally {
    await client.query('SET search_path TO public');
    client.release();
  }
  // Registra o schema de teste em public.sync_tenants — necessário para as rotas
  // /datasnap/rest/TSMSincronizacao (auth por token de cliente Firebird, não JWT).
  await pool.query(`
    INSERT INTO public.sync_tenants (token, schema_name, nome, ativo)
    VALUES ($1, $2, 'Empresa de Teste (Fase 2)', TRUE)
    ON CONFLICT (token) DO UPDATE SET schema_name = EXCLUDED.schema_name, ativo = TRUE
  `, [TEST_TOKEN, TEST_SCHEMA]);
}

async function truncateTestSchema() {
  // NÃO inclui srv_id_map: crud.js (a rota testada aqui) nunca lê/escreve essa tabela —
  // ela é específica do fluxo de sync do Firebird (sincronizacao.js). Truncá-la aqui já
  // causou uma corrida real: Jest roda arquivos de teste em paralelo, e um TRUNCATE CASCADE
  // disparado por este arquivo apagava linhas de srv_id_map de que
  // sincronizacao.integracao.test.js dependia no meio do próprio teste.
  await pool.query(`
    TRUNCATE TABLE
      ${TEST_SCHEMA}.pedidos,
      ${TEST_SCHEMA}.pedidos_parcelas_pagamentos,
      ${TEST_SCHEMA}.clientes,
      ${TEST_SCHEMA}.produtos
    RESTART IDENTITY CASCADE
  `);
  // sync_config é reaproveitado entre testes (não é truncado) — alguns testes dependem
  // de valores nele (ex: codigo_interno_unico); cada teste que o usa reseta explicitamente.
}

module.exports = { TEST_SCHEMA, TEST_TOKEN, setupTestSchema, truncateTestSchema };
