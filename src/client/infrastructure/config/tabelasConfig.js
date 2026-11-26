const fs     = require('fs');
const path   = require('path');
const TABELAS = require('#client/domain/tabelas.js');
const { getParam } = require('#client/infrastructure/firebird/db.js');

const CAMINHO = path.join(process.cwd(), 'tabelas-config.json');

const _defaultAtivo = new Map(TABELAS.map(t => [t.nome, t.defaultAtivo === true]));
const _condicao = new Map(TABELAS.filter(t => t.parametroAtivo).map(t => [t.nome, t.parametroAtivo]));
// Valores lidos do PARAMETROS (id → valor); sem leitura ainda = tabela condicionada fica bloqueada.
const _parametros = new Map();

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

// Relê do Firebird os parâmetros que condicionam tabelas (chamado no início de cada ciclo e na tela).
async function atualizarParametrosTabelas(db) {
  for (const id of new Set([..._condicao.values()].map(c => c.id))) {
    try { _parametros.set(id, (await getParam(db, id)).toUpperCase()); } catch { _parametros.delete(id); }
  }
}

/**
 * Tabela controlada por parâmetro: { id, valor, atual, ativa }; null quando quem decide é o toggle.
 */
function controlePorParametro(nomeTabela) {
  const c = _condicao.get(nomeTabela);
  if (!c) return null;
  const atual = _parametros.get(c.id) ?? null;
  return { id: c.id, valor: c.valor, atual, ativa: atual === c.valor.toUpperCase() };
}

/**
 * Retorna true se a tabela está ativa.
 * Prioridade: parâmetro do Firebird (parametroAtivo) > valor salvo no JSON > defaultAtivo de tabelas.js > false.
 */
function tabelaAtiva(nomeTabela) {
  const porParametro = controlePorParametro(nomeTabela);
  if (porParametro) return porParametro.ativa;
  const config = lerConfig();
  if (Object.prototype.hasOwnProperty.call(config, nomeTabela)) {
    return config[nomeTabela] === true;
  }
  return _defaultAtivo.get(nomeTabela) ?? false;
}

module.exports = { lerConfig, salvarConfig, tabelaAtiva, defaultAtivo: _defaultAtivo, atualizarParametrosTabelas, controlePorParametro };
