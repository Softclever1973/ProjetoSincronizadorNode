const { requireRole, requireRoleOuVendedorEm } = require('../src/server/interfaces/http/middleware/checkRole');

function mockRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

describe('requireRole', () => {
  test('sem role definida para o schema retorna 403', () => {
    const middleware = requireRole('dono', 'gerente');
    const req = { params: { schema: 'empresa_kr' }, userRoles: {} };
    const res = mockRes();
    const next = jest.fn();

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ erro: 'permissão insuficiente' });
    expect(next).not.toHaveBeenCalled();
  });

  test('role presente mas fora da lista permitida retorna 403', () => {
    const middleware = requireRole('dono');
    const req = { params: { schema: 'empresa_kr' }, userRoles: { empresa_kr: 'vendedor' } };
    const res = mockRes();
    const next = jest.fn();

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('role dentro da lista permitida chama next()', () => {
    const middleware = requireRole('dono', 'gerente');
    const req = { params: { schema: 'empresa_kr' }, userRoles: { empresa_kr: 'gerente' } };
    const res = mockRes();
    const next = jest.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('role de outro schema não vaza para o schema da requisição', () => {
    const middleware = requireRole('dono');
    const req = {
      params: { schema: 'empresa_kr' },
      userRoles: { empresa_jb: 'dono' }, // dono só na OUTRA empresa
    };
    const res = mockRes();
    const next = jest.fn();

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('requireRoleOuVendedorEm', () => {
  const TABELAS = new Set(['PEDIDOS', 'PEDIDOS_ITENS']);

  test('dono passa em qualquer tabela', () => {
    const middleware = requireRoleOuVendedorEm(TABELAS);
    const req = { params: { schema: 'empresa_kr', tabela: 'PRODUTOS' }, userRoles: { empresa_kr: 'dono' } };
    const res = mockRes();
    const next = jest.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('gerente passa em qualquer tabela', () => {
    const middleware = requireRoleOuVendedorEm(TABELAS);
    const req = { params: { schema: 'empresa_kr', tabela: 'PRODUTOS' }, userRoles: { empresa_kr: 'gerente' } };
    const res = mockRes();
    const next = jest.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('vendedor passa numa tabela liberada pra ele', () => {
    const middleware = requireRoleOuVendedorEm(TABELAS);
    const req = { params: { schema: 'empresa_kr', tabela: 'PEDIDOS' }, userRoles: { empresa_kr: 'vendedor' } };
    const res = mockRes();
    const next = jest.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('vendedor é bloqueado numa tabela fora do Set', () => {
    const middleware = requireRoleOuVendedorEm(TABELAS);
    const req = { params: { schema: 'empresa_kr', tabela: 'PRODUTOS' }, userRoles: { empresa_kr: 'vendedor' } };
    const res = mockRes();
    const next = jest.fn();

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('comparação do nome da tabela é case-insensitive', () => {
    const middleware = requireRoleOuVendedorEm(TABELAS);
    const req = { params: { schema: 'empresa_kr', tabela: 'pedidos' }, userRoles: { empresa_kr: 'vendedor' } };
    const res = mockRes();
    const next = jest.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
  });
});
