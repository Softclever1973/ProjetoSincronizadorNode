const { pool } = require('../db');
const { permissaoEfetiva, resolverPermissoesEfetivas } = require('../../domain/permissoes');

let cachePlano = new Map(); // plano -> Map(modulo -> nivel)
let cacheRole  = new Map(); // role  -> Map(modulo -> nivel)
let loaded = false;

async function _carregarPermissoes() {
  const [{ rows: rowsPlano }, { rows: rowsRole }] = await Promise.all([
    pool.query('SELECT plano, modulo, nivel FROM public.permissoes_plano'),
    pool.query('SELECT role, modulo, nivel FROM public.permissoes_role'),
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

  cachePlano = novoPlano;
  cacheRole  = novoRole;
  loaded = true;
}

// Diferente de empresasCache: um cache-miss aqui (plano/role desconhecido) é dado de
// negócio legítimo (fail-closed '--'), não necessariamente staleness — por isso não
// recarrega sozinho num miss, só quando explicitamente invalidado (escrita no
// superadmin ou reload manual).
async function obterPermissoesEfetivas(plano, role) {
  if (!loaded) await _carregarPermissoes();
  return resolverPermissoesEfetivas(cachePlano.get(plano), cacheRole.get(role));
}

async function obterNivelEfetivo(plano, role, modulo) {
  if (!loaded) await _carregarPermissoes();
  return permissaoEfetiva(cachePlano.get(plano), cacheRole.get(role), modulo);
}

async function recarregarPermissoes() {
  loaded = false;
  await _carregarPermissoes();
}

module.exports = { obterPermissoesEfetivas, obterNivelEfetivo, recarregarPermissoes };
