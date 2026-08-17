jest.mock('../src/server/domain/planos', () => ({ planoTemFeature: jest.fn() }));
jest.mock('../src/server/infrastructure/db', () => ({ pool: { query: jest.fn() } }));

const { planoTemFeature } = require('../src/server/domain/planos');
const { pool } = require('../src/server/infrastructure/db');
const { requirePlanFeature } = require('../src/server/interfaces/http/middleware/requirePlanFeature');

function mockRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

beforeEach(() => {
  planoTemFeature.mockReset();
  pool.query.mockReset();
});

describe('requirePlanFeature', () => {
  test('lê o plano de sync_tenants pelo schema da rota, não de um claim do JWT', async () => {
    pool.query.mockResolvedValue({ rows: [{ plano: 'SAFIRA1' }] });
    planoTemFeature.mockReturnValue(true);
    const middleware = requirePlanFeature('financeiro');
    const req = { params: { schema: 'empresa_kr' } };
    const res = mockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(pool.query).toHaveBeenCalledWith(
      'SELECT plano FROM public.sync_tenants WHERE schema_name = $1', ['empresa_kr']
    );
    expect(planoTemFeature).toHaveBeenCalledWith('SAFIRA1', 'financeiro');
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('plano sem a feature retorna 403', async () => {
    pool.query.mockResolvedValue({ rows: [{ plano: 'OURO1' }] });
    planoTemFeature.mockReturnValue(false);
    const middleware = requirePlanFeature('financeiro');
    const req = { params: { schema: 'empresa_kr' } };
    const res = mockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ erro: 'recurso não disponível no plano atual' });
    expect(next).not.toHaveBeenCalled();
  });

  test('schema sem linha em sync_tenants passa undefined pro planoTemFeature e retorna 403', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    planoTemFeature.mockReturnValue(false);
    const middleware = requirePlanFeature('financeiro');
    const req = { params: { schema: 'schema_fantasma' } };
    const res = mockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(planoTemFeature).toHaveBeenCalledWith(undefined, 'financeiro');
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('erro na consulta ao banco retorna 500 em vez de deixar passar', async () => {
    pool.query.mockRejectedValue(new Error('conexão recusada'));
    const middleware = requirePlanFeature('financeiro');
    const req = { params: { schema: 'empresa_kr' } };
    const res = mockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(next).not.toHaveBeenCalled();
  });
});
