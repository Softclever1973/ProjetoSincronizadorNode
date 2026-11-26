// Preço na lista = PRECO_VENDA ± ajuste da lista: P = percentual, V = valor fixo; o sinal decide (negativo reduz).
function ehValorFixo(lista) {
  return String(lista?.PERCENTUAL_OU_VALOR ?? 'P').trim().toUpperCase() === 'V';
}

function calcularPrecoLista(precoVenda, lista) {
  const base = Number(precoVenda) || 0;
  const ajuste = Number(lista?.PERCENTUAL_ACRESCIMO_REDUCAO) || 0;
  const preco = ehValorFixo(lista) ? base + ajuste : base * (1 + ajuste / 100);
  return Math.max(0, Math.round(preco * 100) / 100);
}

module.exports = { calcularPrecoLista, ehValorFixo };
