const { query, execute, tabelaExiste } = require('./db');
const TABELAS = require('./tabelas');

async function generatorExiste(db, nome) {
  const rows = await query(
    db,
    `SELECT COUNT(*) AS CNT FROM RDB$GENERATORS WHERE TRIM(RDB$GENERATOR_NAME) = ?`,
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
  // 1. Generator e tabela de cursores de sync (ULTIMOS_REGISTROS_MATRIZ)
  //    Existiam no banco Delphi pré-existente; criados aqui para instalações novas.
  if (!(await generatorExiste(db, 'NOVO_ULTIMOS_REGISTROS_MATRIZ'))) {
    await execute(db, 'CREATE SEQUENCE NOVO_ULTIMOS_REGISTROS_MATRIZ');
    log('[SETUP] Generator NOVO_ULTIMOS_REGISTROS_MATRIZ criado');
  }

  if (!(await tabelaExiste(db, 'ULTIMOS_REGISTROS_MATRIZ'))) {
    await execute(db, `
      CREATE TABLE ULTIMOS_REGISTROS_MATRIZ (
        ID_ULTIMO_REGISTRO_MATRIZ  INTEGER      NOT NULL PRIMARY KEY,
        NOME_TABELA                VARCHAR(50)  NOT NULL UNIQUE,
        ULTIMO_REGISTRO_ATUALIZADO INTEGER      DEFAULT 0 NOT NULL,
        ULTIMO_REGISTRO_DELETADO   INTEGER      DEFAULT 0 NOT NULL
      )
    `);
    log('[SETUP] Tabela ULTIMOS_REGISTROS_MATRIZ criada');
  }

  // 2. Tabela de erros de sincronização
  if (!(await tabelaExiste(db, 'SYNC_ERROS'))) {
    await execute(db, `
      CREATE TABLE SYNC_ERROS (
        ID           VARCHAR(40)   NOT NULL PRIMARY KEY,
        TABELA       VARCHAR(50),
        OPERACAO     VARCHAR(20),
        MENSAGEM     VARCHAR(2000) NOT NULL,
        CRIADO_EM    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP NOT NULL
      )
    `);
    log('[SETUP] Tabela SYNC_ERROS criada');
  }

  // 3. Tabela de pendentes de envio ao servidor
  const primeiraInstalacao = !(await tabelaExiste(db, 'SYNC_ALTERACOES_PENDENTES'));
  if (primeiraInstalacao) {
    await execute(db, `
      CREATE TABLE SYNC_ALTERACOES_PENDENTES (
        NOME_TABELA         VARCHAR(50)  NOT NULL,
        PK_VALOR            VARCHAR(250) NOT NULL,
        TIMESTAMP_ALTERACAO TIMESTAMP    DEFAULT CURRENT_TIMESTAMP NOT NULL,
        PRIMARY KEY (NOME_TABELA, PK_VALOR)
      )
    `);
    log('[SETUP] Tabela SYNC_ALTERACOES_PENDENTES criada');

    // Enfileira todos os registros existentes para envio inicial ao servidor.
    // Feito aqui (antes de criar os triggers) para evitar colisão de PK.
    log('[SETUP] Primeira instalação — enfileirando registros existentes para envio inicial...');
    let totalEnfileirados = 0;
    for (const tabela of TABELAS) {
      if (!(await tabelaExiste(db, tabela.nome))) {
        log(`[SETUP] Tabela ${tabela.nome} não existe — pulando enfileiramento inicial`);
        continue;
      }

      const pks = Array.isArray(tabela.pk) ? tabela.pk : [tabela.pk];
      const pkExpressao = pks.map(p => `CAST(${p} AS VARCHAR(100))`).join(" || '|' || ");
      try {
        await execute(db,
          `INSERT INTO SYNC_ALTERACOES_PENDENTES (NOME_TABELA, PK_VALOR, TIMESTAMP_ALTERACAO)
           SELECT '${tabela.nome}', ${pkExpressao}, CURRENT_TIMESTAMP FROM ${tabela.nome}`
        );
        const cnt = await query(db,
          `SELECT COUNT(*) AS CNT FROM SYNC_ALTERACOES_PENDENTES WHERE NOME_TABELA = ?`,
          [tabela.nome]
        );
        const n = Number(cnt[0]?.CNT || 0);
        if (n > 0) {
          log(`[SETUP] ${tabela.nome}: ${n} registro(s) enfileirado(s)`);
          totalEnfileirados += n;
        }
      } catch (e) {
        log(`[SETUP] Aviso: não foi possível enfileirar ${tabela.nome}: ${e.message}`);
      }
    }
    log(`[SETUP] Total enfileirado para envio inicial: ${totalEnfileirados} registro(s)`);
  }

  // 4. Tabela que rastreia a última versão recebida do servidor por registro
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

  // 5. Triggers em cada tabela para detectar alterações locais
  for (const tabela of TABELAS) {
    if (!(await tabelaExiste(db, tabela.nome))) {
      log(`[SETUP] Tabela ${tabela.nome} não existe — pulando trigger`);
      continue;
    }

    const pks = Array.isArray(tabela.pk) ? tabela.pk : [tabela.pk];
    const pkExpressaoNEW = pks.map(p => `CAST(NEW.${p} AS VARCHAR(100))`).join(" || '|' || ");
    const pkExpressaoOLD = pks.map(p => `CAST(OLD.${p} AS VARCHAR(100))`).join(" || '|' || ");

    // Nomes de trigger no Firebird têm limite de 31 caracteres
    const triggerNome = `SYNC_${tabela.nome}`.substring(0, 31);

    // RECREATE TRIGGER recria silenciosamente se já existir (Firebird 3+),
    // garantindo que instalações existentes recebam suporte a DELETE.
    const sql = `
      RECREATE TRIGGER ${triggerNome} AFTER INSERT OR UPDATE OR DELETE ON ${tabela.nome}
      AS
      DECLARE VARIABLE v_pk VARCHAR(250);
      BEGIN
        IF (RDB$GET_CONTEXT('USER_SESSION', 'SYNC_SKIP') IS NULL) THEN
        BEGIN
          IF (DELETING) THEN
            v_pk = ${pkExpressaoOLD};
          ELSE
            v_pk = ${pkExpressaoNEW};
          UPDATE OR INSERT INTO SYNC_ALTERACOES_PENDENTES
            (NOME_TABELA, PK_VALOR, TIMESTAMP_ALTERACAO)
          VALUES
            ('${tabela.nome}', :v_pk, CURRENT_TIMESTAMP)
          MATCHING (NOME_TABELA, PK_VALOR);
        END
      END
    `;

    try {
      await execute(db, sql);
      log(`[SETUP] Trigger ${triggerNome} atualizada (${tabela.nome})`);
    } catch (e) {
      log(`[SETUP] Aviso: não foi possível atualizar trigger ${triggerNome}: ${e.message}`);
    }
  }

  log('[SETUP] Infraestrutura de sync bidirecional pronta');
}

module.exports = { setup };
