const readline = require('readline');
const fs       = require('fs');
const path     = require('path');
const Firebird = require('node-firebird');
async function pergunta(rl, texto) {
  return new Promise(resolve => rl.question(texto, answer => resolve(answer.trim())));
}

// Suprime o eco nativo do readline (API interna _writeToOutput, mas estavel ha varias
// major versions do Node) e desenha o mascaramento (#) na mao a cada 'keypress'. O
// buffer de linha do readline (rl.line) continua sendo a fonte da verdade — so lemos o
// comprimento dele apos cada tecla e ajustamos a tela pra bater, entao backspace, colar
// com Ctrl+V (habilitarCtrlV, que injeta 'keypress' sintetico) e edicao continuam
// funcionando normalmente por baixo; so a parte visual muda de "nada" para "#####".
async function perguntaSenha(rl, texto, mascara = '#') {
  return new Promise(resolve => {
    process.stdout.write(texto);
    const escreverOriginal = rl._writeToOutput.bind(rl);
    rl._writeToOutput = () => {};

    let exibidos = 0;
    const onKeypress = (_ch, key) => {
      // Enter/Return: rl ja zerou rl.line ao processar a linha internamente — nao mexer
      // na tela aqui, senao os # que acabaram de ser digitados somem antes do resolve().
      if (key && (key.name === 'return' || key.name === 'enter')) return;
      const comprimento = rl.line.length;
      if (comprimento > exibidos) {
        process.stdout.write(mascara.repeat(comprimento - exibidos));
      } else if (comprimento < exibidos) {
        process.stdout.write('\b \b'.repeat(exibidos - comprimento));
      }
      exibidos = comprimento;
    };
    process.stdin.on('keypress', onKeypress);

    rl.question('', answer => {
      process.stdin.removeListener('keypress', onKeypress);
      rl._writeToOutput = escreverOriginal;
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
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

function testarConexaoFirebird(connOpts) {
  return new Promise((resolve) => {
    Firebird.attach(connOpts, (err, db) => {
      if (err) return resolve({ ok: false, erro: err.message });
      db.detach(() => {});
      resolve({ ok: true });
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

// destino: caminho do arquivo a gravar (config.enc ou .env).
// criptografado: true grava via DPAPI (so Windows/pacote empacotado); false grava .env
// em texto puro (modo dev, sem empacotar — nao ha exe fixo pra amarrar via DPAPI).
// Retorna o objeto de configuracao coletado, pra quem chamou popular process.env direto
// sem precisar reabrir/descriptografar o arquivo que acabou de escrever.
async function runSetupWizard({ destino, criptografado }) {
  console.log('\n+--------------------------------------+');
  console.log('|   Configuracao inicial do Cliente    |');
  console.log('+--------------------------------------+\n');
  console.log('Configuracao nao encontrada. Configure agora:\n');
  if (criptografado) {
    console.log('  (as credenciais serao gravadas criptografadas em config.enc,');
    console.log('   amarradas a este Windows/usuario — nao ficam em texto puro em disco)\n');
  }

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
      syncToken = await perguntaSenha(rl, 'SYNC_TOKEN (fornecido pelo administrador do servidor):\n> ');
      if (!syncToken) console.log('  [!] Campo obrigatorio.\n');
    }

    let serverUrl = '';
    let filiaisServidor = [];
    while (true) {
      serverUrl = '';
      while (!serverUrl) {
        serverUrl = await pergunta(rl, '\nURL do servidor\n  ex: http://192.168.1.100:8080\n> ');
        if (!serverUrl) console.log('  [!] Campo obrigatorio.\n');
      }
      serverUrl = serverUrl.replace(/\/+$/, '');

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
        const tentar = await pergunta(rl, '  Tentar novamente com outra URL? [S/n]: ');
        if (tentar.toLowerCase() === 'n') break;
      }
    }

    let fbDatabase = '';
    let fbPassword = '';
    let fbHost = '';
    let fbPort = '';
    let fbUser = '';
    let conexaoFirebirdOk = false;

    while (!conexaoFirebirdOk) {
      fbDatabase = '';
      while (!fbDatabase) {
        fbDatabase = await pergunta(rl, '\nCaminho do banco Firebird\n  ex: C:\\FDBS\\FILIAL.FDB\n> ');
        if (!fbDatabase) console.log('  [!] Campo obrigatorio.\n');
      }

      fbPassword = '';
      while (!fbPassword) {
        fbPassword = await perguntaSenha(rl, '\nSenha do Firebird:\n> ');
        if (!fbPassword) console.log('  [!] Campo obrigatorio.\n');
      }

      const fbHostRaw = await pergunta(rl, '\nHost do Firebird [localhost]:\n> ');
      fbHost = fbHostRaw || 'localhost';

      const fbPortRaw = await pergunta(rl, '\nPorta do Firebird [3050]:\n> ');
      fbPort = fbPortRaw || '3050';

      const fbUserRaw = await pergunta(rl, '\nUsuario do Firebird [SYSDBA]:\n> ');
      fbUser = fbUserRaw || 'SYSDBA';

      process.stdout.write('\n  Testando conexao com o Firebird...');
      const resultado = await testarConexaoFirebird({
        host: fbHost,
        port: parseInt(fbPort, 10),
        database: fbDatabase,
        user: fbUser,
        password: fbPassword,
      });

      if (resultado.ok) {
        console.log(' Conectado com sucesso!\n');
        conexaoFirebirdOk = true;
      } else {
        console.log(` Falhou: ${resultado.erro}`);
        console.log('  [!] Confira caminho do banco, host, porta, usuario e senha e tente novamente.\n');
      }
    }

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

    const dados = {
      SYNC_TOKEN: syncToken,
      FIREBIRD_HOST: fbHost,
      FIREBIRD_PORT: fbPort,
      FIREBIRD_DATABASE: fbDatabase,
      FIREBIRD_USER: fbUser,
      FIREBIRD_PASSWORD: fbPassword,
      INTERVALO_MS: intervalo,
      NOME_FILIAL: nomeFilial,
    };

    if (criptografado) {
      const { protegerConfig } = require('./config-crypto');
      fs.writeFileSync(destino, protegerConfig(dados), 'utf8');
      console.log('\n  [OK] Configuracao criptografada gravada em: ' + destino);
    } else {
      const conteudo = Object.entries(dados).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
      fs.writeFileSync(destino, conteudo, 'utf8');
      console.log('\n  [OK] .env criado em: ' + destino);
    }

    const connOpts = { host: fbHost, port: parseInt(fbPort, 10), database: fbDatabase, user: fbUser, password: fbPassword };

    console.log('  Gravando URL do servidor no banco Firebird...');
    await gravarParametro(connOpts, 60024, serverUrl);

    console.log('  Gravando ID da loja no banco Firebird...');
    await gravarParametro(connOpts, 50003, String(idLoja));

    if (nomeFilial) {
      console.log('  Gravando nome da filial no banco Firebird...');
      await gravarParametro(connOpts, 50005, nomeFilial);
    }

    console.log(`  Para reconfigurar, delete ${path.basename(destino)} e execute novamente.\n`);

    return dados;
  } finally {
    rl.close();
  }
}

module.exports = { runSetupWizard };
