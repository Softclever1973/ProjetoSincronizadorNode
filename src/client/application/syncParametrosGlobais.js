/**
 * Reconciliação dos parâmetros "globais" (paramsSyncMap[].global) entre este PDV e o
 * servidor — extraído de executarCiclo() em index.js. Servidor é fonte de verdade quando
 * ninguém mudou local; este PDV grava de volta via setParam quando outro PDV mudou primeiro.
 * Parâmetros não-globais seguem o comportamento legado: envio unidirecional, sem reconciliação.
 */
const { setParam, getParamDetalhado } = require('#client/infrastructure/firebird/db.js');
const { atualizarParametros, buscarParametros } = require('#client/http.js');
const { paramsSyncMap } = require('#client/infrastructure/config/paramsSyncMap.js');
const { lerEstado, salvarEstado, decidirAcao } = require('#client/parametrosGlobaisState.js');

async function syncParametrosGlobais(db, baseURI, contextoSync, log, { aplicarPull = true } = {}) {
  let parametrosServidor = {};
  try {
    const [{ parametros: resp } = {}] = await buscarParametros(baseURI);
    parametrosServidor = resp || {};
  } catch (e) {
    log(`[Parametros] falha ao buscar parametros do servidor: ${e.message}`);
  }

  const estadoAnterior = lerEstado();
  const novoEstado = { ...estadoAnterior };
  const pushPayload = {};
  const pullList = []; // { fbId, chave, valor }
  const agoraIso = new Date().toISOString();

  for (const { fbId, chave, global } of paramsSyncMap) {
    // getParamDetalhado (não getParam) — pega NOME_DA_TABELA/DESCRICAO/OBSERVACOES da
    // mesma linha do Firebird, pra levar pro Postgres.parametros junto do valor.
    const detalhado = await getParamDetalhado(db, fbId).catch(() => ({ valor: '', nomeDaTabela: null, descricao: null, observacoes: null }));
    const fbVal = detalhado.valor || null;
    const metadados = { id_parametro: fbId, nome_da_tabela: detalhado.nomeDaTabela, descricao: detalhado.descricao, observacoes: detalhado.observacoes };

    if (!global) {
      // Comportamento legado: envio unidirecional por PDV, sem reconciliação.
      if (fbVal) pushPayload[chave] = { valor: fbVal, ...metadados };
      continue;
    }

    const conhecido = estadoAnterior[chave]?.valor;
    const servidor  = parametrosServidor[chave];
    const { acao, valor } = decidirAcao({ local: fbVal, conhecido, servidor });

    if (acao === 'push') {
      pushPayload[chave] = { valor, ...metadados };
      novoEstado[chave] = { valor, origem: 'push', atualizadoEm: agoraIso };
    } else if (acao === 'pull' && aplicarPull) {
      pullList.push({ fbId, chave, valor });
      novoEstado[chave] = { valor, origem: 'pull', atualizadoEm: agoraIso };
    }
    // acao === 'pull' com aplicarPull=false (botão manual "Sincronizar com o servidor" da
    // WebUI): não grava nada no Firebird local nem mexe no estado — fica como está, e o
    // próximo ciclo automático (aplicarPull=true, padrão) decide normalmente. O botão manual
    // é intencionalmente client→server only; puxar do servidor pro Firebird continua sendo
    // responsabilidade exclusiva do ciclo de 30s.
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
      for (const [chave, dado] of Object.entries(pushPayload)) {
        const valor = dado.valor; // pushPayload[chave] agora é { valor, id_parametro, ... }, não string crua
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

  salvarEstado(novoEstado);
}

module.exports = { syncParametrosGlobais };
