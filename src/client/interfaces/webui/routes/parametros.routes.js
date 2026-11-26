const express = require('express');
const { getConnection, query: dbQuery, execute: dbExecute, closeConnection } = require('#client/infrastructure/firebird/db.js');
const { normalizarBlobs } = require('#client/infrastructure/firebird/db-utils.js');
const { paramsSyncMap } = require('#client/infrastructure/config/paramsSyncMap.js');
const { syncParametrosGlobais } = require('#client/application/syncParametrosGlobais.js');

function logComHora(msg) {
  const hora = new Date().toLocaleTimeString('pt-BR');
  console.log(`[${hora}] ${msg}`);
}

function criarParametrosRouter(contexto) {
  const router = express.Router();

  // ── PARÂMETROS ───────────────────────────────────────────────────────────
  router.get('/parametros', async (_req, res) => {
    let db;
    try { db = await getConnection(); } catch (e) {
      return res.render('parametros', { rows: [], error: `Firebird indisponível: ${e.message}`, sincronizados: {} });
    }
    try {
      // OBSERVACOES é BLOB SUB_TYPE 1; db.query() comita a tx antes de retornar,
      // então funções BLOB ficam inválidas (Invalid BLOB ID). Usar CAST no SQL
      // converte o BLOB para VARCHAR dentro da tx, sem precisar da API de BLOB.
      const rows = await dbQuery(db,
        `SELECT ID_PARAMETRO, NOME_DA_TABELA, DESCRICAO, PARAMETRO,
                CAST(OBSERVACOES AS VARCHAR(4000)) AS OBSERVACOES
         FROM PARAMETROS ORDER BY ID_PARAMETRO`
      );
      const normalizado = rows.map(r => normalizarBlobs(r));
      // fbId → status de sincronização com o servidor (populado pelo ciclo em index.js)
      const sincronizados = {};
      for (const { fbId, chave } of paramsSyncMap) {
        sincronizados[fbId] = { chave, ...(contexto.parametrosSincronizados?.[chave] || {}) };
      }
      res.render('parametros', { rows: normalizado, error: null, sincronizados });
    } catch (e) {
      res.render('parametros', { rows: [], error: `Erro ao ler parâmetros: ${e.message}`, sincronizados: {} });
    } finally {
      await closeConnection(db);
    }
  });

  // Dispara syncParametrosGlobais sob demanda (mesma função do ciclo automático de 30s em
  // index.js) — útil pra não esperar o próximo ciclo depois de mudar um parâmetro no
  // Firebird e querer ver o efeito no Postgres na hora. aplicarPull:false de propósito: esse
  // botão é client→server only — nunca deve gravar no Firebird local o que vier do servidor
  // (isso continua sendo só o ciclo automático). Ver comentário em syncParametrosGlobais.js.
  router.post('/parametros/sincronizar', async (_req, res) => {
    if (!contexto.baseURI) {
      return res.status(503).json({ ok: false, message: 'Ainda não conectado ao servidor — aguarde o primeiro ciclo de sincronização.' });
    }
    let db;
    try { db = await getConnection(); } catch (e) {
      return res.status(503).json({ ok: false, message: `Firebird indisponível: ${e.message}` });
    }
    try {
      await syncParametrosGlobais(db, contexto.baseURI, contexto, logComHora, { aplicarPull: false });
      const sincronizados = {};
      for (const { fbId, chave } of paramsSyncMap) {
        sincronizados[fbId] = { chave, ...(contexto.parametrosSincronizados?.[chave] || {}) };
      }
      res.json({ ok: true, sincronizados });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    } finally {
      await closeConnection(db);
    }
  });

  router.post('/parametros/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, message: 'ID inválido' });
    const { PARAMETRO, OBSERVACOES } = req.body || {};
    let db;
    try { db = await getConnection(); } catch (e) {
      return res.status(503).json({ ok: false, message: `Firebird indisponível: ${e.message}` });
    }
    try {
      await dbExecute(db,
        `UPDATE PARAMETROS SET PARAMETRO = ?, OBSERVACOES = ? WHERE ID_PARAMETRO = ?`,
        [PARAMETRO ?? null, OBSERVACOES ?? null, id]
      );
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    } finally {
      await closeConnection(db);
    }
  });

  return router;
}

module.exports = { criarParametrosRouter };
