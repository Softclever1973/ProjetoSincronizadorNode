const https = require('https');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const REPO = 'Softclever1973/ProjetoSincronizadorNode';
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const USER_AGENT = 'ProjetoSincronizadorNode-client';
const TIMEOUT_MS = 15_000; // timeout de INATIVIDADE (sem dados recebidos) — não corta um download grande em andamento

function getJson(url) {
  return new Promise((resolve, reject) => {
    const seguirRedirect = (u) => {
      const req = https.get(u, { headers: { 'User-Agent': USER_AGENT }, timeout: TIMEOUT_MS }, (res) => {
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
      });
      req.on('timeout', () => req.destroy(new Error('Tempo limite excedido ao consultar o GitHub.')));
      req.on('error', reject);
    };
    seguirRedirect(url);
  });
}

function baixarArquivo(url, destino) {
  return new Promise((resolve, reject) => {
    const seguirRedirect = (u) => {
      const req = https.get(u, { headers: { 'User-Agent': USER_AGENT }, timeout: TIMEOUT_MS }, (res) => {
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
      });
      req.on('timeout', () => req.destroy(new Error('Tempo limite excedido ao baixar a atualização.')));
      req.on('error', reject);
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

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Renomeia com algumas tentativas — no Windows um .exe recém-baixado/renomeado
 * fica às vezes brevemente bloqueado (antivírus fazendo scan em tempo real),
 * causando EPERM numa primeira tentativa que teria sucesso segundos depois.
 */
async function renomearComRetry(origem, destino, tentativas = 6, atrasoMs = 400) {
  for (let i = 0; i < tentativas; i++) {
    try {
      await fsp.rename(origem, destino);
      return;
    } catch (e) {
      if (i === tentativas - 1) throw e;
      await sleep(atrasoMs);
    }
  }
}

let atualizando = false;

/**
 * Baixa o novo client.exe e substitui o executável em execução.
 * O Windows não permite sobrescrever um .exe em execução, mas permite
 * renomeá-lo — por isso o atual é movido para um nome "old" antes de o
 * novo assumir o lugar. Nomes "old"/"new" incluem um sufixo único por
 * tentativa para nunca colidir com um arquivo de uma tentativa anterior
 * que ainda não pôde ser removido (ex.: ainda bloqueado pelo processo antigo).
 * O processo novo é lançado e o atual se encerra; os arquivos temporários
 * ficam para trás e são varridos por `limparExeAntigo` na próxima execução.
 */
async function aplicarAtualizacao({ urlDownload, exePath, args }) {
  if (!urlDownload) throw new Error('Release não possui client.exe para download.');
  if (atualizando) throw new Error('Uma atualização já está em andamento.');
  atualizando = true;

  try {
    const dir = path.dirname(exePath);
    const sufixo = Date.now();
    const novoPath = path.join(dir, `client.new.${sufixo}.exe`);
    const antigoPath = path.join(dir, `client.old.${sufixo}.exe`);

    await baixarArquivo(urlDownload, novoPath);

    const { size } = await fsp.stat(novoPath);
    if (size < 1024 * 1024) { // sanity check — o exe empacotado nunca é tão pequeno
      await fsp.unlink(novoPath).catch(() => {});
      throw new Error('Arquivo baixado parece inválido (tamanho inesperado).');
    }

    await renomearComRetry(exePath, antigoPath);
    await renomearComRetry(novoPath, exePath);

    spawn(exePath, args, { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
    setTimeout(() => process.exit(0), 500);
  } finally {
    atualizando = false;
  }
}

/**
 * Remove arquivos client.old(.timestamp).exe / client.new(.timestamp).exe deixados
 * por atualizações anteriores — inclui o formato antigo sem timestamp (nome fixo)
 * para limpar também o que uma versão anterior deste código possa ter deixado para trás.
 */
function limparExeAntigo(exePath) {
  const dir = path.dirname(exePath);
  fs.readdir(dir, (err, arquivos) => {
    if (err) return;
    for (const nome of arquivos) {
      if (/^client\.(old|new)(\.\d+)?\.exe$/.test(nome)) {
        fs.unlink(path.join(dir, nome), () => {}); // silencioso — pode ainda estar em uso
      }
    }
  });
}

module.exports = { verificarAtualizacao, aplicarAtualizacao, limparExeAntigo, compararVersoes };
