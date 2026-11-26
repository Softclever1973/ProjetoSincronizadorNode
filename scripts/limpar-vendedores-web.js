/**
 * Limpa os vendedores que o servidor criava sozinho (antes de o site só vincular vendedores do Sirius).
 *
 * "DONO" negativo (ID = -id do usuário, criado no login do dono):
 *   - padrão: mantido, renomeado com o nome do dono e inativo (STATUS 'I') — a loja pode ter pedidos com ele
 *     que o servidor não vê (tabelas fora do sync, pedidos além da retenção de 2 anos)
 *   - com --apagar-sem-referencia: apagado se nenhuma tabela do servidor o usar (o trigger de DELETE leva a
 *     exclusão às lojas); só depois de conferir nas lojas que o Sirius também não o usa
 *   Nos dois casos o vínculo usuarios_empresas.id_vendedor do dono é desfeito.
 * Vendedor ligado a usuário e que nunca foi para as lojas (ID_ULTIMA_ATUALIZACAO_MATRIZ nulo, criado com MAX+1):
 *   só listado — decidir caso a caso (a loja pode ter outro vendedor com o mesmo ID).
 *
 * Uso:
 *   node scripts/limpar-vendedores-web.js                     (simulação, todas as empresas)
 *   node scripts/limpar-vendedores-web.js --schema=empresa_x  (uma empresa)
 *   node scripts/limpar-vendedores-web.js --executar          (aplica, depois de confirmar com "sim")
 *   --force pula a confirmação (só com --executar)
 *   --apagar-sem-referencia apaga em vez de inativar os "DONO" sem uso no servidor
 */

require('dotenv').config();
const readline = require('readline');
const { pool, withTenantConnection, query, execute } = require('../src/server/infrastructure/db');
const { schemaTenantValido } = require('../src/server/domain/validacao');
const { migrarTriggersDelecao } = require('../src/server/infrastructure/db-init');

const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
  const [k, ...v] = a.slice(2).split('=');
  return [k, v.join('=')];
}));
const executar = 'executar' in args;
const force = 'force' in args;
const apagarSemReferencia = 'apagar-sem-referencia' in args;

if (args.schema && !schemaTenantValido(args.schema)) {
  console.error(`Schema inválido: "${args.schema}".`);
  process.exit(1);
}

// Tabelas do tenant (fora VENDEDORES) com coluna ID_VENDEDOR, para achar quem usa cada vendedor.
async function tabelasComVendedor(db, schema) {
  return (await query(db, `
    SELECT DISTINCT table_name AS tabela FROM information_schema.columns
    WHERE table_schema = $1 AND UPPER(column_name) = 'ID_VENDEDOR' AND LOWER(table_name) <> 'vendedores'`, [schema]))
    .map(r => r.TABELA);
}

// Onde o vendedor é usado no servidor (ex.: ['PEDIDOS: 3']); não enxerga o que só existe no Firebird da loja.
async function referenciasDe(db, tabelas, idVendedor) {
  const refs = [];
  for (const t of tabelas) {
    const [{ N }] = await query(db, `SELECT COUNT(*)::int AS n FROM "${t}" WHERE ID_VENDEDOR = $1`, [idVendedor]);
    if (N) refs.push(`${t.toUpperCase()}: ${N}`);
  }
  return refs;
}

async function analisar(schema) {
  return withTenantConnection(schema, async db => {
    const colunas = new Set((await query(db, `
      SELECT UPPER(column_name) AS col FROM information_schema.columns
      WHERE table_schema = $1 AND LOWER(table_name) = 'vendedores'`, [schema])).map(r => r.COL));
    if (!colunas.size) return null;

    const negativos = await query(db, 'SELECT ID_VENDEDOR, NOME FROM VENDEDORES WHERE ID_VENDEDOR < 0 ORDER BY ID_VENDEDOR DESC');
    const tabelas = await tabelasComVendedor(db, schema);
    for (const v of negativos) {
      v.referencias = await referenciasDe(db, tabelas, v.ID_VENDEDOR);
      const [dono] = (await pool.query('SELECT nome, email FROM public.usuarios WHERE id = $1', [-v.ID_VENDEDOR])).rows;
      v.dono = dono ?? null;
    }

    // Vínculos com vendedor que nunca desceu para as lojas (criado pelo site com MAX+1).
    const vinculados = (await pool.query(
      'SELECT u.email, ue.id_vendedor FROM public.usuarios_empresas ue JOIN public.usuarios u ON u.id = ue.id_usuario WHERE ue.schema_name = $1 AND ue.id_vendedor > 0',
      [schema])).rows;
    const naoSincronizados = [];
    if (colunas.has('ID_ULTIMA_ATUALIZACAO_MATRIZ')) {
      for (const l of vinculados) {
        const [v] = await query(db, 'SELECT NOME, ID_ULTIMA_ATUALIZACAO_MATRIZ FROM VENDEDORES WHERE ID_VENDEDOR = $1', [l.id_vendedor]);
        if (v && v.ID_ULTIMA_ATUALIZACAO_MATRIZ == null) naoSincronizados.push({ ...l, nome: v.NOME });
      }
    }
    return { colunas, negativos, naoSincronizados };
  });
}

