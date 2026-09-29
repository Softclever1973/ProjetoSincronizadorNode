const { camposDivergentes } = require('../src/client/domain/conflitos');

describe('camposDivergentes — diferenças que o próprio sync cria não contam', () => {
  test('ID_LOJA vazio no local = loja da filial no servidor (print UNIDADES PCT/MT)', () => {
    const local = { UNIDADE: 'PCT', DESCRICAO: 'PACOTE', ID_LOJA: null };
    const srv   = { UNIDADE: 'PCT', DESCRICAO: 'PACOTE', ID_LOJA: 1 };
    expect(camposDivergentes(local, srv, { idLoja: 1 })).toEqual([]);
  });

  test('ID_LOJA vazio no local contra OUTRA loja continua divergente', () => {
    expect(camposDivergentes({ ID_LOJA: null }, { ID_LOJA: 2 }, { idLoja: 1 })).toEqual(['ID_LOJA']);
  });

  test('ID_LOJA preenchido e diferente continua divergente', () => {
    expect(camposDivergentes({ ID_LOJA: 3 }, { ID_LOJA: 1 }, { idLoja: 1 })).toEqual(['ID_LOJA']);
  });

  test('coluna só de um lado e SRV_ID não contam', () => {
    expect(camposDivergentes({ A: 1, SRV_ID: null }, { A: 1, SRV_ID: 99, SO_SERVIDOR: 'x' }, {})).toEqual([]);
  });

  test('colunas de controle (ID_ULTIMA_ATUALIZACAO_MATRIZ) não contam', () => {
    expect(camposDivergentes({ A: 1, ID_ULTIMA_ATUALIZACAO_MATRIZ: null }, { A: 1, ID_ULTIMA_ATUALIZACAO_MATRIZ: 50 }, {})).toEqual([]);
  });

  test('colunasAbsolutas: -5 local = 5 servidor', () => {
    const configTabela = { colunasAbsolutas: ['QTDE'] };
    expect(camposDivergentes({ QTDE: -5 }, { QTDE: 5 }, { configTabela })).toEqual([]);
    expect(camposDivergentes({ QTDE: -5 }, { QTDE: 6 }, { configTabela })).toEqual(['QTDE']);
  });

  test('diferença real de conteúdo continua aparecendo', () => {
    expect(camposDivergentes({ DESCRICAO: 'A', ID_LOJA: null }, { DESCRICAO: 'B', ID_LOJA: 1 }, { idLoja: 1 })).toEqual(['DESCRICAO']);
  });
});
