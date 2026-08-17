/**
 * Hooks de handleSave (crud.js) específicos da tabela PEDIDOS_PARCELAS_PAGAMENTOS.
 */
const { execute } = require('../../../server/infrastructure/db');
const { pedidoEstaCancelado } = require('../helpers');

async function antesDaTransacao(db, registro) {
  // Pedido cancelado trava itens e parcelas — insert ou update, não só transição
  // de status do próprio PEDIDOS.
  if (await pedidoEstaCancelado(db, registro.ID_PEDIDO)) {
    throw Object.assign(
      new Error('Pedido cancelado — não é possível alterar itens ou parcelas de pagamento.'),
      { isValidation: true }
    );
  }
}

async function migrarSchema(db, schema, tabela, allowed) {
  if (!allowed.has('STATUS')) {
    await execute(db, `ALTER TABLE ${tabela} ADD COLUMN IF NOT EXISTS STATUS TEXT`).catch(() => {});
    allowed.add('STATUS');
  }
}

module.exports = { antesDaTransacao, migrarSchema };
