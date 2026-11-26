// Hooks de handleSave (crud.js) da PRODUTOS_X_LISTA: produto vinculado a uma lista de preços.
const { query } = require('#server/infrastructure/db.js');
const { calcularPrecoLista } = require('#server/domain/listaPrecos.js');

const campo = (registro, nome) => registro[Object.keys(registro).find(k => k.toUpperCase() === nome)];
const erroValidacao = msg => Object.assign(new Error(msg), { isValidation: true });

// PRECO é sempre calculado aqui (PRECO_VENDA atual ± ajuste da lista), nunca o valor vindo do site.
async function antesDaTransacao(db, registro) {
  const idLista = Number(campo(registro, 'ID_LISTA'));
  const idProduto = Number(campo(registro, 'ID_PRODUTO'));
  if (!idLista || !idProduto) throw erroValidacao('Informe a lista e o produto.');

  const [lista] = await query(db,
    'SELECT PERCENTUAL_ACRESCIMO_REDUCAO, PERCENTUAL_OU_VALOR FROM LISTA_PRECOS WHERE ID_LISTA = $1 LIMIT 1', [idLista]);
  if (!lista) throw erroValidacao('Lista de preço não encontrada.');
  const [produto] = await query(db, 'SELECT PRECO_VENDA FROM PRODUTOS WHERE ID_PRODUTO = $1 LIMIT 1', [idProduto]);
  if (!produto) throw erroValidacao('Produto não encontrado.');

  for (const k of Object.keys(registro)) if (k.toUpperCase() === 'PRECO') delete registro[k];
  registro.PRECO = calcularPrecoLista(produto.PRECO_VENDA, lista);
}

// Mesmo produto só uma vez por lista.
async function validarUnicidade(db, { registro }) {
  const params = [Number(campo(registro, 'ID_LISTA')), Number(campo(registro, 'ID_PRODUTO'))];
  const idVinculo = campo(registro, 'ID_PRODUTO_X_LISTA');
  let excluir = '';
  if (idVinculo != null) { params.push(Number(idVinculo)); excluir = ' AND ID_PRODUTO_X_LISTA <> $3'; }
  const [dup] = await query(db,
    `SELECT 1 FROM PRODUTOS_X_LISTA WHERE ID_LISTA = $1 AND ID_PRODUTO = $2${excluir} LIMIT 1`, params);
  if (dup) throw erroValidacao('Este produto já está nesta lista.');
}

module.exports = { antesDaTransacao, validarUnicidade };
