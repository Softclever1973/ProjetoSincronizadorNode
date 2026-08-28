const { planos: PLANOS } = require('./planos.json');

// Deve bater com o DEFAULT da coluna sync_tenants.plano em src/db-init.js
const PLANO_PADRAO = 'LITE1';

function planoValido(nome) {
  return typeof nome === 'string' && Object.prototype.hasOwnProperty.call(PLANOS, nome);
}

function listarPlanos() {
  return Object.entries(PLANOS).map(([chave, def]) => ({ chave, nome: def.nome }));
}

module.exports = { PLANOS, PLANO_PADRAO, planoValido, listarPlanos };
