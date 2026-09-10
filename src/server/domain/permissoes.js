const { MODULOS, MODULOS_DEF } = require('./modulos');

const NIVEL_RANK = { '--': 0, 'r-': 1, 'rw': 2 };

/**
 * Permissão efetiva de um módulo: a interseção (o menor nível) entre o que o plano libera
 * e o que o role libera. Plano/role/módulo desconhecido é fail-closed ('--') — nunca cai
 * pra um nível mais permissivo por causa de um dado ausente/corrompido.
 *
 * Sub-permissões (`subDe` em MODULOS_DEF, ex. pedidos_inserir sob pedidos) nunca podem
 * superar o nível efetivo do módulo pai — pedidos:'r-' vira teto pra pedidos_inserir mesmo
 * que a combinação plano×role gravada especificamente pra essa chave dê 'rw' isoladamente.
 * Sem isso, zerar a escrita em "Pedidos" dava uma falsa sensação de segurança: as
 * sub-permissões (linhas separadas, fáceis de esquecer) continuariam liberando escrita.
 * A recursão é sempre de profundidade 1 — um módulo 'modulo' (o pai) nunca tem `subDe`.
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
  let nivel = rankPlano <= rankRole ? (nivelPlano in NIVEL_RANK ? nivelPlano : '--') : (nivelRole in NIVEL_RANK ? nivelRole : '--');

  const pai = MODULOS_DEF[modulo]?.subDe;
  if (pai) {
    const nivelPai = permissaoEfetiva(matrizPlano, matrizRole, pai);
    if ((NIVEL_RANK[nivelPai] ?? 0) < NIVEL_RANK[nivel]) nivel = nivelPai;
  }
  return nivel;
}

/** Resolve o mapa completo modulo -> nivel efetivo, para todos os MODULOS conhecidos. */
function resolverPermissoesEfetivas(matrizPlano, matrizRole) {
  return Object.fromEntries(MODULOS.map(m => [m, permissaoEfetiva(matrizPlano, matrizRole, m)]));
}

function podeLer(nivel)      { return nivel === 'r-' || nivel === 'rw'; }
function podeEscrever(nivel)  { return nivel === 'rw'; }

module.exports = { permissaoEfetiva, resolverPermissoesEfetivas, podeLer, podeEscrever, NIVEL_RANK };
