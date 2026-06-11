const { execute, query } = require('./db');
const { getUltimaAtualizacao, getUltimaDelecao, salvarCursor } = require('./cursor');
const { consumirEcho } = require('./echos');
const {
  buscarRegistrosParaAtualizar,
  buscarRegistrosParaDeletar,
  buscarProdutosParaAtualizar,
} = require('./http');
const { salvarConflito } = require('./conflitos');
const { getFKRefs, gerarNovoPK, renomearPKLocal } = require('./db-utils');

// Cache de colunas computadas (read-only) por tabela — evita consultar toda vez
const cacheColunasComputadas = {};

// Cache de colunas existentes por tabela — evita falha em UPSERT quando o servidor
// tem colunas que ainda não foram adicionadas ao schema Firebird da filial
const cacheColunasExistentes = {};

// Cache de colunas NOT NULL por tabela — evita escrever null em coluna com constraint
const cacheColunasNaoNulas = {};

// Cache de tamanhos de todas as colunas string de uma tabela (query única por tabela)
const cacheTamanhosPorTabela = {};

async function getTamanhosColunas(db, nomeTabela) {
  if (cacheTamanhosPorTabela[nomeTabela]) return cacheTamanhosPorTabela[nomeTabela];
  const rows = await query(db, `
    SELECT TRIM(rf.RDB$FIELD_NAME) AS COLUNA, f.RDB$CHARACTER_LENGTH AS MAX_LEN
    FROM RDB$RELATION_FIELDS rf
    JOIN RDB$FIELDS f ON f.RDB$FIELD_NAME = rf.RDB$FIELD_SOURCE
    WHERE rf.RDB$RELATION_NAME = ? AND f.RDB$CHARACTER_LENGTH IS NOT NULL
  `, [nomeTabela]);
  const mapa = {};
  for (const row of rows) mapa[row.COLUNA] = row.MAX_LEN;
  cacheTamanhosPorTabela[nomeTabela] = mapa;
  return mapa;
}

/**
 * Retorna o conjunto de colunas computadas (COMPUTED BY) de uma tabela.
 * Essas colunas são read-only no Firebird e não podem ser incluídas no UPSERT.
 */
async function getColunasComputadas(db, nomeTabela) {
  if (cacheColunasComputadas[nomeTabela]) {
    return cacheColunasComputadas[nomeTabela];
  }

  const rows = await query(
    db,
    `SELECT TRIM(rf.RDB$FIELD_NAME) AS COLUNA
     FROM RDB$RELATION_FIELDS rf
     JOIN RDB$FIELDS f ON f.RDB$FIELD_NAME = rf.RDB$FIELD_SOURCE
     WHERE TRIM(rf.RDB$RELATION_NAME) = ?
       AND f.RDB$COMPUTED_SOURCE IS NOT NULL`,
    [nomeTabela]
  );

  const computadas = new Set(rows.map(r => (r.COLUNA || '').trim()));
  cacheColunasComputadas[nomeTabela] = computadas;
  return computadas;
}

/**
 * Retorna o conjunto de colunas NOT NULL de uma tabela Firebird.
 * Colunas NOT NULL com valor null recebido do servidor são excluídas do UPSERT
 * — o Firebird usa o DEFAULT da DDL no INSERT e preserva o valor no UPDATE.
 */
async function getColunasNaoNulas(db, nomeTabela) {
  if (cacheColunasNaoNulas[nomeTabela]) return cacheColunasNaoNulas[nomeTabela];
  const rows = await query(db, `
    SELECT TRIM(rf.RDB$FIELD_NAME) AS COLUNA
    FROM RDB$RELATION_FIELDS rf
    JOIN RDB$FIELDS f ON f.RDB$FIELD_NAME = rf.RDB$FIELD_SOURCE
    WHERE TRIM(rf.RDB$RELATION_NAME) = ?
      AND COALESCE(rf.RDB$NULL_FLAG, f.RDB$NULL_FLAG) = 1
  `, [nomeTabela]);
  const set = new Set(rows.map(r => (r.COLUNA || '').trim()));
  cacheColunasNaoNulas[nomeTabela] = set;
  return set;
}

