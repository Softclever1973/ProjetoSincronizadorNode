const express = require('express');

function criarAtualizacaoRouter(contexto) {
  const router = express.Router();

  // ── ATUALIZAÇÃO ──────────────────────────────────────────────────────────
  router.post('/atualizacao/aplicar', async (_req, res) => {
    if (typeof contexto._aplicarAtualizacao !== 'function') {
      return res.status(400).json({ ok: false, message: 'Atualização automática não disponível neste modo de execução.' });
    }
    try {
      // Baixa, substitui o .exe, relança e espera ~10s pra confirmar que a nova versão
      // ficou de pé antes de resolver — por isso esta chamada demora mais que as outras.
      // Se a nova versão não sobreviver à janela, isso lança e a versão anterior nunca
      // chega a sair (rollback automático já aconteceu antes do throw).
      await contexto._aplicarAtualizacao();
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  return router;
}

module.exports = { criarAtualizacaoRouter };
