// Client: atende o pedido de verificação lendo o Firebird com as traduções do push e mandando hashes + detalhes.
jest.mock('../src/client/infrastructure/firebird/db', () => ({ query: jest.fn(), execute: jest.fn() }));
jest.mock('../src/client/http', () => ({
  buscarVerificacaoPendente: jest.fn(), enviarVerificacaoTabela: jest.fn(),
  enviarVerificacaoDetalhes: jest.fn(), concluirVerificacao: jest.fn(),
}));
jest.mock('../src/client/infrastructure/config/tabelasConfig', () => ({ tabelaAtiva: jest.fn(() => true) }));

const { query } = require('../src/client/infrastructure/firebird/db');
const http = require('../src/client/http');
const { tabelaAtiva } = require('../src/client/infrastructure/config/tabelasConfig');
const { atenderVerificacao } = require('../src/client/application/verificacaoSync');
const { mockQueryPorSql } = require('./helpers/mockQuery');
const { valorCanonico, hashLinha } = require('../src/client/domain/verificacao');

const LOJA = 3;
const noop = () => {};

beforeEach(() => {
  jest.clearAllMocks();
  http.enviarVerificacaoTabela.mockResolvedValue({ detalhes: ['10'] });
  http.enviarVerificacaoDetalhes.mockResolvedValue({ ok: true });
  http.concluirVerificacao.mockResolvedValue({ ok: true });
});

test('sem pedido: não lê o Firebird', async () => {
  http.buscarVerificacaoPendente.mockResolvedValue({});
  await atenderVerificacao({}, 'http://srv', LOJA, new Set(['MOVIMENTACOES']), noop);
  expect(query).not.toHaveBeenCalled();
  expect(http.concluirVerificacao).not.toHaveBeenCalled();
});

test('MOVIMENTACOES: FK vira SRV_ID, ID_LOJA vazio vira a loja, DATE/TIME viram texto local; detalhes do que o servidor pedir', async () => {
  http.buscarVerificacaoPendente.mockResolvedValue({
    id: 77, tabelas: ['MOVIMENTACOES', 'PEDIDOS', 'CLIENTES'],
    colunasServidor: { MOVIMENTACOES: ['ID_MOVIMENTACAO', 'ID_PRODUTO', 'DATA', 'HORA', 'QUANTIDADE', 'ID_LOJA', 'OBS', 'SO_NO_SERVIDOR'] },
  });
  tabelaAtiva.mockImplementation(nome => nome !== 'CLIENTES');
  mockQueryPorSql(query, [
    ['RDB$RELATION_FIELDS', [
      { COLUNA: 'ID_MOVIMENTACAO', TIPO: 8 }, { COLUNA: 'ID_PRODUTO', TIPO: 8 }, { COLUNA: 'DATA', TIPO: 12 },
      { COLUNA: 'HORA', TIPO: 13 }, { COLUNA: 'QUANTIDADE', TIPO: 16 }, { COLUNA: 'ID_LOJA', TIPO: 8 },
      { COLUNA: 'SO_NO_FIREBIRD', TIPO: 37 }, { COLUNA: 'OBS', TIPO: 261, SUBTIPO: 1 }, { COLUNA: 'ID_ULTIMA_ATUALIZACAO_MATRIZ', TIPO: 8 },
    ]],
    ['FROM PRODUTOS', [{ ID: 22166, SRV_ID: 154 }]],
    ['FROM MOVIMENTACOES', params => (params?.length ? [] : [
      { ID_MOVIMENTACAO: 10, ID_PRODUTO: 22166, DATA: new Date(2026, 9, 14), HORA: new Date(1970, 0, 1, 11, 42, 6), QUANTIDADE: -5, ID_LOJA: null, OBS: 'troca  ' },
    ])],
    ['SYNC_ALTERACOES_PENDENTES', [{ PK_VALOR: '10 ' }]],
  ]);

  await atenderVerificacao({}, 'http://srv', LOJA, new Set(['MOVIMENTACOES', 'CLIENTES']), noop);

  const chamadas = http.enviarVerificacaoTabela.mock.calls.map(c => c[2]);
  const mov = chamadas.find(c => c.tabela === 'MOVIMENTACOES');
  // Só colunas dos dois lados, sem as de controle, em ordem alfabética.
  expect(mov.colunas.map(c => c.nome)).toEqual(['DATA', 'HORA', 'ID_LOJA', 'ID_MOVIMENTACAO', 'ID_PRODUTO', 'OBS', 'QUANTIDADE']);
  // BLOB de texto é lido com CAST (a função de leitura do driver não serve fora da consulta).
  expect(query.mock.calls.some(([, sql]) => sql.includes('CAST(SUBSTRING(OBS FROM 1 FOR 4000) AS VARCHAR(4000)) AS OBS'))).toBe(true);
  const esperado = { DATA: '2026-10-14', HORA: '11:42:06', ID_LOJA: String(LOJA), ID_MOVIMENTACAO: '10', ID_PRODUTO: '154', OBS: 'troca', QUANTIDADE: '-5' };
  expect(mov.hashes).toEqual([['10', hashLinha(mov.colunas.map(c => esperado[c.nome]))]]);
  expect(mov.pendentes).toEqual(['10']);
  expect(http.enviarVerificacaoDetalhes).toHaveBeenCalledWith('http://srv', LOJA, { id: 77, tabela: 'MOVIMENTACOES', registros: { 10: esperado } });

  expect(chamadas.find(c => c.tabela === 'PEDIDOS').motivo).toMatch(/não existe no Firebird/);
  expect(chamadas.find(c => c.tabela === 'CLIENTES').motivo).toMatch(/desativada/);
  expect(http.concluirVerificacao).toHaveBeenCalledWith('http://srv', LOJA, { id: 77, erro: null });
  expect(valorCanonico(new Date(1970, 0, 1, 23, 5, 0), 'hora')).toBe('23:05:00');
});

