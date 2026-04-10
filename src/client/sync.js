const { execute, query } = require('./db');
const { getUltimaAtualizacao, getUltimaDelecao, salvarCursor } = require('./cursor');
const {
  buscarRegistrosParaAtualizar,
  buscarRegistrosParaDeletar,
  buscarProdutosParaAtualizar,
} = require('./http');
const { salvarConflito } = require('./conflitos');

// Cache de colunas computadas (read-only) por tabela — evita consultar toda vez
const cacheColunasComputadas = {};

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
async function upsertRegistro(db, nomeTabela, pkColuna, registro) {
  const computadas = await getColunasComputadas(db, nomeTabela);
  const pks = Array.isArray(pkColuna) ? pkColuna : [pkColuna];

  const colunas = Object.keys(registro).filter(k =>
    registro[k] !== undefined &&
    !COLUNAS_SEMPRE_IGNORADAS.has(k) &&
    !computadas.has(k)
  );

  if (colunas.length === 0) return;

  const placeholders = colunas.map(() => '?').join(', ');
  const valores = colunas.map(c => (registro[c] === undefined ? null : registro[c]));

  const sql =
    `UPDATE OR INSERT INTO ${nomeTabela} (${colunas.join(', ')})` +
    ` VALUES (${placeholders})` +
    ` MATCHING (${pks.join(', ')})`;

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

  const where = pks.map(p => `${p} = ?`).join(' AND ');
  await execute(db, `DELETE FROM ${nomeTabela} WHERE ${where}`, valores);
}

/**
 * Gera um novo valor de PK que não existe na tabela.
 * - PK numérica: MAX(pk) + 1
 * - PK string:   valorAtual + '_1', '_2', ... até achar livre
 *
 * Para PKs compostas, incrementa apenas a última coluna da PK.
 */
async function gerarNovoPK(db, tabela, pkColuna, registro) {
  const pks = Array.isArray(pkColuna) ? pkColuna : [pkColuna];
  const pkPrincipal = pks[pks.length - 1]; // Geralmente a última parte é o ID
  const valorAtual = registro[pkPrincipal];

  const isNumerico = Number.isFinite(Number(valorAtual)) && String(valorAtual).trim() !== '';

  const constraints = pks.slice(0, -1);
  const whereBase = constraints.map(p => `${p} = ?`).join(' AND ');
  const valoresBase = constraints.map(p => registro[p]);

  if (isNumerico) {
    let sql = `SELECT MAX(${pkPrincipal}) AS MAXIMO FROM ${tabela}`;
    if (whereBase) sql += ` WHERE ${whereBase}`;

    const rows = await query(db, sql, valoresBase);
    return (rows[0].MAXIMO || 0) + 1;
  }

  for (let i = 1; i <= 999; i++) {
    const candidato = `${valorAtual}_${i}`.substring(0, 50);
    let sql = `SELECT 1 FROM ${tabela} WHERE ${pkPrincipal} = ?`;
    if (whereBase) sql += ` AND ${whereBase}`;

    const existe = await query(db, sql, [candidato, ...valoresBase]);
    if (existe.length === 0) return candidato;
  }
  throw new Error(`Não foi possível gerar novo PK para ${tabela}.${pkPrincipal}=${valorAtual}`);
}

/**
 * Sincroniza uma tabela completa: busca atualizações no servidor e aplica no banco local.
 */
