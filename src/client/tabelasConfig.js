const fs   = require('fs');
const path = require('path');

const CAMINHO = path.join(process.cwd(), 'tabelas-config.json');

/**
 * Retorna o objeto de configuração { NOME_TABELA: boolean }.
 * Tabelas ausentes são consideradas ATIVAS por padrão.
 */
function lerConfig() {
  try {
    return JSON.parse(fs.readFileSync(CAMINHO, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Persiste o objeto de configuração no arquivo.
 * Usa write-then-rename para evitar corrupção em caso de falha.
 */
function salvarConfig(config) {
  const tmp = CAMINHO + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
  fs.renameSync(tmp, CAMINHO);
}

/**
 * Retorna true se a tabela está ativa (default: true se ausente do arquivo).
 */
function tabelaAtiva(nomeTabela) {
  const config = lerConfig();
  return config[nomeTabela] !== false;
}

module.exports = { lerConfig, salvarConfig, tabelaAtiva };
