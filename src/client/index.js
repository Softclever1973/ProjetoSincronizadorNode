const fs = require('fs');
const path = require('path');

const isPackaged = typeof process.pkg !== 'undefined';

// Quando empacotado, __dirname é read-only (virtual). Usa o diretório do .exe.
const ENV_PATH = isPackaged
  ? path.join(path.dirname(process.execPath), '.env')
  : path.resolve(__dirname, '.env');

const LOG_PATH = path.join(path.dirname(ENV_PATH), 'client.log');

// ---------------------------------------------------------------------------
// --background: relança o processo com janela oculta e sai do terminal atual
// (uso explícito — o exe não faz isso automaticamente)
// ---------------------------------------------------------------------------
if (process.argv.includes('--background')) {
  if (!fs.existsSync(ENV_PATH)) {
    console.error('[ERRO] Configure o cliente primeiro (execute sem --background).');
    process.exit(1);
  }
  const { spawn } = require('child_process');
  const childArgs = isPackaged
    ? process.argv.slice(2).filter(a => a !== '--background')
    : [process.argv[1], ...process.argv.slice(2).filter(a => a !== '--background')];
  spawn(process.execPath, childArgs, {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, SINCRONIZADOR_BG: '1' },
  }).unref();
  console.log('  Cliente iniciado em segundo plano.');
  console.log('  Web UI: http://localhost:3001');
  console.log('  Logs em: ' + LOG_PATH);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Força UTF-8 no terminal Windows (code page 65001) quando há console ativo
// ---------------------------------------------------------------------------
if (!process.env.SINCRONIZADOR_BG && process.platform === 'win32' && process.stdout.isTTY) {
  try { require('child_process').execSync('chcp 65001', { stdio: 'pipe' }); } catch {}
}

// ---------------------------------------------------------------------------
// Quando rodando em segundo plano, redireciona console para arquivo (máx 5 MB)
// ---------------------------------------------------------------------------
if (process.env.SINCRONIZADOR_BG) {
  try {
    if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > 5 * 1024 * 1024) {
      fs.writeFileSync(LOG_PATH, '');
    }
  } catch { }
  const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });
  const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log = (...a) => logStream.write(`${ts()} ${a.join(' ')}\n`);
  console.error = (...a) => logStream.write(`${ts()} [ERRO] ${a.join(' ')}\n`);
}

// ---------------------------------------------------------------------------
// Handlers globais — evitam que erros não tratados encerrem o processo
// ---------------------------------------------------------------------------
process.on('uncaughtException', e => {
  console.error(`[uncaughtException] ${e.stack || e.message}`);
  try { require('./erros').salvarErro({ operacao: 'uncaughtException', mensagem: e.stack || e.message }); } catch {}
});
process.on('unhandledRejection', e => {
  const msg = e instanceof Error ? (e.stack || e.message) : String(e);
  console.error(`[unhandledRejection] ${msg}`);
  try { require('./erros').salvarErro({ operacao: 'unhandledRejection', mensagem: msg }); } catch {}
});

