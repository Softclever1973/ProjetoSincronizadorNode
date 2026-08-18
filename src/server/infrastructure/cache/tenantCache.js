const { query } = require('../db');

/**
 * Cache de metadados de tabela por tenant (chave `schema:tabela`), para as 3 introspecções
 * (colunas existentes, colunas computadas, colunas da PK) que sempre precisavam ser
 * invalidadas em conjunto quando a estrutura de uma tabela muda — antes eram 3 dicts
 * separados, repetindo o mesmo trio de `delete` em ~4 pontos espalhados do arquivo.
 */
function criarTenantCache(tipos) {
  const stores = Object.fromEntries(tipos.map(t => [t, {}]));
  const key = (schema, tabela) => `${schema}:${tabela}`;

  return {
    get(schema, tabela, tipo) {
      return stores[tipo][key(schema, tabela)];
    },
    set(schema, tabela, tipo, valor) {
      stores[tipo][key(schema, tabela)] = valor;
      return valor;
    },
    // tiposParaLimpar: por padrão invalida todos os tipos; passe um subconjunto pra
    // preservar algum (ex.: migração de coluna isolada que não muda colunas computadas).
    invalidate(schema, tabela, tiposParaLimpar = tipos) {
      const k = key(schema, tabela);
      for (const tipo of tiposParaLimpar) delete stores[tipo][k];
    },
  };
}

const colunasCache = criarTenantCache(['colunas', 'pk', 'computadas']);

// Cache de sequences por-tabela já criadas nesta execução do servidor.
// Evita DDL (CREATE SEQUENCE IF NOT EXISTS) em toda requisição de push.
const seqsSrvIdInicializadas = new Set();

// Cache de tabelas que já receberam a UNIQUE constraint nas chaves de negócio.
// Evita DDL repetido em cada push após a constraint já existir.
const constraintsUqAdicionadas = new Set();

async function getColunasServidor(db, nomeTabela, schemaName) {
  const cached = colunasCache.get(schemaName, nomeTabela, 'colunas');
  if (cached) return cached;
  const rows = await query(db,
    `SELECT column_name AS "COLUNA"
     FROM information_schema.columns
     WHERE table_name = lower($1) AND table_schema = lower($2)`,
    [nomeTabela, schemaName]
  );
  return colunasCache.set(schemaName, nomeTabela, 'colunas', new Set(rows.map(r => (r.COLUNA || '').trim().toUpperCase())));
}

/**
 * Retorna as colunas que compõem a PRIMARY KEY real da tabela no PostgreSQL.
 * Para tabelas srvId criadas pelo servidor, isso retorna ['SRV_ID'].
 * Para tabelas legadas (PK original), retorna as colunas da PK Firebird.
 * Resultado cacheado por schema:tabela — invalidado junto com o cache de colunas (mesma
 * TenantCache, tipo 'pk').
 */
async function getPkServidor(db, nomeTabela, schemaName) {
  const cached = colunasCache.get(schemaName, nomeTabela, 'pk');
  if (cached) return cached;
  const rows = await query(db,
    `SELECT kcu.column_name AS "COLUNA"
     FROM information_schema.key_column_usage kcu
     JOIN information_schema.table_constraints tc
       ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema    = kcu.table_schema
      AND tc.table_name      = kcu.table_name
     WHERE kcu.table_schema  = lower($1)
       AND kcu.table_name    = lower($2)
       AND tc.constraint_type = 'PRIMARY KEY'
     ORDER BY kcu.ordinal_position`,
    [schemaName, nomeTabela]
  );
  const pkCols = rows.map(r => (r.COLUNA || '').trim().toUpperCase());
  return colunasCache.set(schemaName, nomeTabela, 'pk', pkCols.length > 0 ? pkCols : null);
}

async function getColunasComputadas(db, nomeTabela, schemaName) {
  const cached = colunasCache.get(schemaName, nomeTabela, 'computadas');
  if (cached) return cached;
  const rows = await query(db,
    `SELECT column_name AS "COLUNA"
     FROM information_schema.columns
     WHERE table_name = lower($1)
       AND table_schema = lower($2)
       AND is_generated = 'ALWAYS'`,
    [nomeTabela, schemaName]
  );
  return colunasCache.set(schemaName, nomeTabela, 'computadas', new Set(rows.map(r => (r.COLUNA || '').trim().toUpperCase())));
}

module.exports = {
  criarTenantCache,
  colunasCache,
  seqsSrvIdInicializadas,
  constraintsUqAdicionadas,
  getColunasServidor,
  getPkServidor,
  getColunasComputadas,
};
