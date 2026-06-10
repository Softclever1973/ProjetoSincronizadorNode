/**
 * Restaura o schema de uma empresa ao estado logo após create-empresa.
 *
 * O que faz:
 *   PostgreSQL — remove todas as tabelas de dados (PRODUTOS, CLIENTES, etc.),
 *                limpa as tabelas de infraestrutura e reinicia as sequências.
 *   Firebird   — zera os cursores de sync e limpa as filas de pendentes/erros.
 *   JSON       — limpa conflitos.json e erros.json do diretório informado.
 *
 * Uso:
 *   node scripts/reset-empresa.js --schema=empresa_jb [opções]
 *
 * Opções PostgreSQL (usa DATABASE_URL do .env se não informado):
 *   --pg-url=postgresql://user:pass@host:5432/db
 *
 * Opções Firebird (omita para pular o reset do cliente):
 *   --fb-database=C:\FDBS\filial.fdb   (caminho completo)
 *   --fb-password=senha                (obrigatório com --fb-database)
 *   --fb-host=localhost                (padrão: localhost)
 *   --fb-port=3050                     (padrão: 3050)
 *   --fb-user=SYSDBA                   (padrão: SYSDBA)
 *   --fb-timeout=30000                 (timeout em ms para UPDATE SRV_ID, padrão: 30000)
 *   --skip-fb-srv-id                   (pula a limpeza de SRV_ID — útil quando há locks nas tabelas)
 *
 * Opções adicionais:
 *   --json-dir=C:\caminho              (diretório dos .json, padrão: cwd)
 *   --force                            (pula confirmação interativa)
 */

require('dotenv').config();
const { Pool }   = require('pg');
const Firebird   = require('node-firebird');
const readline   = require('readline');
const fs         = require('fs');
const path       = require('path');

// Tabelas de infraestrutura criadas pelo create-empresa — mantidas, apenas limpas
const TABELAS_INFRA = new Set([
  'filiais_bloqueadas',
  'registros_deletados',
  'sync_filiais',
  'sync_config',
  'srv_id_map',
]);

// ── Parse de argumentos ───────────────────────────────────────────────────────

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, ...v] = a.slice(2).split('=');
      return [k, v.join('=')];
    })
);

const schema      = args['schema'];
const pgUrl       = args['pg-url'] || process.env.DATABASE_URL;
const fbDatabase  = args['fb-database'];
const fbPassword  = args['fb-password'];
const fbHost      = args['fb-host'] || 'localhost';
const fbPort      = parseInt(args['fb-port'] || '3050', 10);
const fbUser      = args['fb-user']  || 'SYSDBA';
const jsonDir     = args['json-dir'] || process.cwd();
const force       = 'force' in args;
const skipFbSrvId = 'skip-fb-srv-id' in args;
const fbTimeout   = parseInt(args['fb-timeout'] || '30000', 10);

// ── Validação ─────────────────────────────────────────────────────────────────

if (!schema) {
  console.error('Erro: --schema é obrigatório.');
  console.error('Uso: node scripts/reset-empresa.js --schema=empresa_jb [--pg-url=...] [--fb-database=... --fb-password=...]');
  process.exit(1);
}

if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
  console.error(`Schema inválido: "${schema}". Use apenas letras minúsculas, números e underscore.`);
  process.exit(1);
}

if (!pgUrl) {
  console.error('Erro: DATABASE_URL não definida no .env e --pg-url não informado.');
  process.exit(1);
}

if (fbDatabase && !fbPassword) {
  console.error('Erro: --fb-password é obrigatório quando --fb-database é informado.');
  process.exit(1);
}

// ── Confirmação interativa ────────────────────────────────────────────────────

function confirmar() {
  if (force) return Promise.resolve();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const urlLog = pgUrl.replace(/:([^:@/][^@]*)@/, ':***@');
  console.log('\n⚠️  ATENÇÃO — Esta operação é irreversível. Ela irá:\n');
  console.log(`  PostgreSQL (${urlLog})`);
  console.log(`    • Remover TODAS as tabelas de dados do schema "${schema}"`);
  console.log(`    • Truncar as tabelas de infraestrutura (filiais, config, srv_id_map, etc.)`);
  console.log(`    • Reiniciar as sequências seq_atualizacao_matriz, seq_srv_id e seq_srv_id_<tabela>`);
  if (fbDatabase) {
    console.log(`\n  Firebird (${fbDatabase})`);
    console.log('    • Limpar SYNC_ALTERACOES_PENDENTES, SYNC_VERSOES_SERVIDOR, SYNC_ERROS');
    console.log('    • Zerar cursores em ULTIMOS_REGISTROS_MATRIZ');
    console.log('    • Limpar coluna SRV_ID em todas as tabelas sincronizadas');
    console.log(`\n  JSON (${jsonDir})`);
    console.log('    • Limpar conflitos.json e erros.json');
  }
  console.log('\n  Certifique-se de que o servidor Node.js está PARADO antes de continuar.\n');
  return new Promise(resolve => {
    rl.question('Confirma o reset? (sim/não): ', resp => {
      rl.close();
      if (resp.trim().toLowerCase() !== 'sim') {
        console.log('\nOperação cancelada.');
        process.exit(0);
      }
      resolve();
    });
  });
}

