const fs = require('fs');
const path = require('path');
const os = require('os');

const ICON_FILE = path.join(__dirname, 'assets', 'softcleverlogo.ico');
const TEMP_ICON_FILE = path.join(os.tmpdir(), 'sincronizador-tray.ico');

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

async function iniciarTray(porta) {
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

  const tray = new SysTray({
    menu: {
      icon: trayIcon,
      title: '',
      tooltip: 'Sincronizador',
      items: [
        { title: 'Abrir Console', tooltip: '', checked: false, enabled: true },
        { title: 'Abrir Web UI', tooltip: 'http://localhost:' + porta, checked: false, enabled: true },
        SysTray.separator,
        { title: 'Parar cliente', tooltip: '', checked: false, enabled: true },
      ],
    },
    debug: false,
    copyDir: true,
  });

  await tray.ready();

  tray.onClick(async action => {
    if (!action.item) return;
    const titulo = action.item.title;
    if (titulo === 'Abrir Web UI') {
      const { exec } = require('child_process');
      exec('start http://localhost:' + porta);
    } else if (titulo === 'Parar cliente') {
      await tray.kill(true); // encerra o processo Node
    }
  });

  tray.onError(err => {
    console.error('[tray] Erro: ' + err.message);
  });

  return tray;
}

module.exports = { iniciarTray };
