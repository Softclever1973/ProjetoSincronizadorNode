jest.mock('../src/server/infrastructure/cache/permissoesCache', () => ({ obterNivelEfetivo: jest.fn() }));
jest.mock('../src/server/infrastructure/db', () => ({ pool: { query: jest.fn() } }));

const { obterNivelEfetivo } = require('../src/server/infrastructure/cache/permissoesCache');
const { pool } = require('../src/server/infrastructure/db');
const { requireModulo, requireModuloDaTabela } = require('../src/server/interfaces/http/middleware/requireModulo');

function mockRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

beforeEach(() => {
  obterNivelEfetivo.mockReset();
  pool.query.mockReset();
});

describe('requireModulo', () => {
  test.each([
    ['--', 'r', false], ['--', 'w', false],
    ['r-', 'r', true],  ['r-', 'w', false],
    ['rw', 'r', true],  ['rw', 'w', true],
  ])('nivel efetivo=%s, exigido=%s -> autorizado=%s', async (nivel, nivelExigido, autorizado) => {
    pool.query.mockResolvedValue({ rows: [{ plano: 'DIAMANTE1' }] });
    obterNivelEfetivo.mockResolvedValue(nivel);
    const middleware = requireModulo('financeiro', nivelExigido);
    const req = { params: { schema: 'empresa_kr' }, userRoles: { empresa_kr: 'dono' } };
    const res = mockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    if (autorizado) {
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    } else {
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ erro: 'permissão insuficiente' });
      expect(next).not.toHaveBeenCalled();
    }
  });

  test('lê o plano de sync_tenants pelo schema da rota, não de um claim do JWT', async () => {
    pool.query.mockResolvedValue({ rows: [{ plano: 'SAFIRA1' }] });
    obterNivelEfetivo.mockResolvedValue('rw');
    const middleware = requireModulo('financeiro', 'r');
    const req = { params: { schema: 'empresa_kr' }, userRoles: { empresa_kr: 'dono' } };
    const res = mockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(pool.query).toHaveBeenCalledWith(
      'SELECT plano FROM public.sync_tenants WHERE schema_name = $1', ['empresa_kr']
    );
    expect(obterNivelEfetivo).toHaveBeenCalledWith('SAFIRA1', 'dono', 'financeiro');
    expect(next).toHaveBeenCalled();
  });

  test('erro na consulta ao banco retorna 500 em vez de deixar passar', async () => {
    pool.query.mockRejectedValue(new Error('conexão recusada'));
    const middleware = requireModulo('financeiro', 'r');
    const req = { params: { schema: 'empresa_kr' }, userRoles: { empresa_kr: 'dono' } };
    const res = mockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('requireModuloDaTabela', () => {
  test('tabela mapeada delega pro nível efetivo do módulo correspondente', async () => {
    pool.query.mockResolvedValue({ rows: [{ plano: 'LITE1' }] });
    obterNivelEfetivo.mockResolvedValue('r-');
    const middleware = requireModuloDaTabela('w');
    const req = { params: { schema: 'empresa_kr', tabela: 'PRODUTOS' }, userRoles: { empresa_kr: 'vendedor' } };
    const res = mockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(obterNivelEfetivo).toHaveBeenCalledWith('LITE1', 'vendedor', 'produtos');
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('tabela não mapeada chama next() sem tocar pool nem cache', async () => {
    const middleware = requireModuloDaTabela('w');
    const req = { params: { schema: 'empresa_kr', tabela: 'AUX_GENERICA' }, userRoles: { empresa_kr: 'vendedor' } };
    const res = mockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
    expect(obterNivelEfetivo).not.toHaveBeenCalled();
  });

  test('comparação do nome da tabela é case-insensitive', async () => {
    pool.query.mockResolvedValue({ rows: [{ plano: 'LITE1' }] });
    obterNivelEfetivo.mockResolvedValue('rw');
    const middleware = requireModuloDaTabela('r');
    const req = { params: { schema: 'empresa_kr', tabela: 'pedidos' }, userRoles: { empresa_kr: 'vendedor' } };
    const res = mockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(obterNivelEfetivo).toHaveBeenCalledWith('LITE1', 'vendedor', 'pedidos');
    expect(next).toHaveBeenCalled();
  });
});
