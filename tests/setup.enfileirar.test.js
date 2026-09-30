jest.mock('../src/client/infrastructure/firebird/db', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  tabelaExiste: jest.fn(async () => true),
}));

const { query, execute } = require('../src/client/infrastructure/firebird/db');
const { enfileirarTodosRegistros } = require('../src/client/setup');

const noop = () => {};

// Simula uma tabela com PKs 1..totalLinhas: responde COUNT, a faixa keyset (FIRST n) e o total de pendentes.
function simularTabela(totalLinhas) {
  query.mockImplementation(async (db, sql, params = []) => {
    if (/FROM SYNC_ALTERACOES_PENDENTES/.test(sql)) return [{ CNT: totalLinhas }];
    const first = /SELECT FIRST (\d+)/.exec(sql);
    if (first) {
      const n = Number(first[1]);
      const depois = params.length ? params[0] : 0;
      const qtd = Math.max(0, Math.min(n, totalLinhas - depois));
      return [{ N: qtd, ULTIMO: qtd ? depois + qtd : null }];
    }
    if (/SELECT COUNT\(\*\) AS CNT FROM/.test(sql)) return [{ CNT: totalLinhas }];
    return [];
  });
}

beforeEach(() => { jest.clearAllMocks(); execute.mockResolvedValue(undefined); });

describe('enfileirarTodosRegistros — lotes por faixa de PK', () => {
  test('12.000 registros viram 3 MERGEs com as faixas certas e progresso por lote', async () => {
    simularTabela(12000);
    const progresso = [];
    const total = await enfileirarTodosRegistros({}, noop, p => progresso.push(p), ['VENDEDORES']);

    const merges = execute.mock.calls.filter(([, sql]) => sql.includes('MERGE INTO SYNC_ALTERACOES_PENDENTES'));
    expect(merges.map(([, , p]) => p)).toEqual([[5000], [5000, 10000], [10000, 12000]]);
    expect(total).toBe(12000);
    // Barra anda dentro da tabela: 0 → 5000 → 10000 → 12000.
    expect(progresso.filter(p => p.tabela === 'VENDEDORES').map(p => p.enfileiradosNaTabela)).toEqual([0, 5000, 10000, 12000, 12000]);
  });

  test('"Parar" no meio da tabela interrompe entre lotes', async () => {
    simularTabela(12000);
    let lotes = 0;
    execute.mockImplementation(async () => { lotes++; });
    await enfileirarTodosRegistros({}, noop, null, ['VENDEDORES'], () => lotes >= 1);

    expect(execute.mock.calls.filter(([, sql]) => sql.includes('MERGE'))).toHaveLength(1);
  });

  test('PK composta vai num MERGE só', async () => {
    simularTabela(30);
    await enfileirarTodosRegistros({}, noop, null, ['PEDIDOS_PARCELAS_PAGAMENTOS']);

    const merges = execute.mock.calls.filter(([, sql]) => sql.includes('MERGE'));
    expect(merges).toHaveLength(1);
    expect(merges[0][1]).toMatch(/ID_PEDIDO AS VARCHAR\(100\)\) \|\| '\|' \|\| CAST\(PARCELA/);
  });
});
