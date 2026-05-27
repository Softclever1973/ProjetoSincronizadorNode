const express = require('express');
const path = require('path');
const http = require('http');
const https = require('https');
const { listarPendentes, resolverConflito, lerTodos, salvarConflito, salvarLoteConflitos, clearConflitos, emitter: conflitosEmitter } = require('./conflitos');
const { lerTodos: lerErros, limparErros, emitter: errosEmitter } = require('./erros');
const { enviarRegistro } = require('./http');
const { getConnection, query: dbQuery, execute: dbExecute, closeConnection } = require('./db');
const { getUltimaAtualizacao } = require('./cursor');
const TABELAS = require('./tabelas');
const { lerConfig, salvarConfig, defaultAtivo } = require('./tabelasConfig');

const TOKEN = process.env.SYNC_TOKEN;

// Cache de colunas computadas (read-only) por tabela
const cacheColunasComputadas = {};

async function getColunasComputadas(db, nomeTabela) {
  if (cacheColunasComputadas[nomeTabela]) return cacheColunasComputadas[nomeTabela];
  const rows = await dbQuery(db,
    `SELECT TRIM(rf.RDB$FIELD_NAME) AS COLUNA
     FROM RDB$RELATION_FIELDS rf
     JOIN RDB$FIELDS f ON f.RDB$FIELD_NAME = rf.RDB$FIELD_SOURCE
     WHERE TRIM(rf.RDB$RELATION_NAME) = ?
       AND f.RDB$COMPUTED_SOURCE IS NOT NULL`,
    [nomeTabela]
  );
  cacheColunasComputadas[nomeTabela] = new Set(rows.map(r => (r.COLUNA || '').trim()));
  return cacheColunasComputadas[nomeTabela];
}

// Colunas excluídas da comparação de auditoria e das escritas locais.
// São campos de controle de sincronização ou metadados populados por triggers locais
// que usam generators independentes (sobrescrever causaria divergências de GEN).
const COLUNAS_IGNORADAS_AUDITORIA = new Set([
  'ID_ULTIMA_ATUALIZACAO_MATRIZ',
  'ID_ULTIMA_ATUALIZACAO_WEB',
  'ID_ULTIMA_ATT_IFOOD',
  'DATA_HORA',
  'DATA_HORA_ATUALIZACAO',
  'DATA_ALTERACAO',
  'DATA_ULTIMA_ALTERACAO',
  'DATA_ULTIMA_ATUALIZACAO',
  'TIMESTAMP_ALTERACAO',
  'ID_ULTIMA_ATUALIZACAO',
  'DATA_ULTIMA_MOVIMENTACAO',
  'DATA_ULTIMA_ENTRADA',
  'DATA_ULTIMA_SAIDA',
  'DATA_INCLUSAO_SIRIUS',
  'DATA_ALTERACAO_SIRIUS',
  'ULTIMA_ALTERACAO',
  'DATA_PRECO_VENDA',
  'DATA_ULTIMA_ATUAL_IMP_ENTRADA',
  'DATA_PRECO_CUSTO',
]);

function isColunaIgnorada(coluna) {
  return COLUNAS_IGNORADAS_AUDITORIA.has((coluna ?? '').toUpperCase());
}

function normalizarBlobs(row) {
  if (!row || typeof row !== 'object') return row;
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k, typeof v === 'function' ? null : v])
  );
}

function getJSON(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const urlObj = new URL(url);

    const opcoes = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
    };

    const req = lib.request(opcoes, (res) => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error('Resposta inválida')); }
      });
    });

    req.setTimeout(15_000, () => req.destroy(new Error('Timeout de 15s ao conectar ao servidor')));
    req.on('error', reject);
    req.end();
  });
}

const PORTA_PADRAO = 3001;

function formatDisplay(v) {
  if (v === null || v === undefined) return '<span style="color:#aaa;font-style:italic">NULL</span>';
  if (typeof v === 'string' && v.trim() === '') return '<span style="color:#aaa;font-style:italic">"" (vazio)</span>';
  return v;
}

