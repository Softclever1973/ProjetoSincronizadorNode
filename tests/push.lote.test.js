jest.mock('../src/client/infrastructure/firebird/db', () => ({ query: jest.fn(), execute: jest.fn() }));
jest.mock('../src/client/http', () => ({ enviarRegistro: jest.fn(), enviarRegistros: jest.fn() }));
jest.mock('../src/client/infrastructure/persistence/conflitos', () => ({ atualizarOuSalvarConflito: jest.fn(() => 'c1') }));
jest.mock('../src/client/application/syncEngine/echos', () => ({ registrarEcho: jest.fn() }));
jest.mock('../src/client/infrastructure/persistence/erros', () => ({ salvarErro: jest.fn() }));
jest.mock('../src/client/application/syncEngine/controle', () => ({ envioEstaPausado: jest.fn(() => false), cargaEstaPausada: jest.fn(() => false), geracaoEnvio: jest.fn(() => 0) }));

const { query, execute } = require('../src/client/infrastructure/firebird/db');
const { enviarRegistro, enviarRegistros } = require('../src/client/http');
const { atualizarOuSalvarConflito } = require('../src/client/infrastructure/persistence/conflitos');
const { salvarErro } = require('../src/client/infrastructure/persistence/erros');
const { empurrarTabela, _resetLoteParaTeste } = require('../src/client/application/syncEngine/push');
const { mockQueryPorSql } = require('./helpers/mockQuery');

const config = { nome: 'PRODUTOS', pk: 'ID_PRODUTO', srvId: true };
const noop = () => {};
const pendentes = n => Array.from({ length: n }, (_, i) => ({ PK_VALOR: String(i + 1) }));
// Registro local existe pra todo PK pedido (SELECT * ... WHERE ID_PRODUTO = ?).
const registroLocal = params => [{ ID_PRODUTO: Number(params[0]), NOME: `P${params[0]}` }];
const removidosDaFila = () => execute.mock.calls
  .filter(([, sql]) => sql.startsWith('DELETE FROM SYNC_ALTERACOES_PENDENTES')).map(([, , p]) => p[1]);

beforeEach(() => {
  jest.clearAllMocks();
  _resetLoteParaTeste();
  execute.mockResolvedValue(undefined);
});

describe('empurrarTabela — envio em lote (ReceberRegistros)', () => {
  test('3 pendentes vão numa chamada só; cada resultado é tratado individualmente', async () => {
    mockQueryPorSql(query, [['SYNC_ALTERACOES_PENDENTES', pendentes(3)], ['SELECT * FROM PRODUTOS', registroLocal]]);
    enviarRegistros.mockResolvedValue({ resultados: [
      { ok: true, novoId: 50, srvId: 900 },
      { conflito: true, versaoServidor: { ID_PRODUTO: 2 } },
      { erro: 'Erro ao aplicar registro: boom' },
    ] });

    await empurrarTabela({}, 'http://srv', 1, config, noop);

    expect(enviarRegistros).toHaveBeenCalledTimes(1);
    expect(enviarRegistro).not.toHaveBeenCalled();
    const [, , tabela, pk, itens, , , temSrvId] = enviarRegistros.mock.calls[0];
    expect([tabela, pk, temSrvId, itens.length]).toEqual(['PRODUTOS', 'ID_PRODUTO', true, 3]);
    // ok e conflito saem da fila; o com erro fica pra tentar de novo.
    expect(removidosDaFila()).toEqual(['1', '2']);
    expect(atualizarOuSalvarConflito).toHaveBeenCalledTimes(1);
    expect(salvarErro).toHaveBeenCalledWith(expect.objectContaining({ mensagem: 'Erro ao aplicar registro: boom' }));
    expect(execute.mock.calls.some(([, sql, p]) => sql.startsWith('UPDATE PRODUTOS SET SRV_ID') && p[0] === 900)).toBe(true);
  });

  test('250 pendentes viram lotes de 100, 100 e 50', async () => {
    mockQueryPorSql(query, [['SYNC_ALTERACOES_PENDENTES', pendentes(250)], ['SELECT * FROM PRODUTOS', registroLocal]]);
    enviarRegistros.mockImplementation(async (b, l, t, pk, itens) => ({ resultados: itens.map(() => ({ ok: true })) }));

    await empurrarTabela({}, 'http://srv', 1, config, noop);

    expect(enviarRegistros.mock.calls.map(c => c[4].length)).toEqual([100, 100, 50]);
    expect(removidosDaFila()).toHaveLength(250);
  });

  test('servidor antigo (404) cai pro envio unitário e não tenta lote de novo logo em seguida', async () => {
    mockQueryPorSql(query, [['SYNC_ALTERACOES_PENDENTES', pendentes(2)], ['SELECT * FROM PRODUTOS', registroLocal]]);
    enviarRegistros.mockRejectedValue(Object.assign(new Error('404'), { status: 404 }));
    enviarRegistro.mockResolvedValue({ ok: true });

    await empurrarTabela({}, 'http://srv', 1, config, noop);
    await empurrarTabela({}, 'http://srv', 1, config, noop);

    expect(enviarRegistros).toHaveBeenCalledTimes(1);
    expect(enviarRegistro).toHaveBeenCalledTimes(4);
  });

  test('falha de rede no lote: nada sai da fila e não pede ciclo extra', async () => {
    mockQueryPorSql(query, [['SYNC_ALTERACOES_PENDENTES', pendentes(3)], ['SELECT * FROM PRODUTOS', registroLocal]]);
    enviarRegistros.mockRejectedValue(new Error('Timeout de 60s ao conectar ao servidor'));

    const r = await empurrarTabela({}, 'http://srv', 1, config, noop);

    expect(removidosDaFila()).toEqual([]);
    expect(r).toEqual({ temMais: false });
  });

  test('deleção vai no lote com temSrvId=false (igual ao envio unitário) e sai da fila', async () => {
    mockQueryPorSql(query, [['SYNC_ALTERACOES_PENDENTES', [{ PK_VALOR: '7' }]], ['SELECT * FROM PRODUTOS', []]]);
    enviarRegistros.mockResolvedValue({ resultados: [{ ok: true }] });

    await empurrarTabela({}, 'http://srv', 1, config, noop);

    expect(enviarRegistros.mock.calls[0][4][0]).toEqual({ registro: { ID_PRODUTO: '7' }, ultimaVersaoConhecida: 0, deletar: true, temSrvId: false });
    expect(removidosDaFila()).toEqual(['7']);
  });
});
