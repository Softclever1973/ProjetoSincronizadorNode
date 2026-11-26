const { attachComTimeout } = require('./firebird-attach');

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

// "Your user name and password are not defined" às vezes não é credencial errada de
// verdade — é uma corrida de handshake quando um detach() de outra conexão (ex.: a
// escrita em background de salvarErro() em erros.js) chega ao Firebird quase junto com
// este attach(). Retry curto só pra essa mensagem específica; qualquer outro erro
// (credencial de fato errada, banco fora do ar) rejeita na primeira tentativa mesmo.
function getConnection(tentativasRestantes = 2) {
  return attachComTimeout(opcoes).catch(err => {
    if (tentativasRestantes > 0 && /user name and password are not defined/i.test(err.message)) {
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          getConnection(tentativasRestantes - 1).then(resolve, reject);
        }, 500);
      });
    }
    throw err;
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

async function setParam(db, idParametro, valor) {
  await execute(
    db,
    'UPDATE OR INSERT INTO PARAMETROS (ID_PARAMETRO, PARAMETRO) VALUES (?, ?) MATCHING (ID_PARAMETRO)',
    [idParametro, valor]
  );
}

/**
 * Lê a linha inteira de PARAMETROS pelo ID — usado por syncParametrosGlobais.js pra levar
 * pro Postgres.parametros também NOME_DA_TABELA/DESCRICAO/OBSERVACOES, não só o valor
 * (getParam continua só devolvendo o valor, pros ~10 outros usos que esperam string crua).
 * As demais colunas de PARAMETROS (COMPONENTE, NOME_DO_RELATORIO, ALTURA, ...) são
 * posicionamento/estilo de tela do Delphi — fora de escopo aqui.
 */
async function getParamDetalhado(db, idParametro) {
  const rows = await query(
    db,
    'SELECT PARAMETRO, NOME_DA_TABELA, DESCRICAO, OBSERVACOES FROM PARAMETROS WHERE ID_PARAMETRO = ?',
    [idParametro]
  );
  if (rows.length === 0) return { valor: '', nomeDaTabela: null, descricao: null, observacoes: null };
  const r = rows[0];
  const T = v => (typeof v === 'string' ? v.trim() : v) || null;
  return {
    valor: T(r.PARAMETRO) || '',
    nomeDaTabela: T(r.NOME_DA_TABELA),
    descricao: T(r.DESCRICAO),
    observacoes: T(r.OBSERVACOES),
  };
}

module.exports = { getConnection, query, execute, closeConnection, getParam, setParam, getParamDetalhado, tabelaExiste, getTabelasExistentes, opcoes };
