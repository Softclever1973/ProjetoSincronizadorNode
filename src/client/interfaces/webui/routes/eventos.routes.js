const express = require('express');
const { emitter: conflitosEmitter } = require('../../../infrastructure/persistence/conflitos');
const { emitter: errosEmitter } = require('../../../infrastructure/persistence/erros');
const { emitter: atualizacaoEmitter } = require('../../../application/updater');
const { emitter: resetEmitter } = require('../../../application/resetLocal');

function criarEventosRouter() {
  const router = express.Router();

  // ── SSE: stream de erros em tempo real ──────────────────────────────────
  router.get('/eventos', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Mantém a conexão viva com um comentário a cada 25s (evita timeout de proxies)
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 25_000);

    const onErro = (erro) => {
      res.write(`event: novo-erro\ndata: ${JSON.stringify(erro)}\n\n`);
    };

    const onConflito = (conflito) => {
      res.write(`event: novo-conflito\ndata: ${JSON.stringify(conflito)}\n\n`);
    };

    const onAtualizacaoStatus = (status) => {
      res.write(`event: atualizacao-status\ndata: ${JSON.stringify(status)}\n\n`);
    };

    const onResetPendente = (info) => {
      res.write(`event: novo-reset-pendente\ndata: ${JSON.stringify(info)}\n\n`);
    };

    errosEmitter.on('novo-erro', onErro);
    conflitosEmitter.on('novo-conflito', onConflito);
    atualizacaoEmitter.on('status', onAtualizacaoStatus);
    resetEmitter.on('novo-reset-pendente', onResetPendente);

    req.on('close', () => {
      clearInterval(keepAlive);
      errosEmitter.off('novo-erro', onErro);
      conflitosEmitter.off('novo-conflito', onConflito);
      atualizacaoEmitter.off('status', onAtualizacaoStatus);
      resetEmitter.off('novo-reset-pendente', onResetPendente);
    });
  });

  return router;
}

module.exports = { criarEventosRouter };
