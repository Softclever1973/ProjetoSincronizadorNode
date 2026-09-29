const express = require('express');
const { pausar, retomar, pausarEnvio, retomarEnvio, estadoPausa } = require('#client/application/syncEngine/controle.js');
const { obterSessao } = require('#client/interfaces/webui/authSession.js');

function criarControleRouter(contexto) {
  const router = express.Router();

  const _estado = () => ({ ...estadoPausa(), cicloEmAndamento: !!contexto.cicloEmAndamento });

  router.get('/api/sync/estado', (_req, res) => res.json(_estado()));

  router.post('/api/sync/pausar', (req, res) => {
    pausar(obterSessao(req)?.usuario || null);
    console.log('[Controle] Sincronização pausada pela web UI — o ciclo atual para no próximo registro.');
    res.json(_estado());
  });

  router.post('/api/sync/retomar', (_req, res) => {
    retomar();
    console.log('[Controle] Sincronização retomada pela web UI.');
    contexto.executarCicloAgora?.();
    res.json(_estado());
  });

  router.post('/api/sync/pausar-envio', (req, res) => {
    pausarEnvio(obterSessao(req)?.usuario || null);
    console.log('[Controle] Envio ao servidor pausado pela web UI — o recebimento continua.');
    res.json(_estado());
  });

  router.post('/api/sync/retomar-envio', (_req, res) => {
    retomarEnvio();
    console.log('[Controle] Envio ao servidor retomado pela web UI.');
    contexto.executarCicloAgora?.();
    res.json(_estado());
  });

  return router;
}

module.exports = { criarControleRouter };
