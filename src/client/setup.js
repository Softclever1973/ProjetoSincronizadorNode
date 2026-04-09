const { query, execute } = require('./db');
const TABELAS = require('./tabelas');

async function tabelaExiste(db, nome) {
  const rows = await query(
    db,
    `SELECT COUNT(*) AS CNT FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?`,
    [nome]
  );
  return (rows[0].CNT || 0) > 0;
}

async function triggerExiste(db, nome) {
  const rows = await query(
    db,
    `SELECT COUNT(*) AS CNT FROM RDB$TRIGGERS WHERE TRIM(RDB$TRIGGER_NAME) = ?`,
    [nome]
  );
  return (rows[0].CNT || 0) > 0;
}

/**
 * Cria a infraestrutura de sync bidirecional no banco da filial:
 *   - SYNC_ALTERACOES_PENDENTES: registros modificados localmente aguardando envio
 *   - SYNC_VERSOES_SERVIDOR: última versão conhecida do servidor por registro
 *   - Triggers AFTER INSERT OR UPDATE em cada tabela sincronizada
 */
async function setup(db, log = console.log) {
  // 1. Tabela de pendentes de envio ao servidor
  if (!(await tabelaExiste(db, 'SYNC_ALTERACOES_PENDENTES'))) {
    await execute(db, `
      CREATE TABLE SYNC_ALTERACOES_PENDENTES (
        NOME_TABELA         VARCHAR(50)  NOT NULL,
        PK_VALOR            VARCHAR(250) NOT NULL,
        TIMESTAMP_ALTERACAO TIMESTAMP    DEFAULT CURRENT_TIMESTAMP NOT NULL,
        PRIMARY KEY (NOME_TABELA, PK_VALOR)
      )
    `);
    log('[SETUP] Tabela SYNC_ALTERACOES_PENDENTES criada');
  }

  // 2. Tabela que rastreia a última versão recebida do servidor por registro
  //    (usada para detectar conflito na hora do envio)
  if (!(await tabelaExiste(db, 'SYNC_VERSOES_SERVIDOR'))) {
    await execute(db, `
      CREATE TABLE SYNC_VERSOES_SERVIDOR (
        NOME_TABELA                  VARCHAR(50)  NOT NULL,
        PK_VALOR                     VARCHAR(250) NOT NULL,
        ID_ULTIMA_ATUALIZACAO_MATRIZ INTEGER      NOT NULL,
        PRIMARY KEY (NOME_TABELA, PK_VALOR)
      )
    `);
    log('[SETUP] Tabela SYNC_VERSOES_SERVIDOR criada');
  }

  // 3. Triggers em cada tabela para detectar alterações locais
  for (const tabela of TABELAS) {
    const pks = Array.isArray(tabela.pk) ? tabela.pk : [tabela.pk];
    const pkExpressao = pks.map(p => `CAST(NEW.${p} AS VARCHAR(100))`).join(" || '|' || ");

    // Nomes de trigger no Firebird têm limite de 31 caracteres
    const triggerNome = `SYNC_${tabela.nome}`.substring(0, 31);

    if (await triggerExiste(db, triggerNome)) continue;

    const sql = `
      CREATE TRIGGER ${triggerNome} AFTER INSERT OR UPDATE ON ${tabela.nome}
      AS BEGIN
        IF (RDB$GET_CONTEXT('USER_SESSION', 'SYNC_SKIP') IS NULL) THEN
          UPDATE OR INSERT INTO SYNC_ALTERACOES_PENDENTES
            (NOME_TABELA, PK_VALOR, TIMESTAMP_ALTERACAO)
          VALUES
            ('${tabela.nome}', ${pkExpressao}, CURRENT_TIMESTAMP)
          MATCHING (NOME_TABELA, PK_VALOR);
      END
    `;

    try {
      await execute(db, sql);
      log(`[SETUP] Trigger ${triggerNome} criada (${tabela.nome})`);
    } catch (e) {
      log(`[SETUP] Aviso: não foi possível criar trigger ${triggerNome}: ${e.message}`);
    }
  }

  log('[SETUP] Infraestrutura de sync bidirecional pronta');
}

module.exports = { setup };
