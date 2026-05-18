const fs     = require('fs');
const path   = require('path');
const TABELAS = require('./tabelas');

const CAMINHO = path.join(process.cwd(), 'tabelas-config.json');

const _defaultAtivo = new Map(TABELAS.map(t => [t.nome, t.defaultAtivo === true]));

function lerConfig() {
  try {
    return JSON.parse(fs.readFileSync(CAMINHO, 'utf8'));
  } catch {
    return {};
  }
}

function salvarConfig(config) {
  const tmp = CAMINHO + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
  fs.renameSync(tmp, CAMINHO);
}

/**
 * Retorna true se a tabela está ativa.
 * Prioridade: valor salvo no JSON > defaultAtivo definido em tabelas.js > false.
 */
function tabelaAtiva(nomeTabela) {
  const config = lerConfig();
  if (Object.prototype.hasOwnProperty.call(config, nomeTabela)) {
    return config[nomeTabela] === true;
  }
  return _defaultAtivo.get(nomeTabela) ?? false;
}

module.exports = { lerConfig, salvarConfig, tabelaAtiva, defaultAtivo: _defaultAtivo };
