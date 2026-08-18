const express = require('express');
const TABELAS = require('../../../domain/tabelas');
const { isColunaIgnorada, saoIguais } = require('../../../domain/auditoria');
const { getConnection, query: dbQuery, execute: dbExecute, closeConnection } = require('../../../infrastructure/firebird/db');
const { getColunasComputadas, normalizarBlobs } = require('../../../infrastructure/firebird/db-utils');
const { salvarLoteConflitos } = require('../../../infrastructure/persistence/conflitos');
const { getJSON } = require('../shared/getJSON');
const { formatDisplay } = require('../viewHelpers');

const TOKEN = process.env.SYNC_TOKEN;

function criarAuditoriaRouter(contexto) {
  const router = express.Router();

  // ── AUDITORIA ────────────────────────────────────────────────────────────
  router.get('/auditoria', async (req, res) => {
    const tabelaParam = (req.query.tabela || '').toUpperCase().trim();
    const offset      = parseInt(req.query.offset, 10) || 0;
    const limite      = 200;
    const tabelaNomes = TABELAS.map(t => t.nome);
    const base        = { tabelaParam, tabelaNomes, offset, limite, rows: null, error: null,
                          todasColunas: [], pkLabel: '', totalOk: 0, totalDif: 0, totalAusente: 0,
                          temDivergencias: false, proxOffset: 0, temProxima: false, formatDisplay };

    if (!tabelaParam) return res.render('auditoria', base);

    if (!contexto.baseURI || !contexto.idLoja) {
      return res.render('auditoria', { ...base, error: 'Aguardando primeiro ciclo...' });
    }

    const config = TABELAS.find(t => t.nome === tabelaParam);
    if (!config) {
      return res.render('auditoria', { ...base, error: 'Tabela não encontrada na configuração.' });
    }

    const pk  = config.pk;
    const pks = Array.isArray(pk) ? pk : [pk];

    let registrosServidor = [];
    try {
      const pkQuery = pks.map(p => `pk=${p}`).join('&');
      const url = `${contexto.baseURI}/datasnap/rest/TSMSincronizacao/RegistrosPaginados` +
        `?token=${TOKEN}&nomeTabela=${tabelaParam}&${pkQuery}&offset=${offset}&limit=${limite}`;
      registrosServidor = await getJSON(url);
    } catch (e) {
      return res.render('auditoria', { ...base, error: `Erro ao consultar servidor: ${e.message}` });
    }

    if (registrosServidor.length === 0) {
      return res.render('auditoria', { ...base, error: 'Nenhum registro encontrado no servidor para esta página.' });
    }

    const getPKValor  = (r) => pks.map(p => String(r[p] || '')).join('|');
    const mapServidor = new Map(registrosServidor.map(r => [getPKValor(r), r]));

    let db;
    try { db = await getConnection(); } catch (e) {
      return res.render('auditoria', { ...base, error: `Firebird indisponível: ${e.message}` });
    }
    const mapLocal = new Map();
    try {
      /* PERF-02: Antes era 1 query Firebird por registro (N+1 sequencial).
         Com 200 registros em conexão instável de loja: 30s+ de espera.
         Agora: PK simples → 1 query IN (?,...); PK composta → Promise.all paralelo. */
      if (pks.length === 1) {
        // PK simples: uma única query com IN (v1, v2, ...)
        const allPkVals    = registrosServidor.map(r => r[pks[0]]);
        const placeholders = allPkVals.map(() => '?').join(', ');
        const allLocal     = await dbQuery(db,
          `SELECT * FROM ${tabelaParam} WHERE ${pks[0]} IN (${placeholders})`,
          allPkVals
        ).catch(() => []);
        allLocal.forEach(row => mapLocal.set(String(row[pks[0]]), normalizarBlobs(row)));
      } else {
        // PK composta: queries paralelas (Promise.all) em vez de sequenciais (await em loop)
        const whereParts = pks.map(p => `${p} = ?`).join(' AND ');
        const resultados = await Promise.all(
          registrosServidor.map(r => {
            const vals = pks.map(p => r[p]);
            return dbQuery(db, `SELECT * FROM ${tabelaParam} WHERE ${whereParts}`, vals).catch(() => []);
          })
        );
        resultados.forEach((rows, i) => {
          if (rows.length > 0) mapLocal.set(getPKValor(registrosServidor[i]), normalizarBlobs(rows[0]));
        });
      }
    } finally {
      await closeConnection(db);
    }

    const todasColunas = [...new Set(registrosServidor.flatMap(r => Object.keys(r)))].filter(c => !isColunaIgnorada(c));
    let totalOk = 0, totalDif = 0, totalAusente = 0;
    const rows = [];

    for (const pkValor of mapServidor.keys()) {
      const srv = mapServidor.get(pkValor);
      const loc = mapLocal.get(pkValor);
      if (!loc) { totalAusente++; rows.push({ pkValor, srv, loc: null, difColunas: [] }); continue; }
      const difColunas = todasColunas.filter(c => !saoIguais(srv[c], loc[c]));
      if (difColunas.length === 0) totalOk++; else totalDif++;
      rows.push({ pkValor, srv, loc, difColunas });
    }

    res.render('auditoria', {
      tabelaParam, tabelaNomes, offset, limite,
      rows, todasColunas,
      pkLabel: pks.join(', '),
      totalOk, totalDif, totalAusente,
      temDivergencias: totalDif > 0 || totalAusente > 0,
      proxOffset: offset + registrosServidor.length,
      temProxima: registrosServidor.length === limite,
      formatDisplay,
      error: null,
    });
  });

  // ── CORRIGIR AUDITORIA ───────────────────────────────────────────────────
  router.post('/auditoria/corrigir', async (req, res) => {
    const { tabela, offset = 0, escolha = 'matriz' } = req.body || {};
    if (!tabela) return res.status(400).json({ ok: false, message: 'tabela obrigatória' });

    if (!contexto.baseURI || !contexto.idLoja) {
      return res.status(503).json({ ok: false, message: 'Aguardando primeiro ciclo' });
    }

    const config = TABELAS.find(t => t.nome === tabela.toUpperCase());
    if (!config) return res.status(400).json({ ok: false, message: 'Tabela não configurada' });
    const { nome, pk } = config;
    const limite = 200;

    // Busca página do servidor para saber o que comparar
    let registrosServidor;
    try {
      const url = `${contexto.baseURI}/datasnap/rest/TSMSincronizacao/RegistrosPaginados` +
        `?token=${TOKEN}&nomeTabela=${nome}&pk=${pk}&offset=${offset}&limit=${limite}`;
      registrosServidor = await getJSON(url);
    } catch (e) {
      return res.status(502).json({ ok: false, message: `Erro ao consultar servidor: ${e.message}` });
    }

    let processados = 0;
    const conflitosLote = [];
    const pks = Array.isArray(pk) ? pk : [pk];
    const whereParts = pks.map(p => `${p} = ?`).join(' AND ');

    let db;
    try { db = await getConnection(); } catch (e) {
      return res.status(503).json({ ok: false, message: `Firebird indisponível: ${e.message}` });
    }
    try {
      for (const srv of registrosServidor) {
        try {
          const pkValores = pks.map(p => srv[p]);
          const pkValorConcatenado = pks.map(p => String(srv[p] || '')).join('|');

          const localRowsRaw = await dbQuery(db, `SELECT * FROM ${nome} WHERE ${whereParts}`, pkValores).catch(() => []);
          const localRows = localRowsRaw.map(normalizarBlobs);
          const existeLocal = localRows.length > 0;

          // Se idêntico, pula
          if (existeLocal) {
            const difs = Object.keys(srv).filter(c => !isColunaIgnorada(c) && !saoIguais(srv[c], localRows[0][c]));
            if (difs.length === 0) continue;
          }

          if (escolha === 'manual') {
            conflitosLote.push({
              tabela: nome,
              pk,
              pkValor: pkValorConcatenado,
              versaoLocal: localRows[0] || null,
              versaoServidor: srv,
            });
            processados++;
            continue;
          }

          // --- Lógica de Resolução 'Matriz' (Soberania da Matriz) ---
          const jaRecebido = await dbQuery(db,
            `SELECT 1 FROM SYNC_VERSOES_SERVIDOR WHERE NOME_TABELA = ? AND PK_VALOR = ?`,
            [nome, pkValorConcatenado]
          ).catch(() => []);

          if (existeLocal && jaRecebido.length === 0) {
            const pkPrincipal = pks[pks.length - 1];
            const valorPrincipal = srv[pkPrincipal];
            let novoPK;

            if (Number.isFinite(Number(valorPrincipal)) && String(valorPrincipal).trim() !== '') {
              const constraints = pks.slice(0, -1);
              const whereBase = constraints.length > 0 ? constraints.map(p => `${p} = ?`).join(' AND ') : '';
              const valoresBase = constraints.map(p => srv[p]);

              let sqlMax = `SELECT MAX(${pkPrincipal}) AS M FROM ${nome}`;
              if (whereBase) sqlMax += ` WHERE ${whereBase}`;

              const maxRow = await dbQuery(db, sqlMax, valoresBase.length > 0 ? valoresBase : []);
              novoPK = (maxRow[0]?.M || 0) + 1;
            } else {
              for (let i = 1; i <= 99; i++) {
                const cand = `${String(valorPrincipal)}_${i}`.substring(0, 50);
                const existe = await dbQuery(db, `SELECT 1 FROM ${nome} WHERE ${pkPrincipal} = ?`, [cand]);
                if (existe.length === 0) { novoPK = cand; break; }
              }
            }

            if (novoPK) {
              try {
                await dbExecute(db, `UPDATE ${nome} SET ${pkPrincipal} = ? WHERE ${whereParts}`, [novoPK, ...pkValores]);
              } catch (fkErr) {
                // Se falhar por FK, não podemos renomear. Criamos um conflito para resolução manual.
                console.warn(`[AUDITORIA] Falha ao renomear PK em ${nome} (FK violation). Enviando para conflitos.`);
                conflitosLote.push({
                  tabela: nome,
                  pk,
                  pkValor: pkValorConcatenado,
                  versaoLocal: localRows[0],
                  versaoServidor: srv,
                  erro: 'Falha ao renomear (FK violation). Resolva manualmente.'
                });
                continue;
              }
            }
          }

          // Aplica versão da Matriz
          const computadas = await getColunasComputadas(db, nome);
          const colunas = Object.keys(srv).filter(k => srv[k] !== undefined && !isColunaIgnorada(k) && !computadas.has(k));

          if (colunas.length > 0) {
            const placeholders = colunas.map(() => '?').join(', ');
            const valores = colunas.map(c => srv[c] === undefined ? null : srv[c]);

            await dbExecute(db,
              `UPDATE OR INSERT INTO ${nome} (${colunas.join(', ')}) VALUES (${placeholders}) MATCHING (${pks.join(', ')})`,
              valores
            );

            if (srv.ID_ULTIMA_ATUALIZACAO_MATRIZ) {
              await dbExecute(db,
                `UPDATE OR INSERT INTO SYNC_VERSOES_SERVIDOR (NOME_TABELA, PK_VALOR, ID_ULTIMA_ATUALIZACAO_MATRIZ)
                 VALUES (?, ?, ?) MATCHING (NOME_TABELA, PK_VALOR)`,
                [nome, pkValorConcatenado, srv.ID_ULTIMA_ATUALIZACAO_MATRIZ]
              ).catch(() => {});
            }
            processados++;
          }
        } catch (err) {
          console.error(`[AUDITORIA] Erro ao processar registro em ${nome}:`, err);
        }
      }

      // Salva todos os conflitos gerados em uma única operação de I/O
      if (conflitosLote.length > 0) {
        salvarLoteConflitos(conflitosLote);
      }
    } finally {
      await closeConnection(db);
    }

    res.json({ ok: true, processados, modo: escolha });
  });

  /* BUG-05: Esta rota retornava { ok: true } sem processar nada — falso positivo.
   * Retorna 501 com mensagem clara enquanto a feature não é implementada.
   * Nenhum botão da UI atual chama este endpoint; a correção evita que uma
   * chamada direta (ex: curl) pareça ter sucesso sem fazer nada. */
  router.post('/auditoria/resolver-unico', (_req, res) => {
    res.status(501).json({
      ok: false,
      message: 'Resolução individual ainda não implementada. Use "Aplicar Matriz em Tudo" ou resolva via aba Conflitos.',
    });
  });

  return router;
}

module.exports = { criarAuditoriaRouter };
