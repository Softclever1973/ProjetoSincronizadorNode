const { getConnection, closeConnection, execute } = require('./db');

// Grupos de tabelas transacionais — filhas antes do pai (respeita FK no Firebird)
const GRUPOS_LIMPEZA = [
  {
    pai:        'PEDIDOS',
    colunaData: 'DATA_HORA',
    filhas: [
      { tabela: 'PEDIDOS_PARCELAS_PAGAMENTOS', fk: 'ID_PEDIDO' },
      { tabela: 'PEDIDOS_ITENS',               fk: 'ID_PEDIDO' },
    ],
  },
];

function dataLimite() {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 2);
  return d;
}

async function limparRegistrosAntigos(log = console.log) {
  const limite = dataLimite();
  log('[LIMPEZA] Iniciando limpeza de registros com mais de 2 anos...');

  const db = await getConnection();
  try {
    for (const grupo of GRUPOS_LIMPEZA) {
      for (const filha of grupo.filhas) {
        try {
          await execute(db,
            `DELETE FROM ${filha.tabela}
             WHERE ${filha.fk} IN (
               SELECT ${filha.fk} FROM ${grupo.pai}
               WHERE ${grupo.colunaData} IS NOT NULL
                 AND ${grupo.colunaData} < ?
             )`,
            [limite]
          );
          log(`[LIMPEZA] ${filha.tabela}: registros antigos removidos`);
        } catch (e) {
          log(`[LIMPEZA] Aviso ${filha.tabela}: ${e.message}`);
        }
      }

      try {
        await execute(db,
          `DELETE FROM ${grupo.pai}
           WHERE ${grupo.colunaData} IS NOT NULL
             AND ${grupo.colunaData} < ?`,
          [limite]
        );
        log(`[LIMPEZA] ${grupo.pai}: registros antigos removidos`);
      } catch (e) {
        log(`[LIMPEZA] Aviso ${grupo.pai}: ${e.message}`);
      }
    }

    // Limpa erros de sync com mais de 2 anos
    try {
      await execute(db,
        'DELETE FROM SYNC_ERROS WHERE CRIADO_EM IS NOT NULL AND CRIADO_EM < ?',
        [limite]
      );
    } catch (e) {
      log(`[LIMPEZA] Aviso SYNC_ERROS: ${e.message}`);
    }

    // Remove pendentes de envio que ficaram presos por mais de 2 anos
    try {
      await execute(db,
        'DELETE FROM SYNC_ALTERACOES_PENDENTES WHERE TIMESTAMP_ALTERACAO IS NOT NULL AND TIMESTAMP_ALTERACAO < ?',
        [limite]
      );
    } catch (e) {
      log(`[LIMPEZA] Aviso SYNC_ALTERACOES_PENDENTES: ${e.message}`);
    }
  } finally {
    await closeConnection(db);
  }

  log('[LIMPEZA] Limpeza concluída.');
}

module.exports = { limparRegistrosAntigos };
