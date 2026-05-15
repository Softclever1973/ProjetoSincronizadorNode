const readline = require('readline');
const fs       = require('fs');
const path     = require('path');
const Firebird = require('node-firebird');
async function pergunta(rl, texto) {
  return new Promise(resolve => rl.question(texto, answer => resolve(answer.trim())));
}

function habilitarCtrlV() {
  if (process.platform !== 'win32' || !process.stdin.isTTY) return;

  const { execSync } = require('child_process');
  const _emit = process.stdin.emit.bind(process.stdin);

  process.stdin.emit = function (event, ...args) {
    if (event === 'keypress') {
      const key = args[1];
      if (key && key.ctrl && key.name === 'v') {
        try {
          const texto = execSync('powershell -command "Get-Clipboard"', {
            encoding: 'utf8',
            timeout: 500,
          }).replace(/\r?\n?$/, '');
          for (const ch of texto) {
            _emit('keypress', ch, { sequence: ch, ctrl: false, meta: false, shift: false });
          }
        } catch { /* clipboard inacessível — ignora */ }
        return true;
      }
    }
    return _emit(event, ...args);
  };
}

function httpGetJson(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? require('https') : require('http');
    const req = lib.get(url, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch { resolve([]); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
  });
}

async function buscarFiliaisServidor(serverUrl, syncToken) {
  const url = `${serverUrl}/datasnap/rest/TSMSincronizacao/FiliaisRegistradas?token=${encodeURIComponent(syncToken)}`;
  return await httpGetJson(url);
}

function lerParametro(connOpts, idParametro) {
  return new Promise((resolve) => {
    Firebird.attach(connOpts, (err, db) => {
      if (err) return resolve(null);
      db.query(
        'SELECT PARAMETRO FROM PARAMETROS WHERE ID_PARAMETRO = ?',
        [idParametro],
        (err2, rows) => {
          db.detach(() => {});
          if (err2 || !rows || !rows.length) return resolve(null);
          resolve(rows[0].PARAMETRO ?? null);
        }
      );
    });
  });
}

function gravarParametro(connOpts, idParametro, valor) {
  return new Promise((resolve) => {
    Firebird.attach(connOpts, (err, db) => {
      if (err) {
        console.log(`  [!] Nao foi possivel conectar ao Firebird: ${err.message}`);
        console.log(`      Configure manualmente: PARAMETROS onde ID_PARAMETRO=${idParametro}, PARAMETRO=<valor>\n`);
        return resolve();
      }
      db.query(
        'UPDATE OR INSERT INTO PARAMETROS (ID_PARAMETRO, PARAMETRO) VALUES (?, ?) MATCHING (ID_PARAMETRO)',
        [idParametro, valor],
        (err2) => {
          db.detach(() => {});
          if (err2) {
            console.log(`  [!] Erro ao atualizar PARAMETROS: ${err2.message}`);
            console.log(`      Configure manualmente: PARAMETROS onde ID_PARAMETRO=${idParametro}, PARAMETRO=<valor>\n`);
          } else {
            console.log(`  [OK] PARAMETROS(${idParametro}) atualizado: ${valor}`);
          }
          resolve();
        }
      );
    });
  });
}

