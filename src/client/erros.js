const EventEmitter = require('events');
const { getConnection, closeConnection, query, execute } = require('./db');

const MAX_ERROS = 200;

// Emite 'novo-erro' para cada erro salvo — consumido pelo SSE em webui.js.
const emitter = new EventEmitter();

/**
 * Persiste um erro de sincronização e notifica os clientes SSE.
 * @param {object} params
 * @param {string|null} params.tabela    - Nome da tabela envolvida (ou null para erros gerais)
 * @param {string|null} params.operacao  - 'pull' | 'push' | 'ciclo' | 'config'
 * @param {string}      params.mensagem  - Mensagem de erro
 */
function salvarErro({ tabela = null, operacao = null, mensagem = '' }) {
  const erro = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    tabela,
    operacao,
    mensagem: String(mensagem).substring(0, 2000),
    criadoEm: new Date().toISOString(),
  };

  // Emite imediatamente para os clientes SSE (não depende do I/O concluir)
  emitter.emit('novo-erro', erro);

  // Persiste de forma não-bloqueante — não segura o event loop do ciclo de sync
  setImmediate(async () => {
    let db;
    try {
      db = await getConnection();

      await execute(db,
        `INSERT INTO SYNC_ERROS (ID, TABELA, OPERACAO, MENSAGEM, CRIADO_EM)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [erro.id, erro.tabela, erro.operacao, erro.mensagem]
      );

      const contagem = await query(db, `SELECT COUNT(*) AS CNT FROM SYNC_ERROS`);
      const total = contagem[0]?.CNT ?? 0;

      if (total > MAX_ERROS) {
        await execute(db,
          `DELETE FROM SYNC_ERROS WHERE ID IN (
             SELECT ID FROM SYNC_ERROS ORDER BY CRIADO_EM ASC ROWS 1
           )`
        );
      }
    } catch (_) {
      // Falha silenciosa — o erro já foi emitido via SSE; não queremos um loop de erros
    } finally {
      if (db) await closeConnection(db);
    }
  });

  return erro.id;
}

async function lerTodos() {
  let db;
  try {
    db = await getConnection();
    const rows = await query(db, `SELECT * FROM SYNC_ERROS ORDER BY CRIADO_EM ASC`);
    return rows.map(r => ({
      id: r.ID,
      tabela: r.TABELA,
      operacao: r.OPERACAO,
      mensagem: r.MENSAGEM,
      criadoEm: r.CRIADO_EM instanceof Date ? r.CRIADO_EM.toISOString() : r.CRIADO_EM,
    }));
  } finally {
    if (db) await closeConnection(db);
  }
}

async function limparErros() {
  let db;
  try {
    db = await getConnection();
    await execute(db, `DELETE FROM SYNC_ERROS`);
  } finally {
    if (db) await closeConnection(db);
  }
}

module.exports = { salvarErro, lerTodos, limparErros, emitter };