/**
 * Retorna o conjunto de todas as colunas existentes em uma tabela Firebird.
 * Usado para ignorar silenciosamente colunas recebidas do servidor que ainda
 * não foram adicionadas ao schema local da filial.
 */
async function getColunasExistentes(db, nomeTabela) {
  if (cacheColunasExistentes[nomeTabela]) {
    return cacheColunasExistentes[nomeTabela];
  }

  const rows = await query(
    db,
    `SELECT TRIM(rf.RDB$FIELD_NAME) AS COLUNA
     FROM RDB$RELATION_FIELDS rf
     WHERE TRIM(rf.RDB$RELATION_NAME) = ?`,
    [nomeTabela]
  );

  const existentes = new Set(rows.map(r => (r.COLUNA || '').trim()));
  cacheColunasExistentes[nomeTabela] = existentes;
  return existentes;
}

// Colunas que nunca devem ser gravadas na filial.
// Inclui colunas de controle da matriz e colunas populadas por triggers locais
// que usam generators independentes (sobrescrever causaria divergências de GEN).
const COLUNAS_SEMPRE_IGNORADAS = new Set([
  'ID_ULTIMA_ATUALIZACAO_MATRIZ',
  'ID_ULTIMA_ATUALIZACAO_WEB',
  'ID_ULTIMA_ATT_IFOOD',
  'DATA_INCLUSAO_SIRIUS',
  'DATA_ALTERACAO_SIRIUS',
  'ULTIMA_ALTERACAO',
  'DATA_PRECO_VENDA',
  'DATA_ULTIMA_ATUAL_IMP_ENTRADA',
  'DATA_PRECO_CUSTO',
]);

/**
 * Faz UPSERT dinâmico de um registro no banco local.
 * Filtra colunas computadas e colunas exclusivas da matriz automaticamente.
 */
async function upsertRegistro(db, nomeTabela, pkColuna, registro, log = console.log) {
  const [computadas, existentes, naoNulas, tamanhos] = await Promise.all([
    getColunasComputadas(db, nomeTabela),
    getColunasExistentes(db, nomeTabela),
    getColunasNaoNulas(db, nomeTabela),
    getTamanhosColunas(db, nomeTabela),
  ]);
  const pks = Array.isArray(pkColuna) ? pkColuna : [pkColuna];

  const colunas = Object.keys(registro).filter(k =>
    registro[k] !== undefined &&
    !COLUNAS_SEMPRE_IGNORADAS.has(k) &&
    !computadas.has(k) &&
    existentes.has(k) &&
    !(registro[k] === null && naoNulas.has(k)) &&  // não escreve null em coluna NOT NULL
    !(registro[k] === null && pks.some(p => p.toUpperCase() === k.toUpperCase()))  // não escreve null em coluna PK (NOT NULL via constraint, não via flag)
  );

  if (colunas.length === 0) return;

  const placeholders = colunas.map(() => '?').join(', ');
  // Firebird rejeita string vazia em colunas numéricas/data — converte para null.
  // Strings maiores que o CHAR/VARCHAR da coluna são truncadas (com aviso) em vez de
  // deixar o registro inteiro falhar com "string right truncation".
  const valores = colunas.map(c => {
    let v = registro[c];
    if (v === undefined || v === '') return null;
    const maxLen = tamanhos[c];
    if (typeof v === 'string' && maxLen != null && v.length > maxLen) {
      log(`[AVISO] ${nomeTabela}.${c}: valor truncado de ${v.length} → ${maxLen} char(s) (servidor enviou: "${v}")`);
      v = v.slice(0, maxLen);
    }
    return v;
  });

  // MATCHING só pode referenciar colunas presentes no INSERT.
  // Quando o PK é null (registro criado via web sem ID Firebird), ele é filtrado
  // das colunas NOT NULL — nesse caso usa INSERT puro e deixa o trigger gerar o PK.
  const colsUpper    = new Set(colunas.map(c => c.toUpperCase()));
  const matchingPks  = pks.filter(p => colsUpper.has(p.toUpperCase()));
  const sql = matchingPks.length > 0
    ? `UPDATE OR INSERT INTO ${nomeTabela} (${colunas.join(', ')}) VALUES (${placeholders}) MATCHING (${matchingPks.join(', ')})`
    : `INSERT INTO ${nomeTabela} (${colunas.join(', ')}) VALUES (${placeholders})`;

  await execute(db, sql, valores);
}

