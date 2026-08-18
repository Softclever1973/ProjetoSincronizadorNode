const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT_PATH = path.join(os.tmpdir(), 'sincronizador-dpapi.ps1');

// DPAPI (CryptProtectData/CryptUnprotectData) amarra a criptografia ao usuario do
// Windows que executa o processo — so descriptografa rodando como esse mesmo usuario,
// nessa mesma maquina. Copiar config.enc pra outro PC (ou rodar sob outro usuario) nao
// serve pra nada, sem precisar gerenciar nenhuma chave propria. Dado sempre trafega via
// stdin/stdout (nunca em argumento de linha de comando) pra nao aparecer na listagem de
// processos de outros usuarios da mesma maquina.
const SCRIPT = `
param([string]$Modo)
Add-Type -AssemblyName System.Security
$entrada = [Console]::In.ReadToEnd().Trim()
$bytes = [Convert]::FromBase64String($entrada)
if ($Modo -eq 'protect') {
  $saida = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
} else {
  $saida = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
}
[Console]::Out.Write([Convert]::ToBase64String($saida))
`;

function chamarDPAPI(modo, entradaBase64) {
  fs.writeFileSync(SCRIPT_PATH, SCRIPT, 'utf8');
  return execFileSync('powershell', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_PATH, modo,
  ], {
    input: entradaBase64,
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  }).trim();
}

function protegerConfig(dados) {
  const jsonBase64 = Buffer.from(JSON.stringify(dados), 'utf8').toString('base64');
  return chamarDPAPI('protect', jsonBase64);
}

function desprotegerConfig(cifradoBase64) {
  const jsonBase64 = chamarDPAPI('unprotect', cifradoBase64.trim());
  return JSON.parse(Buffer.from(jsonBase64, 'base64').toString('utf8'));
}

module.exports = { protegerConfig, desprotegerConfig };
