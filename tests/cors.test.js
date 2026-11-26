// CORS por lista de origens (CORS_ORIGINS).
const { criarCors, lerOrigens, origemPermitida } = require('../src/server/interfaces/http/middleware/cors');

function rodar(permitidas, { origin, method = 'GET' } = {}) {
  const headers = {};
  const res = {
    setHeader: (k, v) => { headers[k] = v; },
    sendStatus: jest.fn(),
  };
  const next = jest.fn();
  criarCors(permitidas)({ method, headers: origin ? { origin } : {} }, res, next);
  return { headers, res, next };
}

test('lerOrigens: separa por vírgula, tira espaço, barra final e caixa', () => {
  expect(lerOrigens(' https://App.exemplo.com/ , http://localhost:3000,, ')).toEqual(['https://app.exemplo.com', 'http://localhost:3000']);
  expect(lerOrigens(undefined)).toEqual([]);
});

test('sem lista: libera tudo com *', () => {
  const { headers, next } = rodar([], { origin: 'https://qualquer.com' });
  expect(headers['Access-Control-Allow-Origin']).toBe('*');
  expect(next).toHaveBeenCalled();
});

test('origem da lista recebe o próprio endereço de volta', () => {
  const { headers, next } = rodar(['https://app.exemplo.com'], { origin: 'https://app.exemplo.com' });
  expect(headers['Access-Control-Allow-Origin']).toBe('https://app.exemplo.com');
  expect(headers.Vary).toBe('Origin');
  expect(next).toHaveBeenCalled();
});

test('origem fora da lista não recebe permissão (o navegador bloqueia)', () => {
  const { headers, next } = rodar(['https://app.exemplo.com'], { origin: 'https://malicioso.com' });
  expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
  expect(next).toHaveBeenCalled();
});

test('sem Origin (client da loja, curl): segue normal', () => {
  const { headers, next } = rodar(['https://app.exemplo.com']);
  expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
  expect(next).toHaveBeenCalled();
});

test('preflight OPTIONS responde 204 sem chegar nas rotas', () => {
  const { res, next } = rodar(['https://app.exemplo.com'], { origin: 'https://app.exemplo.com', method: 'OPTIONS' });
  expect(res.sendStatus).toHaveBeenCalledWith(204);
  expect(next).not.toHaveBeenCalled();
});

test('curinga de subdomínio', () => {
  const lista = ['https://*.vercel.app'];
  expect(origemPermitida('https://sirius-web-abc.vercel.app', lista)).toBe(true);
  expect(origemPermitida('https://vercel.app', lista)).toBe(false);
  expect(origemPermitida('https://vercel.app.malicioso.com', lista)).toBe(false);
  expect(origemPermitida('http://sirius.vercel.app', lista)).toBe(false);
});
