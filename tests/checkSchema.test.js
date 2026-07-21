const { checkSchema } = require('../src/middleware/checkSchema');

function mockRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

describe('checkSchema', () => {
  test('schema fora da lista do usuário retorna 403', () => {
    const req = { params: { schema: 'empresa_alheia' }, userSchemas: ['empresa_kr', 'empresa_jb'] };
    const res = mockRes();
    const next = jest.fn();

    checkSchema(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ erro: 'acesso negado' });
    expect(next).not.toHaveBeenCalled();
  });

  test('schema presente na lista do usuário chama next()', () => {
    const req = { params: { schema: 'empresa_kr' }, userSchemas: ['empresa_kr', 'empresa_jb'] };
    const res = mockRes();
    const next = jest.fn();

    checkSchema(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('lista de schemas vazia sempre nega acesso', () => {
    const req = { params: { schema: 'empresa_kr' }, userSchemas: [] };
    const res = mockRes();
    const next = jest.fn();

    checkSchema(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
