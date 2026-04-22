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

// Mantém getConnection/closeConnection como wrappers do pool para compatibilidade
// com rotas que abrem conexão manualmente (produtos, pedidos, distribuicao, movCaixas).
async function getConnection() {
  return pool.connect();
}

function closeConnection(client) {
  client.release();
  return Promise.resolve();
}

module.exports = { withConnection, query, execute, getConnection, closeConnection };
