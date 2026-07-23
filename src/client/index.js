const fs = require('fs');
const path = require('path');

// DEP0060 (util._extend) vem do node-firebird internamente — é inofensivo e
// não há nada a corrigir no nosso código. Suprime apenas esse aviso específico.
process.on('warning', w => { if (w.code !== 'DEP0060') process.stderr.write(`Warning: ${w.message}\n`); });

const isPackaged = typeof process.pkg !== 'undefined';

// Iniciado via chave de registro Run (Windows autostart, "Iniciar com o Windows" na
// bandeja) herda cwd = C:\Windows\System32 — sem permissão de escrita ali, isso quebra com
// EPERM qualquer módulo que grave estado via process.cwd() (conflitos.js, tabelasConfig.js,
// parametrosGlobaisState.js). Fixa o cwd pra pasta do .exe logo de cara, antes de qualquer
// spawn ou require desses módulos, pra funcionar igual não importa como foi iniciado
// (duplo-clique, --background manual, ou o registro Run) — o child spawnado pelo bloco
// --background abaixo também herda esse cwd corrigido, então cobre os dois processos.
if (isPackaged) {
  try { process.chdir(path.dirname(process.execPath)); } catch { /* segue mesmo assim — mesmo EPERM de antes, não piora nada */ }
}

// Quando empacotado, __dirname é read-only (virtual). Usa o diretório do .exe.
const ENV_PATH = isPackaged
  ? path.join(path.dirname(process.execPath), '.env')
  : path.resolve(__dirname, '.env');
const CONFIG_ENC_PATH = path.join(path.dirname(ENV_PATH), 'config.enc');
// DPAPI so existe no Windows e so faz sentido pra um .exe instalado numa loja (amarra
// a um Windows/usuario fixo) — em dev (npm run client) continua sendo .env em texto puro.
const USAR_CRIPTOGRAFIA = isPackaged && process.platform === 'win32';

const LOG_PATH   = path.join(path.dirname(ENV_PATH), 'client.log');
const CRASH_PATH = path.join(path.dirname(ENV_PATH), 'crash.log');

function encerrarComErro(err) {
  const linhas = [
    '',
    '╔══════════════════════════════════════════════╗',
    '║      ERRO — o cliente não pôde iniciar       ║',
    '╚══════════════════════════════════════════════╝',
    '',
    err.message,
    '',
    'Verifique o arquivo de configuração (config.enc ou .env) na pasta do executável.',
    '',
  ];
  console.error(linhas.join('\n'));

  try { fs.appendFileSync(CRASH_PATH, `[${new Date().toISOString()}] ${err.stack || err.message}\n`); } catch { /* sem saída */ }

  if (process.stdin.isTTY) {
    console.error('Pressione Enter para fechar...');
    const rl = require('readline').createInterface({ input: process.stdin });
    rl.once('line', () => { rl.close(); process.exit(1); });
  } else {
    setTimeout(() => process.exit(1), 1500);
  }
}

// ---------------------------------------------------------------------------
// --background: relança o processo com janela oculta e sai do terminal atual
// (uso explícito — o exe não faz isso automaticamente)
// ---------------------------------------------------------------------------
if (process.argv.includes('--background')) {
  if (!fs.existsSync(ENV_PATH) && !fs.existsSync(CONFIG_ENC_PATH)) {
    console.error('[ERRO] Configure o cliente primeiro (execute sem --background).');
    process.exit(1);
  }
  const { spawn } = require('child_process');
  const childArgs = isPackaged
    ? process.argv.slice(2).filter(a => a !== '--background')
    : [process.argv[1], ...process.argv.slice(2).filter(a => a !== '--background')];
  spawn(process.execPath, childArgs, {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, SINCRONIZADOR_BG: '1' },
  }).unref();
  console.log('  Cliente iniciado em segundo plano.');
  console.log('  Web UI: http://localhost:3001');
  console.log('  Logs em: ' + LOG_PATH);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Força UTF-8 no terminal Windows (code page 65001) quando há console ativo