/**
 * Deleta um registro do banco local pela chave primária.
 */
async function deletarRegistro(db, nomeTabela, pkColuna, pkValor) {
  const pks = Array.isArray(pkColuna) ? pkColuna : [pkColuna];

  // Se pkValor for um objeto/registro completo, extrai os valores das PKs.
  // Se for uma string concatenada (comum em logs de delete), separa pelo delimitador.
  // Se for um valor único, assume que a PK é simples.
  let valores;
  if (pks.length > 1 && typeof pkValor === 'string' && pkValor.includes('|')) {
    valores = pkValor.split('|');
  } else if (pks.length > 1 && typeof pkValor === 'object' && pkValor !== null) {
    valores = pks.map(p => pkValor[p]);
  } else {
    valores = [pkValor];
  }

  // Apaga filhos FK antes do pai para evitar violação de constraint.
  // Usa apenas a última coluna da PK (principal) como referência de FK.
  const pkPrincipal  = pks[pks.length - 1];
  const valPrincipal = valores[valores.length - 1];
  try {
    const fkRefs = await getFKRefs(db, nomeTabela, pkPrincipal);
    for (const { tabela: tabelaFilha, coluna: colunaFK } of fkRefs) {
      await execute(db, `DELETE FROM ${tabelaFilha} WHERE ${colunaFK} = ?`, [valPrincipal]);
    }
  } catch {
    // Se falhar ao descobrir FKs (ex: permissão), tenta deletar direto mesmo assim
  }

  const where = pks.map(p => `${p} = ?`).join(' AND ');
  await execute(db, `DELETE FROM ${nomeTabela} WHERE ${where}`, valores);
}

/**
 * Avança o generator Firebird para pelo menos `novoValor`, se necessário.
 * Evita que o próximo INSERT do Delphi reutilize um ID já ocupado após uma
 * resolução de colisão de PK via gerarNovoPK (que usa MAX+1, não GEN_ID).
 */
async function sincronizarGenerator(db, nomeGenerator, novoValor) {
  if (!nomeGenerator || !Number.isFinite(novoValor)) return;
  const rows = await query(db, `SELECT GEN_ID(${nomeGenerator}, 0) AS ATUAL FROM RDB$DATABASE`);
  const atual = rows[0]?.ATUAL ?? 0;
  if (atual < novoValor) {
    await execute(db, `SET GENERATOR ${nomeGenerator} TO ${novoValor}`);
  }
}

/**
 * Sincroniza uma tabela completa: busca atualizações no servidor e aplica no banco local.
 */
