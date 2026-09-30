// A matriz global (permissoes_plano/role) é editada pela tela do superadmin: testes não devem fixar os valores dela.
const { pool } = require('../../src/server/infrastructure/db');
const { permissaoEfetiva } = require('../../src/server/domain/permissoes');
const { recarregarPermissoes } = require('../../src/server/infrastructure/cache/permissoesCache');

async function _matriz(tabela, coluna, chave) {
  const { rows } = await pool.query(`SELECT modulo, nivel FROM public.${tabela} WHERE ${coluna} = $1`, [chave]);
  return new Map(rows.map(r => [r.modulo, r.nivel]));
}

// Nível efetivo segundo o que está gravado hoje no banco (sem override de empresa).
async function nivelEsperado(plano, role, modulo) {
  return permissaoEfetiva(await _matriz('permissoes_plano', 'plano', plano), await _matriz('permissoes_role', 'role', role), modulo);
}

// Override por empresa: fixa o nível só no schema de teste, sem tocar a matriz global.
async function fixarOverrides(schema, role, niveis) {
  for (const [modulo, nivel] of Object.entries(niveis)) {
    await pool.query(
      `INSERT INTO public.permissoes_empresa (schema_name, role, modulo, nivel) VALUES ($1, $2, $3, $4)
       ON CONFLICT (schema_name, role, modulo) DO UPDATE SET nivel = EXCLUDED.nivel`,
      [schema, role, modulo, nivel]
    );
  }
  await recarregarPermissoes();
}

async function limparOverrides(schema) {
  await pool.query('DELETE FROM public.permissoes_empresa WHERE schema_name = $1', [schema]);
  await recarregarPermissoes();
}

module.exports = { nivelEsperado, fixarOverrides, limparOverrides };
