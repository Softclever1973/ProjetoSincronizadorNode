/**
 * Loga o erro com um ID rastreável e responde 500 com JSON — nunca expõe e.message
 * (pode conter SQL/detalhe interno) na resposta ao cliente. O ID aparece tanto no log
 * do servidor quanto na resposta, use-o para grep. Compartilhado entre todas as rotas
 * de resources/ (antes só existia dentro de crud.js; pedidos.js e dashboard.js
 * devolviam e.message cru).
 */
function erroServidor(res, e, rota) {
  const id = `CRUD-${Date.now().toString(36).slice(-6).toUpperCase()}`;
  console.error(`[${id}] ${rota}:`, e.stack || e.message);
  res.status(500).json({ erro: 'Erro interno do servidor.', id });
}

module.exports = { erroServidor };
