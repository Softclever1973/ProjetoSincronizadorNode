const { pool } = require('#server/infrastructure/db.js');
const { permissaoEfetiva, resolverPermissoesEfetivas } = require('#server/domain/permissoes.js');

let cachePlano   = new Map(); // plano         -> Map(modulo -> nivel)
let cacheRole    = new Map(); // role          -> Map(modulo -> nivel)
let cacheEmpresa = new Map(); // "schema|role" -> Map(modulo -> nivel) — override, ver db-init.js
let loaded = false;

// Chave composta "schema|role" — o override é por (empresa, role), não só por empresa (ver
// comentário de revisão em db-init.js: pedido do usuário pra poder liberar uma função
// comprada só pra um role específico dentro do cliente, não pra empresa inteira). "|" nunca
// aparece em schema_name (regex /^[a-z_][a-z0-9_]*$/ em userEmpresas.js) nem em role (enum
// fixo), então não há ambiguidade na concatenação.
function _chaveEmpresa(schema, role) { return `${schema}|${role}`; }

async function _carregarPermissoes() {
  const [{ rows: rowsPlano }, { rows: rowsRole }, { rows: rowsEmpresa }] = await Promise.all([
    pool.query('SELECT plano, modulo, nivel FROM public.permissoes_plano'),
    pool.query('SELECT role, modulo, nivel FROM public.permissoes_role'),
    pool.query('SELECT schema_name, role, modulo, nivel FROM public.permissoes_empresa'),
  ]);

  const novoPlano = new Map();
  for (const r of rowsPlano) {
    if (!novoPlano.has(r.plano)) novoPlano.set(r.plano, new Map());
    novoPlano.get(r.plano).set(r.modulo, r.nivel);
  }

  const novoRole = new Map();
  for (const r of rowsRole) {
    if (!novoRole.has(r.role)) novoRole.set(r.role, new Map());
    novoRole.get(r.role).set(r.modulo, r.nivel);
  }

  const novoEmpresa = new Map();
  for (const r of rowsEmpresa) {
    const chave = _chaveEmpresa(r.schema_name, r.role);
    if (!novoEmpresa.has(chave)) novoEmpresa.set(chave, new Map());
    novoEmpresa.get(chave).set(r.modulo, r.nivel);
  }

  cachePlano   = novoPlano;
  cacheRole    = novoRole;
  cacheEmpresa = novoEmpresa;
  loaded = true;
}

// Diferente de empresasCache: um cache-miss aqui (plano/role desconhecido) é dado de
// negócio legítimo (fail-closed '--'), não necessariamente staleness — por isso não
// recarrega sozinho num miss, só quando explicitamente invalidado (escrita no
// superadmin ou reload manual). Já um miss em cacheEmpresa é o caso comum (a maioria das
// empresas/role não tem override nenhum) e não é fail-closed — ver domain/permissoes.js.
async function obterPermissoesEfetivas(plano, role, schema) {
  if (!loaded) await _carregarPermissoes();
  return resolverPermissoesEfetivas(cachePlano.get(plano), cacheRole.get(role), cacheEmpresa.get(_chaveEmpresa(schema, role)));
}

async function obterNivelEfetivo(plano, role, modulo, schema) {
  if (!loaded) await _carregarPermissoes();
  return permissaoEfetiva(cachePlano.get(plano), cacheRole.get(role), modulo, cacheEmpresa.get(_chaveEmpresa(schema, role)));
}

async function recarregarPermissoes() {
  loaded = false;
  await _carregarPermissoes();
}

module.exports = { obterPermissoesEfetivas, obterNivelEfetivo, recarregarPermissoes };
