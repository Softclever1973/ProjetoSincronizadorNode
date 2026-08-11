/**
 * Prova de que /api/:schema/financeiro/* exige a feature "financeiro" (planos Safira+),
 * além do role gerente/dono já existente. Só exercita o caminho bloqueado (403) — não
 * toca em Postgres, porque requirePlanFeature roda antes de qualquer query, na cadeia
 * authJwt → checkSchema → requireRole → requirePlanFeature.
 */
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const financeiroRouter = require('../src/routes/financeiro');
const { TEST_SCHEMA } = require('./helpers/testSchema');

const app = express();
app.use(express.json());
app.use('/api', financeiroRouter);

function tokenPara(role, plano) {
  return jwt.sign(
    {
      id: 999999, nome: 'Teste', schemas: [TEST_SCHEMA],
      roles: { [TEST_SCHEMA]: role }, lojas: {}, vendedores: {},
      planos: { [TEST_SCHEMA]: plano },
    },
    process.env.JWT_SECRET
  );
}

describe('GET /api/:schema/financeiro/contas-pagar — gate de plano', () => {
  test('dono num plano abaixo de Safira recebe 403', async () => {
    const res = await request(app)
      .get(`/api/${TEST_SCHEMA}/financeiro/contas-pagar`)
      .set('Authorization', `Bearer ${tokenPara('dono', 'OURO1')}`);

    expect(res.status).toBe(403);
    expect(res.body.erro).toBe('recurso não disponível no plano atual');
  });

  test('dono sem plano no JWT (cai pro padrão "LITE1") também recebe 403', async () => {
    const token = jwt.sign(
      { id: 999999, schemas: [TEST_SCHEMA], roles: { [TEST_SCHEMA]: 'dono' }, lojas: {}, vendedores: {}, planos: {} },
      process.env.JWT_SECRET
    );
    const res = await request(app)
      .get(`/api/${TEST_SCHEMA}/financeiro/contas-pagar`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  test('vendedor num plano Safira ainda é bloqueado pelo role (não chega no gate de plano)', async () => {
    const res = await request(app)
      .get(`/api/${TEST_SCHEMA}/financeiro/contas-pagar`)
      .set('Authorization', `Bearer ${tokenPara('vendedor', 'SAFIRA1')}`);

    expect(res.status).toBe(403);
  });
});