// ── Reset PostgreSQL ──────────────────────────────────────────────────────────

async function resetPostgres() {
  const urlLog = pgUrl.replace(/:([^:@/][^@]*)@/, ':***@');
  console.log(`\n[PostgreSQL] Conectando a "${urlLog}"...`);

  const pool = new Pool({ connectionString: pgUrl });
  const client = await pool.connect();

  try {
    // Verifica se o schema existe
    const { rows: schemaCheck } = await client.query(
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1`,
      [schema]
    );
    if (schemaCheck.length === 0) {
      throw new Error(`Schema "${schema}" não encontrado no banco de dados.`);
    }

    // Lista todas as tabelas do schema
    const { rows: todasTabelas } = await client.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename`,
      [schema]
    );

    const tabelasDados = todasTabelas
      .map(r => r.tablename)
      .filter(t => !TABELAS_INFRA.has(t));

    console.log(`[PostgreSQL] Schema "${schema}": ${tabelasDados.length} tabela(s) de dados encontrada(s)\n`);

    // Remove tabelas de dados (CASCADE cuida das FKs)
    if (tabelasDados.length > 0) {
      console.log('[PostgreSQL] Removendo tabelas de dados:');
      for (const tabela of tabelasDados) {
        await client.query(`DROP TABLE IF EXISTS "${schema}"."${tabela}" CASCADE`);
        console.log(`  ✓ ${tabela}`);
      }
    } else {
      console.log('[PostgreSQL] Nenhuma tabela de dados encontrada — schema já está limpo.');
    }

    // Trunca tabelas de infraestrutura existentes
    console.log('\n[PostgreSQL] Limpando tabelas de infraestrutura:');
    for (const tabela of TABELAS_INFRA) {
      const { rows: existe } = await client.query(
        `SELECT 1 FROM pg_tables WHERE schemaname = $1 AND tablename = $2`,
        [schema, tabela]
      );
      if (existe.length > 0) {
        await client.query(`TRUNCATE TABLE "${schema}"."${tabela}" CASCADE`);
        console.log(`  ✓ ${tabela}`);
      } else {
        console.log(`  - ${tabela} não existe (ignorado)`);
      }
    }

    // Reinicia sequências globais
    console.log('\n[PostgreSQL] Reiniciando sequências:');
    await client.query(`ALTER SEQUENCE IF EXISTS "${schema}".seq_atualizacao_matriz RESTART WITH 1`);
    console.log('  ✓ seq_atualizacao_matriz → 1');
    await client.query(`ALTER SEQUENCE IF EXISTS "${schema}".seq_srv_id RESTART WITH 1`);
    console.log('  ✓ seq_srv_id → 1');

    // Remove sequences por-tabela criadas pelo novo sistema (seq_srv_id_<tabela>)
    const { rows: seqsPortabela } = await client.query(
      `SELECT sequencename FROM pg_sequences
       WHERE schemaname = $1 AND sequencename LIKE 'seq_srv_id_%' AND sequencename <> 'seq_srv_id'`,
      [schema]
    );
    if (seqsPortabela.length > 0) {
      for (const { sequencename } of seqsPortabela) {
        await client.query(`DROP SEQUENCE IF EXISTS "${schema}"."${sequencename}"`);
        console.log(`  ✓ ${sequencename} removida`);
      }
    }

    console.log('\n[PostgreSQL] Reset concluído.');
  } finally {
    client.release();
    await pool.end();
  }
}

// ── Helpers Firebird (promisificados) ─────────────────────────────────────────

function fbAttach(options) {
  return new Promise((resolve, reject) =>
    Firebird.attach(options, (err, db) => err ? reject(err) : resolve(db))
  );
}

function fbQuery(db, sql, params = []) {
  return new Promise((resolve, reject) =>
    db.query(sql, params, (err, result) => err ? reject(err) : resolve(result || []))
  );
}

