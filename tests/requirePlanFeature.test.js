jest.mock('../src/planos', () => ({ planoTemFeature: jest.fn() }));

const { planoTemFeature } = require('../src/planos');
const { requirePlanFeature } = require('../src/middleware/requirePlanFeature');

function mockRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

beforeEach(() => {
  planoTemFeature.mockReset();
});

describe('requirePlanFeature', () => {
  test('sem plano definido para o schema retorna 403', () => {
    planoTemFeature.mockReturnValue(false);
    const middleware = requirePlanFeature('demo.relatorio_avancado');
    const req = { params: { schema: 'empresa_kr' }, userPlanos: {} };
    const res = mockRes();
    const next = jest.fn();

    middleware(req, res, next);

    expect(planoTemFeature).toHaveBeenCalledWith(undefined, 'demo.relatorio_avancado');
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ erro: 'recurso não disponível no plano atual' });
    expect(next).not.toHaveBeenCalled();
  });

  test('plano sem a feature retorna 403', () => {
    planoTemFeature.mockReturnValue(false);
    const middleware = requirePlanFeature('demo.relatorio_avancado');
    const req = { params: { schema: 'empresa_kr' }, userPlanos: { empresa_kr: 'basico' } };
    const res = mockRes();
    const next = jest.fn();

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('plano com a feature chama next()', () => {
    planoTemFeature.mockReturnValue(true);
    const middleware = requirePlanFeature('demo.relatorio_avancado');
    const req = { params: { schema: 'empresa_kr' }, userPlanos: { empresa_kr: 'basico' } };
    const res = mockRes();
    const next = jest.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('plano de outro schema não vaza para o schema da requisição', () => {
    planoTemFeature.mockReturnValue(false);
    const middleware = requirePlanFeature('demo.relatorio_avancado');
    const req = {
      params: { schema: 'empresa_kr' },
      userPlanos: { empresa_jb: 'enterprise' }, // plano só na OUTRA empresa
    };
    const res = mockRes();
    const next = jest.fn();

    middleware(req, res, next);

    expect(planoTemFeature).toHaveBeenCalledWith(undefined, 'demo.relatorio_avancado');
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
