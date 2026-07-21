const jwt = require('jsonwebtoken');
const tokenBlacklist = require('../src/tokenBlacklist');
const authJwt = require('../src/middleware/authJwt');

const SECRET = 'segredo-de-teste';

function mockRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

beforeAll(() => {
  process.env.JWT_SECRET = SECRET;
});

describe('authJwt', () => {
  test('sem header Authorization retorna 401 "token ausente"', () => {
    const req = { headers: {} };
    const res = mockRes();
    authJwt(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ erro: 'token ausente' });
  });

  test('header sem prefixo "Bearer " retorna 401 "token ausente"', () => {
    const req = { headers: { authorization: 'Basic abc123' } };
    const res = mockRes();
    authJwt(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ erro: 'token ausente' });
  });

  test('token revogado (blacklist) retorna 401 "token revogado"', () => {
    const token = jwt.sign({ id: 1 }, SECRET);
    tokenBlacklist.revogar(token);

    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    authJwt(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ erro: 'token revogado' });
  });

  test('token assinado com segredo errado retorna 401 "token inválido ou expirado"', () => {
    const token = jwt.sign({ id: 1 }, 'segredo-errado');
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    authJwt(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ erro: 'token inválido ou expirado' });
  });

  test('token expirado retorna 401 "token inválido ou expirado"', () => {
    const token = jwt.sign({ id: 1 }, SECRET, { expiresIn: -10 });
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    authJwt(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ erro: 'token inválido ou expirado' });
  });

  test('token válido popula req.* e chama next()', () => {
    const payload = {
      id: 1,
      nome: 'Fulano',
      schemas: ['empresa_kr'],
      roles: { empresa_kr: 'gerente' },
      lojas: { empresa_kr: 3 },
      vendedores: { empresa_kr: 7 },
      isSuperAdmin: false,
    };
    const token = jwt.sign(payload, SECRET);
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    const next = jest.fn();

    authJwt(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.userId).toBe(1);
    expect(req.userName).toBe('Fulano');
    expect(req.userSchemas).toEqual(['empresa_kr']);
    expect(req.userRoles).toEqual({ empresa_kr: 'gerente' });
    expect(req.userLojas).toEqual({ empresa_kr: 3 });
    expect(req.userVendedores).toEqual({ empresa_kr: 7 });
    expect(req.isSuperAdmin).toBe(false);
    expect(res.status).not.toHaveBeenCalled();
  });

  test('campos ausentes no payload viram fallback seguro (nunca undefined)', () => {
    const token = jwt.sign({ id: 2 }, SECRET);
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    const next = jest.fn();

    authJwt(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.userName).toBeNull();
    expect(req.userSchemas).toEqual([]);
    expect(req.userRoles).toEqual({});
    expect(req.userLojas).toEqual({});
    expect(req.userVendedores).toEqual({});
    expect(req.isSuperAdmin).toBe(false);
  });
});
