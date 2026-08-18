/**
 * Reconciliação dos parâmetros "globais" (paramsSyncMap[].global) entre este PDV e o
 * servidor — extraído de executarCiclo() em index.js. Servidor é fonte de verdade quando
 * ninguém mudou local; este PDV grava de volta via setParam quando outro PDV mudou primeiro.
 * Parâmetros não-globais seguem o comportamento legado: envio unidirecional, sem reconciliação.
 */
const { getParam, setParam } = require('../infrastructure/firebird/db');
const { atualizarParametros, buscarParametros } = require('../http');
const { paramsSyncMap } = require('../infrastructure/config/paramsSyncMap');
const { lerEstado, salvarEstado, decidirAcao } = require('../parametrosGlobaisState');

async function syncParametrosGlobais(db, baseURI, contextoSync, log) {
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

  salvarEstado(novoEstado);
}

module.exports = { syncParametrosGlobais };
