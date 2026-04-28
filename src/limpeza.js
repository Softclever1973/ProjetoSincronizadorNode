const { pool } = require('./db');

// Grupos de tabelas transacionais com política de retenção de 2 anos.
// Filhas devem vir antes do pai para respeitar FK constraints.
const GRUPOS_LIMPEZA = [
  {
    pai:       'PEDIDOS',
    colunaData: 'DATA_HORA',
    filhas: [
      { tabela: 'PEDIDOS_PARCELAS_PAGAMENTOS', fk: 'ID_PEDIDO' },
      { tabela: 'PEDIDOS_ITENS',               fk: 'ID_PEDIDO' },
    ],
  },
];

async function limparSchema(schemaName) {
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO ${schemaName}, public`);

    for (const grupo of GRUPOS_LIMPEZA) {
      for (const filha of grupo.filhas) {
        try {
          const r = await client.query(
            `DELETE FROM ${filha.tabela}
             WHERE ${filha.fk} IN (
               SELECT ${filha.fk} FROM ${grupo.pai}
               WHERE ${grupo.colunaData} IS NOT NULL
                 AND ${grupo.colunaData} < NOW() - INTERVAL '2 years'
             )`
          );
          if (r.rowCount > 0) {
            console.log(`[LIMPEZA][${schemaName}] ${filha.tabela}: ${r.rowCount} registro(s) antigo(s) removido(s)`);
          }
        } catch (e) {
          if (e.code !== '42P01' && e.code !== '42703') {
            console.error(`[LIMPEZA][${schemaName}] Erro em ${filha.tabela}: ${e.message}`);
          }
        }
      }

      try {
        const r = await client.query(
          `DELETE FROM ${grupo.pai}
           WHERE ${grupo.colunaData} IS NOT NULL
             AND ${grupo.colunaData} < NOW() - INTERVAL '2 years'`
        );
        if (r.rowCount > 0) {
          console.log(`[LIMPEZA][${schemaName}] ${grupo.pai}: ${r.rowCount} registro(s) antigo(s) removido(s)`);
        }
      } catch (e) {
        // 42P01 = tabela não existe | 42703 = coluna não existe — ambos são não-fatais
        if (e.code !== '42P01' && e.code !== '42703') {
          console.error(`[LIMPEZA][${schemaName}] Erro em ${grupo.pai}: ${e.message}`);
        }
      }
    }

    // Remove entradas antigas do log de deleções
    try {
      const r = await client.query(
        `DELETE FROM registros_deletados
         WHERE criado_em IS NOT NULL
           AND criado_em < NOW() - INTERVAL '2 years'`
      );
      if (r.rowCount > 0) {
        console.log(`[LIMPEZA][${schemaName}] REGISTROS_DELETADOS: ${r.rowCount} entrada(s) antiga(s) removida(s)`);
      }
    } catch (e) {
      if (e.code !== '42P01' && e.code !== '42703') {
        console.error(`[LIMPEZA][${schemaName}] Erro em REGISTROS_DELETADOS: ${e.message}`);
      }
    }
  } finally {
    await client.query('SET search_path TO public');
    client.release();
  }
}

async function limparTodosSchemas() {
  console.log('[LIMPEZA] Iniciando limpeza de registros com mais de 2 anos...');
  try {
    const result = await pool.query(
      'SELECT schema_name FROM public.sync_tenants WHERE ativo = TRUE'
    );
    for (const row of result.rows) {
      await limparSchema(row.schema_name);
    }
  } catch (e) {
    console.error(`[LIMPEZA] Erro geral: ${e.message}`);
  }
  console.log('[LIMPEZA] Limpeza concluída.');
}

const VINTE_QUATRO_HORAS_MS = 24 * 60 * 60 * 1000;

function agendarLimpeza() {
  setInterval(limparTodosSchemas, VINTE_QUATRO_HORAS_MS);
  console.log('[LIMPEZA] Limpeza de registros antigos agendada (a cada 24h).');
}

module.exports = { agendarLimpeza, limparTodosSchemas };
