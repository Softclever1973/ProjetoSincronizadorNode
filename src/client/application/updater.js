const https = require('https');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const EventEmitter = require('events');

const REPO = 'Softclever1973/ProjetoSincronizadorNode';
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`; // ignora pre-releases: lojas nunca recebem beta
const API_LISTA_URL = `https://api.github.com/repos/${REPO}/releases?per_page=30`;
const USER_AGENT = 'ProjetoSincronizadorNode-client';
const TIMEOUT_MS = 15_000; // timeout de INATIVIDADE (sem dados recebidos) — não corta um download grande em andamento
const JANELA_LIVENESS_MS = 10_000; // quanto tempo o processo antigo espera o novo se manter de pé antes de confiar nele
const ESTADO_TTL_MS = 24 * 60 * 60 * 1000; // depois disso um .update-pending.json é considerado abandonado

// Emite 'status' a cada transição do fluxo de atualização — consumido pelo SSE em webui.js
// e pelos toasts em index.js. Ver payloads em cada emit() abaixo.
const emitter = new EventEmitter();

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

/**
 * Compara versões semver: "1.2.3" × "1.10.0" numericamente, e beta antes da final
 * ("1.6.0-beta.2" < "1.6.0-beta.10" < "1.6.0" < "1.6.1").
 */
function _separarVersao(v) {
  const s = String(v).replace(/^v/i, '');
  const i = s.indexOf('-');
  return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)];
}

function compararVersoes(a, b) {
  const [baseA, preA] = _separarVersao(a);
  const [baseB, preB] = _separarVersao(b);
  const pa = baseA.split('.').map(Number);
  const pb = baseB.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0, nb = pb[i] || 0;
    if (na !== nb) return na > nb ? 1 : -1;
  }
  if (!preA || !preB) return preA ? -1 : preB ? 1 : 0; // a final vem depois de qualquer beta da mesma versão
  const ia = preA.split('.'), ib = preB.split('.');
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    if (ia[i] === undefined) return -1;
    if (ib[i] === undefined) return 1;
    const numA = /^\d+$/.test(ia[i]), numB = /^\d+$/.test(ib[i]);
    if (numA && numB && Number(ia[i]) !== Number(ib[i])) return Number(ia[i]) > Number(ib[i]) ? 1 : -1;
    if (numA !== numB) return numA ? -1 : 1;
    if (!numA && ia[i] !== ib[i]) return ia[i] > ib[i] ? 1 : -1;
  }
  return 0;
}

// Versão de teste interno: tag com sufixo (v1.6.0-beta.1). No GitHub sai como "Pre-release" (ver build.yml).
const ehBeta = versao => /-/.test(String(versao));

function _infoRelease(release) {
  const asset = (release.assets || []).find(a => a.name === 'client.exe');
  return {
    versao: String(release.tag_name || '').replace(/^v/i, ''),
    notas: release.body || '',
    urlRelease: release.html_url,
    urlDownload: asset ? asset.browser_download_url : null,
  };
}

/**
 * Opções da faixa de beta: a beta mais nova que a instalada (se houver) e a estável mais nova
 * (mesmo que seja anterior à beta — aí `voltaVersao` = true e a tela avisa). Só releases com client.exe.
 */
function escolherOpcoesBeta(releases, versaoAtual) {
  const validas = (releases || [])
    .filter(r => !r.draft && r.tag_name)
    .map(r => ({ ...(_infoRelease(r)), prerelease: Boolean(r.prerelease) }))
    .filter(r => r.urlDownload);
  const maisNova = lista => lista.reduce((m, r) => (!m || compararVersoes(r.versao, m.versao) > 0 ? r : m), null);
  const beta = maisNova(validas.filter(r => r.prerelease && compararVersoes(r.versao, versaoAtual) > 0));
  const estavel = maisNova(validas.filter(r => !r.prerelease && !ehBeta(r.versao)));
  const semFlag = ({ prerelease, ...resto }) => resto;
  return {
    beta: beta ? semFlag(beta) : null,
    estavel: estavel ? { ...semFlag(estavel), voltaVersao: compararVersoes(estavel.versao, versaoAtual) < 0 } : null,
  };
}

/** Para quem está numa beta: consulta as releases (inclui pre-releases) e devolve { beta, estavel }. */
async function verificarOpcoesBeta(versaoAtual) {
  return escolherOpcoesBeta(await getJson(API_LISTA_URL), versaoAtual);
}