// ---------------------------------------------------------------------------
if (!process.env.SINCRONIZADOR_BG && process.platform === 'win32' && process.stdout.isTTY) {
  try { require('child_process').execSync('chcp 65001', { stdio: 'pipe' }); } catch {}
}

// ---------------------------------------------------------------------------
// Quando rodando em segundo plano, redireciona console para arquivo (máx 5 MB)
// ---------------------------------------------------------------------------
if (process.env.SINCRONIZADOR_BG) {
  try {
    if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > 5 * 1024 * 1024) {
      fs.writeFileSync(LOG_PATH, '');
    }
  } catch { }
  const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });
  const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log = (...a) => logStream.write(`${ts()} ${a.join(' ')}\n`);
  console.error = (...a) => logStream.write(`${ts()} [ERRO] ${a.join(' ')}\n`);
}

// ---------------------------------------------------------------------------
// Handlers globais — evitam que erros não tratados encerrem o processo
// ---------------------------------------------------------------------------
process.on('uncaughtException', e => {
  console.error(`[uncaughtException] ${e.stack || e.message}`);
  try { require('./erros').salvarErro({ operacao: 'uncaughtException', mensagem: e.stack || e.message }); } catch {}
});
process.on('unhandledRejection', e => {
  const msg = e instanceof Error ? (e.stack || e.message) : String(e);
  console.error(`[unhandledRejection] ${msg}`);
  try { require('./erros').salvarErro({ operacao: 'unhandledRejection', mensagem: msg }); } catch {}
});

