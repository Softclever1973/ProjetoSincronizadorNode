const Firebird = require('node-firebird');

if (!process.env.FIREBIRD_DATABASE) {
  throw new Error('FIREBIRD_DATABASE não definido no .env (ex: C:\\FDBS\\FILIAL.FDB)');
}

if (!process.env.FIREBIRD_PASSWORD) {
  throw new Error('FIREBIRD_PASSWORD não definido no .env (ex: FIREBIRD_PASSWORD=masterkey)');
}

const versao = (process.env.FIREBIRD_VERSION || '3').trim().charAt(0);

const opcoes = {
  host: process.env.FIREBIRD_HOST || 'localhost',
  port: parseInt(process.env.FIREBIRD_PORT || '3050', 10),
  database: process.env.FIREBIRD_DATABASE,
  user: process.env.FIREBIRD_USER || 'SYSDBA',
  password: process.env.FIREBIRD_PASSWORD,
};

function getConnection() {
  return new Promise((resolve, reject) => {
    Firebird.attach(opcoes, (err, db) => {
      if (err) return reject(err);
      resolve(db);
    });
  });
}

function query(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

function execute(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
  });
}

function closeConnection(db) {
  return new Promise((resolve) => {
    db.detach(() => resolve());
  });
}

async function tabelaExiste(db, nome) {
  const rows = await query(
    db,
    'SELECT FIRST 1 1 FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?',
    [nome]
  );
  return rows.length > 0;
}

async function getTabelasExistentes(db) {
  const rows = await query(
    db,
    `SELECT TRIM(RDB$RELATION_NAME) AS TABLE_NAME
     FROM RDB$RELATIONS
     WHERE TRIM(RDB$RELATION_NAME) NOT LIKE 'RDB$%'
       AND TRIM(RDB$RELATION_NAME) NOT LIKE 'MON$%'`
  );
  return new Set(rows.map(r => (r.TABLE_NAME || '').trim().toUpperCase()));
}

/**
 * Lê o parâmetro da tabela PARAMETROS pelo ID.
 * Equivalente ao TServicosBanco.getParam() do Delphi.
 */
async function getParam(db, idParametro) {
  const rows = await query(
    db,
    'SELECT PARAMETRO FROM PARAMETROS WHERE ID_PARAMETRO = ?',
    [idParametro]
  );
  return rows.length > 0 ? (rows[0].PARAMETRO || '').trim() : '';
}

module.exports = { getConnection, query, execute, closeConnection, getParam, tabelaExiste, getTabelasExistentes, opcoes };
