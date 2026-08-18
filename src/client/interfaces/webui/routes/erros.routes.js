const express = require('express');
const { lerTodos: lerErros, limparErros } = require('../../../infrastructure/persistence/erros');

function criarErrosRouter() {
  const router = express.Router();

  // ── API: contagem para badge ─────────────────────────────────────────────
  router.get('/api/erros/count', async (_req, res) => {
    try {
      const erros = await lerErros();
      res.json({ total: erros.length });
    } catch (e) {
      res.status(500).json({ total: 0, error: e.message });
    }
  });

  // ── ERROS ────────────────────────────────────────────────────────────────
  router.get('/erros', async (_req, res) => {
    try {
      const erros = await lerErros();
      res.render('erros', { erros });
    } catch (e) {
      res.status(500).render('erros', { erros: [] });
    }
  });

  router.post('/erros/limpar', async (_req, res) => {
    try {
      await limparErros();
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return router;
}

module.exports = { criarErrosRouter };