// ---------------------------------------------------------------------------
// Fechar o X da janela do console → continuar rodando só na bandeja do sistema
// (SIGHUP é disparado no Windows quando o usuário fecha a janela do console)
// ---------------------------------------------------------------------------
if (isPackaged && !process.env.SINCRONIZADOR_BG) {
  process.on('SIGHUP', () => {
    if (!fs.existsSync(ENV_PATH) && !fs.existsSync(CONFIG_ENC_PATH)) { process.exit(0); return; }
    require('child_process').spawn(process.execPath, [], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, SINCRONIZADOR_BG: '1' },
    }).unref();
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------
// Inicialização principal — reinicia automaticamente em caso de erro fatal
// ---------------------------------------------------------------------------
// Le a configuracao de credenciais (config.enc criptografado ou .env legado em texto
// puro), rodando o wizard se nenhum dos dois existir ainda. Se so existir o .env antigo
// num build empacotado, migra pra config.enc na hora e apaga o texto puro — cobre quem
// ja tinha o cliente instalado antes dessa mudanca, sem precisar reconfigurar do zero.
async function carregarConfiguracao() {
  if (fs.existsSync(CONFIG_ENC_PATH)) {
    const { desprotegerConfig } = require('./config-crypto');
    let dados;
    try {
      dados = desprotegerConfig(fs.readFileSync(CONFIG_ENC_PATH, 'utf8'));
    } catch (e) {
      throw new Error(
        `Não foi possível descriptografar config.enc (${e.message}). ` +
        'Isso acontece se o arquivo foi copiado para outro Windows/usuário — ' +
        'a criptografia é amarrada à máquina/usuário original. ' +
        'Apague config.enc e execute novamente para reconfigurar.'
      );
    }
    Object.assign(process.env, dados);
    return;
  }

  if (fs.existsSync(ENV_PATH)) {
    require('dotenv').config({ path: ENV_PATH });
    if (USAR_CRIPTOGRAFIA) {
      try {
        const { protegerConfig } = require('./config-crypto');
        const CHAVES = ['SYNC_TOKEN', 'FIREBIRD_HOST', 'FIREBIRD_PORT', 'FIREBIRD_DATABASE', 'FIREBIRD_USER', 'FIREBIRD_PASSWORD', 'INTERVALO_MS', 'NOME_FILIAL'];
        const dados = {};
        for (const chave of CHAVES) if (process.env[chave] !== undefined) dados[chave] = process.env[chave];
        fs.writeFileSync(CONFIG_ENC_PATH, protegerConfig(dados), 'utf8');
        fs.unlinkSync(ENV_PATH);
        console.log('[OK] .env migrado para config.enc (criptografado) — o arquivo em texto puro foi removido.');
      } catch (e) {
        console.error('[!] Não foi possível migrar .env para config.enc automaticamente: ' + e.message);
      }
    }
    return;
  }

  const { runSetupWizard } = require('./setup-wizard');
  const dados = await runSetupWizard({
    destino: USAR_CRIPTOGRAFIA ? CONFIG_ENC_PATH : ENV_PATH,
    criptografado: USAR_CRIPTOGRAFIA,
  });
  Object.assign(process.env, dados);
}

async function main() {
  try {
    await carregarConfiguracao();
  } catch (e) {
    // Falha de configuração (ex.: config.enc ilegível) é permanente, não transitória —
    // encerra direto em vez de deixar o laço de retry no fim do arquivo tentar de novo
    // por até 90s (mesmo padrão do erro de SYNC_TOKEN ausente, logo abaixo).
    encerrarComErro(e);
    return;
  }

  const { getConnection, closeConnection, getParam, setParam, getTabelasExistentes } = require('./db');
  const { sincronizarTabela } = require('./sync');
  const { empurrarTabela } = require('./push');
  const { atualizarRegime, atualizarParametros, buscarParametros } = require('./http');
  const { paramsSyncMap } = require('./paramsSyncMap');
  const { lerEstado: lerEstadoParametros, salvarEstado: salvarEstadoParametros, decidirAcao } = require('./parametrosGlobaisState');
  const { setup } = require('./setup');
  const { iniciarWebUI } = require('./webui');
  const TABELAS = require('./tabelas');
  const { tabelaAtiva } = require('./tabelasConfig');
  const { salvarErro } = require('./erros');
  const {
    verificarAtualizacao, aplicarAtualizacaoComRespawn, limparExeAntigo,
    lerEstadoPendente, confirmarAtualizacao, emitter: atualizacaoEmitter,
  } = require('./updater');
  const { notificarToast } = require('./notificar');
  const { version: VERSAO_ATUAL } = require('../../package.json');

  if (!process.env.SYNC_TOKEN) {
    encerrarComErro(new Error('SYNC_TOKEN não configurado no .env'));
    return;
  }

  const INTERVALO_MS = parseInt((process.env.INTERVALO_MS || '30000').replace(/_/g, ''), 10);
  const PORTA_WEBUI = 3001;
  const INTERVALO_ATUALIZACAO_MS = 10 * 60 * 1000; // 10min — 6 checagens/hora por cliente, bem abaixo do rate-limit (60/hora)

  let rodando = false;
  const contextoSync = {
    baseURI: null, idLoja: null, idPDV: null, parametrosSincronizados: {},
    versaoAtual: VERSAO_ATUAL, atualizacaoDisponivel: null, atualizacaoStatus: null,
  };

  function log(msg) {
    const hora = new Date().toLocaleTimeString('pt-BR');
    console.log(`[${hora}] ${msg}`);
  }

  // AUTO_ATUALIZAR: ligado por padrão — só 'false' explícito desliga o auto-apply e volta
  // ao fluxo 100% manual (banner + botão "Atualizar agora").
  const AUTO_ATUALIZAR = process.env.AUTO_ATUALIZAR !== 'false';
  const MAX_TENTATIVAS_AUTO_POR_VERSAO = 3;
  const JANELA_JITTER_MS = 4 * 60 * 60 * 1000; // 0-4h, espalha a aplicação automática entre lojas

  // Espera determinística por loja (0-4h) entre "detectar" e "aplicar automaticamente" —
  // se um release tiver um problema sutil que escape do watchdog/rollback, dá tempo de
  // perceber antes que todas as lojas atualizem ao mesmo tempo. O botão manual ignora isso.
  function jitterMsParaLoja(idLoja) {
    if (!idLoja) return 0;
    let h = 0;
    const s = String(idLoja);
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % JANELA_JITTER_MS;
  }

  // ── Auto-atualização (só no .exe empacotado) ──
  // Roda a cada ciclo mas só bate a rede a cada INTERVALO_ATUALIZACAO_MS (10min) — evita
  // estourar o rate-limit do GitHub.
  let ultimaVerificacaoAtualizacao = 0;
  const versaoDetectadaEm = {}; // versao -> timestamp da 1ª detecção (sobrevive a re-checagens)
  async function verificarAtualizacaoSeNecessario() {
    if (!isPackaged) return;
    if (Date.now() - ultimaVerificacaoAtualizacao < INTERVALO_ATUALIZACAO_MS) return;
    ultimaVerificacaoAtualizacao = Date.now();
    try {
      const disponivel = await verificarAtualizacao(VERSAO_ATUAL);
      if (disponivel && disponivel.versao !== contextoSync.atualizacaoDisponivel?.versao) {
        log(`[Atualização] Nova versão disponível: v${disponivel.versao} (atual: v${VERSAO_ATUAL})`);
        notificarToast('Sincronizador', `Nova versão disponível: v${disponivel.versao}.`);
        if (!(disponivel.versao in versaoDetectadaEm)) versaoDetectadaEm[disponivel.versao] = Date.now();
      }
      contextoSync.atualizacaoDisponivel = disponivel;
    } catch (e) {
      log(`[Atualização] falha ao verificar nova versão: ${e.message}`);
    }
  }

  // Decide se aplica a atualização detectada automaticamente — chamado só entre ciclos
  // (nunca no meio de um pull/push), ver `cicloComAutoAtualizacao` mais abaixo.
  const tentativasFalhasPorVersao = {};
  async function aplicarAtualizacaoSeNecessario() {
    if (!isPackaged || !AUTO_ATUALIZAR) return;
    const info = contextoSync.atualizacaoDisponivel;
    if (!info?.urlDownload) return;
    if (!contextoSync.idLoja) return; // ainda sem loja conhecida — sem isso não dá pra calcular o jitter

    const detectadaEm = versaoDetectadaEm[info.versao] ?? Date.now();
    if (Date.now() - detectadaEm < jitterMsParaLoja(contextoSync.idLoja)) return;

    const tentativas = tentativasFalhasPorVersao[info.versao] || 0;
    if (tentativas >= MAX_TENTATIVAS_AUTO_POR_VERSAO) return;

    try {
      await contextoSync._aplicarAtualizacao();
      // se não lançou, o respawn foi confirmado e este processo já está saindo (ver updater.js)
    } catch (e) {
      tentativasFalhasPorVersao[info.versao] = tentativas + 1;
      log(`[Atualização] tentativa automática falhou (${tentativas + 1}/${MAX_TENTATIVAS_AUTO_POR_VERSAO}): ${e.message}`);
    }
  }

  // Estado herdado de uma atualização em andamento quando ESTE processo é o "novo" —
  // confirmado (ou não) depois do primeiro ciclo, ver abaixo.
  let estadoPosAtualizacao = isPackaged ? lerEstadoPendente(process.execPath) : null;

  if (isPackaged) {
    limparExeAntigo(process.execPath); // remove sobras de atualizações anteriores (preserva o que um rollback pendente ainda precisa)

    // Usada tanto pelo fluxo automático quanto pelo botão manual "Atualizar agora" — ambos
    // ganham o mesmo respawn supervisionado + rollback (ver updater.js).
    contextoSync._aplicarAtualizacao = async () => {
      const info = contextoSync.atualizacaoDisponivel;
      if (!info?.urlDownload) throw new Error('Nenhuma atualização disponível para baixar.');
      await aplicarAtualizacaoComRespawn({
        urlDownload: info.urlDownload,
        exePath: process.execPath,
        versaoAtual: VERSAO_ATUAL,
        versaoNova: info.versao,
      });
    };

    atualizacaoEmitter.on('status', (status) => {
      contextoSync.atualizacaoStatus = status;
      if (status.status === 'aplicando') notificarToast('Sincronizador', `Atualizando para v${status.versao}...`);
      else if (status.status === 'revertida') notificarToast('Sincronizador', `Falha ao atualizar para v${status.versao} — revertido automaticamente para a versão anterior.`);
    });
  }

  // Inicia tray ANTES do loop do Firebird para que apareça imediatamente
  // (mostra quando empacotado — em modo background ou normal)
  if (isPackaged) {
    const { iniciarTray } = require('./tray');
    iniciarTray(PORTA_WEBUI, LOG_PATH).catch(e => console.error('[tray] ' + e.message));
  }

  async function executarCiclo() {
    if (rodando) return;
    rodando = true;
    await verificarAtualizacaoSeNecessario(); // primeiro passo do ciclo — ver comentário acima
    let db;
    try {
      db = await getConnection();
    } catch (e) {
      log(`Firebird indisponível no ciclo: ${e.message} — aguardando próximo intervalo`);
      salvarErro({ operacao: 'ciclo', mensagem: e.message });
      rodando = false;
      return;
    }
    try {
      const tabelasExistentes = await getTabelasExistentes(db);
      const baseURI = (await getParam(db, 60024)).replace(/\/+$/, '');
      const idLoja = parseInt(await getParam(db, 50003), 10);
      const idPDVRaw = await getParam(db, 50004);
      const idPDV = idPDVRaw ? parseInt(idPDVRaw, 10) : null;
      const nomeFilialFirebird = await getParam(db, 50005);
      const nomeFilial = process.env.NOME_FILIAL || nomeFilialFirebird || '';
      const regimeFirebird = await getParam(db, 40026).catch(() => null);
      if (regimeFirebird && baseURI) {
        atualizarRegime(baseURI, regimeFirebird).catch(() => {});
      }
      if (baseURI) {
        try {
          // Parâmetros globais (paramsSyncMap[].global) reconciliam pro mesmo valor em
          // todos os PDVs — servidor é fonte de verdade quando ninguém mudou local, e
          // este PDV grava de volta via setParam quando outro mudou primeiro.
          let parametrosServidor = {};
          try {
            const [{ parametros: resp } = {}] = await buscarParametros(baseURI);
            parametrosServidor = resp || {};
          } catch (e) {
            log(`[Parametros] falha ao buscar parametros do servidor: ${e.message}`);
          }

          const estadoAnterior = lerEstadoParametros();
          const novoEstado = { ...estadoAnterior };
          const pushPayload = {};
          const pullList = []; // { fbId, chave, valor }
          const agoraIso = new Date().toISOString();

          for (const { fbId, chave, global } of paramsSyncMap) {
            const fbVal = (await getParam(db, fbId).catch(() => '')) || null;

            if (!global) {
              // Comportamento legado: envio unidirecional por PDV, sem reconciliação.
              if (fbVal) pushPayload[chave] = fbVal;
              continue;
            }

            const conhecido = estadoAnterior[chave]?.valor;
            const servidor  = parametrosServidor[chave];
            const { acao, valor } = decidirAcao({ local: fbVal, conhecido, servidor });

            if (acao === 'push') {
              pushPayload[chave] = valor;
              novoEstado[chave] = { valor, origem: 'push', atualizadoEm: agoraIso };
            } else if (acao === 'pull') {
              pullList.push({ fbId, chave, valor });
              novoEstado[chave] = { valor, origem: 'pull', atualizadoEm: agoraIso };
            }
          }

          // Aplica pulls no Firebird ANTES de persistir o estado — se falhar,
          // desfaz a confirmação otimista para repetir a tentativa no próximo ciclo.
          for (const { fbId, chave, valor } of pullList) {
            try {
              await setParam(db, fbId, valor);
              log(`[Parametros] '${chave}' atualizado localmente a partir do servidor: ${valor}`);
              contextoSync.parametrosSincronizados[chave] = { valor, sincronizadoEm: new Date(), status: 'ok', origem: 'pull' };
            } catch (e) {
              log(`[Parametros] falha ao gravar '${chave}' no Firebird: ${e.message}`);
              novoEstado[chave] = estadoAnterior[chave];
              contextoSync.parametrosSincronizados[chave] = {
                ...contextoSync.parametrosSincronizados[chave],
                status: 'erro', erro: e.message, tentadoEm: new Date(),
              };
            }
          }

          if (Object.keys(pushPayload).length) {
            try {
              await atualizarParametros(baseURI, pushPayload);
              const agora = new Date();
              for (const [chave, valor] of Object.entries(pushPayload)) {
                const anterior = contextoSync.parametrosSincronizados[chave];
                if (anterior?.valor !== valor) {
                  log(`[Parametros] '${chave}' sincronizado com o servidor: ${valor}`);
                }
                contextoSync.parametrosSincronizados[chave] = { valor, sincronizadoEm: agora, status: 'ok', origem: 'push' };
              }
            } catch (e) {
              for (const chave of Object.keys(pushPayload)) {
                contextoSync.parametrosSincronizados[chave] = {
                  ...contextoSync.parametrosSincronizados[chave],
                  status: 'erro', erro: e.message, tentadoEm: new Date(),
                };
                novoEstado[chave] = estadoAnterior[chave]; // desfaz confirmação otimista da chave cujo push falhou
              }
              log(`[Parametros] falha ao enviar parametros ao servidor: ${e.message}`);
            }
          }

          salvarEstadoParametros(novoEstado);
        } catch (e) {
          log(`[Parametros] erro ao sincronizar parametros: ${e.message}`);
        }
      }

      const tabelasAusentes = TABELAS.filter(t => tabelaAtiva(t.nome) && !tabelasExistentes.has(t.nome));
      for (const tabelaAusente of tabelasAusentes) {
        log(`[${tabelaAusente.nome}] tabela ausente no Firebird — pulando sync`);
      }

      if (!baseURI) {
        const msg = 'Parâmetro 60024 (URL do servidor) não configurado.';
        log('ERRO: ' + msg);
        salvarErro({ operacao: 'config', mensagem: msg });
        return;
      }
      if (!idLoja) {
        const msg = 'Parâmetro 50003 (número da loja) não configurado.';
        log('ERRO: ' + msg);
        salvarErro({ operacao: 'config', mensagem: msg });
        return;
      }

      contextoSync.baseURI = baseURI;
      contextoSync.idLoja = idLoja;
      contextoSync.idPDV = idPDV;
      contextoSync.nomeFilial = nomeFilial;

      log(`Iniciando ciclo — servidor: ${baseURI} | loja: ${idLoja}${nomeFilial ? ` (${nomeFilial})` : ''}${idPDV ? ` | PDV: ${idPDV}` : ''}`);

      const tabelasParaSincronizar = TABELAS.filter(t => tabelaAtiva(t.nome) && tabelasExistentes.has(t.nome));

      if (tabelasParaSincronizar.length === 0) {
        log('Nenhuma tabela ativa — acesse http://localhost:3001/configuracoes para ativar tabelas.');
      }

      for (const tabela of tabelasParaSincronizar) {
        try {
          await sincronizarTabela(db, baseURI, idLoja, tabela, log, idPDV, nomeFilial);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          log(`[${tabela.nome}] Erro no pull: ${msg}`);
          salvarErro({ tabela: tabela.nome, operacao: 'pull', mensagem: msg });
        }
      }

      for (const tabela of tabelasParaSincronizar) {
        try {
          await empurrarTabela(db, baseURI, idLoja, tabela, log, idPDV, nomeFilial);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          log(`[${tabela.nome}] Erro no push: ${msg}`);
          salvarErro({ tabela: tabela.nome, operacao: 'push', mensagem: msg });
        }
      }

      log('Ciclo concluído.');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`Erro no ciclo: ${msg}`);
      salvarErro({ operacao: 'ciclo', mensagem: msg });
    } finally {
      await closeConnection(db);
      rodando = false;
    }
  }

  log(`Cliente iniciado. Intervalo: ${INTERVALO_MS / 1000}s`);

  iniciarWebUI(PORTA_WEBUI, contextoSync);

  // Tenta conectar ao Firebird — repete até conseguir (banco pode estar iniciando)
  while (true) {
    try {
      const db = await getConnection();
      try { await setup(db, log, process.env.SYNC_TOKEN); } finally { await closeConnection(db); }
      break;
    } catch (e) {
      log(`Firebird indisponível: ${e.message} — tentando novamente em 30s...`);
      salvarErro({ operacao: 'firebird', mensagem: e.message });
      await new Promise(r => setTimeout(r, 30000));
    }
  }

  async function cicloComAutoAtualizacao() {
    await executarCiclo();
    await aplicarAtualizacaoSeNecessario();
  }

  // Pausa breve para o Firebird liberar a sessão do setup antes do primeiro ciclo.
  // Sem isso, o detach() e a nova conexão chegam ao servidor quase simultaneamente
  // e ele rejeita com "user name and password not defined".
  await new Promise(r => setTimeout(r, 1000));
  await executarCiclo();

  // Este processo é o "novo" de uma atualização recém-aplicada: o primeiro ciclo acima
  // terminou sem lançar exceção (executarCiclo já engole tudo internamente) — critério
  // simples de propósito para "o build subiu e está funcionando". Libera o .exe antigo.
  if (estadoPosAtualizacao) {
    const confirmado = await confirmarAtualizacao(process.execPath);
    if (confirmado) notificarToast('Sincronizador', `Atualizado com sucesso para v${confirmado.versao}.`);
    estadoPosAtualizacao = null;
  }

  setInterval(cicloComAutoAtualizacao, INTERVALO_MS);
}

