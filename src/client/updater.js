const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const REPO = 'Softclever1973/ProjetoSincronizadorNode';
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const USER_AGENT = 'ProjetoSincronizadorNode-client';

function getJson(url) {
  return new Promise((resolve, reject) => {
    const seguirRedirect = (u) => {
      https.get(u, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return seguirRedirect(res.headers.location);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`GitHub API retornou ${res.statusCode}`));
        }
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      }).on('error', reject);
    };
    seguirRedirect(url);
  });
}

function baixarArquivo(url, destino) {
  return new Promise((resolve, reject) => {
    const seguirRedirect = (u) => {
      https.get(u, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return seguirRedirect(res.headers.location);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`Download falhou: HTTP ${res.statusCode}`));
        }
        const arquivo = fs.createWriteStream(destino);
        res.pipe(arquivo);
        arquivo.on('finish', () => arquivo.close(resolve));
        arquivo.on('error', reject);
      }).on('error', reject);
    };
    seguirRedirect(url);
  });
}

/** Compara "1.2.3" com "1.10.0" corretamente (não como string). */
function compararVersoes(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0, nb = pb[i] || 0;
    if (na !== nb) return na > nb ? 1 : -1;
  }
  return 0;
}

/**
 * Consulta a última release no GitHub e retorna os dados da atualização
 * se houver uma versão mais nova que `versaoAtual`, ou null caso contrário.
 */
async function verificarAtualizacao(versaoAtual) {
  const release = await getJson(API_URL);
  const versaoRemota = String(release.tag_name || '').replace(/^v/i, '');
  if (!versaoRemota || compararVersoes(versaoRemota, versaoAtual) <= 0) return null;

  const asset = (release.assets || []).find(a => a.name === 'client.exe');
  return {
    versao: versaoRemota,
    notas: release.body || '',
    urlRelease: release.html_url,
    urlDownload: asset ? asset.browser_download_url : null,
  };
}

/**
 * Baixa o novo client.exe e substitui o executável em execução.
 * O Windows não permite sobrescrever um .exe em execução, mas permite
 * renomeá-lo — por isso o atual é movido para client.old.exe antes de o
 * novo assumir o lugar. O processo novo é lançado e o atual se encerra;
 * o arquivo .old fica para trás (removido na próxima execução bem-sucedida).
 */
async function aplicarAtualizacao({ urlDownload, exePath, args }) {
  if (!urlDownload) throw new Error('Release não possui client.exe para download.');

  const dir = path.dirname(exePath);
  const novoPath = path.join(dir, 'client.new.exe');
  const antigoPath = path.join(dir, 'client.old.exe');

  await baixarArquivo(urlDownload, novoPath);

  const { size } = fs.statSync(novoPath);
  if (size < 1024 * 1024) { // sanity check — o exe empacotado nunca é tão pequeno
    fs.unlinkSync(novoPath);
    throw new Error('Arquivo baixado parece inválido (tamanho inesperado).');
  }

  try { fs.unlinkSync(antigoPath); } catch { /* não existia — ok */ }
  fs.renameSync(exePath, antigoPath);
  fs.renameSync(novoPath, exePath);

  spawn(exePath, args, { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
  setTimeout(() => process.exit(0), 500);
}

/** Remove o client.old.exe deixado por uma atualização anterior, se existir. */
function limparExeAntigo(exePath) {
  const antigoPath = path.join(path.dirname(exePath), 'client.old.exe');
  fs.unlink(antigoPath, () => {}); // silencioso — pode não existir, ou ainda estar em uso
}

module.exports = { verificarAtualizacao, aplicarAtualizacao, limparExeAntigo, compararVersoes };