// ---------------------------------------------------------------------------
// Fechar o X da janela do console → continuar rodando só na bandeja do sistema
// (SIGHUP é disparado no Windows quando o usuário fecha a janela do console)
// ---------------------------------------------------------------------------
if (isPackaged && !process.env.SINCRONIZADOR_BG) {
  process.on('SIGHUP', () => {
    if (!fs.existsSync(ENV_PATH)) { process.exit(0); return; }
    require('child_process').spawn(process.execPath, [], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, SINCRONIZADOR_BG: '1' },
    }).unref();
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------
// Inicialização principal — reinicia automaticamente em caso de erro fatal
// ---------------------------------------------------------------------------
async function main() {
  if (!fs.existsSync(ENV_PATH)) {
    const { runSetupWizard } = require('./setup-wizard');
    await runSetupWizard(ENV_PATH);
  }

  require('dotenv').config({ path: ENV_PATH });

  const { getConnection, closeConnection, getParam, getTabelasExistentes } = require('./db');
  const { sincronizarTabela } = require('./sync');
  const { empurrarTabela } = require('./push');
  const { setup } = require('./setup');
  const { iniciarWebUI } = require('./webui');
  const TABELAS = require('./tabelas');
  const { tabelaAtiva } = require('./tabelasConfig');
  const { salvarErro } = require('./erros');
  const { limparRegistrosAntigos } = require('./limpeza');

  if (!process.env.SYNC_TOKEN) {
    console.error('[ERRO] SYNC_TOKEN não configurado no .env');
    process.exit(1);
  }

  const INTERVALO_MS = parseInt((process.env.INTERVALO_MS || '30000').replace(/_/g, ''), 10);
  const PORTA_WEBUI = 3001;
  const VINTE_QUATRO_HORAS = 24 * 60 * 60 * 1000;

  let rodando = false;
  const contextoSync = { baseURI: null, idLoja: null, idPDV: null };

  function log(msg) {
    const hora = new Date().toLocaleTimeString('pt-BR');
    console.log(`[${hora}] ${msg}`);
  }

  // Inicia tray ANTES do loop do Firebird para que apareça imediatamente
  // (mostra quando empacotado — em modo background ou normal)
  if (isPackaged) {
    const { iniciarTray } = require('./tray');
    iniciarTray(PORTA_WEBUI, LOG_PATH).catch(e => console.error('[tray] ' + e.message));
  }

  async function executarCiclo() {
    if (rodando) return;
    rodando = true;
    const db = await getConnection();
    try {
      const tabelasExistentes = await getTabelasExistentes(db);
      const baseURI = (await getParam(db, 60024)).replace(/\/+$/, '');
      const idLoja = parseInt(await getParam(db, 50003), 10);
      const idPDVRaw = await getParam(db, 50004);
      const idPDV = idPDVRaw ? parseInt(idPDVRaw, 10) : null;
      const nomeFilialParam = await getParam(db, 50005);
      const nomeFilial = nomeFilialParam || process.env.NOME_FILIAL || '';

      const tabelasAusentes = TABELAS.filter(t => tabelaAtiva(t.nome) && !tabelasExistentes.has(t.nome));
      for (const tabelaAusente of tabelasAusentes) {
        log(`[${tabelaAusente.nome}] tabela ausente no Firebird — pulando sync`);
      }

      if (!baseURI) {
        const msg = 'Parâmetro 60024 (URL do servidor) não configurado.';
        log('ERRO: ' + msg);
        salvarErro({ operacao: 'config', mensagem: msg });
        return;
      }
      if (!idLoja) {
        const msg = 'Parâmetro 50003 (número da loja) não configurado.';
        log('ERRO: ' + msg);
        salvarErro({ operacao: 'config', mensagem: msg });
        return;
      }

      contextoSync.baseURI = baseURI;
      contextoSync.idLoja = idLoja;
      contextoSync.idPDV = idPDV;
      contextoSync.nomeFilial = nomeFilial;

      log(`Iniciando ciclo — servidor: ${baseURI} | loja: ${idLoja}${nomeFilial ? ` (${nomeFilial})` : ''}${idPDV ? ` | PDV: ${idPDV}` : ''}`);

      const tabelasParaSincronizar = TABELAS.filter(t => tabelaAtiva(t.nome) && tabelasExistentes.has(t.nome));

      if (tabelasParaSincronizar.length === 0) {
        log('Nenhuma tabela ativa — acesse http://localhost:3001/configuracoes para ativar tabelas.');
      }

      for (const tabela of tabelasParaSincronizar) {
        try {
          await sincronizarTabela(db, baseURI, idLoja, tabela, log, idPDV, nomeFilial);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          log(`[${tabela.nome}] Erro no pull: ${msg}`);
          salvarErro({ tabela: tabela.nome, operacao: 'pull', mensagem: msg });
        }
      }

      for (const tabela of tabelasParaSincronizar) {
        try {
          await empurrarTabela(db, baseURI, idLoja, tabela, log, idPDV, nomeFilial);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          log(`[${tabela.nome}] Erro no push: ${msg}`);
          salvarErro({ tabela: tabela.nome, operacao: 'push', mensagem: msg });
        }
      }

      log('Ciclo concluído.');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`Erro no ciclo: ${msg}`);
      salvarErro({ operacao: 'ciclo', mensagem: msg });
    } finally {
      await closeConnection(db);
      rodando = false;
    }
  }

  log(`Cliente iniciado. Intervalo: ${INTERVALO_MS / 1000}s`);

  iniciarWebUI(PORTA_WEBUI, contextoSync);

  // Tenta conectar ao Firebird — repete até conseguir (banco pode estar iniciando)
  while (true) {
    try {
      const db = await getConnection();
      try { await setup(db, log, process.env.SYNC_TOKEN); } finally { await closeConnection(db); }
      break;
    } catch (e) {
      log(`Firebird indisponível: ${e.message} — tentando novamente em 30s...`);
      salvarErro({ operacao: 'firebird', mensagem: e.message });
      await new Promise(r => setTimeout(r, 30000));
    }
  }

  await executarCiclo();
  setInterval(executarCiclo, INTERVALO_MS);
  setInterval(() => limparRegistrosAntigos(log), VINTE_QUATRO_HORAS);
}

// Reinicia automaticamente se main() lançar erro inesperado
(async () => {
  while (true) {
    try {
      await main();
      break;
    } catch (e) {
      const msg = e.stack || e.message;
      console.error(`[ERRO FATAL] ${msg} — reiniciando em 30s...`);
      try { require('./erros').salvarErro({ operacao: 'fatal', mensagem: msg }); } catch {}
      await new Promise(r => setTimeout(r, 30000));
    }
  }
})();
