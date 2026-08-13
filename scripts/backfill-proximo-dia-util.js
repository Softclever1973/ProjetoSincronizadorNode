/**
 * Preenche A_RECEBER.PROXIMO_DIA_UTIL / A_PAGAR.PROXIMO_DIA_UTIL onde estiver NULL —
 * fim de semana rola pra segunda-feira seguinte, dia de semana fica igual ao vencimento.
 *
 * Uso:
 *   node scripts/backfill-proximo-dia-util.js                  (dry-run, todos os schemas)
 *   node scripts/backfill-proximo-dia-util.js --schema=empresa_kr
 *   node scripts/backfill-proximo-dia-util.js --apply          (aplica de verdade)
 *   node scripts/backfill-proximo-dia-util.js --apply --force  (sem confirmação interativa)
 */

require('dotenv').config();
const { Pool } = require('pg');
const readline = require('readline');

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, ...v] = a.slice(2).split('=');
      return [k, v.join('=') || true];
    })
);

const pgUrl        = args['pg-url'] || process.env.DATABASE_URL;
const schemaFiltro = args['schema'] || null;
const apply        = 'apply' in args;
const force        = 'force' in args;

const EXPR = `CASE EXTRACT(DOW FROM vencimento)
    WHEN 0 THEN vencimento + INTERVAL '1 day'
    WHEN 6 THEN vencimento + INTERVAL '2 days'
    ELSE vencimento
  END`;

if (!pgUrl) {
  console.error('Erro: DATABASE_URL não definida no .env e --pg-url não informado.');
  process.exit(1);
}

function confirmar() {
  if (force) return Promise.resolve();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('\n⚠️  Isso vai fazer UPDATE nas linhas listadas acima, em produção.\n');
  return new Promise(resolve => {
    rl.question('Confirma a aplicação? (sim/não): ', resp => {
      rl.close();
      if (resp.trim().toLowerCase() !== 'sim') {
        console.log('\nOperação cancelada.');
        process.exit(0);
      }
      resolve();
    });
  });
}

async function contarTabela(pool, schema, tabela) {
  const { rows: existe } = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = 'proximo_dia_util'`,
    [schema, tabela]
  );
  if (existe.length === 0) return null;

  const { rows: [c] } = await pool.query(
    `SELECT count(*) FILTER (WHERE proximo_dia_util IS NULL AND vencimento IS NOT NULL) AS pendentes, count(*) AS total
     FROM "${schema}".${tabela}`
  );
  return c;
}

async function aplicarTabela(pool, schema, tabela) {
  const { rowCount } = await pool.query(
    `UPDATE "${schema}".${tabela}
     SET proximo_dia_util = ${EXPR}
     WHERE proximo_dia_util IS NULL AND vencimento IS NOT NULL`
  );
  return rowCount;
}

async function run() {
  const pool = new Pool({ connectionString: pgUrl });
  try {
    const schemas = schemaFiltro
      ? [{ schema_name: schemaFiltro }]
      : (await pool.query(`SELECT schema_name FROM public.sync_tenants WHERE ativo = true ORDER BY schema_name`)).rows;

    console.log('=== Backfill PROXIMO_DIA_UTIL — levantamento ===\n');

    const pendentes = [];
    for (const { schema_name } of schemas) {
      for (const tabela of ['a_receber', 'a_pagar']) {
        const c = await contarTabela(pool, schema_name, tabela);
        if (!c) continue;
        if (Number(c.pendentes) > 0) {
          console.log(`[${schema_name}.${tabela}] pendentes=${c.pendentes} total=${c.total}`);
          pendentes.push({ schema_name, tabela });
        }
      }
    }

    if (pendentes.length === 0) {
      console.log('\nNada a fazer.');
      return;
    }

    if (!apply) {
      console.log('\nDry-run concluído. Rode de novo com --apply para aplicar (e --force para pular a confirmação).');
      return;
    }

    if (!force) await confirmar();

    console.log('\n=== Aplicando ===\n');
    for (const { schema_name, tabela } of pendentes) {
      const n = await aplicarTabela(pool, schema_name, tabela);
      console.log(`  ✓ [${schema_name}.${tabela}] atualizado: ${n}`);
    }
  } finally {
    await pool.end();
  }
}

run().catch(err => {
  console.error('\nErro:', err.message);
  process.exit(1);
});
