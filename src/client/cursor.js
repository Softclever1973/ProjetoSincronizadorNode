const { query, execute } = require('./db');

/**
 * Retorna o próximo valor do generator do Firebird.
 * Equivalente ao TServicosBanco.GeneratorIncrementado() do Delphi.
 */
async function nextGenerator(db, nomeGenerator) {
  const rows = await query(db, `SELECT GEN_ID(${nomeGenerator}, 1) AS NOVO_ID FROM RDB$DATABASE`);
  return rows[0].NOVO_ID;
}

/**
 * Retorna o último ID de atualização já sincronizado para uma tabela.
 * Equivalente ao TUltimosRegistrosMatriz.GetUltimaAtualizacaoMatriz() do Delphi.
 */
async function getUltimaAtualizacao(db, nomeTabela) {
  const rows = await query(
    db,
    'SELECT ULTIMO_REGISTRO_ATUALIZADO FROM ULTIMOS_REGISTROS_MATRIZ WHERE NOME_TABELA = ?',
    [nomeTabela]
  );
  return rows.length > 0 ? (rows[0].ULTIMO_REGISTRO_ATUALIZADO || 0) : 0;
}

/**
 * Retorna o último ID de deleção já processado para uma tabela.
 * Equivalente ao TUltimosRegistrosMatriz.GetUltimaDelecaoMatriz() do Delphi.
 */
async function getUltimaDelecao(db, nomeTabela) {
  const rows = await query(
    db,
    'SELECT ULTIMO_REGISTRO_DELETADO FROM ULTIMOS_REGISTROS_MATRIZ WHERE NOME_TABELA = ?',
    [nomeTabela]
  );
  return rows.length > 0 ? (rows[0].ULTIMO_REGISTRO_DELETADO || 0) : 0;
}

/**
 * Atualiza (ou insere) o cursor de sincronização de uma tabela.
 * Equivalente ao TUltimosRegistrosMatriz.CriarUltimoRegistroMatriz() do Delphi.
 *
 * @param {object} db
 * @param {string} nomeTabela
 * @param {number} idUltimaAtualizacao  — 0 = não atualiza este campo
 * @param {number} idUltimaDelecao      — 0 = não atualiza este campo
 */
async function salvarCursor(db, nomeTabela, idUltimaAtualizacao = 0, idUltimaDelecao = 0) {
  // Verifica se já existe registro para essa tabela
  const rows = await query(
    db,
    'SELECT ID_ULTIMO_REGISTRO_MATRIZ FROM ULTIMOS_REGISTROS_MATRIZ WHERE NOME_TABELA = ?',
    [nomeTabela]
  );

  if (rows.length === 0) {
    // INSERT — ID gerado via generator, igual ao Delphi
    const novoId = await nextGenerator(db, 'NOVO_ULTIMOS_REGISTROS_MATRIZ');
    await execute(
      db,
      `INSERT INTO ULTIMOS_REGISTROS_MATRIZ
         (ID_ULTIMO_REGISTRO_MATRIZ, NOME_TABELA, ULTIMO_REGISTRO_ATUALIZADO, ULTIMO_REGISTRO_DELETADO)
       VALUES (?, ?, ?, ?)`,
      [novoId, nomeTabela, idUltimaAtualizacao || 0, idUltimaDelecao || 0]
    );
  } else {
    // UPDATE — atualiza apenas o campo que veio preenchido
    if (idUltimaAtualizacao > 0) {
      await execute(
        db,
        'UPDATE ULTIMOS_REGISTROS_MATRIZ SET ULTIMO_REGISTRO_ATUALIZADO = ? WHERE NOME_TABELA = ?',
        [idUltimaAtualizacao, nomeTabela]
      );
    }
    if (idUltimaDelecao > 0) {
      await execute(
        db,
        'UPDATE ULTIMOS_REGISTROS_MATRIZ SET ULTIMO_REGISTRO_DELETADO = ? WHERE NOME_TABELA = ?',
        [idUltimaDelecao, nomeTabela]
      );
    }
  }
}

module.exports = { getUltimaAtualizacao, getUltimaDelecao, salvarCursor };
