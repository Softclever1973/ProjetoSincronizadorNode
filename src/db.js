const Firebird = require('node-firebird');
const config = require('./config');

/**
 * Abre uma conexão com o Firebird e retorna uma Promise.
 * Equivalente ao TServicosBanco.CriarConnection() do Delphi.
 */
function getConnection() {
  return new Promise((resolve, reject) => {
    Firebird.attach(config.banco, (err, db) => {
      if (err) return reject(err);
      resolve(db);
    });
  });
}

/**
 * Executa uma query SELECT e retorna os resultados como array de objetos.
 * @param {object} db  - conexão aberta
 * @param {string} sql - SQL a executar
 * @param {Array}  params - parâmetros (opcional)
 */
function query(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

/**
 * Executa um comando DML (INSERT/UPDATE/DELETE) e commita.
 * @param {object} db  - conexão aberta
 * @param {string} sql - SQL a executar
 * @param {Array}  params - parâmetros (opcional)
 */
function execute(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
  });
}

/**
 * Fecha a conexão com o banco.
 */
function closeConnection(db) {
  return new Promise((resolve) => {
    db.detach((err) => resolve());
  });
}

/**
 * Helper: abre conexão, executa a função e fecha a conexão ao final.
 * Uso:
 *   const rows = await withConnection(async (db) => query(db, 'SELECT ...'));
 */
async function withConnection(fn) {
  const db = await getConnection();
  try {
    return await fn(db);
  } finally {
    await closeConnection(db);
  }
}

module.exports = { getConnection, query, execute, closeConnection, withConnection };