async function sincronizarTabela(db, baseURI, idLoja, configTabela, log = console.log) {
  const { nome, pk, temDelete, endpoint } = configTabela;

  // ---- ATUALIZAÇÕES ----
  let totalAtualizados = 0;
  let continuar = true;

  while (continuar) {
    const cursor = await getUltimaAtualizacao(db, nome);

    let registros;
    try {
      if (endpoint === 'TSMProdutos/ProdutosParaAtualizar') {
        registros = await buscarProdutosParaAtualizar(baseURI, idLoja, cursor);
      } else {
        registros = await buscarRegistrosParaAtualizar(baseURI, nome, cursor);
      }
    } catch (e) {
      log(`[${nome}] Erro ao buscar atualizações: ${e.message || e.code || String(e)}`);
      break;
    }

    if (registros.length === 0) {
      continuar = false;
      break;
    }

    // Suprime o trigger de SYNC_ALTERACOES_PENDENTES durante o pull para evitar
    // loop circular onde registros recebidos do servidor são re-enfileirados para envio.
    await execute(db, `EXECUTE BLOCK AS BEGIN RDB$SET_CONTEXT('USER_SESSION', 'SYNC_SKIP', '1'); END`).catch(() => {});

    for (const registro of registros) {
      const pks = Array.isArray(pk) ? pk : [pk];
      const pkValor = pks.map(p => String(registro[p] ?? '')).join('|');

      try {
        // Verifica se há alteração local pendente para este registro
        const pendentes = await query(db,
          `SELECT 1 FROM SYNC_ALTERACOES_PENDENTES WHERE NOME_TABELA = ? AND PK_VALOR = ?`,
          [nome, pkValor]
        ).catch(() => []);

        if (pendentes.length > 0) {
          // Verifica se o registro foi alguma vez recebido do servidor (ou é criação local)
          const versaoConhecida = await query(db,
            `SELECT 1 FROM SYNC_VERSOES_SERVIDOR WHERE NOME_TABELA = ? AND PK_VALOR = ?`,
            [nome, pkValor]
          ).catch(() => []);

          if (versaoConhecida.length === 0) {
            // ── Colisão de PK: dois registros distintos com mesmo PK ──────────
            // O registro local foi criado independentemente; renomeia o PK local
            // para liberar o PK original para o registro do servidor.
            try {
              const novoValorPK = await gerarNovoPK(db, nome, pk, registro);
              const pkPrincipal = pks[pks.length - 1];

              const whereParts = pks.map(p => `${p} = ?`).join(' AND ');
              const whereValores = pks.map(p => registro[p]);

              await execute(db, `UPDATE ${nome} SET ${pkPrincipal} = ? WHERE ${whereParts}`, [novoValorPK, ...whereValores]);

              // Calcula o novo PK_VALOR (concatenado) para atualizar a fila de pendentes
              const registroAtualizado = { ...registro, [pkPrincipal]: novoValorPK };
              const novoPKValor = pks.map(p => String(registroAtualizado[p] ?? '')).join('|');

              await execute(db,
                `UPDATE SYNC_ALTERACOES_PENDENTES SET PK_VALOR = ? WHERE NOME_TABELA = ? AND PK_VALOR = ?`,
                [String(novoPKValor), nome, pkValor]
              ).catch(() => {});

              log(`[${nome}] PK duplicada (${pkValor}) — registro local renomeado para ${novoPKValor}`);
            } catch (e) {
              log(`[${nome}] Erro ao resolver colisão de PK (${pkValor}): ${e.message}`);
              continue;
            }
            // Agora aplica o registro do servidor com o PK original (flui para o upsert abaixo)
          } else {
            // ── Conflito de conteúdo: mesmo registro editado nos dois lados ───
            // Lê a versão local ANTES de sobrescrever e salva para resolução manual.
            const whereParts = pks.map(p => `${p} = ?`).join(' AND ');
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

            // Remove dos pendentes (conflito já registrado; push não deve re-enviar)
            await execute(db,
              `DELETE FROM SYNC_ALTERACOES_PENDENTES WHERE NOME_TABELA = ? AND PK_VALOR = ?`,
              [nome, pkValor]
            ).catch(() => {});

            // Avança o cursor para não ficar preso neste registro
            const novoId = registro.ID_ULTIMA_ATUALIZACAO_MATRIZ;
            if (novoId) await salvarCursor(db, nome, novoId, 0);
            continue; // Não aplica o upsert — usuário decide na webui
          }
        }

        await upsertRegistro(db, nome, pk, registro);
        totalAtualizados++;

        // Registra a versão do servidor para detecção futura de conflitos
        const versaoServidor = registro.ID_ULTIMA_ATUALIZACAO_MATRIZ;
        if (versaoServidor) {
          await execute(db,
            `UPDATE OR INSERT INTO SYNC_VERSOES_SERVIDOR (NOME_TABELA, PK_VALOR, ID_ULTIMA_ATUALIZACAO_MATRIZ)
             VALUES (?, ?, ?) MATCHING (NOME_TABELA, PK_VALOR)`,
            [nome, pkValor, versaoServidor]
          ).catch(() => {});
        }

        const novoId = registro.ID_ULTIMA_ATUALIZACAO_MATRIZ;
        if (novoId) await salvarCursor(db, nome, novoId, 0);
      } catch (e) {
        log(`[${nome}] Erro ao aplicar registro (${pk}=${registro[pk]}): ${e.message}`);
      }
    }

    // Reativa o trigger de SYNC_ALTERACOES_PENDENTES ao fim do lote
    await execute(db, `EXECUTE BLOCK AS BEGIN RDB$SET_CONTEXT('USER_SESSION', 'SYNC_SKIP', NULL); END`).catch(() => {});
  }

  if (totalAtualizados > 0) {
    log(`[${nome}] ${totalAtualizados} registro(s) atualizado(s)`);
  }

  // ---- DELEÇÕES ----
  if (!temDelete) return;

  let totalDeletados = 0;
  let continuarDelete = true;

  while (continuarDelete) {
    const cursorDelete = await getUltimaDelecao(db, nome);

    let registrosDeletados;
    try {
      registrosDeletados = await buscarRegistrosParaDeletar(baseURI, nome, cursorDelete);
    } catch (e) {
      log(`[${nome}] Erro ao buscar deleções: ${e.message || e.code || String(e)}`);
      break;
    }

    if (registrosDeletados.length === 0) {
      continuarDelete = false;
      break;
    }

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
  }

  if (totalDeletados > 0) {
    log(`[${nome}] ${totalDeletados} registro(s) deletado(s)`);
  }
}

module.exports = { sincronizarTabela };
