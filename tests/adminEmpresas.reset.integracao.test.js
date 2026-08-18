/**
 * Testes de integração contra Postgres real cobrindo a marcação de `resetado_em` em
 * `sync_tenants` (feature de detecção de reset pelo client, ver src/client/resetLocal.js):
 * GET /StatusReset (sincronizacao.js, autenticação por token) antes/depois de um reset via
 * POST /superadmin/empresas/:schema/reset (adminEmpresas.js, autenticação JWT superadmin).
 * Schema próprio (`empresa_teste_reset`) — não colide com outros arquivos de teste.
 */
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { pool } = require('../src/server/infrastructure/db');
const { initializeDatabase, initializeTenantSchema } = require('../src/server/infrastructure/db-init');
const sincronizacaoRouter = require('../src/server/interfaces/http/routes/datasnap/sincronizacao');
const adminEmpresasRouter = require('../src/server/interfaces/http/routes/datasnap/adminEmpresas');
const authJwt = require('../src/server/interfaces/http/middleware/authJwt');
const requireSuperAdmin = require('../src/server/interfaces/http/middleware/requireSuperAdmin');

const SCHEMA = 'empresa_teste_reset';
const TOKEN = 'TOKEN_TESTE_RESET';

const app = express();
app.use(express.json());
app.use('/datasnap/rest/TSMSincronizacao', sincronizacaoRouter);
app.use('/superadmin', authJwt, requireSuperAdmin, adminEmpresasRouter);

const AUTH_SUPERADMIN = `Bearer ${jwt.sign({ id: 999999, isSuperAdmin: true }, process.env.JWT_SECRET)}`;

function statusReset() {
  return request(app).get('/datasnap/rest/TSMSincronizacao/StatusReset').query({ token: TOKEN });
}

beforeAll(async () => {
  await initializeDatabase();
  await pool.query('DELETE FROM public.sync_tenants WHERE schema_name = $1', [SCHEMA]);
  await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await initializeTenantSchema(SCHEMA);
  await pool.query(
    'INSERT INTO public.sync_tenants (token, schema_name, nome, plano) VALUES ($1, $2, $3, $4)',
    [TOKEN, SCHEMA, 'Empresa Teste Reset', 'SAFIRA1']
  );
}, 30000);

afterAll(async () => {
  await pool.query('DELETE FROM public.sync_tenants WHERE schema_name = $1', [SCHEMA]);
  await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await pool.end();
}, 30000);

describe('GET /StatusReset + POST /superadmin/empresas/:schema/reset', () => {
  test('antes de qualquer reset, resetado_em vem vazio', async () => {
    const res = await statusReset();
    expect(res.status).toBe(200);
    expect(res.body.resetado_em ?? null).toBeNull();
  });

  test('senha de reset errada não marca resetado_em', async () => {
    const res = await request(app)
      .post(`/superadmin/empresas/${SCHEMA}/reset`)
      .set('Authorization', AUTH_SUPERADMIN)
      .send({ confirmar: SCHEMA, senhaReset: 'senha-errada' });

    expect(res.status).toBe(403);
    const status = await statusReset();
    expect(status.body.resetado_em ?? null).toBeNull();
  });

  test('reset bem-sucedido marca resetado_em, refletido em GET /StatusReset', async () => {
    // Compara com NOW() da mesma conexão Postgres, não com o relógio do processo Node —
    // evita falso negativo por clock drift entre o test runner e o banco.
    const { rows: [{ agora }] } = await pool.query('SELECT NOW() - INTERVAL \'1 second\' AS agora');

    const reset = await request(app)
      .post(`/superadmin/empresas/${SCHEMA}/reset`)
      .set('Authorization', AUTH_SUPERADMIN)
      .send({ confirmar: SCHEMA, senhaReset: process.env.RESET_SECRET });

    expect(reset.status).toBe(200);
    expect(reset.body.ok).toBe(true);

    const status = await statusReset();
    expect(status.body.resetado_em).toBeTruthy();
    expect(new Date(status.body.resetado_em).getTime()).toBeGreaterThanOrEqual(agora.getTime());
  });
});
