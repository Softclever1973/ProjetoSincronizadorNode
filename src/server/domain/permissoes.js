const { MODULOS } = require('./modulos');

const NIVEL_RANK = { '--': 0, 'r-': 1, 'rw': 2 };

/**
 * Permissão efetiva de um módulo: a interseção (o menor nível) entre o que o plano libera
 * e o que o role libera. Plano/role/módulo desconhecido é fail-closed ('--') — nunca cai
 * pra um nível mais permissivo por causa de um dado ausente/corrompido.
 *
 * @param {Map<string,string>|undefined} matrizPlano  modulo -> nivel, para UM plano específico
 * @param {Map<string,string>|undefined} matrizRole   modulo -> nivel, para UMA role específica
 * @param {string} modulo
 * @returns {'--'|'r-'|'rw'}
 */
function permissaoEfetiva(matrizPlano, matrizRole, modulo) {
  const nivelPlano = matrizPlano?.get(modulo) ?? '--';
  const nivelRole  = matrizRole?.get(modulo)  ?? '--';
  const rankPlano  = NIVEL_RANK[nivelPlano] ?? 0;
  const rankRole   = NIVEL_RANK[nivelRole]  ?? 0;
  return rankPlano <= rankRole ? (nivelPlano in NIVEL_RANK ? nivelPlano : '--') : (nivelRole in NIVEL_RANK ? nivelRole : '--');
}

/** Resolve o mapa completo modulo -> nivel efetivo, para todos os MODULOS conhecidos. */
function resolverPermissoesEfetivas(matrizPlano, matrizRole) {
  return Object.fromEntries(MODULOS.map(m => [m, permissaoEfetiva(matrizPlano, matrizRole, m)]));
}

function podeLer(nivel)      { return nivel === 'r-' || nivel === 'rw'; }
function podeEscrever(nivel)  { return nivel === 'rw'; }

module.exports = { permissaoEfetiva, resolverPermissoesEfetivas, podeLer, podeEscrever, NIVEL_RANK };