/**
 * Consulta a última release no GitHub e retorna os dados da atualização
 * se houver uma versão mais nova que `versaoAtual`, ou null caso contrário.
 */
async function verificarAtualizacao(versaoAtual) {
  const release = await getJson(API_URL);
  const info = _infoRelease(release);
  if (!info.versao || compararVersoes(info.versao, versaoAtual) <= 0) return null;
  return info;
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

function estadoPath(exePath) {
  return path.join(path.dirname(exePath), '.update-pending.json');
}

/**
 * Lê o estado de atualização pendente (gravado logo antes do respawn, ver
 * `aplicarAtualizacaoComRespawn`). Retorna null se não existe, está corrompido ou passou do
 * TTL — em qualquer um desses casos o chamador deve agir como se não houvesse nenhuma
 * atualização em andamento (nunca travar o boot por causa de um arquivo de estado ruim).
 */
function lerEstadoPendente(exePath) {
  try {
    const raw = fs.readFileSync(estadoPath(exePath), 'utf8');
    const estado = JSON.parse(raw);
    if (!estado || !estado.exeAntigoPath || !estado.criadoEm) return null;
    if (Date.now() - new Date(estado.criadoEm).getTime() > ESTADO_TTL_MS) return null;
    return estado;
  } catch {
    return null;
  }
}

async function salvarEstadoPendente(exePath, estado) {
  const p = estadoPath(exePath);
  const tmp = `${p}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(estado, null, 2), 'utf8');
  await fsp.rename(tmp, p);
}

async function apagarEstadoPendente(exePath) {
  await fsp.unlink(estadoPath(exePath)).catch(() => {}); // silencioso — pode já não existir
}

/** Resolve com o child assim que ele não emitir 'error' dentro da janela de graça. */
function spawnComGraca(exePath, graceMs = 300) {
  return new Promise((resolve, reject) => {
    const child = spawn(exePath, [], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, SINCRONIZADOR_BG: '1' },
    });
    const onError = (e) => { clearTimeout(timer); reject(e); };
    const timer = setTimeout(() => {
      child.removeListener('error', onError);
      resolve(child);
    }, graceMs);
    child.once('error', onError);
  });
}

/**
 * Igual à proteção de `renomearComRetry`, mas para o spawn em si — um antivírus pode
 * bloquear brevemente o .exe recém-materializado sob o nome original antes da primeira
 * execução.
 */
async function spawnComRetry(exePath, tentativas = 3, atrasoMs = 500) {
  let ultimoErro;
  for (let i = 0; i < tentativas; i++) {
    try {
      return await spawnComGraca(exePath);
    } catch (e) {
      ultimoErro = e;
      if (i < tentativas - 1) await sleep(atrasoMs);
    }
  }
  throw ultimoErro;
}

/** Espera até `ms` pelo child sair/errar; resolve `true` se ele sobreviver à janela toda. */
function aguardarLiveness(child, ms) {
  return new Promise((resolve) => {
    let decidido = false;
    const onFim = (sobreviveu) => {
      if (decidido) return;
      decidido = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      resolve(sobreviveu);
    };
    const onExit = () => onFim(false);
    const onError = () => onFim(false);
    const timer = setTimeout(() => onFim(true), ms);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

/**
 * Desfaz uma troca de executável que não sobreviveu à janela de watchdog: isola o build
 * quebrado sob um nome próprio (para diagnóstico, não é apagado na hora) e restaura a
 * versão anterior no nome original. Quem chama continua rodando — nunca chegou a sair.
 */
async function reverterAtualizacao({ exePath, antigoPath }) {
  const dir = path.dirname(exePath);
  const quebradoPath = path.join(dir, `client.broken.${Date.now()}.exe`);
  try {
    await renomearComRetry(exePath, quebradoPath);
  } catch {
    // segue tentando restaurar a versão anterior mesmo que isolar o build quebrado falhe
  }
  await renomearComRetry(antigoPath, exePath);
  await apagarEstadoPendente(exePath);
}

let atualizando = false;

/**
 * Baixa a nova versão, substitui o .exe em execução (Windows não permite sobrescrever um
 * .exe rodando, mas permite renomeá-lo — por isso o atual é movido para um nome "old" antes
 * de o novo assumir o lugar) e relança o processo novo, supervisionando por
 * JANELA_LIVENESS_MS antes de encerrar este processo. Se o novo não sobreviver a essa
 * janela, reverte automaticamente para a versão anterior e ESTE processo continua rodando
 * normalmente (nunca chega a sair). É a única função de aplicação — usada tanto pelo fluxo
 * automático (index.js) quanto pelo botão manual "Atualizar agora" (webui.js), então ambos
 * ganham o mesmo respawn + watchdog + rollback.
 */
async function aplicarAtualizacaoComRespawn({ urlDownload, exePath, versaoAtual, versaoNova }) {
  if (!urlDownload) throw new Error('Release não possui client.exe para download.');
  if (atualizando) throw new Error('Uma atualização já está em andamento.');
  atualizando = true;

  try {
    emitter.emit('status', { status: 'aplicando', versao: versaoNova, em: new Date().toISOString() });

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

    await salvarEstadoPendente(exePath, {
      versaoAnterior: versaoAtual,
      versaoNova,
      exeAntigoPath: antigoPath,
      criadoEm: new Date().toISOString(),
    });

    let child;
    try {
      child = await spawnComRetry(exePath);
    } catch (e) {
      await reverterAtualizacao({ exePath, antigoPath });
      emitter.emit('status', { status: 'revertida', versao: versaoNova, em: new Date().toISOString() });
      throw new Error(`Falha ao iniciar a nova versão: ${e.message}`);
    }

    const sobreviveu = await aguardarLiveness(child, JANELA_LIVENESS_MS);
    if (!sobreviveu) {
      await reverterAtualizacao({ exePath, antigoPath });
      emitter.emit('status', { status: 'revertida', versao: versaoNova, em: new Date().toISOString() });
      throw new Error('A nova versão não permaneceu em execução — atualização revertida automaticamente.');
    }

    child.unref();
    emitter.emit('status', { status: 'respawned', versao: versaoNova, em: new Date().toISOString() });
    setTimeout(() => process.exit(0), 500);
  } finally {
    atualizando = false;
  }
}

/**
 * Chamado pelo processo NOVO depois que o primeiro ciclo de sync terminou sem exceção —
 * critério simples de propósito, já que erros pontuais de tabela/rede são rotina
 * operacional e não indicam build quebrado (uma exceção que impede até isso é coberta pela
 * segunda camada de rollback em index.js, fora deste módulo). Libera o .exe antigo e
 * encerra o "período de prova" desta atualização.
 */
async function confirmarAtualizacao(exePath) {
  const estado = lerEstadoPendente(exePath);
  if (!estado) return null;
  if (estado.exeAntigoPath) await fsp.unlink(estado.exeAntigoPath).catch(() => {});
  await apagarEstadoPendente(exePath);
  const info = { status: 'sucesso', versao: estado.versaoNova, em: new Date().toISOString() };
  emitter.emit('status', info);
  return info;
}

/**
 * Remove arquivos client.old(.timestamp).exe / client.new(.timestamp).exe / client.broken(.timestamp).exe
 * deixados por atualizações anteriores — inclui o formato antigo sem timestamp (nome fixo)
 * para limpar também o que uma versão anterior deste código possa ter deixado para trás.
 * Preserva o .exe antigo referenciado por um `.update-pending.json` ainda válido — ele pode
 * ainda ser necessário para um rollback (ver `confirmarAtualizacao`/Camada 2 em index.js).
 */
function limparExeAntigo(exePath) {
  const dir = path.dirname(exePath);
  const estado = lerEstadoPendente(exePath);
  const preservar = estado ? path.resolve(estado.exeAntigoPath) : null;
  fs.readdir(dir, (err, arquivos) => {
    if (err) return;
    for (const nome of arquivos) {
      if (/^client\.(old|new|broken)(\.\d+)?\.exe$/.test(nome)) {
        const caminho = path.join(dir, nome);
        if (preservar && path.resolve(caminho) === preservar) continue;
        fs.unlink(caminho, () => {}); // silencioso — pode ainda estar em uso
      }
    }
  });
}

module.exports = {
  verificarAtualizacao,
  verificarOpcoesBeta,
  escolherOpcoesBeta,
  ehBeta,
  aplicarAtualizacaoComRespawn,
  limparExeAntigo,
  compararVersoes,
  lerEstadoPendente,
  confirmarAtualizacao,
  emitter,
};
