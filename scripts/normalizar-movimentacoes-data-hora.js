/**
 * Normaliza MOVIMENTACOES.DATA/HORA para o formato limpo ("YYYY-MM-DD" / "HH:MM:SS")
 * em linhas legadas que ainda estão no formato serializado de Date do node-firebird
 * ("1970-0M-0DTHH:MM:SS.000Z" para HORA, "YYYY-MM-DDT03:00:00.000Z" para DATA — ver
 * comentário em src/routes/sincronizacao.js sobre por que isso acontecia).
 *
 * Ambas as colunas são TEXT no PostgreSQL, então o ORDER BY das telas web (crud.js)
 * é uma comparação de string — linhas nesse formato antigo ordenam fora de ordem
 * cronológica quando misturadas com linhas no formato limpo.
 *
 * HORA: extrai a hora-do-dia via "AT TIME ZONE 'UTC'" (funciona mesmo nos casos em
 * que o valor rolou para 1970-01-02 — ver investigação, provavelmente um bug de dupla
 * conversão de fuso em alguma versão antiga do código; a extração de hora-do-dia é
 * independente de qual dia do epoch o valor caiu).
 * DATA: sempre com sufixo "T03:00:00.000Z" (meia-noite local BRT = 03:00 UTC), então
 * os 10 primeiros caracteres já são a data correta — sem risco de virada de dia.
 *
 * Uso:
 *   node scripts/normalizar-movimentacoes-data-hora.js                  (dry-run, todos os schemas)
 *   node scripts/normalizar-movimentacoes-data-hora.js --schema=empresa_kr_reforma
 *   node scripts/normalizar-movimentacoes-data-hora.js --apply          (aplica de verdade)
 *   node scripts/normalizar-movimentacoes-data-hora.js --apply --force  (sem confirmação interativa)
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

const HORA_REGEX = '^1970-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.000Z$';
const DATA_REGEX = '^\\d{4}-\\d{2}-\\d{2}T03:00:00\\.000Z$';

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

async function contarSchema(pool, schema) {
  const { rows: existe } = await pool.query(
    `SELECT 1 FROM pg_tables WHERE schemaname = $1 AND tablename = 'movimentacoes'`,
    [schema]
  );
  if (existe.length === 0) return null;

  const { rows: [contagem] } = await pool.query(
    `SELECT
       count(*) FILTER (WHERE hora ~ $1) AS hora_legado,
       count(*) FILTER (WHERE data ~ $2) AS data_legado,
       count(*) AS total
     FROM "${schema}".movimentacoes`,
    [HORA_REGEX, DATA_REGEX]
  );
  console.log(
    Number(contagem.hora_legado) === 0 && Number(contagem.data_legado) === 0
      ? `[${schema}] nada a normalizar (${contagem.total} linhas).`
      : `[${schema}] total=${contagem.total} hora_legado=${contagem.hora_legado} data_legado=${contagem.data_legado}`
  );
  return contagem;
}

async function aplicarSchema(pool, schema) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rHora = await client.query(
      `UPDATE "${schema}".movimentacoes
       SET hora = to_char(hora::timestamptz AT TIME ZONE 'UTC', 'HH24:MI:SS')
       WHERE hora ~ $1`,
      [HORA_REGEX]
    );
    const rData = await client.query(
      `UPDATE "${schema}".movimentacoes
       SET data = substring(data from 1 for 10)
       WHERE data ~ $1`,
      [DATA_REGEX]
    );
    await client.query('COMMIT');
    console.log(`  ✓ [${schema}] aplicado: hora=${rHora.rowCount} data=${rData.rowCount}`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(`  ✗ [${schema}] erro, rollback:`, e.message);
  } finally {
    client.release();
  }
}

async function run() {
  const pool = new Pool({ connectionString: pgUrl });
  try {
    const schemas = schemaFiltro
      ? [{ schema_name: schemaFiltro }]
      : (await pool.query(`SELECT schema_name FROM public.sync_tenants WHERE ativo = true ORDER BY schema_name`)).rows;

    console.log('=== Normalização MOVIMENTACOES.DATA/HORA — levantamento ===\n');

    const pendentes = [];
    for (const { schema_name } of schemas) {
      const r = await contarSchema(pool, schema_name);
      if (r && (Number(r.hora_legado) > 0 || Number(r.data_legado) > 0)) pendentes.push(schema_name);
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
    for (const schema_name of pendentes) {
      await aplicarSchema(pool, schema_name);
    }
  } finally {
    await pool.end();
  }
}

run().catch(err => {
  console.error('\nErro:', err.message);
  process.exit(1);
});
