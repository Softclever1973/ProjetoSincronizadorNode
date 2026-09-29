jest.mock('../src/client/infrastructure/firebird/db', () => ({ query: jest.fn(), execute: jest.fn() }));
jest.mock('../src/client/http', () => ({ enviarRegistro: jest.fn() }));
jest.mock('../src/client/infrastructure/persistence/conflitos', () => ({ atualizarOuSalvarConflito: jest.fn() }));
jest.mock('../src/client/application/syncEngine/echos', () => ({ registrarEcho: jest.fn() }));
jest.mock('../src/client/infrastructure/persistence/erros', () => ({ salvarErro: jest.fn() }));
// Mock pra não gravar sync-pausa.json no cwd durante o teste.
jest.mock('../src/client/application/syncEngine/controle', () => ({ estaPausado: jest.fn(() => false) }));

const { query, execute } = require('../src/client/infrastructure/firebird/db');
const { enviarRegistro } = require('../src/client/http');
const { estaPausado } = require('../src/client/application/syncEngine/controle');
const { empurrarTabela } = require('../src/client/application/syncEngine/push');
const { mockQueryPorSql } = require('./helpers/mockQuery');

const config = { nome: 'MOVIMENTACOES', pk: 'ID_MOVIMENTACAO' };
const noopLog = () => {};

beforeEach(() => {
  jest.clearAllMocks();
  execute.mockResolvedValue(undefined);
  estaPausado.mockReturnValue(false);
});

describe('empurrarTabela — pausa e lote', () => {
  test('pausado antes de começar: não envia nada e não pede ciclo extra', async () => {
    estaPausado.mockReturnValue(true);
    mockQueryPorSql(query, [['SYNC_ALTERACOES_PENDENTES', [{ PK_VALOR: '1' }, { PK_VALOR: '2' }]]]);

    const r = await empurrarTabela({}, 'http://srv', 5, config, noopLog);

    expect(enviarRegistro).not.toHaveBeenCalled();
    expect(r).toEqual({ temMais: false });
  });

  test('pausa no meio do lote: para no próximo registro', async () => {
    mockQueryPorSql(query, [
      ['SYNC_ALTERACOES_PENDENTES', [{ PK_VALOR: '1' }, { PK_VALOR: '2' }, { PK_VALOR: '3' }]],
      ['SELECT * FROM MOVIMENTACOES', [{ ID_MOVIMENTACAO: 1 }]],
    ]);
    enviarRegistro.mockImplementation(async () => { estaPausado.mockReturnValue(true); return {}; });

    await empurrarTabela({}, 'http://srv', 5, config, noopLog);

    expect(enviarRegistro).toHaveBeenCalledTimes(1);
  });

  test('busca os pendentes com FIRST (lote limitado)', async () => {
    mockQueryPorSql(query, [['SYNC_ALTERACOES_PENDENTES', []]]);

    await empurrarTabela({}, 'http://srv', 5, config, noopLog);

    expect(query.mock.calls[0][1]).toMatch(/SELECT FIRST \d+ PK_VALOR FROM SYNC_ALTERACOES_PENDENTES/);
  });

  test('lote que não é cheio não pede ciclo extra', async () => {
    mockQueryPorSql(query, [
      ['SYNC_ALTERACOES_PENDENTES', [{ PK_VALOR: '1' }]],
      ['SELECT * FROM MOVIMENTACOES', [{ ID_MOVIMENTACAO: 1 }]],
    ]);
    enviarRegistro.mockResolvedValue({});

    expect(await empurrarTabela({}, 'http://srv', 5, config, noopLog)).toEqual({ temMais: false });
  });
});