async function sincronizarTabela(db, baseURI, idLoja, configTabela, log = console.log, idPDV = null, nomeFilial = '') {
  const { nome, pk, temDelete, endpoint, filtroFilial = null, filtroFilialViaFK = null, generator = null, colunaData = null } = configTabela;

  // ---- ATUALIZAÇÕES ----
  let totalAtualizados = 0;
  let continuar = true;

  while (continuar) {
    const cursor = await getUltimaAtualizacao(db, nome);

    let registros;
    try {
      if (endpoint === 'TSMProdutos/ProdutosParaAtualizar') {
        registros = await buscarProdutosParaAtualizar(baseURI, idLoja, cursor, idPDV, nomeFilial);
      } else {
        registros = await buscarRegistrosParaAtualizar(baseURI, nome, cursor, idLoja, filtroFilial, idPDV, colunaData, nomeFilial, filtroFilialViaFK);
      }
    } catch (e) {
      log(`[${nome}] Erro ao buscar atualizações: ${e.message || e.code || String(e)}`);
      break;
    }

    if (registros.length === 0) {
      continuar = false;
      break;
    }

    log(`[${nome}] recebendo ${registros.length} registro(s) do servidor`);

    // Suprime o trigger de SYNC_ALTERACOES_PENDENTES durante o pull para evitar
    // loop circular onde registros recebidos do servidor são re-enfileirados para envio.
    await execute(db, `EXECUTE BLOCK AS BEGIN RDB$SET_CONTEXT('USER_SESSION', 'SYNC_SKIP', '1'); END`).catch(() => { });

    for (const registro of registros) {
      const pks = Array.isArray(pk) ? pk : [pk];
      const pkValor = pks.map(p => String(registro[p] ?? '')).join('|');

      try {
        // node-firebird usa socket único — queries paralelas no mesmo db corrompem as respostas.
        // versaoConhecida = null em erro (distinto de [] = "nunca recebido do servidor").
        const pendentes = await query(db,
          `SELECT 1 FROM SYNC_ALTERACOES_PENDENTES WHERE NOME_TABELA = ? AND PK_VALOR = ?`,
          [nome, pkValor]
        ).catch(() => []);
        const versaoConhecida = await query(db,
          `SELECT ID_ULTIMA_ATUALIZACAO_MATRIZ FROM SYNC_VERSOES_SERVIDOR WHERE NOME_TABELA = ? AND PK_VALOR = ?`,
          [nome, pkValor]
        ).catch(() => null);

        log(`[${nome}] pk=${pkValor} pendentes=${pendentes.length} versaoConhecida=${versaoConhecida === null ? 'ERRO' : versaoConhecida.length === 0 ? 'NUNCA_RECEBIDO' : versaoConhecida[0].ID_ULTIMA_ATUALIZACAO_MATRIZ} versaoServidor=${registro.ID_ULTIMA_ATUALIZACAO_MATRIZ}`);

        if (pendentes.length > 0) {

          if (versaoConhecida !== null && versaoConhecida.length === 0) {
            // ── Colisão de PK: dois registros criados independentemente com o mesmo PK ──
            const wherePartsLocal = pks.map(p => `${p} = ?`).join(' AND ');
            const existeLocal = await query(db,
              `SELECT * FROM ${nome} WHERE ${wherePartsLocal}`,
              pks.map(p => registro[p])
            ).catch(() => []);

            const novoIdColisao = registro.ID_ULTIMA_ATUALIZACAO_MATRIZ;

            if (existeLocal.length === 0) {
              // Registro deletado localmente — pendente é uma deleção, não colisão.
              // Avança o cursor e deixa a fase de push propagar o delete ao servidor.
              if (novoIdColisao) await salvarCursor(db, nome, novoIdColisao, 0).catch(() => {});
              log(`[${nome}] Registro ${pkValor} deletado localmente — aguardando push de deleção`);
              continue;
            }

            // Colisão real: usuário criou um registro e o servidor também criou um com o mesmo PK.
            // Não há precedência automática — salva conflito para resolução manual.
            salvarConflito({
              tabela: nome,
              pk,
              pkValor,
              versaoLocal: existeLocal[0],
              versaoServidor: registro,
            });
            if (novoIdColisao) await salvarCursor(db, nome, novoIdColisao, 0).catch(() => {});
            log(`[${nome}] Colisão de PK (${pkValor}) — conflito salvo para resolução manual`);
            continue; // Não aplica upsert — usuário decide na webui
          } else if (versaoConhecida !== null && versaoConhecida.length > 0) {
            // ── Registro conhecido dos dois lados ──
            const versaoConhecidaNum = versaoConhecida[0].ID_ULTIMA_ATUALIZACAO_MATRIZ;
            const versaoServidorNum  = registro.ID_ULTIMA_ATUALIZACAO_MATRIZ;

            if (versaoServidorNum && versaoConhecidaNum && versaoServidorNum <= versaoConhecidaNum) {
              // Servidor não mudou desde o último sync — apenas o cliente alterou.
              // Avança cursor e deixa o push enviar a mudança local sem conflito.
              log(`[${nome}] pk=${pkValor} servidor não mudou (versaoServidor=${versaoServidorNum} <= conhecido=${versaoConhecidaNum}) — push local pendente`);
              await salvarCursor(db, nome, versaoServidorNum, 0).catch(() => {});
              continue;
            }

            // Servidor tem versão mais nova E cliente tem mudança pendente → conflito real.
            const whereParts  = pks.map(p => `${p} = ?`).join(' AND ');
            const whereValores = pks.map(p => registro[p]);
            const localRows = await query(db,
              `SELECT * FROM ${nome} WHERE ${whereParts}`, whereValores
            ).catch(() => []);

            if (localRows.length > 0) {
              salvarConflito({
                tabela: nome,
                pk,
                pkValor,
                versaoLocal: localRows[0],
                versaoServidor: registro,
              });
              log(`[${nome}] Conflito detectado (${pkValor}) — resolva em http://localhost:3001`);
            }

            await execute(db,
              `DELETE FROM SYNC_ALTERACOES_PENDENTES WHERE NOME_TABELA = ? AND PK_VALOR = ?`,
              [nome, pkValor]
            ).catch(() => {});

            const novoId = registro.ID_ULTIMA_ATUALIZACAO_MATRIZ;
            if (novoId) await salvarCursor(db, nome, novoId, 0).catch(() => {});
            continue; // Não aplica o upsert — usuário decide na webui
          }
          // versaoConhecida === null (erro na query): cai para upsert por segurança.
        }

        // Eco de push: o servidor devolveu um registro que acabamos de enviar.
        // O conteúdo já está correto localmente; basta avançar o cursor.
        const idServidor = registro.ID_ULTIMA_ATUALIZACAO_MATRIZ;
        if (idServidor && pendentes.length === 0 && consumirEcho(nome, pkValor, idServidor)) {
          await salvarCursor(db, nome, idServidor, 0).catch(() => {});
          await execute(db,
            `UPDATE OR INSERT INTO SYNC_VERSOES_SERVIDOR (NOME_TABELA, PK_VALOR, ID_ULTIMA_ATUALIZACAO_MATRIZ)
             VALUES (?, ?, ?) MATCHING (NOME_TABELA, PK_VALOR)`,
            [nome, pkValor, idServidor]
          ).catch(() => {});
          continue;
        }

        // Proteção contra overwrite de dado pré-existente no cliente:
        // se nunca recebemos este registro do servidor (versaoConhecida vazia)
        // e ele já existe localmente, é um dado local que não passou pelo push.
        // Salva conflito para revisão manual em vez de sobrescrever silenciosamente.
        if (versaoConhecida !== null && versaoConhecida.length === 0) {
          const whereLocal = pks.map(p => `${p} = ?`).join(' AND ');
          const localRows = await query(db,
            `SELECT * FROM ${nome} WHERE ${whereLocal}`,
            pks.map(p => registro[p])
          ).catch(() => []);

          if (localRows.length > 0) {
            salvarConflito({
              tabela: nome,
              pk,
              pkValor,
              versaoLocal: localRows[0],
              versaoServidor: registro,
            });
            const novoIdConflito = registro.ID_ULTIMA_ATUALIZACAO_MATRIZ;
            if (novoIdConflito) await salvarCursor(db, nome, novoIdConflito, 0).catch(() => {});
            log(`[${nome}] Registro ${pkValor} existe localmente sem histórico de sync — conflito salvo`);
            continue;
          }
        }

        // Quando o PK é nulo (registro criado via web sem ID Firebird), pré-gera o PK
        // diretamente do generator para não depender do trigger BEFORE INSERT, que é
        // suprimido pelo SYNC_SKIP ativo durante o pull em lote.
        const allPKsNull = pks.every(p => registro[p] == null);
        let registroParaUpsert = registro;
        let pkPreGerado = null;

        if (allPKsNull && generator && !Array.isArray(pk)) {
          const genRows = await query(db,
            `SELECT GEN_ID(${generator}, 1) AS NOVO_ID FROM RDB$DATABASE`
          ).catch((err) => {
            log(`[${nome}] Falha ao pré-gerar PK com generator '${generator}': ${err.message}`);
            return [];
          });
          const novoPK = genRows[0]?.NOVO_ID;
          if (novoPK != null) {
            pkPreGerado = novoPK;
            registroParaUpsert = { ...registro, [pk]: novoPK };
          }
        }

        // Traduz FKs que armazenam SRV_ID para o PK local correspondente.
        // Necessário para registros criados via web que referenciam PRODUTOS pelo SRV_ID
        // em vez do ID_PRODUTO nativo do Firebird (ex: MOVIMENTACOES.ID_PRODUTO).
        for (const fkRef of (configTabela.fks || [])) {
          if (!fkRef.traduzirSrvId || !fkRef.pkRef) continue;
          const valFk = registroParaUpsert[fkRef.coluna];
          if (valFk == null) continue;
          const localRows = await query(db,
            `SELECT FIRST 1 ${fkRef.pkRef} FROM ${fkRef.tabela} WHERE SRV_ID = ?`, [valFk]
          ).catch(() => []);
          if (localRows.length > 0 && localRows[0][fkRef.pkRef] != null) {
            log(`[${nome}] FK ${fkRef.coluna}: SRV_ID=${valFk} → ${fkRef.pkRef}=${localRows[0][fkRef.pkRef]}`);
            registroParaUpsert = { ...registroParaUpsert, [fkRef.coluna]: localRows[0][fkRef.pkRef] };
          }
        }

        await upsertRegistro(db, nome, pk, registroParaUpsert, log);
        totalAtualizados++;

        if (allPKsNull && registro.SRV_ID != null) {
          let pkGerado = null;

          if (pkPreGerado != null) {
            pkGerado = String(pkPreGerado);
          } else {
            // Fallback: PK composto ou sem generator — busca pelo SRV_ID
            const gerados = await query(db,
              `SELECT FIRST 1 ${pks.join(', ')} FROM ${nome} WHERE SRV_ID = ?`,
              [registro.SRV_ID]
            ).catch(() => []);
            if (gerados.length > 0) {
              pkGerado = pks.map(p => String(gerados[0][p] ?? '')).join('|');
              await sincronizarGenerator(db, generator, Number(gerados[0][pks[pks.length - 1]]));
            }
          }

          if (pkGerado) {
            await execute(db,
              `UPDATE OR INSERT INTO SYNC_ALTERACOES_PENDENTES (NOME_TABELA, PK_VALOR, TIMESTAMP_ALTERACAO)
               VALUES (?, ?, CURRENT_TIMESTAMP) MATCHING (NOME_TABELA, PK_VALOR)`,
              [nome, pkGerado]
            ).catch(() => {});
            // Marca a versão atual do servidor para este PK gerado.
            // Sem isso, no próximo pull o Firebird vê pendente=true + versaoConhecida=0
            // e trata o registro como colisão de PK, gerando outro id — loop infinito.
            const versaoAtual = registro.ID_ULTIMA_ATUALIZACAO_MATRIZ;
            if (versaoAtual) {
              await execute(db,
                `UPDATE OR INSERT INTO SYNC_VERSOES_SERVIDOR (NOME_TABELA, PK_VALOR, ID_ULTIMA_ATUALIZACAO_MATRIZ)
                 VALUES (?, ?, ?) MATCHING (NOME_TABELA, PK_VALOR)`,
                [nome, pkGerado, versaoAtual]
              ).catch(() => {});
            }
            log(`[${nome}] PK null → PK gerado: ${pkGerado} (SRV_ID=${registro.SRV_ID}) — enfileirado para push`);
          }
        }

        // Mantém o generator da filial sempre à frente dos IDs que o servidor já atribuiu,
        // evitando que o próximo INSERT do Delphi produza um ID que o servidor já usa.
        await sincronizarGenerator(db, generator, registro[pks[pks.length - 1]]);

        // Registra a versão do servidor para detecção futura de conflitos
        // (omite para PKs nulos — pkValor seria "" e causaria entradas inválidas)
        const versaoServidor = registro.ID_ULTIMA_ATUALIZACAO_MATRIZ;
        if (versaoServidor && !allPKsNull) {
          await execute(db,
            `UPDATE OR INSERT INTO SYNC_VERSOES_SERVIDOR (NOME_TABELA, PK_VALOR, ID_ULTIMA_ATUALIZACAO_MATRIZ)
             VALUES (?, ?, ?) MATCHING (NOME_TABELA, PK_VALOR)`,
            [nome, pkValor, versaoServidor]
          ).catch(() => { });
        }

        const novoId = registro.ID_ULTIMA_ATUALIZACAO_MATRIZ;
        if (novoId) await salvarCursor(db, nome, novoId, 0);
      } catch (e) {
        const pkValorLog = Array.isArray(pk)
          ? pk.map(k => `${k}=${registro[k]}`).join(',')
          : `${pk}=${registro[pk]}`;
        if (e.message && e.message.includes('FOREIGN KEY')) {
          log(`[${nome}] FK pendente (${pkValorLog}) — pai ausente na filial, pulando`);
          const novoId = registro.ID_ULTIMA_ATUALIZACAO_MATRIZ;
          if (novoId) await salvarCursor(db, nome, novoId, 0).catch(() => {});
        } else {
          log(`[${nome}] Erro ao aplicar registro (${pkValorLog}): ${e.message}`);
        }
      }
    }

    // Reativa o trigger de SYNC_ALTERACOES_PENDENTES ao fim do lote
    await execute(db, `EXECUTE BLOCK AS BEGIN RDB$SET_CONTEXT('USER_SESSION', 'SYNC_SKIP', NULL); END`).catch(() => { });
  }

  if (totalAtualizados > 0) {
    log(`[${nome}] ${totalAtualizados} registro(s) atualizado(s)`);
  }

  // Verificação final do generator: garante que está à frente do maior ID
  // presente na tabela local, cobrindo registros que passaram pelo caminho
  // de echo, conflito ou erro de FK sem acionar o sincronizarGenerator por-registro.
  if (generator && !Array.isArray(pk)) {
    try {
      const rows = await query(db, `SELECT MAX(${pk}) AS MAXIMO FROM ${nome}`);
      const maximo = rows[0]?.MAXIMO;
      if (maximo != null && Number.isFinite(Number(maximo))) {
        await sincronizarGenerator(db, generator, Number(maximo));
      }
    } catch { /* tabela pode ainda não existir no banco local */ }
  }

  // ---- DELEÇÕES ----
  if (!temDelete) return;

  let totalDeletados = 0;
  let continuarDelete = true;

  while (continuarDelete) {
    const cursorDelete = await getUltimaDelecao(db, nome);

    let registrosDeletados;
    try {
      registrosDeletados = await buscarRegistrosParaDeletar(baseURI, nome, cursorDelete, nomeFilial);
    } catch (e) {
      log(`[${nome}] Erro ao buscar deleções: ${e.message || e.code || String(e)}`);
      break;
    }

    if (registrosDeletados.length === 0) {
      continuarDelete = false;
      break;
    }

    await execute(db, `EXECUTE BLOCK AS BEGIN RDB$SET_CONTEXT('USER_SESSION', 'SYNC_SKIP', '1'); END`).catch(() => { });

    for (const rd of registrosDeletados) {
      try {
        await deletarRegistro(db, nome, pk, rd.ID_REGISTROS);
        totalDeletados++;

        const novoIdDelete = rd.ID_REGISTRO_DELETADO;
        if (novoIdDelete) {
          await salvarCursor(db, nome, 0, novoIdDelete);
        }
      } catch (e) {
        log(`[${nome}] Erro ao deletar registro (${pk}=${rd.ID_REGISTROS}): ${e.message}`);
      }
    }

    await execute(db, `EXECUTE BLOCK AS BEGIN RDB$SET_CONTEXT('USER_SESSION', 'SYNC_SKIP', NULL); END`).catch(() => { });
  }

  if (totalDeletados > 0) {
    log(`[${nome}] ${totalDeletados} registro(s) deletado(s)`);
  }
}

module.exports = { sincronizarTabela };
