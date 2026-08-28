const { pool } = require('../../../infrastructure/db');
const { obterNivelEfetivo } = require('../../../infrastructure/cache/permissoesCache');
const { podeLer, podeEscrever } = require('../../../domain/permissoes');
const { TABELA_MODULO } = require('../../../domain/tabelaModulo');

// Lê o plano fresco de sync_tenants a cada requisição (mesmo princípio de
// requirePlanFeature.js: não confiar no claim do JWT, pra não dar 403 indevido logo
// após um upgrade de plano — só que aqui a resolução final passa pelo cache, não por
// uma query direta por requisição).
async function _planoDoSchema(schema) {
  const { rows } = await pool.query('SELECT plano FROM public.sync_tenants WHERE schema_name = $1', [schema]);
  return rows[0]?.plano ?? null; // null -> miss no cache -> fail-closed '--'
}

function _autorizado(nivel, nivelExigido) {
  return nivelExigido === 'w' ? podeEscrever(nivel) : podeLer(nivel);
}

/** Middleware fixo: gate para uma rota cujo módulo é conhecido em tempo de definição da rota. */
function requireModulo(modulo, nivelExigido) {
  return async (req, res, next) => {
    try {
      const schema = req.params.schema;
      const role   = req.userRoles?.[schema];
      const plano  = await _planoDoSchema(schema);
      const nivel  = await obterNivelEfetivo(plano, role, modulo);
      if (!_autorizado(nivel, nivelExigido)) return res.status(403).json({ erro: 'permissão insuficiente' });
      next();
    } catch (e) {
      res.status(500).json({ erro: e.message });
    }
  };
}

/** Middleware table-driven: resolve o módulo a partir de :tabela via TABELA_MODULO, então
 * aplica a mesma checagem. Tabela não mapeada -> next() sem gate (fora do escopo do
 * sistema de módulos, preserva o comportamento atual). */
function requireModuloDaTabela(nivelExigido) {
  return async (req, res, next) => {
    try {
      const tabela = (req.params.tabela || '').toUpperCase();
      const modulo = TABELA_MODULO[tabela];
      if (!modulo) return next();

      const schema = req.params.schema;
      const role   = req.userRoles?.[schema];
      const plano  = await _planoDoSchema(schema);
      const nivel  = await obterNivelEfetivo(plano, role, modulo);
      if (!_autorizado(nivel, nivelExigido)) return res.status(403).json({ erro: 'permissão insuficiente' });
      next();
    } catch (e) {
      res.status(500).json({ erro: e.message });
    }
  };
}

module.exports = { requireModulo, requireModuloDaTabela };
