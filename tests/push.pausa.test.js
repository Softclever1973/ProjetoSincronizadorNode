jest.mock('../src/client/infrastructure/firebird/db', () => ({ query: jest.fn(), execute: jest.fn() }));
jest.mock('../src/client/http', () => ({
  enviarRegistro: jest.fn(),
  enviarRegistros: jest.fn(() => Promise.reject(Object.assign(new Error('404'), { status: 404 }))),
}));
jest.mock('../src/client/infrastructure/persistence/conflitos', () => ({ atualizarOuSalvarConflito: jest.fn() }));
jest.mock('../src/client/application/syncEngine/echos', () => ({ registrarEcho: jest.fn() }));
jest.mock('../src/client/infrastructure/persistence/erros', () => ({ salvarErro: jest.fn() }));
// Mock pra não gravar sync-pausa.json no cwd durante o teste.
jest.mock('../src/client/application/syncEngine/controle', () => ({ envioEstaPausado: jest.fn(() => false), cargaEstaPausada: jest.fn(() => false), geracaoEnvio: jest.fn(() => 0) }));

const { query, execute } = require('../src/client/infrastructure/firebird/db');
const { enviarRegistro } = require('../src/client/http');
const { envioEstaPausado: estaPausado, cargaEstaPausada } = require('../src/client/application/syncEngine/controle');

// Pendente da carga (data fixa de filaCarga.js) × alteração do dia a dia.
const DA_CARGA = new Date(1900, 0, 1);
const DO_DIA = new Date(2026, 8, 30, 10, 0, 0);
const { empurrarTabela } = require('../src/client/application/syncEngine/push');
const { mockQueryPorSql } = require('./helpers/mockQuery');

const config = { nome: 'MOVIMENTACOES', pk: 'ID_MOVIMENTACAO' };
const noopLog = () => {};

beforeEach(() => {
  jest.clearAllMocks();
  execute.mockResolvedValue(undefined);
  estaPausado.mockReturnValue(false);
  cargaEstaPausada.mockReturnValue(false);
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

  test('"Parar" da carga (nova geração) larga o lote já carregado na memória', async () => {
    const { geracaoEnvio } = require('../src/client/application/syncEngine/controle');
    mockQueryPorSql(query, [
      ['SYNC_ALTERACOES_PENDENTES', [{ PK_VALOR: '1' }, { PK_VALOR: '2' }, { PK_VALOR: '3' }]],
      ['SELECT * FROM MOVIMENTACOES', [{ ID_MOVIMENTACAO: 1 }]],
    ]);
    enviarRegistro.mockImplementation(async () => { geracaoEnvio.mockReturnValue(1); return {}; });

    const r = await empurrarTabela({}, 'http://srv', 5, config, noopLog);

    expect(enviarRegistro).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ temMais: false });
    geracaoEnvio.mockReturnValue(0);
  });

  test('busca os pendentes com FIRST (lote limitado)', async () => {
    mockQueryPorSql(query, [['SYNC_ALTERACOES_PENDENTES', []]]);

    await empurrarTabela({}, 'http://srv', 5, config, noopLog);

    expect(query.mock.calls[0][1]).toMatch(/SELECT FIRST \d+ PK_VALOR, TIMESTAMP_ALTERACAO FROM SYNC_ALTERACOES_PENDENTES/);
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

describe('empurrarTabela — pausa só da carga', () => {
  test('carga pausada: busca só os pendentes do dia a dia e envia eles', async () => {
    cargaEstaPausada.mockReturnValue(true);
    mockQueryPorSql(query, [
      ['SYNC_ALTERACOES_PENDENTES', [{ PK_VALOR: '7', TIMESTAMP_ALTERACAO: DO_DIA }]],
      ['SELECT * FROM MOVIMENTACOES', [{ ID_MOVIMENTACAO: 7 }]],
    ]);
    enviarRegistro.mockResolvedValue({});

    await empurrarTabela({}, 'http://srv', 5, config, noopLog);

    expect(query.mock.calls[0][1]).toMatch(/TIMESTAMP_ALTERACAO >= TIMESTAMP '1901-01-01/);
    expect(enviarRegistro).toHaveBeenCalledTimes(1);
  });

  test('carga não pausada: busca tudo, sem filtro de data', async () => {
    mockQueryPorSql(query, [['SYNC_ALTERACOES_PENDENTES', []]]);
    await empurrarTabela({}, 'http://srv', 5, config, noopLog);
    expect(query.mock.calls[0][1]).not.toMatch(/1901-01-01/);
  });

  test('pausar a carga no meio de um lote com pendentes da carga para no próximo registro', async () => {
    mockQueryPorSql(query, [
      ['SYNC_ALTERACOES_PENDENTES', ['1', '2', '3'].map(pk => ({ PK_VALOR: pk, TIMESTAMP_ALTERACAO: DA_CARGA }))],
      ['SELECT * FROM MOVIMENTACOES', [{ ID_MOVIMENTACAO: 1 }]],
    ]);
    enviarRegistro.mockImplementation(async () => { cargaEstaPausada.mockReturnValue(true); return {}; });

    const r = await empurrarTabela({}, 'http://srv', 5, config, noopLog);

    expect(enviarRegistro).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ temMais: false });
  });

  test('pausar a carga no meio de um lote só do dia a dia não interrompe', async () => {
    mockQueryPorSql(query, [
      ['SYNC_ALTERACOES_PENDENTES', ['1', '2', '3'].map(pk => ({ PK_VALOR: pk, TIMESTAMP_ALTERACAO: DO_DIA }))],
      ['SELECT * FROM MOVIMENTACOES', [{ ID_MOVIMENTACAO: 1 }]],
    ]);
    enviarRegistro.mockImplementation(async () => { cargaEstaPausada.mockReturnValue(true); return {}; });

    await empurrarTabela({}, 'http://srv', 5, config, noopLog);

    expect(enviarRegistro).toHaveBeenCalledTimes(3);
  });
});
