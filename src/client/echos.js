// Rastreia registros recém-enviados ao servidor pra evitar que o pull seguinte os
// reaplique — sem isso, o próximo pull buscaria de volta o registro com o novo
// ID_ULTIMA_ATUALIZACAO_MATRIZ atribuído pelo push e faria um upsert redundante.
// Chave "TABELA|pkValor" → novoId do servidor. Cada eco é consumido uma única vez
// (delete após match) pra não bloquear re-pulls legítimos de uma atualização externa posterior.

const _echos = new Map();

function registrarEcho(tabela, pkValor, novoId) {
  _echos.set(`${tabela}|${pkValor}`, novoId);
}

/**
 * Retorna true e remove o eco se o registro recebido do servidor for exatamente
 * o eco de um push recente (mesma tabela, mesmo PK, mesmo ID_ULTIMA_ATUALIZACAO_MATRIZ).
 */
function consumirEcho(tabela, pkValor, idServidor) {
  const chave = `${tabela}|${pkValor}`;
  if (_echos.get(chave) === idServidor) {
    _echos.delete(chave);
    return true;
  }
  return false;
}

module.exports = { registrarEcho, consumirEcho };
