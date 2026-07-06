const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SCRIPT_PATH = path.join(os.tmpdir(), 'sincronizador-notif.ps1');

// Mostra um balão/toast nativo do Windows via PowerShell (NotifyIcon) — o próprio
// Windows 10/11 traduz isso para uma notificação moderna da Central de Ações.
// Escrito num arquivo .ps1 temporário e invocado com argumentos separados (spawn,
// não exec) para evitar problemas de escaping de aspas dentro de um -Command inline.
const SCRIPT = `
param([string]$Titulo, [string]$Mensagem)
Add-Type -AssemblyName System.Windows.Forms
$ni = New-Object System.Windows.Forms.NotifyIcon
$ni.Icon = [System.Drawing.SystemIcons]::Information
$ni.Visible = $true
$ni.ShowBalloonTip(10000, $Titulo, $Mensagem, [System.Windows.Forms.ToolTipIcon]::Info)
Start-Sleep -Seconds 10
$ni.Dispose()
`;

function notificarToast(titulo, mensagem) {
  if (process.platform !== 'win32') return;
  try {
    fs.writeFileSync(SCRIPT_PATH, SCRIPT, 'utf8');
    spawn('powershell', [
      '-WindowStyle', 'Hidden',
      '-ExecutionPolicy', 'Bypass',
      '-File', SCRIPT_PATH,
      '-Titulo', titulo,
      '-Mensagem', mensagem,
    ], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch (e) {
    console.error('[notificacao] falha ao exibir toast:', e.message);
  }
}

module.exports = { notificarToast };
