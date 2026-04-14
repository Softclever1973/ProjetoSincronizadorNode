const { query, execute } = require('./db');
const { enviarRegistro } = require('./http');
const { atualizarOuSalvarConflito } = require('./conflitos');

/**
 * Envia ao servidor os registros locais que foram alterados desde o último sync.
 * Detecta conflitos e os salva para resolução manual via interface web.
 */
async function empurrarTabela(db, baseURI, idLoja, configTabela, log = console.log, idPDV = null) {
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
      // Registro foi deletado localmente — remove dos pendentes sem enviar
      await execute(db,
        `DELETE FROM SYNC_ALTERACOES_PENDENTES WHERE NOME_TABELA = ? AND PK_VALOR = ?`,
        [nome, pkValor]
      ).catch(() => {});
      continue;
    }

    const registro = registros[0];

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
    } catch {}

    try {
      const resultado = await enviarRegistro(baseURI, idLoja, nome, pk, registro, ultimaVersaoConhecida, false, idPDV);

      if (resultado.conflito) {
        // Remove dos pendentes para não re-enviar indefinidamente no próximo ciclo
        await execute(db,
          `DELETE FROM SYNC_ALTERACOES_PENDENTES WHERE NOME_TABELA = ? AND PK_VALOR = ?`,
          [nome, pkValor]
        ).catch(() => {});

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
        totalEnviados++;
      }
    } catch (e) {
      log(`[${nome}] Erro ao enviar (${pk}=${pkValor}): ${e.message}`);
    }
  }

  if (totalEnviados > 0)  log(`[${nome}] ${totalEnviados} registro(s) enviado(s) ao servidor`);
  if (totalConflitos > 0) log(`[${nome}] ${totalConflitos} conflito(s) — acesse http://localhost:<porta_webui>/conflitos`);
}

module.exports = { empurrarTabela };
