/**
 * Corrige clientes com SITUACAO vazia (cadastrados pelo site antes de ela ser preenchida): grava 'A'
 * e dá novo ID_ULTIMA_ATUALIZACAO_MATRIZ, para o valor descer também às lojas.
 *
 * Uso:
 *   node scripts/corrigir-situacao-clientes.js                     (simulação, todas as empresas)
 *   node scripts/corrigir-situacao-clientes.js --schema=empresa_x  (uma empresa)
 *   node scripts/corrigir-situacao-clientes.js --executar          (aplica, depois de confirmar com "sim")
 *   --force pula a confirmação (só com --executar)
 */

require('dotenv').config();
const readline = require('readline');
const { pool, withTenantConnection, query, execute } = require('../src/server/infrastructure/db');
const { schemaTenantValido } = require('../src/server/domain/validacao');

const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
  const [k, ...v] = a.slice(2).split('=');
  return [k, v.join('=')];
}));
const executar = 'executar' in args;
const force = 'force' in args;

if (args.schema && !schemaTenantValido(args.schema)) {
  console.error(`Schema inválido: "${args.schema}".`);
  process.exit(1);
}

const VAZIA = "NULLIF(TRIM(SITUACAO::TEXT), '') IS NULL";

// Colunas de CLIENTES no tenant (vazio = tabela ainda não existe).
async function colunasClientes(db, schema) {
  return new Set((await query(db, `
    SELECT UPPER(column_name) AS col FROM information_schema.columns
    WHERE table_schema = $1 AND LOWER(table_name) = 'clientes'`, [schema])).map(r => r.COL));
}

async function analisar(schema) {
  return withTenantConnection(schema, async db => {
    const colunas = await colunasClientes(db, schema);
    if (!colunas.has('SITUACAO')) return null;
    const clientes = await query(db, `SELECT SRV_ID, ID_CLIENTE, RAZAO_SOCIAL FROM CLIENTES WHERE ${VAZIA} ORDER BY SRV_ID`);
    return { colunas, clientes };
  });
}

async function aplicar(schema, colunas) {
  return withTenantConnection(schema, async db => {
    const bump = colunas.has('ID_ULTIMA_ATUALIZACAO_MATRIZ')
      ? `, ID_ULTIMA_ATUALIZACAO_MATRIZ = nextval('${schema}.seq_atualizacao_matriz')` : '';
    // Refeito aqui: só mexe no que continua vazio no momento do "sim".
    const r = await execute(db, `UPDATE CLIENTES SET SITUACAO = 'A'${bump} WHERE ${VAZIA}`);
    return r?.rowCount ?? 0;
  });
}

async function main() {
  const schemas = args.schema
    ? [args.schema]
    : (await pool.query('SELECT schema_name FROM public.sync_tenants ORDER BY schema_name')).rows.map(r => r.schema_name);

  const plano = [];
  for (const schema of schemas) {
    let r;
    try { r = await analisar(schema); } catch (e) { console.error(`[${schema}] erro ao analisar: ${e.message}`); continue; }
    if (!r?.clientes.length) continue;
    plano.push({ schema, ...r });
    console.log(`\n== ${schema}: ${r.clientes.length} cliente(s) sem SITUACAO`);
    for (const c of r.clientes.slice(0, 20)) {
      console.log(`  SRV_ID ${c.SRV_ID}  ID_CLIENTE ${c.ID_CLIENTE ?? '(aguardando loja)'}  ${c.RAZAO_SOCIAL ?? ''}`);
    }
    if (r.clientes.length > 20) console.log(`  … e mais ${r.clientes.length - 20}`);
  }

  if (!plano.length) { console.log('Nenhum cliente sem SITUACAO.'); return; }
  if (!executar) { console.log("\nSimulação — nada foi alterado. Para gravar SITUACAO = 'A': --executar"); return; }

  if (!force) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const resp = await new Promise(r => rl.question("\nGravar SITUACAO = 'A' nesses clientes? (sim/não): ", r));
    rl.close();
    if (resp.trim().toLowerCase() !== 'sim') { console.log('Cancelado.'); return; }
  }
  for (const p of plano) {
    const n = await aplicar(p.schema, p.colunas);
    console.log(`  ✔ ${p.schema}: ${n} cliente(s) corrigido(s)`);
  }
}

main()
  .catch(e => { console.error(`Erro: ${e.message}`); process.exitCode = 1; })
  .finally(() => pool.end());
