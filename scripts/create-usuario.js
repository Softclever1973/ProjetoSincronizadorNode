/**
 * Cria um usuário no sistema e opcionalmente vincula a um schema existente.
 *
 * Uso:
 *   node scripts/create-usuario.js --email=admin@empresa.com --senha=senha123
 *   node scripts/create-usuario.js --email=admin@empresa.com --senha=senha123 --schema=empresa_kr --role=dono
 *   node scripts/create-usuario.js --email=ger@empresa.com  --senha=senha123 --schema=empresa_kr --role=gerente --loja=2
 *   node scripts/create-usuario.js --email=su@sirius.com    --senha=senha123 --super-admin
 *
 * Use este script para criar o primeiro usuário (bootstrap) — não há endpoint público de registro.
 * Roles disponíveis: dono | gerente | vendedor
 * --loja é obrigatório para gerente e vendedor.
 * --super-admin concede acesso ao painel de gestão de empresas (/admin.html).
 */

require('dotenv').config();
const { Pool }  = require('pg');
const bcrypt    = require('bcryptjs');

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, ...v] = a.slice(2).split('=');
      return [k, v.join('=')];
    })
);

const email       = args.email;
const senha       = args.senha;
const schema      = args.schema ?? null;
const role        = args.role   ?? 'dono';
const loja        = args.loja   ? parseInt(args.loja) : null;
const superAdmin  = 'super-admin' in args;

const ROLES_VALIDOS = ['dono', 'gerente', 'vendedor'];

if (!email || !senha) {
  console.error('Uso: node scripts/create-usuario.js --email=admin@empresa.com --senha=senha123 [--schema=empresa_kr --role=dono] [--super-admin]');
  process.exit(1);
}

if (!ROLES_VALIDOS.includes(role)) {
  console.error(`Erro: role inválido '${role}'. Use: ${ROLES_VALIDOS.join(' | ')}`);
  process.exit(1);
}

if (schema && role !== 'dono' && !loja) {
  console.error(`Erro: --loja é obrigatório para role '${role}'.`);
  process.exit(1);
}

async function run() {
  const pool   = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    const existe = await client.query(
      'SELECT id FROM public.usuarios WHERE email = $1', [email]
    );
    if (existe.rows.length > 0) {
      console.error(`Erro: email '${email}' já cadastrado.`);
      process.exit(1);
    }

    const senhaHash = await bcrypt.hash(senha, 12);
    const result    = await client.query(
      'INSERT INTO public.usuarios (email, senha_hash, is_super_admin) VALUES ($1, $2, $3) RETURNING id',
      [email, senhaHash, superAdmin]
    );
    const id = result.rows[0].id;
    const superTag = superAdmin ? ' [SUPER-ADMIN]' : '';
    console.log(`  ✓ Usuário criado: id=${id} email=${email}${superTag}`);

    if (schema) {
      const schemaExiste = await client.query(
        'SELECT 1 FROM public.sync_tenants WHERE schema_name = $1', [schema]
      );
      if (schemaExiste.rows.length === 0) {
        console.log(`  ! Schema '${schema}' não encontrado em sync_tenants — vínculo não criado.`);
      } else {
        await client.query(
          'INSERT INTO public.usuarios_empresas (id_usuario, schema_name, role, id_loja) VALUES ($1, $2, $3, $4)',
          [id, schema, role, loja]
        );
        const lojaInfo = loja ? ` (loja ${loja})` : '';
        console.log(`  ✓ Vinculado ao schema '${schema}' como ${role}${lojaInfo}`);
      }
    }

    console.log('\nUsuário criado com sucesso.\n');
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => {
  console.error('Erro:', err.message);
  process.exit(1);
});
