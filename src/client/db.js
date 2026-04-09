const Firebird = require('node-firebird');
const fs = require('fs');
const path = require('path');

/**
 * Lê o sirius.ini do cliente (filial) e retorna as opções de conexão Firebird.
 * Mesmo formato do sirius.ini do servidor, mas sem a 3ª linha (porta HTTP).
 */
function lerConfigFilial() {
  const caminhoIni = path.join(process.cwd(), 'sirius-client.ini');

  if (!fs.existsSync(caminhoIni)) {
    throw new Error(`sirius-client.ini não encontrado em: ${caminhoIni}`);
  }

  const linhas = fs.readFileSync(caminhoIni, 'utf8')
    .split('\n')
    .map(l => l.trim());

  const linha1 = linhas[0] || '';
  const versao = (linhas[1] || '3').trim().charAt(0);

  let caminhoBanco, caminhoServidor, porta;

  const temPortaExplicita =
    linha1.includes('/3050') ||
    linha1.includes('/3051') ||
    linha1.includes('/3060');

  if (temPortaExplicita) {
    const posDosPontos = linha1.lastIndexOf(':');
    caminhoBanco = linha1.substring(posDosPontos + 1).replace(/\//g, '\\');
    const prefixo = linha1.substring(0, posDosPontos);
    const partes = prefixo.split('/');
    caminhoServidor = partes[0];
    porta = parseInt(partes[1], 10);
  } else {
    const posDosPontos = linha1.indexOf(':');
    caminhoServidor = linha1.substring(0, posDosPontos);
    caminhoBanco = linha1.substring(posDosPontos + 1);
    porta = 3050;
  }

  return {
    host: caminhoServidor || 'localhost',
    port: porta || 3050,
    database: caminhoBanco,
    user: 'SYSDBA',
    password: versao === '2' ? 'masterkey' : 'Soft1973824650',
  };
}

const opcoes = lerConfigFilial();

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

module.exports = { getConnection, query, execute, closeConnection, getParam, opcoes };
