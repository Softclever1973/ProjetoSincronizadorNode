const EventEmitter = require('events');
const { query, execute, tabelaExiste } = require('./db');
const { verificarStatusReset } = require('./http');
const TABELAS = require('./domain/tabelas');

// Emite 'novo-reset-pendente' quando o servidor sinaliza um reset ainda não aplicado localmente — consumido pelo SSE em webui.js.
const emitter = new EventEmitter();

// Compara em segundos — o valor viaja Postgres -> JSON -> Firebird TIMESTAMP e volta com precisão diferente em cada etapa.
function normalizar(valor) {
  if (!valor) return null;
  const t = new Date(valor).getTime();
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

async function lerBaseline(db) {
  const rows = await query(db, 'SELECT ULTIMO_RESET_CONHECIDO FROM SYNC_RESET_STATUS WHERE ID = 1');
  return rows.length > 0 ? rows[0].ULTIMO_RESET_CONHECIDO : undefined; // undefined = nunca checado
}

async function gravarBaseline(db, valor) {
  // node-firebird espera um Date de verdade em TIMESTAMP — a string ISO do JSON precisa ser convertida, não passada crua.
  await execute(
    db,
    'UPDATE OR INSERT INTO SYNC_RESET_STATUS (ID, ULTIMO_RESET_CONHECIDO) VALUES (1, ?) MATCHING (ID)',
    [new Date(valor)]
  );
}

async function verificarResetServidor(db, baseURI, contextoSync, log) {
  const { resetado_em: resetadoEm } = await verificarStatusReset(baseURI);
  if (!resetadoEm) return; // tenant nunca foi resetado

  const baseline = await lerBaseline(db);
  if (baseline === undefined) {
    // 1ª checagem desde que este recurso existe — sem isso, resets antigos já resolvidos manualmente disparariam alarme falso.
    await gravarBaseline(db, resetadoEm);
    log('[Reset] baseline inicial gravado, sem alerta.');
    return;
  }
  if (normalizar(baseline) === normalizar(resetadoEm)) {
    contextoSync.resetPendente = null;
    return;
  }
  if (contextoSync.resetPendente && normalizar(contextoSync.resetPendente.resetadoEm) === normalizar(resetadoEm)) {
    return; // já emitido pra este valor, não repete a cada ciclo
  }
  contextoSync.resetPendente = { resetadoEm };
  log(`[Reset] servidor foi resetado em ${resetadoEm} — pendente de limpeza local.`);
  emitter.emit('novo-reset-pendente', contextoSync.resetPendente);
}

async function aplicarResetLocal(db, baseURI, log = () => {}) {
  // Refaz a consulta ao servidor — fecha a corrida entre a última checagem do ciclo e o clique.
  const { resetado_em: resetadoEm } = await verificarStatusReset(baseURI);
  log(`[Reset] aplicando limpeza local pro reset de ${resetadoEm}...`);

  const passos = [
    'DELETE FROM SYNC_ALTERACOES_PENDENTES',
    'DELETE FROM SYNC_VERSOES_SERVIDOR',
    'DELETE FROM SYNC_ERROS',
    'UPDATE ULTIMOS_REGISTROS_MATRIZ SET ULTIMO_REGISTRO_ATUALIZADO = 0, ULTIMO_REGISTRO_DELETADO = 0',
  ];
  for (const sql of passos) {
    try { await execute(db, sql); } catch (e) { log(`[Reset] aviso: ${sql} falhou: ${e.message}`); }
  }
  for (const nomeTabela of TABELAS.filter(t => t.srvId).map(t => t.nome)) {
    if (!(await tabelaExiste(db, nomeTabela))) continue;
    try {
      await execute(db, `UPDATE ${nomeTabela} SET SRV_ID = NULL WHERE SRV_ID IS NOT NULL`);
    } catch (e) { log(`[Reset] aviso: SRV_ID de ${nomeTabela} não foi limpo: ${e.message}`); }
  }

  await gravarBaseline(db, resetadoEm); // propaga erro — se falhar, banner continua até novo clique
  log(`[Reset] limpeza local concluída, baseline atualizado para ${resetadoEm}.`);
  return { ok: true, resetadoEm };
}

module.exports = { verificarResetServidor, aplicarResetLocal, emitter };
