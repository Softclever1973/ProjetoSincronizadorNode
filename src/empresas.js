const { pool } = require('./db');

let cache = new Map(); // token → { schema_name, nome }
let loaded = false;

async function _carregarEmpresas() {
  const result = await pool.query(
    'SELECT token, schema_name, nome FROM public.sync_tenants WHERE ativo = TRUE'
  );
  cache = new Map(result.rows.map(r => [r.token, { schema_name: r.schema_name, nome: r.nome }]));
  loaded = true;
}

async function resolverEmpresa(token) {
  if (!loaded) await _carregarEmpresas();
  if (cache.has(token)) return cache.get(token);
  // Cache miss: recarrega uma vez — cobre empresa adicionada sem restart do servidor
  await _carregarEmpresas();
  return cache.get(token) ?? null;
}

async function recarregarEmpresas() {
  loaded = false;
  await _carregarEmpresas();
}

module.exports = { resolverEmpresa, recarregarEmpresas };
