/**
 * Prova de ponta a ponta do requirePlanFeature: um plano real presente em src/planos.json
 * libera a rota demo; um plano desconhecido é bloqueado (fail-closed) mesmo com o resto
 * do JWT válido. Não toca em Postgres (as rotas testadas aqui não fazem query nenhuma),
 * mas usa Express + supertest de verdade para exercitar authJwt → checkSchema →
 * requirePlanFeature na cadeia real, não só a lógica isolada.
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

describe('GET /api/:schema/admin/demo-feature', () => {
  test('plano válido com a feature retorna 200', async () => {
    const res = await request(app)
      .get(`/api/${TEST_SCHEMA}/admin/demo-feature`)
      .set('Authorization', `Bearer ${tokenComPlano(PLANO_PADRAO)}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('plano desconhecido é bloqueado (fail-closed), mesmo com token válido', async () => {
    const res = await request(app)
      .get(`/api/${TEST_SCHEMA}/admin/demo-feature`)
      .set('Authorization', `Bearer ${tokenComPlano('plano_desconhecido')}`);

    expect(res.status).toBe(403);
    expect(res.body.erro).toBe('recurso não disponível no plano atual');
  });

  test('sem token retorna 401', async () => {
    const res = await request(app).get(`/api/${TEST_SCHEMA}/admin/demo-feature`);
    expect(res.status).toBe(401);
  });
});

describe('GET /api/:schema/plano', () => {
  test('retorna plano/nome/features do usuário autenticado', async () => {
    const res = await request(app)
      .get(`/api/${TEST_SCHEMA}/plano`)
      .set('Authorization', `Bearer ${tokenComPlano('diamante')}`);

    expect(res.status).toBe(200);
    expect(res.body.plano).toBe('diamante');
    expect(res.body.features).toContain('demo.relatorio_avancado');
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
});
