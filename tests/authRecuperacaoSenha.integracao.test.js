/**
 * Testes de integração contra Postgres real (mesmo banco de dev de .env) para o fluxo de
 * "esqueci minha senha" — POST /auth/esqueci-senha e POST /auth/redefinir-senha. Usa um
 * e-mail de teste dedicado em public.usuarios (mesmo padrão de adminEmpresas.plano.integracao.test.js
 * — ver CLAUDE.md sobre isolamento entre arquivos de teste de integração).
 *
 * O microsserviço externo "Sirius Email API" é mockado — não depende de nenhum processo
 * externo rodando, e captura o link de redefinição para extrair o token gerado.
 */
const express = require('express');
const request = require('supertest');
const bcrypt = require('bcryptjs');

jest.mock('../src/server/infrastructure/email/emailApiClient');
const { enviarEmail } = require('../src/server/infrastructure/email/emailApiClient');

const { pool } = require('../src/server/infrastructure/db');
const { initializeDatabase } = require('../src/server/infrastructure/db-init');
const authRouter = require('../src/server/interfaces/http/routes/datasnap/auth');

const app = express();
app.use(express.json());
app.use('/auth', authRouter);

const EMAIL_TESTE = 'reset.teste@example.com';
const SENHA_ORIGINAL = 'senhaOriginal123';

async function limparUsuarioDeTeste() {
  await pool.query('DELETE FROM public.usuarios WHERE email = $1', [EMAIL_TESTE]);
}

function extrairTokenDoLink() {
  const chamada = enviarEmail.mock.calls[enviarEmail.mock.calls.length - 1][0];
  const match = chamada.html.match(/token=([a-f0-9]+)/);
  return match[1];
}

// Capturado uma única vez (no primeiro teste que chama /auth/esqueci-senha) e reaproveitado
// pelos testes de /auth/redefinir-senha — chamar /auth/esqueci-senha de novo para o mesmo
// e-mail dentro de RESET_THROTTLE_MS (60s) é intencionalmente bloqueado pela rota (evita
// reenvio em disparada) e não geraria um token novo mesmo se tentássemos.
let tokenValido;

beforeAll(async () => {
  await initializeDatabase();
  await limparUsuarioDeTeste();
  const senhaHash = await bcrypt.hash(SENHA_ORIGINAL, 12);
  await pool.query(
    'INSERT INTO public.usuarios (email, senha_hash, ativo) VALUES ($1, $2, TRUE)',
    [EMAIL_TESTE, senhaHash]
  );
}, 30000);

afterAll(async () => {
  await limparUsuarioDeTeste();
  await pool.end();
});

beforeEach(() => {
  enviarEmail.mockClear();
  enviarEmail.mockResolvedValue({ success: true });
});

describe('POST /auth/esqueci-senha', () => {
  it('envia e-mail e grava o hash do token quando o e-mail existe', async () => {
    const res = await request(app).post('/auth/esqueci-senha').send({ email: EMAIL_TESTE });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(enviarEmail).toHaveBeenCalledTimes(1);
    expect(enviarEmail.mock.calls[0][0].to).toBe(EMAIL_TESTE);
    tokenValido = extrairTokenDoLink();

    const { rows: [usuario] } = await pool.query(
      'SELECT reset_token_hash, reset_token_expira FROM public.usuarios WHERE email = $1', [EMAIL_TESTE]
    );
    expect(usuario.reset_token_hash).toBeTruthy();
    expect(new Date(usuario.reset_token_expira).getTime()).toBeGreaterThan(Date.now());
  });

  it('responde com a mesma mensagem genérica para e-mail inexistente, sem enviar e-mail', async () => {
    const res = await request(app).post('/auth/esqueci-senha').send({ email: 'nao.existe.xyz@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(enviarEmail).not.toHaveBeenCalled();
  });

  it('rejeita corpo sem e-mail', async () => {
    const res = await request(app).post('/auth/esqueci-senha').send({});
    expect(res.status).toBe(400);
  });
});

describe('POST /auth/redefinir-senha', () => {
  it('rejeita token inválido', async () => {
    const res = await request(app)
      .post('/auth/redefinir-senha')
      .send({ token: 'token-que-nao-existe', novaSenha: 'novaSenha456' });
    expect(res.status).toBe(400);
  });

  it('rejeita senha curta mesmo com token válido', async () => {
    // A validação de tamanho ocorre antes da consulta ao token, então isso não o consome —
    // tokenValido continua utilizável no teste seguinte.
    const res = await request(app).post('/auth/redefinir-senha').send({ token: tokenValido, novaSenha: '123' });
    expect(res.status).toBe(400);
  });

  it('redefine a senha com token válido e o invalida após o uso', async () => {
    const novaSenha = 'novaSenha456';

    const res = await request(app).post('/auth/redefinir-senha').send({ token: tokenValido, novaSenha });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // login com a senha antiga deve falhar, com a nova deve funcionar
    const loginAntigo = await request(app).post('/auth/login').send({ email: EMAIL_TESTE, senha: SENHA_ORIGINAL });
    expect(loginAntigo.status).toBe(401);

    const loginNovo = await request(app).post('/auth/login').send({ email: EMAIL_TESTE, senha: novaSenha });
    expect(loginNovo.status).toBe(200);

    // reusar o mesmo token não deve mais funcionar (já foi limpo após o uso)
    const reuso = await request(app).post('/auth/redefinir-senha').send({ token: tokenValido, novaSenha: 'outraSenha789' });
    expect(reuso.status).toBe(400);
  });
});