// Segunda camada de rollback (Camada 2): cobre o caso de um build recém-atualizado que
// lança exceção síncrona antes mesmo de chegar ao primeiro executarCiclo() — mais lento
// que o watchdog de liveness em updater.js (Camada 1), mas ainda dentro deste laço de
// retry. Deliberadamente NÃO usa require('./updater') — se o bug estiver dentro desse
// módulo, importá-lo aqui durante o rollback poderia falhar também. Só fs/path/child_process.
function _temAtualizacaoPendenteBruto() {
  try {
    return fs.existsSync(path.join(path.dirname(process.execPath), '.update-pending.json'));
  } catch {
    return false;
  }
}

function _rollbackAtualizacaoFatalBruto() {
  try {
    const exePath = process.execPath;
    const dir = path.dirname(exePath);
    const statePath = path.join(dir, '.update-pending.json');
    if (!fs.existsSync(statePath)) return false;

    let estado;
    try { estado = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return false; }
    if (!estado || !estado.exeAntigoPath || !fs.existsSync(estado.exeAntigoPath)) return false;

    const quebradoPath = path.join(dir, `client.broken.${Date.now()}.exe`);
    try { fs.renameSync(exePath, quebradoPath); } catch { /* segue tentando restaurar mesmo assim */ }
    fs.renameSync(estado.exeAntigoPath, exePath);
    try { fs.unlinkSync(statePath); } catch {}

    require('child_process').spawn(exePath, [], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, SINCRONIZADOR_BG: '1' },
    }).unref();
    return true;
  } catch {
    return false;
  }
}

