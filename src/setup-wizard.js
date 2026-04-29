const readline = require('readline');
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');

function gerarSecret(bytes = 64) {
  return crypto.randomBytes(bytes).toString('hex');
}

async function pergunta(rl, texto) {
  return new Promise(resolve => rl.question(texto, answer => resolve(answer.trim())));
}

// Intercepta Ctrl+V no stdin e injeta o conteúdo da área de transferência
// caractere a caractere, como se tivesse sido digitado.
// Só ativa no Windows com terminal interativo (TTY).
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

async function runSetupWizard() {
  const envPath = path.join(process.cwd(), '.env');

  console.log('\n+--------------------------------------+');
  console.log('|   Configuracao inicial do Servidor   |');
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
    let dbUrl = '';
    while (!dbUrl) {
      dbUrl = await pergunta(rl, 'URL PostgreSQL\n  ex: postgresql://postgres:senha@localhost:5432/matriz\n> ');
      if (!dbUrl) console.log('  [!] Campo obrigatorio.\n');
    }

    const portaRaw = await pergunta(rl, '\nPorta HTTP [8080]:\n> ');
    const porta = portaRaw || '8080';

    const jwtSecret  = gerarSecret(64);
    const adminToken = gerarSecret(32);

    const conteudo = [
      `DATABASE_URL=${dbUrl}`,
      `PORT=${porta}`,
      `JWT_SECRET=${jwtSecret}`,
      `ADMIN_TOKEN=${adminToken}`,
    ].join('\n') + '\n';

    fs.writeFileSync(envPath, conteudo, 'utf8');

    console.log('\n  [OK] .env criado em: ' + envPath);
    console.log('  JWT_SECRET e ADMIN_TOKEN foram gerados automaticamente.');
    console.log('\n  Proximo passo: cadastre a primeira empresa (token por empresa):');
    console.log('  node scripts/create-empresa.js --schema=empresa_xx --token=TOKEN --nome="Nome"');
    console.log('\n  Para reconfigurar, delete o .env e execute novamente.\n');
  } finally {
    rl.close();
  }
}

module.exports = { runSetupWizard };
