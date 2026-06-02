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

async function enfileirarTodosRegistros(db, log, onProgresso = null, tabelasFiltro = null) {
  const lista = tabelasFiltro && tabelasFiltro.length > 0
    ? TABELAS.filter(t => tabelasFiltro.includes(t.nome))
    : TABELAS;
  const total = lista.length;
  let totalEnfileirados = 0;

  for (let i = 0; i < total; i++) {
    const tabela = lista[i];
    let enfileiradosNaTabela = 0;

    if (!(await tabelaExiste(db, tabela.nome))) {
      log(`[SETUP] Tabela ${tabela.nome} não existe — pulando enfileiramento`);
    } else {
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
        enfileiradosNaTabela = Number(cnt[0]?.CNT || 0);
        if (enfileiradosNaTabela > 0) {
          log(`[SETUP] ${tabela.nome}: ${enfileiradosNaTabela} registro(s) enfileirado(s)`);
          totalEnfileirados += enfileiradosNaTabela;
        }
      } catch (e) {
        log(`[SETUP] Aviso: não foi possível enfileirar ${tabela.nome}: ${e.message}`);
      }
    }

    if (onProgresso) {
      onProgresso({ processadas: i + 1, total, tabela: tabela.nome, enfileiradosNaTabela, totalEnfileirados, porcentagem: Math.round(((i + 1) / total) * 100) });
    }
  }

  log(`[SETUP] Total enfileirado para envio: ${totalEnfileirados} registro(s)`);
  return totalEnfileirados;
}

/**
 * Cria a infraestrutura de sync bidirecional no banco da filial.
 * Ao detectar troca de empresa (token diferente do armazenado em SYNC_CONFIG),
 * limpa todos os pendentes e cursores para que nenhum dado da empresa anterior
 * seja enviado ao novo servidor. O envio inicial é 100% manual via botão
 * "Forçar Carga Inicial" em http://localhost:3001/configuracoes.
 */
async function setup(db, log = console.log, token = null) {
  // 1. Generator e tabela de cursores de sync (ULTIMOS_REGISTROS_MATRIZ)
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

  // 3. Config interna — armazena o token para detectar troca de empresa
  if (!(await tabelaExiste(db, 'SYNC_CONFIG'))) {
    await execute(db, `
      CREATE TABLE SYNC_CONFIG (
        CHAVE VARCHAR(50)  NOT NULL PRIMARY KEY,
        VALOR VARCHAR(500)
      )
    `);
    log('[SETUP] Tabela SYNC_CONFIG criada');
  }

  // 4. Tabela de pendentes de envio ao servidor
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

  // 5. Tabela que rastreia a última versão recebida do servidor por registro
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

  // 6. Detecta troca de empresa — ao mudar o token, limpa tudo para que nenhum
  //    dado da empresa anterior chegue ao novo servidor. O envio inicial fica
  //    a cargo do operador via botão "Forçar Carga Inicial".
  if (token) {
    const configRows = await query(db,
      `SELECT VALOR FROM SYNC_CONFIG WHERE CHAVE = 'SYNC_TOKEN'`
    ).catch(() => []);
    const tokenArmazenado = configRows.length > 0 ? (configRows[0].VALOR || '').trim() : null;

    if (tokenArmazenado !== token) {
      log('[SETUP] Token alterado — limpando pendentes da empresa anterior...');
      await execute(db, `DELETE FROM SYNC_ALTERACOES_PENDENTES`).catch(() => {});
      await execute(db, `DELETE FROM SYNC_VERSOES_SERVIDOR`).catch(() => {});
      await execute(db,
        `UPDATE ULTIMOS_REGISTROS_MATRIZ SET ULTIMO_REGISTRO_ATUALIZADO = 0, ULTIMO_REGISTRO_DELETADO = 0`
      ).catch(() => {});
      await execute(db, `DELETE FROM SYNC_ERROS`).catch(() => {});
      try { require('./conflitos').clearConflitos(); } catch {}
      log('[SETUP] Pendentes limpos. Use "Forçar Carga Inicial" na web UI para enviar os dados.');

      await execute(db,
        `UPDATE OR INSERT INTO SYNC_CONFIG (CHAVE, VALOR) VALUES ('SYNC_TOKEN', ?) MATCHING (CHAVE)`,
        [token]
      ).catch(() => {});
    }
  }

  // 7. Triggers em cada tabela para detectar alterações locais
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

  // 8. Coluna SRV_ID e índice nas tabelas onde a filial cria registros localmente
  for (const t of TABELAS.filter(t => t.srvId && t.generator)) {
    if (!(await tabelaExiste(db, t.nome))) continue;

    try {
      const colRows = await query(db,
        `SELECT COUNT(*) AS CNT FROM RDB$RELATION_FIELDS
         WHERE TRIM(RDB$RELATION_NAME) = ? AND TRIM(RDB$FIELD_NAME) = ?`,
        [t.nome, 'SRV_ID']
      );
      if ((colRows[0].CNT || 0) === 0) {
        await execute(db, `ALTER TABLE ${t.nome} ADD SRV_ID INTEGER`);
        log(`[SETUP] ${t.nome}: coluna SRV_ID adicionada`);
      }
    } catch (e) {
      log(`[SETUP] Aviso: não foi possível adicionar SRV_ID em ${t.nome}: ${e.message}`);
    }

    try {
      const idxNome = ('IDX_' + t.nome + '_SRV_ID').substring(0, 31);
      const idxRows = await query(db,
        `SELECT COUNT(*) AS CNT FROM RDB$INDICES WHERE TRIM(RDB$INDEX_NAME) = ?`,
        [idxNome]
      );
      if ((idxRows[0].CNT || 0) === 0) {
        await execute(db, `CREATE INDEX ${idxNome} ON ${t.nome} (SRV_ID)`);
        log(`[SETUP] ${t.nome}: índice ${idxNome} criado`);
      }
    } catch (e) {
      log(`[SETUP] Aviso: não foi possível criar índice SRV_ID em ${t.nome}: ${e.message}`);
    }
  }

  log('[SETUP] Infraestrutura de sync bidirecional pronta');
}

