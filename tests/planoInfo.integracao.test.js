/**
 * GET /api/:schema/plano — informa o plano atual do usuário e as features liberadas por ele
 * (src/planos.json). Não toca em Postgres (não faz query nenhuma), mas usa Express + supertest
 * de verdade para exercitar authJwt → checkSchema na cadeia real, não só a lógica isolada.
 */
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const adminRouter = require('../src/routes/resources/admin');
const { PLANO_PADRAO } = require('../src/planos');
const { TEST_SCHEMA } = require('./helpers/testSchema');

const app = express();
app.use(express.json());
app.use('/api', adminRouter);

function tokenComPlano(plano) {
  return jwt.sign(
    { id: 999999, nome: 'Teste', schemas: [TEST_SCHEMA], roles: {}, lojas: {}, vendedores: {}, planos: { [TEST_SCHEMA]: plano } },
    process.env.JWT_SECRET
  );
}

describe('GET /api/:schema/plano', () => {
  test('retorna plano/nome/features do usuário autenticado', async () => {
    const res = await request(app)
      .get(`/api/${TEST_SCHEMA}/plano`)
      .set('Authorization', `Bearer ${tokenComPlano('DIAMANTE1')}`);

    expect(res.status).toBe(200);
    expect(res.body.plano).toBe('DIAMANTE1');
    expect(res.body.features).toContain('financeiro');
    expect(res.body.features).toContain('exportacao');
  });

  test('plano abaixo de Safira não tem financeiro nem exportacao', async () => {
    const res = await request(app)
      .get(`/api/${TEST_SCHEMA}/plano`)
      .set('Authorization', `Bearer ${tokenComPlano('OURO1')}`);

    expect(res.status).toBe(200);
    expect(res.body.features).not.toContain('financeiro');
    expect(res.body.features).not.toContain('exportacao');
  });

  test('sem claim de plano no JWT cai para o plano padrão', async () => {
    const token = jwt.sign(
      { id: 999999, schemas: [TEST_SCHEMA], roles: {}, lojas: {}, vendedores: {}, planos: {} },
      process.env.JWT_SECRET
    );
    const res = await request(app)
      .get(`/api/${TEST_SCHEMA}/plano`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.plano).toBe(PLANO_PADRAO);
  });

  test('sem token retorna 401', async () => {
    const res = await request(app).get(`/api/${TEST_SCHEMA}/plano`);
    expect(res.status).toBe(401);
  });
});
