/**
 * Ponto de entrada das rotas de tabelas.
 * Compõe os sub-routers em um único express.Router exportado para src/server.js.
 *
 * Estrutura do módulo:
 *   constants.js  — constantes e validações de negócio
 *   helpers.js    — colunasTabela, resolveIdLoja, registrarAuditLog, buildNomeLojaExpr,
 *                   dateExprFromCols, buildWhere
 *   crud.js       — GET/POST/DELETE /tabelas/:tabela + /colunas, /next-pk, /by-pk, /distinct
 *   pedidos.js    — /pedidos-completo, /pedidos-lista, /pedidos/:id/itens, /pedidos/:id/pagamentos
 *   dashboard.js  — /dashboard e todos os sub-endpoints de gráficos
 *   audit.js      — /audit-log
 *   admin.js      — /admin/sync-config (GET + PUT) + /filiais
 */

const express   = require('express');
const router    = express.Router();

router.use('/', require('./crud'));
router.use('/', require('./pedidos'));
router.use('/', require('./dashboard'));
router.use('/', require('./audit'));
router.use('/', require('./admin'));

module.exports = router;