test('tabela com SRV_ID: chave é o SRV_ID; sem SRV_ID ainda vira "local:<pk>"; fila traduzida para a mesma chave', async () => {
  http.buscarVerificacaoPendente.mockResolvedValue({ id: 79, tabelas: ['MOVIMENTACOES'], colunasServidor: { MOVIMENTACOES: ['ID_MOVIMENTACAO', 'QUANTIDADE'] } });
  tabelaAtiva.mockReturnValue(true);
  mockQueryPorSql(query, [
    ['RDB$RELATION_FIELDS', [{ COLUNA: 'ID_MOVIMENTACAO', TIPO: 8 }, { COLUNA: 'QUANTIDADE', TIPO: 16 }, { COLUNA: 'SRV_ID', TIPO: 8 }]],
    ['FROM PRODUTOS', []],
    ['FROM MOVIMENTACOES', [
      { ID_MOVIMENTACAO: 1, SRV_ID: 26985, QUANTIDADE: 3 },
      { ID_MOVIMENTACAO: 2, SRV_ID: null, QUANTIDADE: 4 },
    ]],
    ['SYNC_ALTERACOES_PENDENTES', [{ PK_VALOR: '2' }, { PK_VALOR: '1' }, { PK_VALOR: '999' }]],
  ]);
  http.enviarVerificacaoTabela.mockResolvedValue({ detalhes: [] });

  await atenderVerificacao({}, 'http://srv', LOJA, new Set(['MOVIMENTACOES']), noop);

  const mov = http.enviarVerificacaoTabela.mock.calls[0][2];
  expect(mov.chave).toBe('SRV_ID');
  expect(mov.hashes.map(([k]) => k)).toEqual(['26985', 'local:2']);
  expect(mov.pendentes).toEqual(['local:2', '26985']); // PK 999 não está mais no Firebird: fica de fora
  expect(query.mock.calls.some(([, sql]) => /SELECT FIRST \d+ SKIP \d+ ID_MOVIMENTACAO, SRV_ID/.test(sql))).toBe(true);
});

test('erro numa tabela vai como erro dela e não derruba o pedido', async () => {
  http.buscarVerificacaoPendente.mockResolvedValue({ id: 78, tabelas: ['UNIDADES'], colunasServidor: { UNIDADES: ['UNIDADE'] } });
  tabelaAtiva.mockReturnValue(true);
  query.mockRejectedValue(new Error('conexão perdida'));
  await atenderVerificacao({}, 'http://srv', LOJA, new Set(['UNIDADES']), noop);
  expect(http.enviarVerificacaoTabela).toHaveBeenCalledWith('http://srv', LOJA, { id: 78, tabela: 'UNIDADES', erro: 'conexão perdida' });
  expect(http.concluirVerificacao).toHaveBeenCalledWith('http://srv', LOJA, { id: 78, erro: null });
});
