const { planos: PLANOS } = require('./planos.json');

// Deve bater com o DEFAULT da coluna sync_tenants.plano em src/db-init.js
const PLANO_PADRAO = 'LITE1';

function planoValido(nome) {
  return typeof nome === 'string' && Object.prototype.hasOwnProperty.call(PLANOS, nome);
}

function listarPlanos() {
  return Object.entries(PLANOS).map(([chave, def]) => ({ chave, nome: def.nome, features: def.features }));
}

/**
 * Features do plano informado. Plano desconhecido/corrompido → [] (fail-closed),
 * NÃO cai para PLANO_PADRAO — um valor inesperado no banco não deve conceder
 * silenciosamente as features de outro plano. console.warn pra não ficar
 * silencioso: um "plano" incorreto (ex.: digitado errado num script) hoje
 * bloqueava tudo sem deixar rastro nenhum no log.
 */
function featuresDoPlano(nomePlano) {
  if (!planoValido(nomePlano)) {
    console.warn(`[planos] plano desconhecido: "${nomePlano}" — nenhuma feature liberada`);
    return [];
  }
  return PLANOS[nomePlano].features;
}

function planoTemFeature(nomePlano, featureKey) {
  return featuresDoPlano(nomePlano).includes(featureKey);
}

module.exports = { PLANOS, PLANO_PADRAO, planoValido, listarPlanos, featuresDoPlano, planoTemFeature };
