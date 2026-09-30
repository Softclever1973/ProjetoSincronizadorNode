const express = require('express');
const TABELAS = require('#client/domain/tabelas.js');
const { lerConfig, salvarConfig, defaultAtivo, tabelaAtiva } = require('#client/infrastructure/config/tabelasConfig.js');
const { estaPausado, cargaEstaPausada, interromperEnvioAtual } = require('#client/application/syncEngine/controle.js');
const { SQL_EH_CARGA } = require('#client/domain/filaCarga.js');
const { getConnection, query: dbQuery, execute: dbExecute, closeConnection } = require('#client/infrastructure/firebird/db.js');
const { clearConflitos } = require('#client/infrastructure/persistence/conflitos.js');
const { aplicarResetLocal } = require('#client/application/resetLocal.js');

function criarConfiguracoesRouter(contexto) {
  const router = express.Router();

  // Estado em memória do envio pós-carga-inicial (null = inativo)
  let estadoEnvio = null;
  // Estado da fase de enfileiramento da carga inicial (null = nenhuma em andamento)
  let estadoEnfileiramento = null;
  // "Parar" pedido durante o enfileiramento: termina a tabela atual e desfaz a fila da carga.
  let pararCarga = false;

  // Tira da fila o que a carga enfileirou (só a marca da carga — alteração real fica) e larga o lote em memória.
  async function removerPendentesDaCarga(db) {
    const tabelas = estadoEnvio?.tabelas || [];
    let removidos = 0;
    if (tabelas.length > 0) {
      const ph = tabelas.map(() => '?').join(', ');
      const where = `NOME_TABELA IN (${ph}) AND ${SQL_EH_CARGA}`;
      const cnt = await dbQuery(db, `SELECT COUNT(*) AS TOTAL FROM SYNC_ALTERACOES_PENDENTES WHERE ${where}`, tabelas).catch(() => [{ TOTAL: 0 }]);
      removidos = Number(cnt[0]?.TOTAL || 0);
      await dbExecute(db, `DELETE FROM SYNC_ALTERACOES_PENDENTES WHERE ${where}`, tabelas);
    }
    interromperEnvioAtual();
    const dados = { ativo: true, parado: true, removidos, total: estadoEnvio?.total || 0, enviados: 0, pendentes: 0, porcentagem: 0 };
    if (estadoEnvio) {
      dados.enviados = Math.max(0, (estadoEnvio.total || 0) - (estadoEnvio.ultimosPendentes ?? estadoEnvio.total ?? 0));
      estadoEnvio.ultimoResultado = { em: Date.now(), dados };
    }
    console.log(`[Carga] Parada pelo operador — ${removidos} pendente(s) removido(s) da fila`);
    return removidos;
  }

  router.post('/api/carga-inicial/parar', async (_req, res) => {
    if (estadoEnfileiramento) {
      pararCarga = true;
      return res.json({ ok: true, fase: 'enfileirando', message: 'Parando após a tabela atual...' });
    }
    if (!estadoEnvio || estadoEnvio.ultimoResultado) return res.status(409).json({ ok: false, message: 'Nenhum envio de carga em andamento.' });
    let db;
    try { db = await getConnection(); } catch (e) {
      return res.status(503).json({ ok: false, message: `Firebird indisponível: ${e.message}` });
    }
    try {
      const removidos = await removerPendentesDaCarga(db);
      res.json({ ok: true, fase: 'enviando', removidos });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    } finally {
      await closeConnection(db);
    }
  });

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
    if (estadoEnfileiramento) return res.status(409).json({ ok: false, message: 'Já existe uma carga inicial em andamento.' });
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // O trabalho continua mesmo se a aba for recarregada; o estado fica aqui pra tela reencontrar.
    estadoEnfileiramento = { processadas: 0, total: 0, tabela: null, totalEnfileirados: 0, porcentagem: 0 };
    pararCarga = false;
    const enviar = (evento, dados) => {
      if (evento === 'progresso') estadoEnfileiramento = { ...dados };
      if (!res.writableEnded) res.write(`event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`);
    };

    const { enfileirarTodosRegistros } = require('#client/setup.js');
    const log = (msg) => console.log(msg);
    let db;
    try { db = await getConnection(); } catch (e) {
      estadoEnfileiramento = null;
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
      const totalEnfileirados = await enfileirarTodosRegistros(db, log, ({ processadas, total, tabela, enfileiradosNaTabela, totalNaTabela, totalEnfileirados: acumulado, porcentagem }) => {
        const decorrido = (Date.now() - inicio) / 1000;
        // Estimativa pela porcentagem (que já anda por lote dentro da tabela), não por tabelas concluídas.
        const restanteSegundos = porcentagem >= 1 && decorrido > 2
          ? Math.round((decorrido / porcentagem) * (100 - porcentagem))
          : null;
        enviar('progresso', { processadas, total, tabela, enfileiradosNaTabela, totalNaTabela, totalEnfileirados: acumulado, porcentagem, restanteSegundos });
      }, tabelasFiltro, () => pararCarga);

      iniciarAcompanhamento(totalEnfileirados, tabelasFiltro);
      if (pararCarga) {
        const removidos = await removerPendentesDaCarga(db);
        enviar('parado', { removidos });
      } else {
        enviar('concluido', { totalEnfileirados, duracaoSegundos: Math.round((Date.now() - inicio) / 1000) });
      }
    } catch (e) {
      enviar('erro', { message: e.message });
    } finally {
      estadoEnfileiramento = null;
      await closeConnection(db);
      res.end();
    }
  });

  // Só as tabelas da carga contam; tabela inativa nunca é enviada, então fica de fora (e é avisada).
  function iniciarAcompanhamento(total, tabelasFiltro) {
    const tabelas = tabelasFiltro && tabelasFiltro.length > 0 ? tabelasFiltro : TABELAS.map(t => t.nome);
    const agora = Date.now();
    estadoEnvio = { total, inicio: agora, tabelas, ultimosPendentes: null, ultimaMudanca: agora, ultimoResultado: null };
  }

  const SEM_PROGRESSO_MS = 3 * 60 * 1000;

  router.get('/api/carga-inicial/progresso', async (_req, res) => {
    if (estadoEnfileiramento) return res.json({ ativo: true, fase: 'enfileirando', ...estadoEnfileiramento });
    if (!estadoEnvio) return res.json({ ativo: false });
    if (estadoEnvio.ultimoResultado) {
      const r = estadoEnvio.ultimoResultado;
      if (Date.now() - r.em > 60 * 1000) estadoEnvio = null; // mantém o "concluído" visível por 1 min após F5
      return res.json(r.dados);
    }
    const ativas   = estadoEnvio.tabelas.filter(n => tabelaAtiva(n));
    const inativas = estadoEnvio.tabelas.filter(n => !tabelaAtiva(n));
    let db;
    try { db = await getConnection(); } catch (e) {
      return res.status(503).json({ erro: `Firebird indisponível: ${e.message}` });
    }
    try {
      let porTabela = [];
      if (ativas.length > 0) {
        const ph = ativas.map(() => '?').join(', ');
        // Só os pendentes da carga: alteração do dia a dia entrando na fila não atrasa a barra.
        porTabela = await dbQuery(db,
          `SELECT NOME_TABELA, COUNT(*) AS TOTAL FROM SYNC_ALTERACOES_PENDENTES
           WHERE NOME_TABELA IN (${ph}) AND ${SQL_EH_CARGA} GROUP BY NOME_TABELA`,
          ativas);
      }
      const pendentes = porTabela.reduce((s, r) => s + Number(r.TOTAL || 0), 0);
      const { total, inicio } = estadoEnvio;
      const enviados = Math.max(0, total - pendentes);
      const porcentagem = total > 0 ? Math.min(100, Math.round((enviados / total) * 100)) : 100;
      const decorrido = Math.round((Date.now() - inicio) / 1000);

      if (estadoEnvio.ultimosPendentes === null || pendentes < estadoEnvio.ultimosPendentes) estadoEnvio.ultimaMudanca = Date.now();
      estadoEnvio.ultimosPendentes = pendentes;
      const pausado = cargaEstaPausada();
      const pausaGlobal = estaPausado();
      const semProgresso = pendentes > 0 && !pausado && !contexto.cicloEmAndamento
        && Date.now() - estadoEnvio.ultimaMudanca > SEM_PROGRESSO_MS;

      const dados = {
        ativo: true, total, enviados, pendentes, porcentagem, decorrido,
        pausado, pausaGlobal, cicloEmAndamento: !!contexto.cicloEmAndamento, semProgresso, inativas,
        restantesPorTabela: porTabela.map(r => ({ tabela: String(r.NOME_TABELA).trim(), pendentes: Number(r.TOTAL || 0) })),
      };
      if (porcentagem >= 100 || pendentes === 0) {
        dados.porcentagem = 100;
        estadoEnvio.ultimoResultado = { em: Date.now(), dados: { ...dados, concluido: true } };
      }
      res.json(dados);
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
      iniciarAcompanhamento(resultado.totalEnfileirados, [...new Set(resultado.resumo.map(r => r.tabela))]);
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
