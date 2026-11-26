const express = require('express');
const { getConnection, query: dbQuery, closeConnection } = require('#client/infrastructure/firebird/db.js');
const { getJSON } = require('#client/interfaces/webui/shared/getJSON.js');
const TABELAS = require('#client/domain/tabelas.js');

const TOKEN = process.env.SYNC_TOKEN;
const CACHE_TOTAIS_MS = 60_000;

// Só as tabelas com filtro por loja — o servidor usa isso pra calcular MAX_ID/total
// restrito à loja local em vez da empresa inteira (ver StatusTabelas no servidor).
const FILTROS_FILIAL = TABELAS
  .filter(t => t.filtroFilial || t.filtroFilialViaFK)
  .map(t => ({ nome: t.nome, filtroFilial: t.filtroFilial, filtroFilialViaFK: t.filtroFilialViaFK }));

async function statusServidor(contexto, contar) {
  const params = new URLSearchParams({
    token: TOKEN, idLoja: String(contexto.idLoja), filtros: JSON.stringify(FILTROS_FILIAL), contar: contar ? '1' : '0',
  });
  const r = await getJSON(`${contexto.baseURI}/datasnap/rest/TSMSincronizacao/StatusTabelas?${params}`, contar ? 120_000 : 15_000);
  if (!Array.isArray(r)) throw new Error(r?.message || 'resposta inesperada');
  return r;
}

// Uma consulta por informação (não uma por tabela): cursor e fila de envio de todas as tabelas.
async function porTabela(db, sql) {
  const rows = await dbQuery(db, sql).catch(() => []);
  return new Map(rows.map(r => [String(r.NOME_TABELA || '').trim(), Number(r.VALOR) || 0]));
}

function criarStatusRouter(contexto) {
  const router = express.Router();
  let cacheTotais = null; // { em, promessa }; em = fim do cálculo

  router.get('/status', async (req, res) => {
    const vazio = { tabelas: [], totalOk: 0, totalPendente: 0, totalErro: 0 };
    if (!contexto.baseURI || !contexto.idLoja) {
      return res.status(503).render('status', { ...vazio, error: 'Aguardando primeiro ciclo de sincronização...' });
    }

    let servidor;
    try {
      servidor = await statusServidor(contexto, false);
    } catch (e) {
      return res.status(502).render('status', { ...vazio, error: `Erro ao consultar servidor: ${e.message}` });
    }

    let db;
    try { db = await getConnection(); } catch (e) {
      return res.status(503).render('status', { ...vazio, error: `Firebird indisponível: ${e.message}` });
    }
    let cursores, pendentes;
    try {
      cursores = await porTabela(db, 'SELECT NOME_TABELA, ULTIMO_REGISTRO_ATUALIZADO AS VALOR FROM ULTIMOS_REGISTROS_MATRIZ');
      pendentes = await porTabela(db, 'SELECT NOME_TABELA, COUNT(*) AS VALOR FROM SYNC_ALTERACOES_PENDENTES GROUP BY NOME_TABELA');
    } finally {
      await closeConnection(db);
    }

    const tabelas = [];
    let totalOk = 0, totalPendente = 0, totalErro = 0;
    for (const sv of servidor) {
      const cursorLocal = cursores.get(sv.tabela) || 0;
      const sincronizado = !sv.erro && sv.maxId !== null && cursorLocal >= sv.maxId;
      if (sv.erro) totalErro++;
      else if (sincronizado) totalOk++;
      else totalPendente++;

      tabelas.push({
        nome: sv.tabela, totalServidor: sv.total, maxId: sv.maxId, cursorLocal,
        pendentesEnvio: pendentes.get(sv.tabela) || 0,
        statusCor:   sv.erro ? '#6c757d' : sincronizado ? '#27ae60' : '#e67e22',
        statusTexto: sv.erro ? 'N/D'     : sincronizado ? 'OK'      : 'Pendente',
      });
    }

    res.render('status', { tabelas, totalOk, totalPendente, totalErro, error: null });
  });

  // Totais (COUNT(*) no servidor e no Firebird) — lentos em banco grande; a página busca depois de abrir.
  async function calcularTotais() {
    const servidor = await statusServidor(contexto, true);
    const local = {};
    const db = await getConnection();
    try {
      for (const sv of servidor) {
        const r = await dbQuery(db, `SELECT COUNT(*) AS TOTAL FROM ${sv.tabela}`).catch(() => null);
        local[sv.tabela] = r ? Number(r[0].TOTAL) || 0 : null;
      }
    } finally {
      await closeConnection(db);
    }
    return {
      servidor: Object.fromEntries(servidor.map(sv => [sv.tabela, sv.total])),
      local,
      calculadoEm: new Date().toISOString(),
    };
  }

  router.get('/status/totais', async (req, res) => {
    if (!contexto.baseURI || !contexto.idLoja) return res.status(503).json({ erro: 'Aguardando primeiro ciclo' });
    // em = null enquanto calcula: nunca roda dois cálculos ao mesmo tempo.
    const vencido = cacheTotais?.em != null && (req.query.recalcular === '1' || Date.now() - cacheTotais.em > CACHE_TOTAIS_MS);
    if (!cacheTotais || vencido) {
      const entrada = { em: null, promessa: calcularTotais() };
      cacheTotais = entrada;
      entrada.promessa.then(() => { entrada.em = Date.now(); }, () => { if (cacheTotais === entrada) cacheTotais = null; });
    }
    try {
      res.json(await cacheTotais.promessa);
    } catch (e) {
      res.status(502).json({ erro: e.message });
    }
  });

  return router;
}

module.exports = { criarStatusRouter };