// fbQuery com timeout — evita travar se outra aplicação tiver lock na tabela
function fbQueryComTimeout(db, sql, params = [], ms = 8000) {
  return Promise.race([
    fbQuery(db, sql, params),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timeout (${ms / 1000}s) — feche o Delphi e outras conexões ao Firebird`)), ms)
    ),
  ]);
}

function fbDetach(db) {
  return new Promise(resolve => db.detach(resolve));
}

function ehErroDeTabelaNaoEncontrada(e) {
  const msg = (e.message || '').toLowerCase();
  return msg.includes('table unknown') || msg.includes('object not found') || msg.includes('-204');
}

// ── Reset Firebird ────────────────────────────────────────────────────────────

async function resetFirebird() {
  console.log(`\n[Firebird] Conectando a "${fbDatabase}"...`);

  const options = {
    host:           fbHost,
    port:           fbPort,
    database:       fbDatabase,
    user:           fbUser,
    password:       fbPassword,
    lowercase_keys: false,
  };

  let db;
  try {
    db = await fbAttach(options);
    console.log('[Firebird] Conectado.\n');

    // Limpa filas de pendentes e erros
    const tabelasLimpar = [
      'SYNC_ALTERACOES_PENDENTES',
      'SYNC_VERSOES_SERVIDOR',
      'SYNC_ERROS',
    ];

    console.log('[Firebird] Limpando tabelas de sync:');
    for (const tabela of tabelasLimpar) {
      try {
        await fbQuery(db, `DELETE FROM ${tabela}`);
        console.log(`  ✓ ${tabela}`);
      } catch (e) {
        if (ehErroDeTabelaNaoEncontrada(e)) {
          console.log(`  - ${tabela} não existe (ignorado)`);
        } else {
          throw e;
        }
      }
    }

    // Zera cursores de sync
    try {
      await fbQuery(db,
        `UPDATE ULTIMOS_REGISTROS_MATRIZ
         SET ULTIMO_REGISTRO_ATUALIZADO = 0,
             ULTIMO_REGISTRO_DELETADO   = 0`
      );
      console.log('  ✓ ULTIMOS_REGISTROS_MATRIZ — cursores zerados');
    } catch (e) {
      if (ehErroDeTabelaNaoEncontrada(e)) {
        console.log('  - ULTIMOS_REGISTROS_MATRIZ não existe (ignorado)');
      } else {
        throw e;
      }
    }

    // Limpa a coluna SRV_ID nas tabelas que a possuem
    if (skipFbSrvId) {
      console.log('\n[Firebird] Limpeza de SRV_ID ignorada (--skip-fb-srv-id).');
    } else {
      const tabelasComSrvId = [
        'PRODUTOS', 'PRODUTOS_GRADES', 'PRODUTOS_X_LISTA', 'MOVIMENTACOES',
        'CLIENTES', 'CLIENTES_X_ENTREGA', 'FORNECEDORES', 'FORN_CONTATOS_ADICIONAIS',
        'TRANSPORTADORES', 'TRANSP_CONTATOS_ADICIONAIS', 'TRANSPORTADORES_PLACAS',
        'REPRESENTANTES', 'PEDIDOS', 'PEDIDOS_ITENS',
      ];
      console.log(`\n[Firebird] Limpando SRV_ID (timeout: ${fbTimeout / 1000}s — feche o Delphi antes se travar):`);
      console.log('           Use --skip-fb-srv-id para pular esta etapa se houver locks.\n');
      for (const tabela of tabelasComSrvId) {
        try {
          await fbQueryComTimeout(db, `UPDATE ${tabela} SET SRV_ID = NULL`, [], fbTimeout);
          console.log(`  ✓ ${tabela}.SRV_ID = NULL`);
        } catch (e) {
          if (ehErroDeTabelaNaoEncontrada(e)) {
            console.log(`  - ${tabela} não existe (ignorado)`);
          } else {
            console.warn(`  ⚠ ${tabela}: ${e.message}`);
          }
        }
      }
    }

    console.log('\n[Firebird] Reset concluído.');
  } finally {
    if (db) await fbDetach(db);
  }
}

// ── Limpa arquivos JSON ───────────────────────────────────────────────────────

function limparJson() {
  const arquivos = ['conflitos.json', 'erros.json'];
  console.log(`\n[JSON] Limpando arquivos em "${jsonDir}":`);
  for (const nome of arquivos) {
    const caminho = path.join(jsonDir, nome);
    try {
      fs.writeFileSync(caminho, '{}', 'utf8');
      console.log(`  ✓ ${nome}`);
    } catch (e) {
      if (e.code === 'ENOENT') {
        console.log(`  - ${nome} não existe (ignorado)`);
      } else {
        console.warn(`  ⚠ Não foi possível limpar ${nome}: ${e.message}`);
      }
    }
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function run() {
  console.log(`\n=== Reset de empresa: schema "${schema}" ===`);
  await confirmar();
  await resetPostgres();
  if (fbDatabase) {
    await resetFirebird();
    limparJson();
  }
  console.log(`\n✓ Schema "${schema}" restaurado ao estado pós create-empresa.\n`);
}

run().catch(err => {
  console.error('\nErro:', err.message);
  process.exit(1);
});