/**
 * Enfileira os últimos `limite` registros de cada tabela para push ao servidor.
 * Diferente da carga inicial completa, preserva cursores de pull e SYNC_VERSOES_SERVIDOR.
 * Útil para sincronizar um subconjunto recente sem refazer tudo do zero.
 */
async function enfileirarRegistrosParcial(db, limite, log, tabelasFiltro = null) {
  const lista = tabelasFiltro && tabelasFiltro.length > 0
    ? TABELAS.filter(t => tabelasFiltro.includes(t.nome))
    : TABELAS;

  let totalEnfileirados = 0;
  const resumo = [];

  for (const tabela of lista) {
    if (!(await tabelaExiste(db, tabela.nome))) {
      log(`[SETUP] Tabela ${tabela.nome} não existe — pulando`);
      continue;
    }

    const pks = Array.isArray(tabela.pk) ? tabela.pk : [tabela.pk];
    const pkPrincipal = pks[0];
    const pkExpressao = pks.map(p => `CAST(${p} AS VARCHAR(100))`).join(" || '|' || ");

    try {
      await execute(db,
        `DELETE FROM SYNC_ALTERACOES_PENDENTES WHERE NOME_TABELA = ?`,
        [tabela.nome]
      ).catch(() => {});

      await execute(db,
        `INSERT INTO SYNC_ALTERACOES_PENDENTES (NOME_TABELA, PK_VALOR, TIMESTAMP_ALTERACAO)
         SELECT '${tabela.nome}', ${pkExpressao}, CURRENT_TIMESTAMP
         FROM (SELECT FIRST ${limite} * FROM ${tabela.nome} ORDER BY ${pkPrincipal} DESC) AS T`
      );

      const cnt = await query(db,
        `SELECT COUNT(*) AS CNT FROM SYNC_ALTERACOES_PENDENTES WHERE NOME_TABELA = ?`,
        [tabela.nome]
      );
      const n = Number(cnt[0]?.CNT || 0);
      totalEnfileirados += n;
      resumo.push({ tabela: tabela.nome, enfileirados: n });
      if (n > 0) log(`[SETUP] ${tabela.nome}: ${n} registro(s) enfileirado(s) (últimos ${limite})`);
    } catch (e) {
      log(`[SETUP] Aviso: não foi possível enfileirar ${tabela.nome}: ${e.message}`);
      resumo.push({ tabela: tabela.nome, enfileirados: 0, erro: e.message });
    }
  }

  log(`[SETUP] Carga parcial: ${totalEnfileirados} registro(s) enfileirado(s) no total`);
  return { totalEnfileirados, resumo };
}

module.exports = { setup, enfileirarTodosRegistros, enfileirarRegistrosParcial };
