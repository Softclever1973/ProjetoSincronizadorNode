const { erroServidor, erroValidacao } = require('../src/server/interfaces/http/erroServidor');

// res mínimo do Express: guarda status/corpo e expõe req (usado para o nome da rota no log).
function resFalso(req = { method: 'GET', baseUrl: '/datasnap/rest/TSMSincronizacao', path: '/StatusTabelas' }) {
  const res = { req, headersSent: false, statusCode: null, body: null };
  res.status = c => { res.statusCode = c; return res; };
  res.json = b => { res.body = b; return res; };
  return res;
}

let log;
beforeEach(() => { log = jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => log.mockRestore());

describe('erroServidor — nunca vaza detalhe interno', () => {
  test('erro inesperado vira mensagem genérica com ID; detalhe só no log', () => {
    const res = resFalso();
    erroServidor(res, new Error('connect ECONNREFUSED 10.0.0.5:5432'));
    expect(res.statusCode).toBe(500);
    expect(res.body.erro).toBe('Erro interno do servidor.');
    expect(res.body.id).toMatch(/^SRV-/);
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|10\.0\.0\.5/);
    expect(log.mock.calls[0].join(' ')).toMatch(new RegExp(`${res.body.id}.*StatusTabelas`));
  });

  test('log não leva a query string (token do sync)', () => {
    const res = resFalso({ method: 'GET', baseUrl: '/x', path: '/y', originalUrl: '/x/y?token=SEGREDO' });
    erroServidor(res, new Error('boom'));
    expect(log.mock.calls[0].join(' ')).not.toMatch(/SEGREDO/);
  });

  test('erro de dado do Postgres é traduzido, sem nome de constraint', () => {
    const res = resFalso();
    erroServidor(res, Object.assign(new Error('duplicate key value violates unique constraint "usuarios_email_key"'), { code: '23505' }));
    expect(res.statusCode).toBe(409);
    expect(res.body.erro).toBe('Já existe um registro com esse valor.');
    expect(JSON.stringify(res.body)).not.toMatch(/usuarios_email_key/);
  });

  test('mensagem nossa (validação/proibido) passa como está', () => {
    const res = resFalso();
    erroServidor(res, erroValidacao('Pedido cancelado não pode ser editado.'));
    expect([res.statusCode, res.body]).toEqual([400, { erro: 'Pedido cancelado não pode ser editado.' }]);

    const res2 = resFalso();
    erroServidor(res2, Object.assign(new Error('registro de outra loja'), { isForbidden: true }));
    expect(res2.statusCode).toBe(403);
  });

  test("rotas do sync usam a chave 'message'", () => {
    const res = resFalso();
    erroServidor(res, new Error('x'), 'rota', 'message');
    expect(res.body).toHaveProperty('message', 'Erro interno do servidor.');
  });
});
