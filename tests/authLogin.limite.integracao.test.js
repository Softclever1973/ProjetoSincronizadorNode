// Limite de tentativas no POST /auth/login (Postgres real, e-mail de teste próprio em public.usuarios).
const express = require('express');
const request = require('supertest');
const bcrypt = require('bcryptjs');

const { pool } = require('../src/server/infrastructure/db');
const { initializeDatabase } = require('../src/server/infrastructure/db-init');
const authRouter = require('../src/server/interfaces/http/routes/datasnap/auth');
const tentativas = require('../src/server/infrastructure/cache/tentativasLogin');

const app = express();
app.set('trust proxy', true); // cada teste usa um IP próprio via X-Forwarded-For
app.use(express.json());
app.use('/auth', authRouter);

const EMAIL = 'limite.login.teste@example.com';
const SENHA = 'senhaCerta123';

const login = (ip, email, senha) => request(app).post('/auth/login').set('X-Forwarded-For', ip).send({ email, senha });

beforeAll(async () => {
  await initializeDatabase();
  await pool.query('DELETE FROM public.usuarios WHERE email = $1', [EMAIL]);
  await pool.query('INSERT INTO public.usuarios (email, senha_hash, ativo) VALUES ($1, $2, TRUE)', [EMAIL, await bcrypt.hash(SENHA, 4)]);
}, 30000);

afterAll(async () => {
  await pool.query('DELETE FROM public.usuarios WHERE email = $1', [EMAIL]);
  await pool.end();
});

beforeEach(() => tentativas._limparTudo());

describe('limite por e-mail', () => {
  test(`${tentativas.MAX_POR_EMAIL} senhas erradas travam a conta, até com a senha certa`, async () => {
    for (let i = 0; i < tentativas.MAX_POR_EMAIL; i++) expect((await login('10.0.0.1', EMAIL, 'errada')).status).toBe(401);
    const r = await login('10.0.0.1', EMAIL, SENHA);
    expect(r.status).toBe(429);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    expect(r.body.erro).toMatch(/Muitas tentativas/);
    expect(r.body.token).toBeUndefined();
  });

  test('trava vale de qualquer IP e ignora maiúsculas/espaços no e-mail', async () => {
    for (let i = 0; i < tentativas.MAX_POR_EMAIL; i++) await login(`10.0.1.${i}`, EMAIL, 'errada');
    expect((await login('10.0.2.1', ` ${EMAIL.toUpperCase()} `, SENHA)).status).toBe(429);
  });

  test('login certo zera a contagem da conta', async () => {
    for (let i = 0; i < tentativas.MAX_POR_EMAIL - 1; i++) await login('10.0.3.1', EMAIL, 'errada');
    expect((await login('10.0.3.1', EMAIL, SENHA)).status).toBe(200);
    for (let i = 0; i < tentativas.MAX_POR_EMAIL - 1; i++) await login('10.0.3.1', EMAIL, 'errada');
    expect((await login('10.0.3.1', EMAIL, SENHA)).status).toBe(200);
  });
});

describe('limite por IP', () => {
  test(`${tentativas.MAX_POR_IP} falhas com e-mails variados travam o IP, não os outros`, async () => {
    for (let i = 0; i < tentativas.MAX_POR_IP; i++) await login('10.0.4.1', `naoexiste${i}@example.com`, 'x');
    expect((await login('10.0.4.1', EMAIL, SENHA)).status).toBe(429);
    expect((await login('10.0.4.2', EMAIL, SENHA)).status).toBe(200);
  });
});

describe('janela de tempo', () => {
  test('a trava some depois da janela', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < tentativas.MAX_POR_EMAIL; i++) tentativas.registrarFalha(EMAIL, '10.0.5.1', t0);
    expect(tentativas.segundosBloqueado(EMAIL, '10.0.5.1', t0 + 1000)).toBe(tentativas.JANELA_MS / 1000 - 1);
    expect(tentativas.segundosBloqueado(EMAIL, '10.0.5.1', t0 + tentativas.JANELA_MS)).toBe(0);
  });
});
