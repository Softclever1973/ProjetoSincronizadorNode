/**
 * Hooks de handleSave (crud.js) específicos da tabela PEDIDOS.
 */
const { query, execute } = require('../../../../../infrastructure/db');
const { resolverNomeVendedor, gerarContasReceberDoPedido } = require('../helpers');

function aplicarCamposAutomaticos(req, registro) {
  const now        = new Date();
  const hojeIso    = now.toISOString().slice(0, 10);
  const horaUtcZ   = now.toISOString().slice(11, 19) + 'Z';
  const dataPedido = registro.DATA_DO_PEDIDO || hojeIso;
  const nomeUser   = req.userName || null;

  if (!registro.HORA_DO_PEDIDO)     registro.HORA_DO_PEDIDO    = horaUtcZ;
  if (!registro.TIPO_OPERACAO)      registro.TIPO_OPERACAO     = 'VD';
  if (!registro.DATA_DE_EMISSAO)    registro.DATA_DE_EMISSAO   = dataPedido;
  if (!registro.DATA_DE_EMISSAO_NF) registro.DATA_DE_EMISSAO_NF = dataPedido;
  if (!registro.USUARIO && nomeUser)      registro.USUARIO      = nomeUser;
  if (!registro.USUARIO_NOME && nomeUser) registro.USUARIO_NOME = nomeUser;
  if (!registro.AUTORIZADO_POR && nomeUser) registro.AUTORIZADO_POR = nomeUser;
  if (!registro.DATA_REALIZACAO && registro.STATUS === 'R')
    registro.DATA_REALIZACAO = dataPedido;
}

async function migrarSchema(db, schema, tabela, allowed) {
  // ENDERECO_ENTREGA_JSON é web-only: ENDERECO_ESCOLHIDO (sincronizado) é VARCHAR(8)
  // na filial, só cabe o CEP — não comporta o JSON completo (ver _assemblarEndereco
  // no frontend).
  for (const [col, type] of [['OUTRAS_DESPESAS', 'NUMERIC(15,2)'], ['MODALIDADE_FRETE', 'VARCHAR(1)'], ['ENDERECO_ENTREGA_JSON', 'TEXT']]) {
    if (!allowed.has(col)) {
      await execute(db, `ALTER TABLE ${tabela} ADD COLUMN IF NOT EXISTS ${col} ${type}`).catch(() => {});
      allowed.add(col);
    }
  }
}

async function denormalizar(db, schema, registro, allowed) {
  // O select do frontend chama-se MODALIDADE_FRETE, mas o campo real sincronizado
  // com o Firebird é FRETE_EMITENTE_DESTINATARIO (VARCHAR(1), mesmos códigos S/E/D/T/R/P).
  if (registro.MODALIDADE_FRETE && allowed.has('FRETE_EMITENTE_DESTINATARIO'))
    registro.FRETE_EMITENTE_DESTINATARIO = registro.MODALIDADE_FRETE;

  if (registro.ID_VENDEDOR && !registro.NOME_VENDEDOR && allowed.has('NOME_VENDEDOR')) {
    const nomeVendedor = await resolverNomeVendedor(db, schema, registro.ID_VENDEDOR);
    if (nomeVendedor) registro.NOME_VENDEDOR = nomeVendedor;
  }
}

async function validarTransicao(db, { registro, update, dadosAntes }) {
  // Pedido cancelado trava qualquer edição, não só uma tentativa de mudar o status —
  // não existe caminho de volta a partir de Cancelado.
  if (update && dadosAntes?.STATUS === 'C') {
    throw Object.assign(
      new Error('Pedido cancelado não pode ser editado.'),
      { isValidation: true }
    );
  }

  // Realizado não pode ir direto pra Cancelado (precisa voltar a Pendente
  // antes); nenhuma das duas transições é permitida se alguma parcela já tiver
  // pagamento registrado.
  if (update && dadosAntes && registro.STATUS && registro.STATUS !== dadosAntes.STATUS) {
    const statusAntigo = dadosAntes.STATUS;
    const statusNovo   = registro.STATUS;
    if (statusAntigo === 'R' && statusNovo === 'C') {
      throw Object.assign(
        new Error('Pedido realizado não pode ser cancelado diretamente — volte para pendente primeiro.'),
        { isValidation: true }
      );
    }
    if ((statusAntigo === 'R' && statusNovo === 'P') || (statusAntigo === 'P' && statusNovo === 'C')) {
      const pago = await query(db,
        `SELECT 1 FROM PEDIDOS_PARCELAS_PAGAMENTOS WHERE ID_PEDIDO = $1 AND STATUS = 'R' LIMIT 1`,
        [registro.ID_PEDIDO]
      ).catch(() => []);
      if (pago.length > 0) throw Object.assign(
        new Error('Não é possível alterar o status: já existe pagamento registrado para este pedido.'),
        { isValidation: true }
      );
    }
  }
}

function aposSalvar(schema, { registro, dadosAntes }) {
  // Pedido virou Realizado — gera as A_RECEBER das parcelas já cadastradas (fire-and-forget).
  // Pagamento não é pré-requisito para "Realizado": ver gerarContasReceberDoPedido().
  if (registro.STATUS === 'R' && dadosAntes?.STATUS !== 'R') {
    gerarContasReceberDoPedido(schema, registro.ID_PEDIDO).catch(e =>
      console.error('[CRUD-pedidoRealizado] Falha ao gerar A_RECEBER:', e.message)
    );
  }
}

module.exports = { aplicarCamposAutomaticos, migrarSchema, denormalizar, validarTransicao, aposSalvar };