// Reinicia automaticamente se main() lançar erro inesperado
(async () => {
  let tentativas = 0;
  while (true) {
    try {
      await main();
      break;
    } catch (e) {
      tentativas++;
      const msg = e.stack || e.message;
      try { require('./erros').salvarErro({ operacao: 'fatal', mensagem: msg }); } catch {}

      const pendente = isPackaged && _temAtualizacaoPendenteBruto();

      // Após 3 falhas consecutivas na inicialização, para (ou reverte, se for um build
      // recém-atualizado que nunca conseguiu subir)
      if (tentativas >= 3) {
        if (pendente) {
          console.error('[Atualização] a nova versão falhou ao iniciar 3x seguidas — revertendo para a versão anterior...');
          const revertido = _rollbackAtualizacaoFatalBruto();
          if (revertido) {
            console.error('[Atualização] Revertido — a versão anterior foi reiniciada em segundo plano.');
            process.exit(1);
            return;
          }
          console.error('[Atualização] Falha ao reverter automaticamente — intervenção manual necessária.');
        }
        encerrarComErro(e);
        break;
      }

      // Build recém-atualizado falhando: backoff curto (é o suspeito óbvio, não vale
      // esperar como se fosse instabilidade de rede/infra transitória)
      const espera = pendente ? 3000 : 30000;
      console.error(`[ERRO FATAL] ${msg} — reiniciando em ${Math.round(espera / 1000)}s... (tentativa ${tentativas}/3)`);
      await new Promise(r => setTimeout(r, espera));
    }
  }
})();
