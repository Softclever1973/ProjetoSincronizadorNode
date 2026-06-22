const { query, execute } = require('./db');
const { enviarRegistro } = require('./http');
const { atualizarOuSalvarConflito } = require('./conflitos');
const { registrarEcho } = require('./echos');
const { salvarErro } = require('./erros');

/**
 * Envia ao servidor os registros locais que foram alterados desde o último sync.
 * Detecta conflitos e os salva para resolução manual via interface web.
 */
async function empurrarTabela(db, baseURI, idLoja, configTabela, log = console.log, idPDV = null, nomeFilial = '') {
  const { nome, pk } = configTabela;

  let pendentes;
  try {
    pendentes = await query(
      db,
      `SELECT PK_VALOR FROM SYNC_ALTERACOES_PENDENTES WHERE NOME_TABELA = ? ORDER BY TIMESTAMP_ALTERACAO`,
      [nome]
    );
  } catch {
    // Tabela ainda não existe (setup não rodou ou falhou)
    return;
  }

  if (pendentes.length === 0) return;

  log(`[${nome}] ${pendentes.length} registro(s) pendente(s) para enviar ao servidor`);

  let totalEnviados = 0;
  let totalConflitos = 0;

  for (const pendente of pendentes) {
    const pks = Array.isArray(pk) ? pk : [pk];
    const pkValor = pendente.PK_VALOR;
    const pkValores = pkValor.split('|');

    // Busca o registro completo no banco local
    let registros;
    try {
      const whereParts = pks.map(p => `${p} = ?`).join(' AND ');
      registros = await query(
        db,
        `SELECT * FROM ${nome} WHERE ${whereParts}`,
        pkValores
      );
    } catch (e) {
      log(`[${nome}] Erro ao buscar registro local (${pkValor}): ${e.message}`);
      continue;
    }

    if (registros.length === 0) {
      const registroDelete = {};
      pks.forEach((coluna, i) => { registroDelete[coluna] = pkValores[i]; });
      try {
        log(`[${nome}] Enviando deleção (${pkValor}) ao servidor`);
        await enviarRegistro(baseURI, idLoja, nome, pk, registroDelete, 0, false, idPDV, nomeFilial, true);
        totalEnviados++;
      } catch (e) {
        log(`[${nome}] Erro ao enviar deleção (${pkValor}): ${e.message}`);
      }
      await execute(db,
        `DELETE FROM SYNC_ALTERACOES_PENDENTES WHERE NOME_TABELA = ? AND PK_VALOR = ?`,
        [nome, pkValor]
      ).catch(() => { });
      continue;
    }

    const registro = registros[0];

    // Se o registro tem ID_LOJA mas está nulo, preenche com o ID da filial.
    // Garante que registros criados localmente pelo Delphi (sem ID_LOJA explícito)
    // sejam identificados corretamente no servidor.
    if ((registro.ID_LOJA == null || registro.ID_LOJA === '') && idLoja) {
      registro.ID_LOJA = idLoja;
    }

    // Traduz FKs: PK local → SRV_ID antes de enviar ao servidor.
    // O servidor usa SRV_ID como referência global entre tenants; o Firebird local
    // armazena o ID nativo (ex: MOVIMENTACOES.ID_PRODUTO = ID local de PRODUTOS).
    let registroParaEnviar = registro;
    let fkNaoResolvida = false;
    for (const fkRef of (configTabela.fks || [])) {
      if (!fkRef.traduzirSrvId || !fkRef.pkRef) continue;
      const localId = registroParaEnviar[fkRef.coluna];
      if (localId == null) continue;
      let srvRows;
      try {
        srvRows = await query(db,
          `SELECT FIRST 1 SRV_ID FROM ${fkRef.tabela} WHERE ${fkRef.pkRef} = ?`, [localId]
        );
      } catch (err) {
        log(`[${nome}] ERRO ao traduzir FK ${fkRef.coluna} (${fkRef.pkRef}=${localId}): ${err.message}`);
        fkNaoResolvida = true;
        break;
      }
      if (srvRows.length === 0 || srvRows[0].SRV_ID == null) {
        log(`[${nome}] WARN FK ${fkRef.coluna}: ${fkRef.pkRef}=${localId} sem SRV_ID — enfileirando ${fkRef.tabela} para sync`);
        // Auto-enfileira o registro pai para que o próximo ciclo resolva o SRV_ID.
        // Sem isso, o filho fica bloqueado indefinidamente até intervenção manual.
        await execute(db,
          `UPDATE OR INSERT INTO SYNC_ALTERACOES_PENDENTES (NOME_TABELA, PK_VALOR, TIMESTAMP_ALTERACAO)
           VALUES (?, ?, CURRENT_TIMESTAMP) MATCHING (NOME_TABELA, PK_VALOR)`,
          [fkRef.tabela, String(localId)]
        ).catch(e2 => log(`[${nome}] WARN: não foi possível enfileirar ${fkRef.tabela}/${localId}: ${e2.message}`));
        fkNaoResolvida = true;
        break;
      }
      log(`[${nome}] FK ${fkRef.coluna}: ${fkRef.pkRef}=${localId} → SRV_ID=${srvRows[0].SRV_ID}`);
      registroParaEnviar = { ...registroParaEnviar, [fkRef.coluna]: srvRows[0].SRV_ID };
    }
    if (fkNaoResolvida) continue;

    // Normaliza colunas declaradas como absolutas: o Firebird filial pode armazenar
    // quantidades com sinal negativo (ex: Saídas em MOVIMENTACOES.QTDE = -5), mas o
    // servidor usa apenas valores positivos — a direção é indicada por TP.MOV.
    for (const col of (configTabela.colunasAbsolutas || [])) {
      const val = registroParaEnviar[col];
      if (typeof val === 'number' && Number.isFinite(val) && val < 0) {
        const absVal = Math.abs(val);
        registroParaEnviar = { ...registroParaEnviar, [col]: absVal };
        log(`[${nome}] coluna ${col}: ${val} → ${absVal} (normalização absoluta)`);
      }
    }

    // Última versão conhecida do servidor para este registro (para detecção de conflito)
    let ultimaVersaoConhecida = 0;
    try {
      const versoes = await query(
        db,
        `SELECT ID_ULTIMA_ATUALIZACAO_MATRIZ FROM SYNC_VERSOES_SERVIDOR WHERE NOME_TABELA = ? AND PK_VALOR = ?`,
        [nome, pkValor]
      );
      if (versoes.length > 0) {
        ultimaVersaoConhecida = versoes[0].ID_ULTIMA_ATUALIZACAO_MATRIZ || 0;
      }
    } catch { }

    try {
      log(`[${nome}] Enviando (${Array.isArray(pk) ? pk.map(p => `${p}=${registroParaEnviar[p]}`).join(', ') : `${pk}=${registroParaEnviar[pk]}`}) ao servidor`);
      const resultado = await enviarRegistro(baseURI, idLoja, nome, pk, registroParaEnviar, ultimaVersaoConhecida, false, idPDV, nomeFilial, false, configTabela.srvId ?? false);

      if (resultado.conflito) {
        // Remove dos pendentes para não re-enviar indefinidamente no próximo ciclo
        await execute(db,
          `DELETE FROM SYNC_ALTERACOES_PENDENTES WHERE NOME_TABELA = ? AND PK_VALOR = ?`,
          [nome, pkValor]
        ).catch(() => { });

        // Atualiza conflito existente para (tabela + pkValor) em vez de duplicar
        const id = atualizarOuSalvarConflito({
          tabela: nome,
          pk,
          pkValor,
          versaoLocal: registro,
          versaoServidor: resultado.versaoServidor,
        });
        totalConflitos++;
        log(`[${nome}] Conflito (${pk}=${pkValor}) — id: ${id}`);
      } else {
        await execute(db,
          `DELETE FROM SYNC_ALTERACOES_PENDENTES WHERE NOME_TABELA = ? AND PK_VALOR = ?`,
          [nome, pkValor]
        );
        if (resultado.novoId) registrarEcho(nome, pkValor, resultado.novoId);
        // Atualiza SYNC_VERSOES_SERVIDOR imediatamente após push bem-sucedido.
        // Sem isso, um carga-parcial que re-enfileira este registro antes do próximo pull
        // causaria um falso conflito (versaoConhecida < novoId do servidor).
        if (resultado.novoId) {
          await execute(db,
            `UPDATE OR INSERT INTO SYNC_VERSOES_SERVIDOR (NOME_TABELA, PK_VALOR, ID_ULTIMA_ATUALIZACAO_MATRIZ)
             VALUES (?, ?, ?) MATCHING (NOME_TABELA, PK_VALOR)`,
            [nome, pkValor, resultado.novoId]
          ).catch(() => {});
        }
        if (resultado.srvId && configTabela.srvId) {
          const whereParts = pks.map(p => `${p} = ?`).join(' AND ');
          await execute(db, `EXECUTE BLOCK AS BEGIN RDB$SET_CONTEXT('USER_SESSION', 'SYNC_SKIP', '1'); END`).catch(() => {});
          let srvIdGravado = false;
          try {
            await execute(db,
              `UPDATE ${nome} SET SRV_ID = ? WHERE ${whereParts}`,
              [resultado.srvId, ...pkValores]
            );
            srvIdGravado = true;
          } catch (e) {
            log(`[${nome}] ERRO ao gravar SRV_ID local (${pkValor}): ${e.message} — re-enfileirando para retry`);
            // Re-enfileira o registro para que o próximo ciclo tente novamente.
            // Sem isso, o registro sai de SYNC_ALTERACOES_PENDENTES com SRV_ID=NULL
            // no Firebird, e qualquer FK que dependa dele fica bloqueada indefinidamente.
            await execute(db,
              `UPDATE OR INSERT INTO SYNC_ALTERACOES_PENDENTES (NOME_TABELA, PK_VALOR, TIMESTAMP_ALTERACAO)
               VALUES (?, ?, CURRENT_TIMESTAMP) MATCHING (NOME_TABELA, PK_VALOR)`,
              [nome, pkValor]
            ).catch(e2 => log(`[${nome}] ERRO ao re-enfileirar (${pkValor}): ${e2.message}`));
          }
          await execute(db, `EXECUTE BLOCK AS BEGIN RDB$SET_CONTEXT('USER_SESSION', 'SYNC_SKIP', NULL); END`).catch(() => {});
          if (srvIdGravado) {
            log(`[${nome}] SRV_ID=${resultado.srvId} gravado localmente (${pkValor})`);
          }
        }
        totalEnviados++;
      }
    } catch (e) {
      log(`[${nome}] Erro ao enviar (${pk}=${pkValor}): ${e.message}`);
      salvarErro({ tabela: nome, operacao: 'push', mensagem: e.message });
    }
  }

  if (totalEnviados > 0) log(`[${nome}] ${totalEnviados} registro(s) enviado(s) ao servidor`);
  if (totalConflitos > 0) log(`[${nome}] ${totalConflitos} conflito(s) — acesse http://localhost:<porta_webui>/conflitos`);
}

module.exports = { empurrarTabela };
