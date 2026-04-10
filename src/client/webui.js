const express = require('express');
const http = require('http');
const https = require('https');
const { listarPendentes, resolverConflito, lerTodos, salvarConflito, salvarLoteConflitos } = require('./conflitos');
const { enviarRegistro } = require('./http');
const { getConnection, query: dbQuery, execute: dbExecute, closeConnection } = require('./db');
const { getUltimaAtualizacao } = require('./cursor');
const TABELAS = require('./tabelas');
const { lerConfig, salvarConfig } = require('./tabelasConfig');

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

function html(body) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Conflitos de Sincronização</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, sans-serif; background: #f5f5f5; padding: 24px; }
    nav { margin-bottom: 20px; display: flex; gap: 12px; font-size: 13px; }
    nav a { color: #3498db; text-decoration: none; padding: 4px 10px; border: 1px solid #3498db; border-radius: 4px; }
    nav a:hover { background: #3498db; color: white; }
    h1 { color: #333; margin-bottom: 16px; }
    .badge { display: inline-block; background: #e74c3c; color: white; border-radius: 12px; padding: 2px 10px; font-size: 13px; margin-left: 8px; }
    .badge.ok { background: #27ae60; }
    .conflito { background: white; border: 1px solid #ddd; border-radius: 8px; margin-bottom: 24px; overflow: hidden; }
    .conflito-header { background: #f8d7da; padding: 12px 16px; border-bottom: 1px solid #ddd; }
    .conflito-header h2 { font-size: 15px; color: #721c24; }
    .conflito-header span { font-size: 12px; color: #555; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; }
    .lado { padding: 16px; }
    .lado:first-child { border-right: 1px solid #eee; }
    .lado h3 { font-size: 13px; font-weight: bold; margin-bottom: 10px; text-transform: uppercase; color: #666; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    td { padding: 4px 6px; border-bottom: 1px solid #f0f0f0; vertical-align: top; word-break: break-all; }
    td:first-child { font-weight: bold; color: #555; width: 40%; }
    .diff { background: #fff3cd; }
    .acoes { padding: 12px 16px; background: #fafafa; border-top: 1px solid #eee; display: flex; gap: 8px; align-items: center; }
    button { padding: 8px 18px; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: bold; }
    .btn-local    { background: #3498db; color: white; }
    .btn-servidor { background: #e67e22; color: white; }
    .btn-mesclar  { background: #8e44ad; color: white; }
    .btn-local:hover    { background: #2980b9; }
    .btn-servidor:hover { background: #d35400; }
    .btn-mesclar:hover  { background: #6c3483; }
    .empty { text-align: center; padding: 48px; color: #888; }
    .resolvido { opacity: 0.5; }
    .resolvido .conflito-header { background: #d4edda; }
    .resolvido .conflito-header h2 { color: #155724; }
  </style>
</head>
<body>
  <nav>
    <a href="/">Conflitos</a>
    <a href="/status">Status</a>
    <a href="/auditoria">Auditoria</a>
    <a href="/configuracoes">Configurações</a>
  </nav>
  ${body}
  <script>
    async function corrigir(tabela, offset, escolha = 'matriz') {
      const btn = event.target;
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Processando...';
      try {
        const r = await fetch('/auditoria/corrigir', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tabela, offset, escolha })
        });
        const data = await r.json();
        if (data.ok) {
          if (escolha === 'manual') {
            window.location.href = '/'; // Redireciona para conflitos
          } else {
            btn.textContent = 'Concluído: ' + data.processados + ' registro(s)';
            setTimeout(() => location.reload(), 1500);
          }
        } else {
          alert('Erro: ' + (data.message || 'desconhecido'));
          btn.disabled = false;
          btn.textContent = originalText;
        }
      } catch(e) {
        alert('Erro de rede: ' + e.message);
        btn.disabled = false;
        btn.textContent = originalText;
      }
    }

    async function resolver(id, escolha) {
      const btn = event.target;
      btn.disabled = true;
      btn.textContent = 'Aguarde...';
      try {
        const r = await fetch('/conflitos/' + id + '/resolver', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ escolha })
        });
        const data = await r.json();
        if (data.ok) {
          location.reload();
        } else {
          alert('Erro: ' + (data.message || 'desconhecido'));
          btn.disabled = false;
        }
      } catch(e) {
        alert('Erro de rede: ' + e.message);
        btn.disabled = false;
      }
    }

    async function resolverMesclado(conflitoid) {
      const campos = {};
      document.querySelectorAll('[name^="campo-' + conflitoid + '-"]').forEach(function(r) {
        if (r.checked) {
          var col = r.name.replace('campo-' + conflitoid + '-', '');
          campos[col] = r.value;
        }
      });
      const btn = event.target;
      btn.disabled = true;
      btn.textContent = 'Aguarde...';
      try {
        const r = await fetch('/conflitos/' + conflitoid + '/resolver', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ escolha: 'mesclar', campos })
        });
        const data = await r.json();
        if (data.ok) {
          location.reload();
        } else {
          alert('Erro: ' + (data.message || 'desconhecido'));
          btn.disabled = false;
          btn.textContent = 'Aplicar seleção';
        }
      } catch(e) {
        alert('Erro de rede: ' + e.message);
        btn.disabled = false;
        btn.textContent = 'Aplicar seleção';
      }
    }
  </script>
</body>
</html>`;
}

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
  app.use(express.json());

  // ── STATUS DE SINCRONIZAÇÃO ──────────────────────────────────────────────
  app.get('/status', async (req, res) => {
    if (!contexto.baseURI || !contexto.idLoja) {
      return res.status(503).send(html(`
        <h1>Status de Sincronização</h1>
        <div class="empty"><p>Aguardando primeiro ciclo de sincronização...</p></div>
      `));
    }

    let statusServidor = [];
    try {
      const url = `${contexto.baseURI}/datasnap/rest/TSMSincronizacao/StatusTabelas?token=${TOKEN}`;
      statusServidor = await getJSON(url);
    } catch (e) {
      return res.status(502).send(html(`
        <h1>Status de Sincronização</h1>
        <div class="empty"><p>Erro ao consultar servidor: ${e.message}</p></div>
      `));
    }

    const db = await getConnection();
    let linhas = '';
    let totalOk = 0, totalPendente = 0, totalErro = 0;

    try {
      for (const sv of statusServidor) {
        // Cursor local
        let cursorLocal = 0;
        let totalLocal = 0;
        let pendentesEnvio = 0;
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
        const statusCor = sv.erro ? '#6c757d' : sincronizado ? '#27ae60' : '#e67e22';
        const statusTexto = sv.erro ? 'N/D' : sincronizado ? 'OK' : 'Pendente';

        if (sv.erro) totalErro++;
        else if (sincronizado) totalOk++;
        else totalPendente++;

        linhas += `
          <tr>
            <td>${sv.tabela}</td>
            <td style="text-align:right">${sv.total ?? '—'}</td>
            <td style="text-align:right">${totalLocal || '—'}</td>
            <td style="text-align:right">${sv.maxId ?? '—'}</td>
            <td style="text-align:right">${cursorLocal || 0}</td>
            <td style="text-align:right;color:#e74c3c;font-weight:bold">${pendentesEnvio > 0 ? pendentesEnvio : '—'}</td>
            <td style="text-align:center;color:${statusCor};font-weight:bold">${statusTexto}</td>
          </tr>`;
      }
    } finally {
      await closeConnection(db);
    }

    res.send(html(`
      <h1>Status de Sincronização</h1>
      <p style="margin-bottom:16px;font-size:13px;color:#666">
        <span style="color:#27ae60;font-weight:bold">${totalOk} OK</span> &nbsp;|&nbsp;
        <span style="color:#e67e22;font-weight:bold">${totalPendente} pendente(s)</span> &nbsp;|&nbsp;
        <span style="color:#6c757d">${totalErro} N/D</span>
        &nbsp;&nbsp;
        <a href="/status" style="font-size:12px">Atualizar</a>
        &nbsp;|&nbsp;
        <a href="/" style="font-size:12px">Ver conflitos</a>
      </p>
      <table style="width:100%;border-collapse:collapse;background:white;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1)">
        <thead style="background:#f0f0f0;font-size:12px;text-transform:uppercase;color:#555">
          <tr>
            <th style="padding:10px 12px;text-align:left">Tabela</th>
            <th style="padding:10px 12px;text-align:right">Servidor</th>
            <th style="padding:10px 12px;text-align:right">Local</th>
            <th style="padding:10px 12px;text-align:right">Max ID Servidor</th>
            <th style="padding:10px 12px;text-align:right">Cursor Local</th>
            <th style="padding:10px 12px;text-align:right">A Enviar</th>
            <th style="padding:10px 12px;text-align:center">Status</th>
          </tr>
        </thead>
        <tbody style="font-size:13px">
          ${linhas}
        </tbody>
      </table>
    `));
  });

  // ── AUDITORIA ────────────────────────────────────────────────────────────
  app.get('/auditoria', async (req, res) => {
    const tabelaParam = (req.query.tabela || '').toUpperCase().trim();
    const offset      = parseInt(req.query.offset, 10) || 0;
    const limite      = 200;

    // Monta seletor de tabela
    const opcoes = TABELAS.map(t =>
      `<option value="${t.nome}" ${t.nome === tabelaParam ? 'selected' : ''}>${t.nome}</option>`
    ).join('');

    const seletor = `
      <form method="get" action="/auditoria" style="margin-bottom:20px;display:flex;gap:8px;align-items:center">
        <select name="tabela" style="padding:7px 12px;border:1px solid #ccc;border-radius:4px;font-size:14px">
          <option value="">— Selecione uma tabela —</option>
          ${opcoes}
        </select>
        <button type="submit" style="padding:7px 16px;background:#3498db;color:white;border:none;border-radius:4px;cursor:pointer;font-size:14px">Comparar</button>
      </form>`;

    if (!tabelaParam) {
      return res.send(html(`<h1>Auditoria de Dados</h1>${seletor}`));
    }

    if (!contexto.baseURI || !contexto.idLoja) {
      return res.send(html(`<h1>Auditoria de Dados</h1>${seletor}
        <div class="empty"><p>Aguardando primeiro ciclo...</p></div>`));
    }

    const config = TABELAS.find(t => t.nome === tabelaParam);
    if (!config) {
      return res.send(html(`<h1>Auditoria de Dados</h1>${seletor}
        <div class="empty"><p>Tabela não encontrada na configuração.</p></div>`));
    }

    const pk = config.pk;
    const pks = Array.isArray(pk) ? pk : [pk];

    // Busca página do servidor
    let registrosServidor = [];
    try {
      const pkQuery = Array.isArray(pk) ? pk.map(p => `pk=${p}`).join('&') : `pk=${pk}`;
      const url = `${contexto.baseURI}/datasnap/rest/TSMSincronizacao/RegistrosPaginados` +
        `?token=${TOKEN}&nomeTabela=${tabelaParam}&${pkQuery}&offset=${offset}&limit=${limite}`;
      registrosServidor = await getJSON(url);
    } catch (e) {
      return res.send(html(`<h1>Auditoria — ${tabelaParam}</h1>${seletor}
        <div class="empty"><p>Erro ao consultar servidor: ${e.message}</p></div>`));
    }

    if (registrosServidor.length === 0) {
      return res.send(html(`<h1>Auditoria — ${tabelaParam}</h1>${seletor}
        <div class="empty"><p>Nenhum registro encontrado no servidor para esta página.</p></div>`));
    }

    // Monta mapa servidor por PK (concatenada)
    const getPKValor = (r) => pks.map(p => String(r[p] || '')).join('|');
    const mapServidor = new Map(registrosServidor.map(r => [getPKValor(r), r]));

    // Busca os mesmos registros no banco local
    const db = await getConnection();
    const mapLocal = new Map();
    try {
      const whereParts = pks.map(p => `${p} = ?`).join(' AND ');
      for (const registroSrv of registrosServidor) {
        const pkValores = pks.map(p => registroSrv[p]);
        const rows = await dbQuery(db, `SELECT * FROM ${tabelaParam} WHERE ${whereParts}`, pkValores)
          .catch(() => []);
        if (rows.length > 0) mapLocal.set(getPKValor(registroSrv), normalizarBlobs(rows[0]));
      }
    } finally {
      await closeConnection(db);
    }

    // Determina colunas (excluindo colunas ignoradas para comparação)
    const todasColunas = [...new Set(registrosServidor.flatMap(r => Object.keys(r)))]
      .filter(c => !isColunaIgnorada(c));

    let totalOk = 0, totalDif = 0, totalAusente = 0;
    let linhas = '';

    for (const pkValor of mapServidor.keys()) {
      const srv = mapServidor.get(pkValor);
      const loc = mapLocal.get(pkValor);

      if (!loc) {
        totalAusente++;
        linhas += `<tr style="background:#fff3cd">
          <td>${pkValor}</td>
          <td colspan="${todasColunas.length}" style="color:#856404;font-style:italic">
            Não existe na filial
          </td>
        </tr>`;
        continue;
      }

      const difColunas = todasColunas.filter(c => !saoIguais(srv[c], loc[c]));

      if (difColunas.length === 0) {
        totalOk++;
      } else {
        totalDif++;
      }

      const bgColor = difColunas.length > 0 ? 'background:#f8d7da' : '';
      const pkStyle = difColunas.length > 0 ? 'font-weight:bold' : '';

      linhas += `<tr style="${bgColor}">
        <td><strong style="${pkStyle}">${pkValor}</strong></td>
        ${todasColunas.map(c => {
          const isDif = difColunas.includes(c);
          const val = isDif
            ? `<span title="Servidor: ${String(srv[c] ?? 'NULL')}" style="color:#721c24;font-weight:bold">${formatDisplay(loc[c])}</span>`
            : `<span style="color:#aaa">${formatDisplay(loc[c])}</span>`;
          return `<td>${val}</td>`;
        }).join('')}
      </tr>`;
    }

    const proxOffset = offset + registrosServidor.length;
    const temProxima = registrosServidor.length === limite;

    const paginacao = `
      <div style="margin-top:16px;display:flex;gap:8px">
        ${offset > 0
          ? `<a href="/auditoria?tabela=${tabelaParam}&offset=${Math.max(0, offset - limite)}"
               style="padding:6px 14px;background:#eee;border-radius:4px;text-decoration:none;font-size:13px">← Anterior</a>`
          : ''}
        ${temProxima
          ? `<a href="/auditoria?tabela=${tabelaParam}&offset=${proxOffset}"
               style="padding:6px 14px;background:#eee;border-radius:4px;text-decoration:none;font-size:13px">Próxima →</a>`
          : ''}
        <span style="font-size:12px;color:#888;margin-left:8px;align-self:center">
          Registros ${offset + 1}–${offset + registrosServidor.length}
        </span>
      </div>`;

    const temDivergencias = totalDif > 0 || totalAusente > 0;

    res.send(html(`
      <h1>Auditoria — ${tabelaParam}</h1>
      ${seletor}
      <div style="margin-bottom:12px;display:flex;align-items:center;gap:16px;flex-wrap:wrap">
        <span style="font-size:13px;color:#666">
          <span style="color:#27ae60;font-weight:bold">${totalOk} iguais</span> &nbsp;|&nbsp;
          <span style="color:#c0392b;font-weight:bold">${totalDif} diferente(s)</span> &nbsp;|&nbsp;
          <span style="color:#856404;font-weight:bold">${totalAusente} ausente(s) na filial</span>
        </span>
        ${temDivergencias ? `
        <button onclick="corrigir('${tabelaParam}', ${offset}, 'matriz')"
          style="padding:7px 16px;background:#27ae60;color:white;border:none;border-radius:4px;cursor:pointer;font-size:13px;font-weight:bold">
          Aplicar Matriz em Tudo
        </button>
        <button onclick="corrigir('${tabelaParam}', ${offset}, 'manual')"
          style="padding:7px 16px;background:#e67e22;color:white;border:none;border-radius:4px;cursor:pointer;font-size:13px;font-weight:bold">
          Resolver um por um (Conflitos)
        </button>` : ''}
        <small style="color:#aaa;font-size:11px">Vermelho = filial difere (mouse = valor do servidor)</small>
      </div>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;background:white;font-size:12px;box-shadow:0 1px 3px rgba(0,0,0,.1)">
          <thead style="background:#f0f0f0;text-transform:uppercase;color:#555">
            <tr>
              <th style="padding:8px 10px;text-align:left">${pk}</th>
              ${todasColunas.map(c => `<th style="padding:8px 10px;text-align:left">${c}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${linhas}
          </tbody>
        </table>
      </div>
      ${paginacao}
    `));
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

  app.post('/auditoria/resolver-unico', async (req, res) => {
    const { tabela, pkValor, escolha } = req.body;
    // ... lógica para resolver apenas UM registro direto da linha (similar ao acima)
    // Para simplificar, vamos reutilizar a aba de conflitos:
    // Se clicar em 'F' ou 'M' na linha, podemos simplesmente criar um conflito e resolvê-lo imediatamente.
    res.json({ ok: true });
  });

  // ── CONFLITOS ────────────────────────────────────────────────────────────
  app.get('/', (req, res) => {
    const mostrarResolvidos = req.query.todos === '1';
    const lista = mostrarResolvidos ? lerTodos() : listarPendentes();
    const pendentes = listarPendentes();

    if (lista.length === 0) {
      return res.send(html(`
        <h1>Conflitos de Sincronização</h1>
        <div class="empty">
          <p>Nenhum conflito ${mostrarResolvidos ? '' : 'pendente '}encontrado.</p>
          ${!mostrarResolvidos ? '<p style="margin-top:8px"><a href="/?todos=1">Ver resolvidos</a></p>' : '<p style="margin-top:8px"><a href="/">Voltar</a></p>'}
        </div>
      `));
    }

    const cards = lista.map(c => {
      const { divergentesTable, localRows, servidorRows, numDivergentes } = renderCampos(c.versaoLocal, c.versaoServidor, c.id);
      const resolvido = c.resolvido;
      const escolhaLabel = c.escolha === 'local' ? 'versão local' : c.escolha === 'servidor' ? 'versão do servidor' : 'mesclado campo a campo';
      const escolha = resolvido ? `Resolvido: manteve <strong>${escolhaLabel}</strong>` : '';
      const gridId = `grid-${c.id}`;

      return `
        <div class="conflito${resolvido ? ' resolvido' : ''}">
          <div class="conflito-header" style="cursor:pointer;display:flex;justify-content:space-between;align-items:center" onclick="
            var g=document.getElementById('${gridId}');
            var aberto=g.style.display!=='none';
            g.style.display=aberto?'none':'';
            this.querySelector('.toggle-icon').textContent=aberto?'▼ Ver detalhes':'▲ Ocultar';
          ">
            <div>
              <h2>${c.tabela} — ${c.pk} = ${c.pkValor}
                ${!resolvido ? `<span style="font-size:12px;font-weight:normal;color:#c0392b;margin-left:8px">${numDivergentes} campo(s) diferente(s)</span>` : ''}
              </h2>
              <span>${c.criadoEm ? 'Detectado em: ' + new Date(c.criadoEm).toLocaleString('pt-BR') : ''}</span>
              ${resolvido ? `<span style="margin-left:16px;color:#155724">${escolha}</span>` : ''}
            </div>
            <span class="toggle-icon" style="font-size:12px;color:#888;white-space:nowrap;padding-left:16px">▲ Ocultar</span>
          </div>
          <div class="grid" id="${gridId}">
            ${numDivergentes > 0 ? `
            <div style="grid-column:1/-1;padding:16px 16px 0">
              <h3 style="font-size:13px;font-weight:bold;margin-bottom:10px;text-transform:uppercase;color:#666">Campos Divergentes</h3>
              ${divergentesTable}
            </div>` : ''}
            <div class="lado">
              <h3>Versão Local (Filial)</h3>
              <table>${localRows}</table>
            </div>
            <div class="lado">
              <h3>Versão do Servidor (Matriz)</h3>
              <table>${servidorRows}</table>
            </div>
          </div>
          ${!resolvido ? `
          <div class="acoes">
            <button class="btn-local"    onclick="resolver('${c.id}', 'local')">Manter versão local</button>
            <button class="btn-servidor" onclick="resolver('${c.id}', 'servidor')">Manter versão do servidor</button>
            <button class="btn-mesclar"  onclick="resolverMesclado('${c.id}')">Aplicar seleção campo a campo</button>
          </div>` : ''}
        </div>`;
    }).join('');

    res.send(html(`
      <h1>Conflitos de Sincronização
        ${pendentes.length > 0
          ? `<span class="badge">${pendentes.length} pendente(s)</span>`
          : '<span class="badge ok">0 pendentes</span>'}
      </h1>
      <p style="margin-bottom:16px;font-size:13px;color:#666">
        Campos destacados em amarelo diferem entre as versões.
        ${!mostrarResolvidos && lista.length !== lerTodos().length
          ? `<a href="/?todos=1" style="margin-left:8px">Ver todos (incluindo resolvidos)</a>`
          : mostrarResolvidos ? `<a href="/" style="margin-left:8px">Ocultar resolvidos</a>` : ''}
      </p>
      ${cards}
    `));
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
  app.get('/configuracoes', (_req, res) => {
    const config = lerConfig();

    // Agrupa tabelas por campo 'grupo'
    const grupos = {};
    for (const t of TABELAS) {
      const g = t.grupo || 'Outras';
      if (!grupos[g]) grupos[g] = [];
      grupos[g].push(t);
    }

    const totalAtivas = TABELAS.filter(t => config[t.nome] !== false).length;

    const secoes = Object.entries(grupos).map(([grupo, tabelas]) => {
      const linhas = tabelas.map(t => {
        const ativo = config[t.nome] !== false;
        return `
          <tr>
            <td style="padding:8px 12px;font-size:13px;font-family:monospace">${t.nome}</td>
            <td style="padding:8px 12px;font-size:12px;color:#888">${Array.isArray(t.pk) ? t.pk.join(', ') : t.pk}</td>
            <td style="padding:8px 12px;text-align:center">
              <label class="toggle-switch">
                <input type="checkbox" ${ativo ? 'checked' : ''} onchange="toggleTabela('${t.nome}', this.checked)">
                <span class="slider"></span>
              </label>
            </td>
            <td style="padding:8px 12px;font-size:12px" id="status-${t.nome}">
              <span style="color:${ativo ? '#27ae60' : '#e74c3c'};font-weight:bold">${ativo ? 'Ativa' : 'Inativa'}</span>
            </td>
          </tr>`;
      }).join('');

      return `
        <div style="margin-bottom:24px">
          <h2 style="font-size:14px;text-transform:uppercase;color:#555;margin-bottom:8px;letter-spacing:1px">${grupo}</h2>
          <table style="width:100%;border-collapse:collapse;background:white;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1)">
            <thead style="background:#f0f0f0;font-size:11px;text-transform:uppercase;color:#777">
              <tr>
                <th style="padding:8px 12px;text-align:left">Tabela</th>
                <th style="padding:8px 12px;text-align:left">Chave Primária</th>
                <th style="padding:8px 12px;text-align:center;width:80px">Sincronizar</th>
                <th style="padding:8px 12px;text-align:left;width:80px">Status</th>
              </tr>
            </thead>
            <tbody>${linhas}</tbody>
          </table>
        </div>`;
    }).join('');

    res.send(html(`
      <style>
        .toggle-switch { position:relative; display:inline-block; width:42px; height:22px; }
        .toggle-switch input { opacity:0; width:0; height:0; }
        .slider { position:absolute; cursor:pointer; inset:0; background:#ccc; border-radius:22px; transition:.3s; }
        .slider:before { position:absolute; content:""; height:16px; width:16px; left:3px; bottom:3px; background:white; border-radius:50%; transition:.3s; }
        input:checked + .slider { background:#27ae60; }
        input:checked + .slider:before { transform:translateX(20px); }
      </style>
      <h1>Configurações de Tabelas</h1>
      <p style="margin-bottom:16px;font-size:13px;color:#666">
        Tabelas inativas são ignoradas nos ciclos de pull e push.
        A alteração tem efeito no próximo ciclo (sem necessidade de reiniciar).
        &nbsp;<strong style="color:#333">${totalAtivas}/${TABELAS.length}</strong> ativas.
      </p>
      <div style="margin-bottom:20px;display:flex;gap:8px">
        <button onclick="toggleTodos(true)"  style="padding:7px 16px;background:#27ae60;color:white;border:none;border-radius:4px;cursor:pointer;font-size:13px">Ativar todas</button>
        <button onclick="toggleTodos(false)" style="padding:7px 16px;background:#e74c3c;color:white;border:none;border-radius:4px;cursor:pointer;font-size:13px">Desativar todas</button>
      </div>
      ${secoes}
      <script>
        async function toggleTabela(tabela, ativo) {
          const el = document.getElementById('status-' + tabela);
          if (el) el.innerHTML = '<span style="color:#888">Salvando...</span>';
          try {
            const r = await fetch('/configuracoes/toggle', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ tabela, ativo })
            });
            const d = await r.json();
            if (d.ok && el) {
              el.innerHTML = '<span style="color:' + (ativo ? '#27ae60' : '#e74c3c') + ';font-weight:bold">' + (ativo ? 'Ativa' : 'Inativa') + '</span>';
            } else if (el) {
              el.innerHTML = '<span style="color:#e74c3c">Erro</span>';
            }
          } catch(e) {
            if (el) el.innerHTML = '<span style="color:#e74c3c">Erro de rede</span>';
          }
        }

        async function toggleTodos(ativo) {
          const r = await fetch('/configuracoes/toggle-todos', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ativo })
          });
          if ((await r.json()).ok) location.reload();
        }
      </script>
    `));
  });

  app.post('/configuracoes/toggle', (req, res) => {
    const { tabela, ativo } = req.body || {};
    if (!tabela || typeof ativo !== 'boolean') {
      return res.status(400).json({ ok: false, message: 'tabela e ativo (boolean) obrigatórios' });
    }
    if (!TABELAS.find(t => t.nome === tabela)) {
      return res.status(400).json({ ok: false, message: 'Tabela não encontrada' });
    }
    const config = lerConfig();
    if (ativo) {
      delete config[tabela]; // ausente = ativo (padrão), evita crescimento desnecessário do arquivo
    } else {
      config[tabela] = false;
    }
    salvarConfig(config);
    res.json({ ok: true, tabela, ativo });
  });

  app.post('/configuracoes/toggle-todos', (req, res) => {
    const { ativo } = req.body || {};
    if (typeof ativo !== 'boolean') {
      return res.status(400).json({ ok: false, message: 'ativo (boolean) obrigatório' });
    }
    const config = {};
    if (!ativo) {
      for (const t of TABELAS) config[t.nome] = false;
    }
    // ativo = true → arquivo vazio (todos ativos por padrão)
    salvarConfig(config);
    res.json({ ok: true, ativo });
  });

  app.listen(porta, () => {
    console.log(`[WEBUI] Interface de conflitos: http://localhost:${porta}`);
  });
}

module.exports = { iniciarWebUI };
