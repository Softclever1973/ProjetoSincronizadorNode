const { query, execute } = require('../db');
const { chaveNegocioTabela } = require('../../domain/schema');

// Colunas que o servidor gerencia internamente — não devem ser sobrescritas pela filial
// nem viram coluna numa tabela criada automaticamente (ver criarTabelaSeNecessario).
const COLUNAS_IGNORADAS_SERVIDOR = new Set([
  'ID_ULTIMA_ATUALIZACAO_MATRIZ',
  'ID_ULTIMA_ATUALIZACAO_WEB',
  'SRV_ID', // rastreado em srv_id_map; não existe como coluna nas tabelas do servidor
]);

/**
 * Retorna as colunas de uma tabela consultando o information_schema do PostgreSQL.
 * Chaves normalizadas para UPPERCASE (padrão do projeto).
 *
 * @param {import('pg').PoolClient} db
 * @param {string} schema
 * @param {string} tabela
 * @returns {Promise<Array<{ COLUMN_NAME: string, DATA_TYPE: string, IS_GENERATED: string, CHARACTER_MAXIMUM_LENGTH: number|null }>>}
 */
async function colunasTabela(db, schema, tabela) {
  return query(db, `
    SELECT
      UPPER(column_name) AS column_name,
      data_type,
      CASE WHEN is_generated = 'ALWAYS' THEN 'ALWAYS' ELSE '' END AS is_generated,
      character_maximum_length
    FROM information_schema.columns
    WHERE table_schema = $1 AND LOWER(table_name) = LOWER($2)
    ORDER BY ordinal_position
  `, [schema, tabela]);
}

/**
 * Cria a tabela no schema do tenant a partir de uma lista de colunas já tipadas.
 * Chamado quando ReceberRegistro ou o CRUD genérico da web (crud.js) encontram
 * colunasServidor vazio (tabela inexistente — tipos inferidos do primeiro registro via
 * colunasTipadasDeRegistro), e por GarantirTabela (tabela vazia na filial — sem registro
 * real, tipos vêm da introspecção do Firebird feita pelo cliente).
 * colunasTipadas: [{ nome, tipoPg }, ...].
 *
 * @param {import('pg').PoolClient} db
 * @param {string} nomeTabela
 * @param {string} schemaName
 * @param {Array<{ nome: string, tipoPg: string }>} colunasTipadas
 * @param {string[]} pks
 * @param {boolean} [useSrvId]
 */
async function criarTabelaSeNecessario(db, nomeTabela, schemaName, colunasTipadas, pks, useSrvId = false) {
  const pkSet = new Set(Array.isArray(pks) ? pks : [pks]);
  const colunasTipadasFiltradas = colunasTipadas.filter(({ nome }) => !COLUNAS_IGNORADAS_SERVIDOR.has(nome));
  const colunas = colunasTipadasFiltradas
    .map(({ nome, tipoPg }) => `${nome} ${tipoPg}${pkSet.has(nome) && !useSrvId ? ' NOT NULL' : ''}`);
  if (!colunasTipadas.some(c => c.nome === 'ID_ULTIMA_ATUALIZACAO_MATRIZ')) {
    colunas.push('ID_ULTIMA_ATUALIZACAO_MATRIZ INTEGER');
  }
  if (useSrvId) {
    colunas.unshift('SRV_ID INTEGER NOT NULL');
    await execute(db,
      `CREATE TABLE IF NOT EXISTS ${nomeTabela} (${colunas.join(', ')}, PRIMARY KEY (SRV_ID))`
    );
    // Garante que as chaves de negócio do Firebird sejam únicas no servidor,
    // impedindo duplicatas caso o srv_id_map perca a entrada e o registro seja re-inserido.
    const chaveNegocio = chaveNegocioTabela(pks, new Set(colunasTipadas.map(c => c.nome)));
    if (chaveNegocio.length > 0) {
      await execute(db,
        `ALTER TABLE ${nomeTabela} ADD CONSTRAINT uq_${nomeTabela.toLowerCase()}_bk UNIQUE (${chaveNegocio.join(', ')})`
      ).catch(e => { if (e.code !== '42710' && e.code !== '42P07') throw e; }); // 42710 = duplicate_object, 42P07 = índice de mesmo nome já existe
    }
  } else {
    await execute(db,
      `CREATE TABLE IF NOT EXISTS ${nomeTabela} (${colunas.join(', ')}, PRIMARY KEY (${[...pkSet].join(', ')}))`
    );
  }
  const triggerName = `tg_${nomeTabela.toLowerCase()}_seq`;
  await execute(db, `DROP TRIGGER IF EXISTS ${triggerName} ON ${nomeTabela}`);
  await execute(db, `
    CREATE TRIGGER ${triggerName}
    BEFORE INSERT OR UPDATE ON ${nomeTabela}
    FOR EACH ROW EXECUTE FUNCTION ${schemaName}.fn_seq_atualizacao()
  `);
  const delTriggerName = `tg_${nomeTabela.toLowerCase()}_del`;
  await execute(db, `DROP TRIGGER IF EXISTS ${delTriggerName} ON ${nomeTabela}`);
  await execute(db, `
    CREATE TRIGGER ${delTriggerName}
    AFTER DELETE ON ${nomeTabela}
    FOR EACH ROW EXECUTE FUNCTION ${schemaName}.fn_registrar_delecao()
  `);
  console.log(`[${schemaName}] Tabela '${nomeTabela}' criada automaticamente via carga inicial.`);
}

module.exports = { colunasTabela, criarTabelaSeNecessario, COLUNAS_IGNORADAS_SERVIDOR };
