const { Pool } = require('pg');
const { databaseUrl } = require('./config');

const pool = new Pool({ connectionString: databaseUrl });

/**
 * Executa uma função com um client do pool. Libera o client ao final.
 */
async function withConnection(fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

function _validarSchema(schemaName) {
  if (!/^[a-z_][a-z0-9_]*$/.test(schemaName))
    throw new Error(`Nome de schema inválido: '${schemaName}'`);
}

/**
 * Executa uma função com um client cujo search_path aponta para o schema do tenant.
 * O search_path é sempre resetado para 'public' no finally — evita contaminação de sessão
 * em conexões reutilizadas do pool.
 */
async function withTenantConnection(schemaName, fn) {
  _validarSchema(schemaName);
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO ${schemaName}, public`);
    return await fn(client);
  } finally {
    await client.query('SET search_path TO public');
    client.release();
  }
}

/**
 * Executa uma query SELECT e retorna os resultados com chaves em UPPERCASE.
 */
async function query(client, sql, params = []) {
  const result = await client.query(sql, params);
  return result.rows.map(row =>
    Object.fromEntries(Object.entries(row).map(([k, v]) => [k.toUpperCase(), v]))
  );
}

/**
 * Executa um comando DML (INSERT/UPDATE/DELETE).
 */
async function execute(client, sql, params = []) {
  return client.query(sql, params);
}

function isMissingTableError(error) {
  const mensagem = String(error?.message || '');
  return Boolean(
    error && (
      error.code === '42P01' ||
      /relation .* does not exist/i.test(mensagem) ||
      /relação .* não existe/i.test(mensagem)
    )
  );
}

function isMissingColumnError(error) {
  return Boolean(error && error.code === '42703');
}

// Mantém getConnection/closeConnection como wrappers do pool para compatibilidade
// com rotas que abrem conexão manualmente (produtos, pedidos, distribuicao, movCaixas).
async function getConnection() {
  return pool.connect();
}

function closeConnection(client) {
  client.release();
  return Promise.resolve();
}

module.exports = { pool, withConnection, withTenantConnection, query, execute, getConnection, closeConnection, isMissingTableError, isMissingColumnError };