/**
 * Extrai a representação "ingênua" de uma data/timestamp — sem timezone.
 * Firebird armazena timestamps sem timezone; node-firebird retorna Date objects
 * no cliente (usando horário local da máquina) e ISO strings UTC no servidor.
 * Comparar getTime() causa falsos positivos de 3h (UTC-3). Comparar apenas
 * os dígitos de data/hora ignora o fuso e reflete o valor real armazenado.
 */
function toNaiveDateTime(v) {
  const pad = n => String(n).padStart(2, '0');
  if (v instanceof Date) {
    // Usa horário LOCAL da máquina — é o que o Firebird armazenou
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}` +
           `T${pad(v.getHours())}:${pad(v.getMinutes())}:${pad(v.getSeconds())}`;
  }
  if (typeof v === 'string') {
    // Remove frações de segundo e sufixo de timezone ("Z", "+00:00", "-03:00" …)
    return v.replace(/\.\d+/, '').replace(/([+-]\d{2}:\d{2}|Z)$/, '').replace(' ', 'T');
  }
  return String(v);
}

function saoIguais(v1, v2) {
  if ((v1 === null || v1 === undefined) && (v2 === null || v2 === undefined)) return true;
  if (v1 === null || v1 === undefined || v2 === null || v2 === undefined) return false;

  // Detecta se ambos são datas/timestamps (Date object ou string ISO/YYYY-MM-DD)
  const isDate = (v) => v instanceof Date || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}[T ]/.test(String(v)));
  if (isDate(v1) && isDate(v2)) {
    // Compara apenas os dígitos de data/hora sem timezone para evitar falsos
    // positivos causados pela diferença UTC vs horário local (ex: UTC-3 Brasília)
    return toNaiveDateTime(v1).substring(0, 19) === toNaiveDateTime(v2).substring(0, 19);
  }

  // Trata strings vazias vs null de forma estrita
  if (typeof v1 === 'string' && v1.trim() === '' && (v2 === null || v2 === undefined)) return false;
  if (typeof v2 === 'string' && v2.trim() === '' && (v1 === null || v1 === undefined)) return false;

  return String(v1) === String(v2);
}

// Padrão de colunas sempre exibidas para identificação rápida do registro
const COLUNAS_IDENTIFICACAO = /DESCRI|^NOME$|PRECO|VALOR|REFERENCIA|CODIGO|EAN|UNIDADE|MARCA|CATEGORIA|TIPO/i;

/**
 * Renderiza as tabelas de campos do conflito em seções colapsáveis ordenadas por importância.
 * Retorna { divergentesTable, localRows, servidorRows, numDivergentes } onde:
 *   - divergentesTable: tabela única com 4 colunas (campo, valor local, radio escolha, valor servidor)
 *   - localRows / servidorRows: <tbody> para identificação e outros campos (layout lado a lado)
 */
function renderCampos(versaoLocal, versaoServidor, conflitoid) {
  const todasColunas = [...new Set([
    ...Object.keys(versaoLocal || {}),
    ...Object.keys(versaoServidor || {}),
  ])];

  const divergentes   = todasColunas.filter(c => !saoIguais(versaoLocal?.[c], versaoServidor?.[c]));
  const identificacao = todasColunas.filter(c => COLUNAS_IDENTIFICACAO.test(c) && !divergentes.includes(c));
  const outros        = todasColunas.filter(c => !divergentes.includes(c) && !identificacao.includes(c));

  const renderLinha = (col, isDif, grupo, startOpen) => {
    const style = isDif ? ' class="diff"' : '';
    const hidden = startOpen ? '' : ' style="display:none"';
    return {
      local:    `<tr${style} data-group="${grupo}"${hidden}><td>${col}</td><td>${formatDisplay(versaoLocal?.[col])}</td></tr>`,
      servidor: `<tr${style} data-group="${grupo}"${hidden}><td>${col}</td><td>${formatDisplay(versaoServidor?.[col])}</td></tr>`,
    };
  };

  // Cada seção tem um ID único compartilhado pelas duas tabelas (local e servidor)
  const uid = Math.random().toString(36).slice(2, 7);

  function secao(cols, grupo, label, corFundo, corTexto, isDif, startOpen = false) {
    if (cols.length === 0) return { local: '', servidor: '' };

    const seta = startOpen ? '&#9660;' : '&#9654;';
    const toggleStyle = `background:${corFundo};font-size:11px;font-weight:bold;color:${corTexto};padding:6px 8px;cursor:pointer;user-select:none;text-transform:uppercase`;
    const headerRow = `<tr onclick="
      document.querySelectorAll('[data-group=\\'${grupo}-${uid}\\']').forEach(function(el){
        el.style.display = el.style.display === '' ? 'none' : '';
      });
      this.querySelector('.seta').innerHTML = this.querySelector('.seta').innerHTML === '&#9654;' ? '&#9660;' : '&#9654;';
    ">
      <td colspan="2" style="${toggleStyle}">
        <span class="seta">${seta}</span> ${label} (${cols.length})
      </td>
    </tr>`;

    let local = headerRow;
    let servidor = headerRow;

    for (const col of cols) {
      const l = renderLinha(col, isDif, `${grupo}-${uid}`, startOpen);
      local    += l.local;
      servidor += l.servidor;
    }

    return { local, servidor };
  }

  // Tabela única de campos divergentes com radio buttons por linha
  let divergentesTable = '';
  if (divergentes.length > 0) {
    const headerStyle = `background:#f8d7da;font-size:11px;font-weight:bold;color:#721c24;padding:6px 8px;text-transform:uppercase;text-align:center`;
    const rows = divergentes.map(col => {
      const radioLocal    = `<input type="radio" name="campo-${conflitoid}-${col}" value="local" checked>`;
      const radioServidor = `<input type="radio" name="campo-${conflitoid}-${col}" value="servidor">`;
      return `<tr class="diff">
        <td style="font-weight:bold;color:#555;width:20%">${col}</td>
        <td style="width:30%">${formatDisplay(versaoLocal?.[col])}</td>
        <td style="text-align:center;width:20%;white-space:nowrap">
          <label style="margin-right:8px">${radioLocal} Local</label>
          <label>${radioServidor} Servidor</label>
        </td>
        <td style="width:30%">${formatDisplay(versaoServidor?.[col])}</td>
      </tr>`;
    }).join('');

    divergentesTable = `
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:12px">
        <thead>
          <tr>
            <th style="${headerStyle}">Campo</th>
            <th style="${headerStyle}">Valor Local</th>
            <th style="${headerStyle}">Escolha</th>
            <th style="${headerStyle}">Valor Servidor</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  const s2 = secao(identificacao, 'iden', 'Identificação',      '#eaf3fb', '#2471a3', false, false);
  const s3 = secao(outros,        'out',  'Outros campos',      '#f5f5f5', '#666',    false, false);

  return {
    divergentesTable,
    localRows:    `<tbody>${s2.local}${s3.local}</tbody>`,
    servidorRows: `<tbody>${s2.servidor}${s3.servidor}</tbody>`,
    numDivergentes: divergentes.length,
  };
}

function iniciarWebUI(porta = PORTA_PADRAO, contexto = {}) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.use(express.static(path.join(__dirname, 'public')));
  app.use(express.json());

  // Middleware: injeta currentPage em todas as views para aria-current="page" no nav
  app.use((req, res, next) => {
    const pathMap = { '/': 'conflitos', '/status': 'status', '/auditoria': 'auditoria', '/configuracoes': 'configuracoes', '/erros': 'erros' };
    res.locals.currentPage = pathMap[req.path] || '';
    next();
  });

  // Estado em memória do envio pós-carga-inicial (null = inativo)
  let estadoEnvio = null;

  // ── STATUS DE SINCRONIZAÇÃO ──────────────────────────────────────────────
  app.get('/status', async (req, res) => {
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

    const db = await getConnection();
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

  // ── AUDITORIA ────────────────────────────────────────────────────────────
  app.get('/auditoria', async (req, res) => {
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

    const db = await getConnection();
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
  app.post('/auditoria/corrigir', async (req, res) => {
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

    const db = await getConnection();
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
  app.post('/auditoria/resolver-unico', (_req, res) => {
    res.status(501).json({
      ok: false,
      message: 'Resolução individual ainda não implementada. Use "Aplicar Matriz em Tudo" ou resolva via aba Conflitos.',
    });
  });

  // ── CONFLITOS ────────────────────────────────────────────────────────────
  app.get('/', (req, res) => {
    const mostrarResolvidos = req.query.todos === '1';
    const POR_PAGINA = 30;
    const pendentes = listarPendentes();
    const listaCompleta = (mostrarResolvidos ? lerTodos() : pendentes).slice().reverse();
    const total = listaCompleta.length;
    const totalGeral = lerTodos().length;

    const totalPaginas = Math.max(1, Math.ceil(total / POR_PAGINA));
    const pagina = Math.min(Math.max(1, parseInt(req.query.pagina, 10) || 1), totalPaginas);
    const inicio = (pagina - 1) * POR_PAGINA;
    const lista  = listaCompleta.slice(inicio, inicio + POR_PAGINA);

    const base      = mostrarResolvidos ? '/?todos=1' : '/';
    const linkPagina = p => `${base}${base.includes('?') ? '&' : '?'}pagina=${p}`;

    const paginacaoHTML = (() => {
      if (totalPaginas <= 1) return '';
      const fim = Math.min(inicio + POR_PAGINA, total);
      const partes = [];
      if (pagina > 1) partes.push(`<a href="${linkPagina(pagina - 1)}" style="padding:4px 10px;border:1px solid #3498db;border-radius:4px;color:#3498db;text-decoration:none">← Anterior</a>`);
      const de = Math.max(1, pagina - 2), ate = Math.min(totalPaginas, pagina + 2);
      if (de > 1) partes.push(`<span style="color:#aaa">…</span>`);
      for (let p = de; p <= ate; p++) {
        partes.push(p === pagina
          ? `<span style="padding:4px 10px;border:1px solid #3498db;border-radius:4px;background:#3498db;color:white;font-weight:bold">${p}</span>`
          : `<a href="${linkPagina(p)}" style="padding:4px 10px;border:1px solid #ccc;border-radius:4px;color:#555;text-decoration:none">${p}</a>`);
      }
      if (ate < totalPaginas) partes.push(`<span style="color:#aaa">…</span>`);
      if (pagina < totalPaginas) partes.push(`<a href="${linkPagina(pagina + 1)}" style="padding:4px 10px;border:1px solid #3498db;border-radius:4px;color:#3498db;text-decoration:none">Próxima →</a>`);
      const irParaForm = `<form method="get" action="${base.split('?')[0]}" style="display:inline-flex;align-items:center;gap:4px;margin-left:12px">${mostrarResolvidos ? '<input type="hidden" name="todos" value="1">' : ''}<label style="font-size:12px;color:#888">Ir para:</label><input type="number" name="pagina" min="1" max="${totalPaginas}" value="${pagina}" style="width:54px;padding:3px 6px;border:1px solid #ccc;border-radius:4px;font-size:13px;text-align:center"><button type="submit" style="padding:3px 8px;border:1px solid #3498db;border-radius:4px;background:#3498db;color:white;font-size:12px;cursor:pointer">→</button></form>`;
      return `<div style="display:flex;align-items:center;gap:6px;margin-top:20px;flex-wrap:wrap">${partes.join('')}<span style="margin-left:8px;font-size:12px;color:#888">${inicio + 1}–${fim} de ${total}</span>${irParaForm}</div>`;
    })();

    const conflitos = lista.map(c => ({ ...c, rendered: renderCampos(c.versaoLocal, c.versaoServidor, c.id) }));

    res.render('conflitos', {
      conflitos, numPendentes: pendentes.length,
      total, totalGeral, pagina, totalPaginas, inicio,
      mostrarResolvidos, paginacaoHTML,
    });
  });

  app.post('/conflitos/:id/resolver', async (req, res) => {
    const { id } = req.params;
    const { escolha, campos } = req.body;

    if (!['local', 'servidor', 'mesclar'].includes(escolha)) {
      return res.status(400).json({ ok: false, message: 'escolha inválida' });
    }

    if (escolha === 'mesclar' && (typeof campos !== 'object' || campos === null)) {
      return res.status(400).json({ ok: false, message: 'campos obrigatório para escolha mesclar' });
    }

    let conflito;
    try {
      conflito = resolverConflito(id, escolha);
    } catch (e) {
      return res.status(404).json({ ok: false, message: e.message });
    }

    if (escolha === 'local') {
      // Força envio da versão local ao servidor (ignora conflito)
      if (!contexto.baseURI || !contexto.idLoja) {
        return res.status(500).json({ ok: false, message: 'Configuração do servidor não disponível ainda' });
      }
      try {
        await enviarRegistro(contexto.baseURI, contexto.idLoja,
          conflito.tabela, conflito.pk, conflito.versaoLocal, 0, true);
      } catch (e) {
        return res.status(500).json({ ok: false, message: `Falha ao enviar ao servidor: ${e.message}` });
      }
    } else if (escolha === 'servidor') {
      // Aplica a versão do servidor no banco local da filial
      const db = await getConnection();
      try {
        const reg = conflito.versaoServidor;
        const computadas = await getColunasComputadas(db, conflito.tabela);
        const colunas = Object.keys(reg).filter(k =>
          reg[k] !== undefined && !COLUNAS_IGNORADAS_AUDITORIA.has(k) && !computadas.has(k)
        );
        const placeholders = colunas.map(() => '?').join(', ');
        const valores = colunas.map(c => (reg[c] === undefined ? null : reg[c]));
        const pks = Array.isArray(conflito.pk) ? conflito.pk : [conflito.pk];
        await dbExecute(db,
          `UPDATE OR INSERT INTO ${conflito.tabela} (${colunas.join(', ')}) VALUES (${placeholders}) MATCHING (${pks.join(', ')})`,
          valores
        );
        // Atualiza versão conhecida do servidor
        if (reg.ID_ULTIMA_ATUALIZACAO_MATRIZ) {
          await dbExecute(db,
            `UPDATE OR INSERT INTO SYNC_VERSOES_SERVIDOR (NOME_TABELA, PK_VALOR, ID_ULTIMA_ATUALIZACAO_MATRIZ)
             VALUES (?, ?, ?) MATCHING (NOME_TABELA, PK_VALOR)`,
            [conflito.tabela, conflito.pkValor, reg.ID_ULTIMA_ATUALIZACAO_MATRIZ]
          ).catch(() => {});
        }
      } catch (e) {
        return res.status(500).json({ ok: false, message: `Falha ao aplicar versão do servidor: ${e.message}` });
      } finally {
        await closeConnection(db);
      }
    } else if (escolha === 'mesclar') {
      // Constrói registro mesclado: base local, sobrescreve campos escolhidos do servidor
      const base = { ...conflito.versaoLocal };
      for (const [col, origem] of Object.entries(campos)) {
        if (origem === 'servidor') {
          base[col] = conflito.versaoServidor?.[col] ?? null;
        }
      }

      // 1. Aplica o registro mesclado no banco local (igual ao fluxo 'servidor')
      const db = await getConnection();
      try {
        const computadas = await getColunasComputadas(db, conflito.tabela);
        const colunas = Object.keys(base).filter(k =>
          base[k] !== undefined && !COLUNAS_IGNORADAS_AUDITORIA.has(k) && !computadas.has(k)
        );
        const placeholders = colunas.map(() => '?').join(', ');
        const valores = colunas.map(c => (base[c] === undefined ? null : base[c]));
        const pks = Array.isArray(conflito.pk) ? conflito.pk : [conflito.pk];
        await dbExecute(db,
          `UPDATE OR INSERT INTO ${conflito.tabela} (${colunas.join(', ')}) VALUES (${placeholders}) MATCHING (${pks.join(', ')})`,
          valores
        );
      } catch (e) {
        return res.status(500).json({ ok: false, message: `Falha ao aplicar mesclagem localmente: ${e.message}` });
      } finally {
        await closeConnection(db);
      }

      // 2. Envia o registro mesclado ao servidor forçando (igual ao fluxo 'local')
      if (!contexto.baseURI || !contexto.idLoja) {
        return res.status(500).json({ ok: false, message: 'Configuração do servidor não disponível ainda' });
      }
      try {
        await enviarRegistro(contexto.baseURI, contexto.idLoja,
          conflito.tabela, conflito.pk, base, 0, true);
      } catch (e) {
        return res.status(500).json({ ok: false, message: `Falha ao enviar mesclagem ao servidor: ${e.message}` });
      }
    }

    res.json({ ok: true });
  });

  // ── CONFIGURAÇÕES DE TABELAS ─────────────────────────────────────────────

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

  app.get('/configuracoes', async (_req, res) => {
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

  app.post('/configuracoes/toggle', async (req, res) => {
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

  app.post('/configuracoes/carga-inicial', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const enviar = (evento, dados) =>
      res.write(`event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`);

    const { enfileirarTodosRegistros } = require('./setup');
    const log = (msg) => console.log(msg);
    const db = await getConnection();
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

  app.get('/api/carga-inicial/progresso', async (_req, res) => {
    if (!estadoEnvio) return res.json({ ativo: false });
    const db = await getConnection();
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

  app.post('/configuracoes/toggle-todos', async (req, res) => {
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

  // ── SSE: stream de erros em tempo real ──────────────────────────────────
  app.get('/eventos', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Mantém a conexão viva com um comentário a cada 25s (evita timeout de proxies)
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 25_000);

    const onErro = (erro) => {
      res.write(`event: novo-erro\ndata: ${JSON.stringify(erro)}\n\n`);
    };

    const onConflito = (conflito) => {
      res.write(`event: novo-conflito\ndata: ${JSON.stringify(conflito)}\n\n`);
    };

    errosEmitter.on('novo-erro', onErro);
    conflitosEmitter.on('novo-conflito', onConflito);

    req.on('close', () => {
      clearInterval(keepAlive);
      errosEmitter.off('novo-erro', onErro);
      conflitosEmitter.off('novo-conflito', onConflito);
    });
  });

  // ── API: contagens para badges ───────────────────────────────────────────
  app.get('/api/conflitos/count', (_req, res) => {
    res.json({ total: listarPendentes().length });
  });

  app.get('/api/erros/count', async (_req, res) => {
    try {
      const erros = await lerErros();
      res.json({ total: erros.length });
    } catch (e) {
      res.status(500).json({ total: 0, error: e.message });
    }
  });

  // ── ERROS ────────────────────────────────────────────────────────────────
  app.get('/erros', async (_req, res) => {
    try {
      const erros = await lerErros();
      res.render('erros', { erros });
    } catch (e) {
      res.status(500).render('erros', { erros: [] });
    }
  });

  app.post('/erros/limpar', async (_req, res) => {
    try {
      await limparErros();
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.listen(porta, () => {
    console.log(`[WEBUI] Interface de conflitos: http://localhost:${porta}`);
  });
}

module.exports = { iniciarWebUI };
