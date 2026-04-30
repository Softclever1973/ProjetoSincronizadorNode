const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, execSync } = require('child_process');

const ICON_FILE = path.join(__dirname, 'assets', 'softcleverlogo.ico');
const TEMP_ICON_FILE = path.join(os.tmpdir(), 'sincronizador-tray.ico');

const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const REG_NAME = 'SincronizadorCliente';

// seq_id de cada item no menu (separator conta como posição)
const IDX_STARTUP = 3;

function prepareTrayIconPath() {
  try {
    const data = fs.readFileSync(ICON_FILE);
    fs.writeFileSync(TEMP_ICON_FILE, data);
    return TEMP_ICON_FILE;
  } catch (e) {
    console.error('[tray] falha ao preparar ícone temporário:', e.message);
    return ICON_FILE;
  }
}

function isStartupEnabled() {
  try {
    execSync(`reg query "${REG_KEY}" /v "${REG_NAME}"`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function setStartup(enable) {
  try {
    if (enable) {
      const exePath = process.execPath;
      execSync(`reg add "${REG_KEY}" /v "${REG_NAME}" /t REG_SZ /d "${exePath} --background" /f`, { stdio: 'pipe' });
    } else {
      execSync(`reg delete "${REG_KEY}" /v "${REG_NAME}" /f`, { stdio: 'pipe' });
    }
    return true;
  } catch (e) {
    console.error('[tray] Erro ao alterar startup:', e.message);
    return false;
  }
}

async function iniciarTray(porta, logPath) {
  let SysTray;
  try {
    SysTray = require('systray2').default;
  } catch (e) {
    // systray2 não disponível (ex: Linux sem suporte)
    return null;
  }

  // copyDir: true → copia o binário Go para ~/.cache/node-systray/<versão>/
  // antes de executar. Necessário quando empacotado com pkg (FS virtual é read-only).
  const trayIcon = prepareTrayIconPath();
  let startupEnabled = isStartupEnabled();

  const tray = new SysTray({
    menu: {
      icon: trayIcon,
      title: '',
      tooltip: 'Sincronizador',
      items: [
        { title: 'Abrir Console',         tooltip: '',                             checked: false,          enabled: !!logPath },
        { title: 'Abrir Web UI',          tooltip: 'http://localhost:' + porta,    checked: false,          enabled: true },
        SysTray.separator,
        { title: 'Iniciar com o Windows', tooltip: '',                             checked: startupEnabled, enabled: true },
        { title: 'Parar cliente',         tooltip: '',                             checked: false,          enabled: true },
      ],
    },
    debug: false,
    copyDir: true,
  });

  await tray.ready();

  tray.onClick(async action => {
    if (!action.item) return;
    const titulo = action.item.title;

    if (titulo === 'Abrir Console') {
      const safeLog = logPath.replace(/'/g, "''");
      exec(`start "Sincronizador Console" cmd /k "chcp 65001 > nul && powershell -NoExit -Command Get-Content -Wait -Tail 100 -Encoding utf8 '${safeLog}'"`);

    } else if (titulo === 'Abrir Web UI') {
      exec('start http://localhost:' + porta);

    } else if (titulo === 'Iniciar com o Windows') {
      startupEnabled = !startupEnabled;
      if (setStartup(startupEnabled)) {
        tray.sendAction({
          type: 'update-item',
          item: { title: 'Iniciar com o Windows', tooltip: '', checked: startupEnabled, enabled: true },
          seq_id: IDX_STARTUP,
        });
      } else {
        // Reverte em caso de falha
        startupEnabled = !startupEnabled;
      }

    } else if (titulo === 'Parar cliente') {
      await tray.kill(true);
    }
  });

  tray.onError(err => {
    console.error('[tray] Erro: ' + err.message);
  });

  return tray;
}

module.exports = { iniciarTray };
