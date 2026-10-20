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
    // 4º argumento: schema, pro override por empresa.
    expect(obterNivelEfetivo).toHaveBeenCalledWith('SAFIRA1', 'dono', 'financeiro', 'empresa_kr');
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

    expect(obterNivelEfetivo).toHaveBeenCalledWith('LITE1', 'vendedor', 'produtos', 'empresa_kr');
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  async function rodar(nivelExigido, tabela, role) {
    const req = { params: { schema: 'empresa_kr', tabela }, userRoles: { empresa_kr: role } };
    const res = mockRes();
    const next = jest.fn();
    await requireModuloDaTabela(nivelExigido)(req, res, next);
    return { res, next };
  }

  test('tabela não mapeada: leitura liberada sem tocar pool nem cache', async () => {
    const { res, next } = await rodar('r', 'AUX_GENERICA', 'vendedor');

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
    expect(obterNivelEfetivo).not.toHaveBeenCalled();
  });

  test.each([['vendedor', false], ['gerente', false], ['dono', true]])(
    'tabela não mapeada: gravação por %s -> autorizado=%s', async (role, autorizado) => {
      const { res, next } = await rodar('w', 'AUX_GENERICA', role);

      if (autorizado) expect(next).toHaveBeenCalled();
      else { expect(res.status).toHaveBeenCalledWith(403); expect(next).not.toHaveBeenCalled(); }
      expect(obterNivelEfetivo).not.toHaveBeenCalled();
    });

  test('VENDEDORES: leitura liberada, gravação pelo módulo pedidos', async () => {
    expect((await rodar('r', 'VENDEDORES', 'vendedor')).next).toHaveBeenCalled();
    expect(obterNivelEfetivo).not.toHaveBeenCalled();

    pool.query.mockResolvedValue({ rows: [{ plano: 'LITE1' }] });
    obterNivelEfetivo.mockResolvedValue('rw');
    expect((await rodar('w', 'VENDEDORES', 'vendedor')).next).toHaveBeenCalled();
    expect(obterNivelEfetivo).toHaveBeenCalledWith('LITE1', 'vendedor', 'pedidos', 'empresa_kr');

    obterNivelEfetivo.mockResolvedValue('r-');
    expect((await rodar('w', 'VENDEDORES', 'vendedor')).res.status).toHaveBeenCalledWith(403);
  });

  test.each(['parametros', 'SRV_ID_MAP', 'sync_filiais', 'filiais_bloqueadas', 'registros_deletados'])(
    'tabela interna %s: 403 até para o dono, leitura ou gravação', async tabela => {
      for (const nivel of ['r', 'w']) {
        const { res, next } = await rodar(nivel, tabela, 'dono');
        expect(res.status).toHaveBeenCalledWith(403);
        expect(next).not.toHaveBeenCalled();
      }
    });

  test('A_RECEBER e A_PAGAR seguem o módulo financeiro', async () => {
    pool.query.mockResolvedValue({ rows: [{ plano: 'LITE1' }] });
    obterNivelEfetivo.mockResolvedValue('--');
    for (const tabela of ['A_RECEBER', 'A_PAGAR']) {
      expect((await rodar('r', tabela, 'vendedor')).res.status).toHaveBeenCalledWith(403);
      expect(obterNivelEfetivo).toHaveBeenLastCalledWith('LITE1', 'vendedor', 'financeiro', 'empresa_kr');
    }
  });

  test('comparação do nome da tabela é case-insensitive', async () => {
    pool.query.mockResolvedValue({ rows: [{ plano: 'LITE1' }] });
    obterNivelEfetivo.mockResolvedValue('rw');
    const middleware = requireModuloDaTabela('r');
    const req = { params: { schema: 'empresa_kr', tabela: 'pedidos' }, userRoles: { empresa_kr: 'vendedor' } };
    const res = mockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(obterNivelEfetivo).toHaveBeenCalledWith('LITE1', 'vendedor', 'pedidos', 'empresa_kr');
    expect(next).toHaveBeenCalled();
  });
});
