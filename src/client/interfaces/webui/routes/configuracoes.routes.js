const express = require('express');
const TABELAS = require('#client/domain/tabelas.js');
const { lerConfig, salvarConfig, defaultAtivo } = require('#client/infrastructure/config/tabelasConfig.js');
const { getConnection, query: dbQuery, execute: dbExecute, closeConnection } = require('#client/infrastructure/firebird/db.js');
const { clearConflitos } = require('#client/infrastructure/persistence/conflitos.js');
const { aplicarResetLocal } = require('#client/application/resetLocal.js');

function criarConfiguracoesRouter(contexto) {
  const router = express.Router();

  // Estado em memória do envio pós-carga-inicial (null = inativo)
  let estadoEnvio = null;

  async function getTabelasExistentesFirebird() {
    let db;
    try {
      db = await getConnection();
      const rows = await dbQuery(db, `
        SELECT TRIM(r.RDB$RELATION_NAME) AS NOME
        FROM RDB$RELATIONS r
        WHERE r.RDB$SYSTEM_FLAG = 0
          AND r.RDB$VIEW_SOURCE IS NULL
      `);
      return new Set(rows.map(r => r.NOME.trim()));
    } catch {
      return new Set();
    } finally {
      if (db) closeConnection(db);
    }
  }

  // ── CONFIGURAÇÕES DE TABELAS ─────────────────────────────────────────────
  router.get('/configuracoes', async (_req, res) => {
    const salvo = lerConfig();
    const existentes = await getTabelasExistentesFirebird();
    // Mescla: valor salvo no JSON tem prioridade; senão usa defaultAtivo de tabelas.js
    const config = {};
    for (const t of TABELAS) {
      config[t.nome] = Object.prototype.hasOwnProperty.call(salvo, t.nome)
        ? salvo[t.nome]
        : (defaultAtivo.get(t.nome) ?? false);
    }
    const grupos = {};
    for (const t of TABELAS) {
      const g = t.grupo || 'Outras';
      if (!grupos[g]) grupos[g] = [];
      grupos[g].push(t);
    }
    res.render('configuracoes', {
      grupos, config,
      existentes: [...existentes],
      totalAtivas: TABELAS.filter(t => config[t.nome] === true && existentes.has(t.nome)).length,
      totalTabelas: TABELAS.length,
    });
  });

  router.post('/configuracoes/toggle', async (req, res) => {
    const { tabela, ativo } = req.body || {};
    if (!tabela || typeof ativo !== 'boolean') {
      return res.status(400).json({ ok: false, message: 'tabela e ativo (boolean) obrigatórios' });
    }
    if (!TABELAS.find(t => t.nome === tabela)) {
      return res.status(400).json({ ok: false, message: 'Tabela não encontrada na lista de sincronização' });
    }
    if (ativo) {
      const existentes = await getTabelasExistentesFirebird();
      if (!existentes.has(tabela)) {
        return res.status(400).json({ ok: false, message: 'Tabela não existe no banco Firebird local' });
      }
    }
    const config = lerConfig();
    if (ativo) {
      config[tabela] = true;
    } else {
      config[tabela] = false;
    }
    salvarConfig(config);
    res.json({ ok: true, tabela, ativo });
  });

  router.post('/configuracoes/carga-inicial', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const enviar = (evento, dados) =>
      res.write(`event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`);

    const { enfileirarTodosRegistros } = require('#client/setup.js');
    const log = (msg) => console.log(msg);
    let db;
    try { db = await getConnection(); } catch (e) {
      enviar('erro', { message: `Firebird indisponível: ${e.message}` });
      res.end();
      return;
    }
    const inicio = Date.now();

    try {
      const tabelasFiltro = Array.isArray(req.body?.tabelas) && req.body.tabelas.length > 0 ? req.body.tabelas : null;

      if (tabelasFiltro) {
        const placeholders = tabelasFiltro.map(() => '?').join(', ');
        await dbExecute(db, `DELETE FROM SYNC_ALTERACOES_PENDENTES WHERE NOME_TABELA IN (${placeholders})`, tabelasFiltro).catch(() => {});
        await dbExecute(db, `DELETE FROM SYNC_VERSOES_SERVIDOR     WHERE NOME_TABELA IN (${placeholders})`, tabelasFiltro).catch(() => {});
        await dbExecute(db,
          `UPDATE ULTIMOS_REGISTROS_MATRIZ SET ULTIMO_REGISTRO_ATUALIZADO = 0, ULTIMO_REGISTRO_DELETADO = 0 WHERE NOME_TABELA IN (${placeholders})`,
          tabelasFiltro
        ).catch(() => {});
      } else {
        await dbExecute(db, `DELETE FROM SYNC_ALTERACOES_PENDENTES`).catch(() => {});
        await dbExecute(db, `DELETE FROM SYNC_VERSOES_SERVIDOR`).catch(() => {});
        await dbExecute(db,
          `UPDATE ULTIMOS_REGISTROS_MATRIZ SET ULTIMO_REGISTRO_ATUALIZADO = 0, ULTIMO_REGISTRO_DELETADO = 0`
        ).catch(() => {});
        await dbExecute(db, `DELETE FROM SYNC_ERROS`).catch(() => {});
        try { clearConflitos(); } catch {}
      }
      const totalEnfileirados = await enfileirarTodosRegistros(db, log, ({ processadas, total, tabela, enfileiradosNaTabela, totalEnfileirados: acumulado, porcentagem }) => {
        const decorrido = (Date.now() - inicio) / 1000;
        const restanteSegundos = processadas >= 3 && decorrido > 0
          ? Math.round((decorrido / processadas) * (total - processadas))
          : null;
        enviar('progresso', { processadas, total, tabela, enfileiradosNaTabela, totalEnfileirados: acumulado, porcentagem, restanteSegundos });
      }, tabelasFiltro);

      estadoEnvio = { total: totalEnfileirados, inicio: Date.now() };
      enviar('concluido', { totalEnfileirados, duracaoSegundos: Math.round((Date.now() - inicio) / 1000) });
    } catch (e) {
      enviar('erro', { message: e.message });
    } finally {
      await closeConnection(db);
      res.end();
    }
  });

  router.get('/api/carga-inicial/progresso', async (_req, res) => {
    if (!estadoEnvio) return res.json({ ativo: false });
    let db;
    try { db = await getConnection(); } catch (e) {
      return res.status(503).json({ erro: `Firebird indisponível: ${e.message}` });
    }
    try {
      const rows = await dbQuery(db, `SELECT COUNT(*) AS TOTAL FROM SYNC_ALTERACOES_PENDENTES`);
      const pendentes = Number(rows[0]?.TOTAL || 0);
      const { total, inicio } = estadoEnvio;
      const enviados = Math.max(0, total - pendentes);
      const porcentagem = total > 0 ? Math.round((enviados / total) * 100) : 100;
      const decorrido = Math.round((Date.now() - inicio) / 1000);
      if (porcentagem >= 100) estadoEnvio = null;
      res.json({ ativo: true, total, enviados, pendentes, porcentagem, decorrido });
    } catch (e) {
      res.json({ ativo: false, erro: e.message });
    } finally {
      await closeConnection(db);
    }
  });

  router.post('/api/carga-parcial', async (req, res) => {
    const limite = parseInt(req.body?.limite, 10);
    if (!limite || limite <= 0) {
      return res.status(400).json({ ok: false, message: 'Informe limite (inteiro positivo). Ex: {"limite":5000}' });
    }
    const tabelasFiltro = Array.isArray(req.body?.tabelas) && req.body.tabelas.length > 0
      ? req.body.tabelas
      : null;

    const { enfileirarRegistrosParcial } = require('#client/setup.js');
    let db;
    try { db = await getConnection(); } catch (e) {
      return res.status(503).json({ ok: false, message: `Firebird indisponível: ${e.message}` });
    }
    try {
      const resultado = await enfileirarRegistrosParcial(db, limite, console.log, tabelasFiltro);
      estadoEnvio = { total: resultado.totalEnfileirados, inicio: Date.now() };
      res.json({ ok: true, limite, tabelas: tabelasFiltro ?? 'todas', ...resultado });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    } finally {
      await closeConnection(db);
    }
  });

  // Limpeza local após reset no servidor — ver src/client/resetLocal.js e o banner 'novo-reset-pendente'.
  router.post('/reset-local/aplicar', async (req, res) => {
    let db;
    try { db = await getConnection(); } catch (e) {
      return res.status(503).json({ ok: false, message: `Firebird indisponível: ${e.message}` });
    }
    try {
      const resultado = await aplicarResetLocal(db, contexto.baseURI, console.log);
      contexto.resetPendente = null;
      res.json({ ok: true, ...resultado });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    } finally {
      await closeConnection(db);
    }
  });

  router.post('/configuracoes/toggle-todos', async (req, res) => {
    const { ativo } = req.body || {};
    if (typeof ativo !== 'boolean') {
      return res.status(400).json({ ok: false, message: 'ativo (boolean) obrigatório' });
    }
    const config = {};
    if (ativo) {
      const existentes = await getTabelasExistentesFirebird();
      for (const t of TABELAS) {
        config[t.nome] = existentes.has(t.nome) ? true : false;
      }
    } else {
      for (const t of TABELAS) config[t.nome] = false;
    }
    salvarConfig(config);
    res.json({ ok: true, ativo });
  });

  return router;
}

module.exports = { criarConfiguracoesRouter };
