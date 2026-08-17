/**
 * Testes de integração contra Postgres real (mesmo banco de dev de .env), exercitando
 * o CRUD de `plano` nas rotas de superadmin (adminEmpresas.js). Usa um schema próprio
 * (`empresa_teste_plano`, distinto de `empresa_teste`/`empresa_e2e` usados por outros
 * arquivos de teste) para não colidir com truncates/drops de outros testes rodando em
 * paralelo — ver aviso em CLAUDE.md sobre isolamento entre arquivos de teste de
 * integração.
 */
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { pool } = require('../src/server/infrastructure/db');
const { initializeDatabase } = require('../src/server/infrastructure/db-init');
const { PLANO_PADRAO } = require('../src/planos');
const adminEmpresasRouter = require('../src/routes/adminEmpresas');
const authJwt = require('../src/server/interfaces/http/middleware/authJwt');
const requireSuperAdmin = require('../src/server/interfaces/http/middleware/requireSuperAdmin');

const app = express();
app.use(express.json());
app.use('/superadmin', authJwt, requireSuperAdmin, adminEmpresasRouter);

const SCHEMA = 'empresa_teste_plano';
const SCHEMA_INVALIDO = 'empresa_teste_plano_invalido'; // usado só no teste negativo — nunca chega a ser criado
const EMAILS_DONO = ['dono.teste.plano@example.com', 'dono.teste.plano.invalido@example.com'];

function tokenSuperAdmin() {
  return jwt.sign({ id: 999999, isSuperAdmin: true }, process.env.JWT_SECRET);
}
const AUTH_SUPERADMIN = `Bearer ${tokenSuperAdmin()}`;

async function limparSchemaDeTeste(schema) {
  await pool.query('DELETE FROM public.usuarios_empresas WHERE schema_name = $1', [schema]);
  await pool.query('DELETE FROM public.sync_tenants WHERE schema_name = $1', [schema]);
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
}

// POST /superadmin/empresas também cria a conta do dono em public.usuarios — sem limpar
// isso aqui, uma segunda execução deste arquivo de teste bate em "e-mail já cadastrado"
// e falha com 409 em vez de 201, mesmo com o schema/token já limpos.
async function limparDonosDeTeste() {
  await pool.query('DELETE FROM public.usuarios WHERE email = ANY($1::text[])', [EMAILS_DONO]);
}

async function limparTudo() {
  await limparSchemaDeTeste(SCHEMA);
  await limparSchemaDeTeste(SCHEMA_INVALIDO);
  await limparDonosDeTeste();
}

beforeAll(async () => {
  // Garante que a migração da coluna `plano` (src/db-init.js) já rodou neste banco —
  // mesma chamada idempotente que o server.js faz no startup, necessária aqui porque
  // os testes não dependem de o servidor já ter sido iniciado contra este Postgres.
  await initializeDatabase();
  await limparTudo();
}, 30000);

afterAll(async () => {
  await limparTudo();
  await pool.end();
}, 30000);

describe('POST /superadmin/empresas — campo plano', () => {
  test('sem empresa.plano persiste o plano padrão (LITE1)', async () => {
    const res = await request(app)
      .post('/superadmin/empresas')
      .set('Authorization', AUTH_SUPERADMIN)
      .send({
        empresa: { schema: SCHEMA, token: 'TOKEN_TESTE_PLANO', nome: 'Empresa Teste Plano', regime_tributario: 'simples' },
        dono: { nome: 'Dono Teste', email: 'dono.teste.plano@example.com', senha: 'senha123' },
      });

    expect(res.status).toBe(201);

    const { rows } = await pool.query('SELECT plano FROM public.sync_tenants WHERE schema_name = $1', [SCHEMA]);
    expect(rows[0].plano).toBe(PLANO_PADRAO);
  }, 15000);

  test('empresa.plano inválido retorna 400 e não cria nada', async () => {
    const res = await request(app)
      .post('/superadmin/empresas')
      .set('Authorization', AUTH_SUPERADMIN)
      .send({
        empresa: { schema: SCHEMA_INVALIDO, token: 'TOKEN_TESTE_PLANO_INVALIDO', nome: 'X', regime_tributario: 'simples', plano: 'plano_que_nao_existe' },
        dono: { nome: 'Dono', email: 'dono.teste.plano.invalido@example.com', senha: 'senha123' },
      });

    expect(res.status).toBe(400);
    expect(res.body.erro).toMatch(/Plano inválido/);

    const { rows } = await pool.query('SELECT 1 FROM public.sync_tenants WHERE schema_name = $1', [SCHEMA_INVALIDO]);
    expect(rows).toHaveLength(0);
  });
});

describe('PUT /superadmin/empresas/:schema/plano', () => {
  test('plano válido atualiza e reflete em GET /empresas', async () => {
    const put = await request(app)
      .put(`/superadmin/empresas/${SCHEMA}/plano`)
      .set('Authorization', AUTH_SUPERADMIN)
      .send({ plano: 'DIAMANTE1' });

    expect(put.status).toBe(200);
    expect(put.body.ok).toBe(true);

    const get = await request(app).get('/superadmin/empresas').set('Authorization', AUTH_SUPERADMIN);
    const empresa = get.body.find(e => e.schema_name === SCHEMA);
    expect(empresa.plano).toBe('DIAMANTE1');
  });

  test('plano inválido retorna 400 e não altera o valor atual', async () => {
    const res = await request(app)
      .put(`/superadmin/empresas/${SCHEMA}/plano`)
      .set('Authorization', AUTH_SUPERADMIN)
      .send({ plano: 'plano_que_nao_existe' });

    expect(res.status).toBe(400);

    const { rows } = await pool.query('SELECT plano FROM public.sync_tenants WHERE schema_name = $1', [SCHEMA]);
    expect(rows[0].plano).toBe('DIAMANTE1'); // valor do teste anterior, inalterado
  });

  test('schema inexistente retorna 404', async () => {
    const res = await request(app)
      .put('/superadmin/empresas/schema_que_nao_existe/plano')
      .set('Authorization', AUTH_SUPERADMIN)
      .send({ plano: 'LITE1' });

    expect(res.status).toBe(404);
  });
});

describe('GET /superadmin/planos', () => {
  test('lista os planos definidos em src/planos.json', async () => {
    const res = await request(app).get('/superadmin/planos').set('Authorization', AUTH_SUPERADMIN);

    expect(res.status).toBe(200);
    expect(res.body.map(p => p.chave)).toEqual(
      expect.arrayContaining(['LITE1', 'BRONZE1', 'PRATA1', 'OURO1', 'SAFIRA1', 'DIAMANTE1'])
    );
  });
});
