/**
 * Cadastra uma nova empresa no sistema multi-tenant.
 * Cria o schema no PostgreSQL, a infraestrutura de sync, e registra o token.
 *
 * Uso:
 *   node scripts/create-empresa.js --schema=empresa_jb --token=TOKEN_NOVO [--nome="JB Atacado"]
 *
 * Pré-requisito: o servidor já deve ter sido inicializado ao menos uma vez
 * (para que public.sync_tenants exista).
 */

require('dotenv').config();
const { pool } = require('../src/db');
const { initializeTenantSchema } = require('../src/db-init');

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, ...v] = a.slice(2).split('=');
      return [k, v.join('=')];
    })
);

const schema = args.schema;
const token  = args.token;
const nome   = args.nome || schema;

if (!schema || !token) {
  console.error('Uso: node scripts/create-empresa.js --schema=empresa_jb --token=TOKEN [--nome="Nome Empresa"]');
  process.exit(1);
}

if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
  console.error(`Schema inválido: '${schema}'. Use apenas letras minúsculas, números e underscore.`);
  process.exit(1);
}

async function run() {
  try {
    console.log(`\nCriando empresa: schema='${schema}' nome='${nome}'`);

    // Verifica se token já existe
    const { rows: existeToken } = await pool.query(
      'SELECT schema_name FROM public.sync_tenants WHERE token = $1',
      [token]
    );
    if (existeToken.length > 0) {
      console.error(`Erro: token já cadastrado para schema '${existeToken[0].schema_name}'.`);
      process.exit(1);
    }

    // Verifica se schema já está em uso
    const { rows: existeSchema } = await pool.query(
      'SELECT token FROM public.sync_tenants WHERE schema_name = $1',
      [schema]
    );
    if (existeSchema.length > 0) {
      console.error(`Erro: schema '${schema}' já está em uso por outro token.`);
      process.exit(1);
    }

    // Cria schema + toda a infraestrutura de sync (funções, triggers, tabelas)
    await initializeTenantSchema(schema);
    console.log(`  ✓ Schema '${schema}' e infraestrutura de sync criados`);

    // Registra na tabela de controle
    await pool.query(
      'INSERT INTO public.sync_tenants (token, schema_name, nome) VALUES ($1, $2, $3)',
      [token, schema, nome]
    );
    console.log(`  ✓ Empresa registrada em public.sync_tenants`);
    console.log(`\nEmpresa criada com sucesso. O servidor detectará o novo token automaticamente.\n`);
  } finally {
    await pool.end();
  }
}

run().catch(err => {
  console.error('Erro ao criar empresa:', err.message);
  process.exit(1);
});