async function aplicar(schema, { colunas, negativos }) {
  // Garante o trigger que registra a exclusão em registros_deletados (é ele que leva o DELETE às lojas).
  if (apagarSemReferencia) await migrarTriggersDelecao(schema);
  await withTenantConnection(schema, async db => {
    const tabelas = await tabelasComVendedor(db, schema);
    // Uma transação: vendedor e vínculo do usuário mudam juntos, ou nada muda.
    await execute(db, 'BEGIN');
    try {
      for (const v of negativos) {
        // Recontado aqui: um pedido pode ter usado o vendedor entre a simulação e o "sim".
        if (apagarSemReferencia && (await referenciasDe(db, tabelas, v.ID_VENDEDOR)).length === 0) {
          await execute(db, 'DELETE FROM VENDEDORES WHERE ID_VENDEDOR = $1', [v.ID_VENDEDOR]);
        } else {
          const nome = String(v.dono?.nome || v.dono?.email || 'DONO').trim().slice(0, 45);
          const sets = ['NOME = $2', ...(colunas.has('STATUS') ? ["STATUS = 'I'"] : []),
            ...(colunas.has('ID_ULTIMA_ATUALIZACAO_MATRIZ') ? [`ID_ULTIMA_ATUALIZACAO_MATRIZ = nextval('${schema}.seq_atualizacao_matriz')`] : [])];
          await execute(db, `UPDATE VENDEDORES SET ${sets.join(', ')} WHERE ID_VENDEDOR = $1`, [v.ID_VENDEDOR, nome]);
        }
        await execute(db, 'UPDATE public.usuarios_empresas SET id_vendedor = NULL WHERE schema_name = $1 AND id_vendedor = $2',
          [schema, v.ID_VENDEDOR]);
      }
      await execute(db, 'COMMIT');
    } catch (e) {
      await execute(db, 'ROLLBACK').catch(() => {});
      throw e;
    }
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
    if (!r || (!r.negativos.length && !r.naoSincronizados.length)) continue;
    plano.push({ schema, ...r });

    console.log(`\n== ${schema}`);
    for (const v of r.negativos) {
      const quem = v.dono ? `${v.dono.nome || ''} <${v.dono.email}>` : 'usuário não encontrado';
      const uso = v.referencias.length ? `usado em ${v.referencias.join(', ')}` : 'sem uso no servidor';
      console.log(apagarSemReferencia && !v.referencias.length
        ? `  apagar             ${v.ID_VENDEDOR} "${v.NOME}" (${quem}) — ${uso}`
        : `  inativar/renomear  ${v.ID_VENDEDOR} "${v.NOME}" (${quem}) — ${uso}`);
    }
    for (const l of r.naoSincronizados) {
      console.log(`  ⚠️ revisar à mão     ${l.id_vendedor} "${l.nome}" vinculado a ${l.email} — nunca foi para as lojas`);
    }
  }

  if (!plano.length) { console.log('Nada a limpar.'); return; }
  if (!executar) { console.log('\nSimulação — nada foi alterado. Para aplicar: --executar'); return; }

  if (!force) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const resp = await new Promise(r => rl.question('\nAplicar as mudanças acima? (sim/não): ', r));
    rl.close();
    if (resp.trim().toLowerCase() !== 'sim') { console.log('Cancelado.'); return; }
  }
  for (const p of plano) {
    if (!p.negativos.length) continue;
    await aplicar(p.schema, p);
    console.log(`  ✔ ${p.schema}: ${p.negativos.length} vendedor(es) "DONO" tratado(s)`);
  }
  console.log('Os vendedores revisados à mão não foram alterados. Os usuários afetados verão o vínculo novo no próximo login.');
}

main()
  .catch(e => { console.error(`Erro: ${e.message}`); process.exitCode = 1; })
  .finally(() => pool.end());