async function runSetupWizard(envPath) {
  console.log('\n+--------------------------------------+');
  console.log('|   Configuracao inicial do Cliente    |');
  console.log('+--------------------------------------+\n');
  console.log('Arquivo .env nao encontrado. Configure agora:\n');

  habilitarCtrlV();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  rl.on('SIGINT', () => {
    console.log('\n\n  Configuracao cancelada.\n');
    rl.close();
    process.exit(0);
  });

  try {
    let syncToken = '';
    while (!syncToken) {
      syncToken = await pergunta(rl, 'SYNC_TOKEN (fornecido pelo administrador do servidor):\n> ');
      if (!syncToken) console.log('  [!] Campo obrigatorio.\n');
    }

    let serverUrl = '';
    while (!serverUrl) {
      serverUrl = await pergunta(rl, '\nURL do servidor\n  ex: http://192.168.1.100:8080\n> ');
      if (!serverUrl) console.log('  [!] Campo obrigatorio.\n');
    }
    serverUrl = serverUrl.replace(/\/+$/, '');

    let filiaisServidor = [];
    while (true) {
      process.stdout.write('\n  Verificando conexao com o servidor...');
      try {
        filiaisServidor = await buscarFiliaisServidor(serverUrl, syncToken);
        console.log(' Conectado com sucesso!');
        if (filiaisServidor.length > 0) {
          const lista = filiaisServidor
            .map(f => `${f.ID_LOJA}${f.NOME ? ` (${f.NOME})` : ''}`)
            .join(', ');
          console.log(`  Filiais ja registradas: ${lista}`);
        } else {
          console.log('  Nenhuma filial registrada ainda.');
        }
        break;
      } catch (e) {
        console.log(` Falhou: ${e.message}`);
        const tentar = await pergunta(rl, '  Tentar novamente? [S/n]: ');
        if (tentar.toLowerCase() === 'n') break;
      }
    }

    let fbDatabase = '';
    while (!fbDatabase) {
      fbDatabase = await pergunta(rl, '\nCaminho do banco Firebird\n  ex: C:\\FDBS\\FILIAL.FDB\n> ');
      if (!fbDatabase) console.log('  [!] Campo obrigatorio.\n');
    }

    let fbPassword = '';
    while (!fbPassword) {
      fbPassword = await pergunta(rl, '\nSenha do Firebird:\n> ');
      if (!fbPassword) console.log('  [!] Campo obrigatorio.\n');
    }

    const fbHostRaw = await pergunta(rl, '\nHost do Firebird [localhost]:\n> ');
    const fbHost = fbHostRaw || 'localhost';

    const fbPortRaw = await pergunta(rl, '\nPorta do Firebird [3050]:\n> ');
    const fbPort = fbPortRaw || '3050';

    const fbUserRaw = await pergunta(rl, '\nUsuario do Firebird [SYSDBA]:\n> ');
    const fbUser = fbUserRaw || 'SYSDBA';

    const intervaloRaw = await pergunta(rl, '\nIntervalo entre ciclos em ms [30000]:\n> ');
    const intervalo = intervaloRaw || '30000';

    const nomeFilialRaw = await pergunta(rl, '\nNome desta filial (ex: Loja Centro) [opcional]:\n> ');
    const nomeFilial = nomeFilialRaw.trim();

    const connOptsTemp = { host: fbHost, port: parseInt(fbPort, 10), database: fbDatabase, user: fbUser, password: fbPassword };
    const idLojaFirebird = await lerParametro(connOptsTemp, 50003);
    const ultimoIdServidor = filiaisServidor.length > 0
      ? Math.max(...filiaisServidor.map(f => Number(f.ID_LOJA) || 0))
      : 0;

    // Padrão: Firebird se já configurado, senão próximo disponível no servidor, senão 1
    const idLojaPadrao = idLojaFirebird || (ultimoIdServidor > 0 ? String(ultimoIdServidor + 1) : '1');

    // Hint: sempre mostra o último do servidor quando disponível
    const parteServidor = ultimoIdServidor > 0 ? `ultimo no servidor: ${ultimoIdServidor}` : null;
    const parteFirebird = idLojaFirebird ? `Firebird: ${idLojaFirebird}` : null;
    const idLojaHint = [parteServidor, parteFirebird].filter(Boolean).join(' | ') || 'padrao';

    let idLojaStr = '';
    while (true) {
      idLojaStr = (await pergunta(rl, `\nID desta loja — ${idLojaHint} (Enter para aceitar ${idLojaPadrao}):\n> `)).trim();
      if (!idLojaStr) { idLojaStr = idLojaPadrao; break; }
      if (/^\d+$/.test(idLojaStr) && parseInt(idLojaStr, 10) > 0) break;
      console.log('  [!] Informe um numero inteiro positivo.\n');
    }
    const idLoja = parseInt(idLojaStr, 10);

    const conteudo = [
      `SYNC_TOKEN=${syncToken}`,
      `FIREBIRD_HOST=${fbHost}`,
      `FIREBIRD_PORT=${fbPort}`,
      `FIREBIRD_DATABASE=${fbDatabase}`,
      `FIREBIRD_USER=${fbUser}`,
      `FIREBIRD_PASSWORD=${fbPassword}`,
      `INTERVALO_MS=${intervalo}`,
      `NOME_FILIAL=${nomeFilial}`,
    ].join('\n') + '\n';

    fs.writeFileSync(envPath, conteudo, 'utf8');
    console.log('\n  [OK] .env criado em: ' + envPath);

    const connOpts = { host: fbHost, port: parseInt(fbPort, 10), database: fbDatabase, user: fbUser, password: fbPassword };

    console.log('  Gravando URL do servidor no banco Firebird...');
    await gravarParametro(connOpts, 60024, serverUrl);

    console.log('  Gravando ID da loja no banco Firebird...');
    await gravarParametro(connOpts, 50003, String(idLoja));

    if (nomeFilial) {
      console.log('  Gravando nome da filial no banco Firebird...');
      await gravarParametro(connOpts, 50005, nomeFilial);
    }

    console.log('  Para reconfigurar, delete o .env e execute novamente.\n');
  } finally {
    rl.close();
  }
}

module.exports = { runSetupWizard };
