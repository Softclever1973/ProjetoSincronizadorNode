// Rastreia registros recém-enviados ao servidor para evitar que o pull seguinte
// os reaplique desnecessariamente. O servidor atribui um novo ID_ULTIMA_ATUALIZACAO_MATRIZ
// ao receber um push; sem este módulo, o próximo ciclo de pull buscaria esse registro
// de volta e faria um upsert redundante.
//
// A chave é "TABELA|pkValor" e o valor é o novoId retornado pelo servidor.
// Cada eco é consumido uma única vez (delete após match) para não bloquear
// re-pulls legítimos caso o servidor atualize o registro externamente depois.

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
