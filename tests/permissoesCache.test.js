jest.mock('../src/server/infrastructure/db', () => ({ pool: { query: jest.fn() } }));

const { pool } = require('../src/server/infrastructure/db');
const { obterNivelEfetivo, obterPermissoesEfetivas, recarregarPermissoes } = require('../src/server/infrastructure/cache/permissoesCache');

// Ordem das consultas em _carregarPermissoes: plano, role, empresa (override).
function mockCarga(plano, role, empresa = []) {
  pool.query
    .mockResolvedValueOnce({ rows: plano })
    .mockResolvedValueOnce({ rows: role })
    .mockResolvedValueOnce({ rows: empresa });
}

function mockRowsPadrao() {
  mockCarga(
    [{ plano: 'DIAMANTE1', modulo: 'financeiro', nivel: 'rw' }],
    [{ role: 'vendedor', modulo: 'financeiro', nivel: '--' }],
  );
}

describe('permissoesCache', () => {
  beforeEach(async () => {
    pool.query.mockReset();
    // Estado conhecido no início de cada teste: força um reload controlado em vez de depender
    // do estado "nunca carregado" do módulo (que só existe uma vez, no primeiro require do processo).
    mockRowsPadrao();
    await recarregarPermissoes();
    pool.query.mockClear();
  });

  test('cache carregado reflete os dados do banco sem nova consulta', async () => {
    const nivel = await obterNivelEfetivo('DIAMANTE1', 'vendedor', 'financeiro');
    expect(pool.query).not.toHaveBeenCalled(); // já carregado no beforeEach, não recarrega sozinho
    expect(nivel).toBe('--'); // interseção: plano rw, role --
  });

  test('chamadas repetidas reaproveitam o cache, sem nova consulta', async () => {
    await obterNivelEfetivo('DIAMANTE1', 'vendedor', 'financeiro');
    await obterNivelEfetivo('DIAMANTE1', 'vendedor', 'financeiro');
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('recarregarPermissoes força nova consulta e reflete dado atualizado', async () => {
    const antes = await obterNivelEfetivo('DIAMANTE1', 'vendedor', 'financeiro');
    expect(antes).toBe('--');

    mockCarga(
      [{ plano: 'DIAMANTE1', modulo: 'financeiro', nivel: 'rw' }],
      [{ role: 'vendedor', modulo: 'financeiro', nivel: 'rw' }],
    );
    await recarregarPermissoes();

    expect(pool.query).toHaveBeenCalledTimes(3);
    const depois = await obterNivelEfetivo('DIAMANTE1', 'vendedor', 'financeiro');
    expect(depois).toBe('rw');
  });

  test('obterPermissoesEfetivas monta o mapa completo a partir das linhas planas', async () => {
    mockCarga(
      [
        { plano: 'DIAMANTE1', modulo: 'financeiro', nivel: 'rw' },
        { plano: 'DIAMANTE1', modulo: 'produtos', nivel: 'rw' },
      ],
      [
        { role: 'gerente', modulo: 'financeiro', nivel: 'rw' },
        { role: 'gerente', modulo: 'produtos', nivel: 'rw' },
      ],
    );
    await recarregarPermissoes();

    const modulos = await obterPermissoesEfetivas('DIAMANTE1', 'gerente');
    expect(modulos.financeiro).toBe('rw');
    expect(modulos.produtos).toBe('rw');
    expect(modulos.usuarios).toBe('--'); // ausente nas linhas mockadas -> fail-closed
  });

  test('override da empresa vale só pro schema+role dele', async () => {
    mockCarga(
      [{ plano: 'DIAMANTE1', modulo: 'financeiro', nivel: 'rw' }],
      [{ role: 'vendedor', modulo: 'financeiro', nivel: '--' }],
      [{ schema_name: 'empresa_kr', role: 'vendedor', modulo: 'financeiro', nivel: 'r-' }],
    );
    await recarregarPermissoes();

    expect(await obterNivelEfetivo('DIAMANTE1', 'vendedor', 'financeiro', 'empresa_kr')).toBe('r-');
    expect(await obterNivelEfetivo('DIAMANTE1', 'vendedor', 'financeiro', 'outra')).toBe('--');
  });
});
