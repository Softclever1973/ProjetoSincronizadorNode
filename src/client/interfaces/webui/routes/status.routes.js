const express = require('express');
const { getConnection, query: dbQuery, closeConnection } = require('#client/infrastructure/firebird/db.js');
const { getUltimaAtualizacao } = require('#client/application/syncEngine/cursor.js');
const { getJSON } = require('#client/interfaces/webui/shared/getJSON.js');

const TOKEN = process.env.SYNC_TOKEN;

function criarStatusRouter(contexto) {
  const router = express.Router();

  // ── STATUS DE SINCRONIZAÇÃO ──────────────────────────────────────────────
  router.get('/status', async (req, res) => {
    if (!contexto.baseURI || !contexto.idLoja) {
      return res.status(503).render('status', {
        tabelas: [], totalOk: 0, totalPendente: 0, totalErro: 0,
        error: 'Aguardando primeiro ciclo de sincronização...',
      });
    }

    let statusServidor = [];
    try {
      const url = `${contexto.baseURI}/datasnap/rest/TSMSincronizacao/StatusTabelas?token=${TOKEN}`;
      statusServidor = await getJSON(url);
    } catch (e) {
      return res.status(502).render('status', {
        tabelas: [], totalOk: 0, totalPendente: 0, totalErro: 0,
        error: `Erro ao consultar servidor: ${e.message}`,
      });
    }

    let db;
    try { db = await getConnection(); } catch (e) {
      return res.status(503).render('status', {
        tabelas: [], totalOk: 0, totalPendente: 0, totalErro: 0,
        error: `Firebird indisponível: ${e.message}`,
      });
    }
    const tabelas = [];
    let totalOk = 0, totalPendente = 0, totalErro = 0;

    try {
      for (const sv of statusServidor) {
        let cursorLocal = 0, totalLocal = 0, pendentesEnvio = 0;
        try {
          cursorLocal = await getUltimaAtualizacao(db, sv.tabela);
          const cntLocal = await dbQuery(db, `SELECT COUNT(*) AS TOTAL FROM ${sv.tabela}`);
          totalLocal = cntLocal[0].TOTAL || 0;
          const cntPend = await dbQuery(db,
            `SELECT COUNT(*) AS TOTAL FROM SYNC_ALTERACOES_PENDENTES WHERE NOME_TABELA = ?`, [sv.tabela]
          ).catch(() => [{ TOTAL: 0 }]);
          pendentesEnvio = cntPend[0].TOTAL || 0;
        } catch { /* tabela pode não existir localmente */ }

        const sincronizado = !sv.erro && sv.maxId !== null && cursorLocal >= sv.maxId;
        const statusCor    = sv.erro ? '#6c757d' : sincronizado ? '#27ae60' : '#e67e22';
        const statusTexto  = sv.erro ? 'N/D'     : sincronizado ? 'OK'      : 'Pendente';

        if (sv.erro) totalErro++;
        else if (sincronizado) totalOk++;
        else totalPendente++;

        tabelas.push({ nome: sv.tabela, totalServidor: sv.total, totalLocal, maxId: sv.maxId,
                       cursorLocal, pendentesEnvio, statusCor, statusTexto });
      }
    } finally {
      await closeConnection(db);
    }

    res.render('status', { tabelas, totalOk, totalPendente, totalErro, error: null });
  });

  return router;
}

module.exports = { criarStatusRouter };
