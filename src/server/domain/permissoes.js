const { MODULOS, MODULOS_DEF } = require('./modulos');

const NIVEL_RANK = { '--': 0, 'r-': 1, 'rw': 2 };

/**
 * Permissão efetiva de um módulo: a interseção (o menor nível) entre o que o plano libera
 * e o que o role libera — a menos que exista um **override por empresa** (`matrizEmpresa`,
 * 2026-09-28) pra esse módulo, que aí vence sobre plano×role por completo (pode tanto
 * restringir quanto LIBERAR além do que o plano cobre — ex. cliente compra uma função avulsa
 * sem mudar de plano inteiro). Diferente de plano/role, a AUSÊNCIA de override não é
 * fail-closed: sem linha em `permissoes_empresa` pra esse módulo, cai no plano×role normal.
 * Plano/role/módulo desconhecido nesses dois, porém, continua fail-closed ('--') — nunca cai
 * pra um nível mais permissivo por causa de um dado ausente/corrompido.
 *
 * Sub-permissões (`subDe` em MODULOS_DEF, ex. pedidos_inserir sob pedidos) nunca podem
 * superar o nível efetivo do módulo pai — pedidos:'r-' vira teto pra pedidos_inserir mesmo
 * que a combinação plano×role (ou um override por empresa) gravada especificamente pra essa
 * chave dê 'rw' isoladamente. Sem isso, zerar a escrita em "Pedidos" dava uma falsa sensação
 * de segurança: as sub-permissões (linhas separadas, fáceis de esquecer) continuariam
 * liberando escrita — e um override de empresa esquecido numa sub-permissão teria o mesmo
 * risco. A recursão é sempre de profundidade 1 — um módulo 'modulo' (o pai) nunca tem `subDe`.
 *
 * @param {Map<string,string>|undefined} matrizPlano   modulo -> nivel, para UM plano específico
 * @param {Map<string,string>|undefined} matrizRole    modulo -> nivel, para UMA role específica
 * @param {string} modulo
 * @param {Map<string,string>|undefined} matrizEmpresa modulo -> nivel, override de UMA empresa específica (opcional)
 * @returns {'--'|'r-'|'rw'}
 */
function permissaoEfetiva(matrizPlano, matrizRole, modulo, matrizEmpresa) {
  const overrideEmpresa = matrizEmpresa?.get(modulo);
  let nivel;
  if (overrideEmpresa != null && overrideEmpresa in NIVEL_RANK) {
    nivel = overrideEmpresa;
  } else {
    const nivelPlano = matrizPlano?.get(modulo) ?? '--';
    const nivelRole  = matrizRole?.get(modulo)  ?? '--';
    const rankPlano  = NIVEL_RANK[nivelPlano] ?? 0;
    const rankRole   = NIVEL_RANK[nivelRole]  ?? 0;
    nivel = rankPlano <= rankRole ? (nivelPlano in NIVEL_RANK ? nivelPlano : '--') : (nivelRole in NIVEL_RANK ? nivelRole : '--');
  }
  // Função binária não tem "só leitura": a tela mostra 'r-' (linha antiga) como Liberado, então vale 'rw'.
  if (nivel === 'r-' && MODULOS_DEF[modulo]?.binario) nivel = 'rw';

  const pai = MODULOS_DEF[modulo]?.subDe;
  if (pai) {
    const nivelPai = permissaoEfetiva(matrizPlano, matrizRole, pai, matrizEmpresa);
    if ((NIVEL_RANK[nivelPai] ?? 0) < NIVEL_RANK[nivel]) nivel = nivelPai;
  }
  return nivel;
}

/** Resolve o mapa completo modulo -> nivel efetivo, para todos os MODULOS conhecidos. */
function resolverPermissoesEfetivas(matrizPlano, matrizRole, matrizEmpresa) {
  return Object.fromEntries(MODULOS.map(m => [m, permissaoEfetiva(matrizPlano, matrizRole, m, matrizEmpresa)]));
}

function podeLer(nivel)      { return nivel === 'r-' || nivel === 'rw'; }
function podeEscrever(nivel)  { return nivel === 'rw'; }

module.exports = { permissaoEfetiva, resolverPermissoesEfetivas, podeLer, podeEscrever, NIVEL_RANK };
