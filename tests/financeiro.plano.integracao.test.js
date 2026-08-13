// /api/:schema/financeiro/* exige feature "financeiro" (Safira+), lida de sync_tenants — não
// do claim do JWT. Schema fictício próprio pra não colidir com TEST_SCHEMA/plano_info.
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const financeiroRouter = require('../src/routes/financeiro');
const { pool } = require('../src/db');

const SCHEMA = 'empresa_teste_financeiro_plano';

const app = express();
app.use(express.json());
app.use('/api', financeiroRouter);

function tokenPara(role, planoNoClaim) {
  return jwt.sign(
    {
      id: 999999, nome: 'Teste', schemas: [SCHEMA],
      roles: { [SCHEMA]: role }, lojas: {}, vendedores: {},
      planos: { [SCHEMA]: planoNoClaim },
    },
    process.env.JWT_SECRET
  );
}

async function setPlanoNoBanco(plano) {
  await pool.query('UPDATE public.sync_tenants SET plano = $1 WHERE schema_name = $2', [plano, SCHEMA]);
}

beforeAll(async () => {
  await pool.query('DELETE FROM public.sync_tenants WHERE schema_name = $1', [SCHEMA]);
  await pool.query(
    'INSERT INTO public.sync_tenants (token, schema_name, nome, plano) VALUES ($1, $2, $3, $4)',
    ['TOKEN_TESTE_FINANCEIRO_PLANO', SCHEMA, 'Empresa Teste Financeiro Plano', 'LITE1']
  );
}, 30000);

afterAll(async () => {
  await pool.query('DELETE FROM public.sync_tenants WHERE schema_name = $1', [SCHEMA]);
  await pool.end();
});

describe('GET /api/:schema/financeiro/contas-pagar — gate de plano', () => {
  test('dono num plano abaixo de Safira recebe 403 (plano lido do banco, claim do JWT diz Diamante)', async () => {
    await setPlanoNoBanco('OURO1');

    const res = await request(app)
      .get(`/api/${SCHEMA}/financeiro/contas-pagar`)
      // claim do JWT propositalmente mais alto que o banco — não deve liberar acesso
      .set('Authorization', `Bearer ${tokenPara('dono', 'DIAMANTE1')}`);

    expect(res.status).toBe(403);
    expect(res.body.erro).toBe('recurso não disponível no plano atual');
  });

  test('dono num plano Safira+ é liberado, mesmo com claim do JWT desatualizado (Lite)', async () => {
    await setPlanoNoBanco('SAFIRA1');

    const res = await request(app)
      .get(`/api/${SCHEMA}/financeiro/contas-pagar`)
      .set('Authorization', `Bearer ${tokenPara('dono', 'LITE1')}`);

    expect(res.status).not.toBe(403);
  });

  test('upgrade de plano no banco libera o acesso na próxima requisição, sem reemitir o JWT', async () => {
    await setPlanoNoBanco('LITE1');
    const token = `Bearer ${tokenPara('dono', 'LITE1')}`;

    const antes = await request(app).get(`/api/${SCHEMA}/financeiro/contas-pagar`).set('Authorization', token);
    expect(antes.status).toBe(403);

    await setPlanoNoBanco('SAFIRA1');

    const depois = await request(app).get(`/api/${SCHEMA}/financeiro/contas-pagar`).set('Authorization', token);
    expect(depois.status).not.toBe(403);
  });

  test('schema sem linha em sync_tenants cai pro plano padrão (sem feature) e recebe 403', async () => {
    const SCHEMA_FANTASMA = 'schema_que_nao_existe_em_sync_tenants_fin';
    const token = jwt.sign(
      { id: 999999, schemas: [SCHEMA_FANTASMA], roles: { [SCHEMA_FANTASMA]: 'dono' }, lojas: {}, vendedores: {}, planos: {} },
      process.env.JWT_SECRET
    );
    const res = await request(app)
      .get(`/api/${SCHEMA_FANTASMA}/financeiro/contas-pagar`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  test('vendedor num plano Safira ainda é bloqueado pelo role (não chega no gate de plano)', async () => {
    await setPlanoNoBanco('SAFIRA1');

    const res = await request(app)
      .get(`/api/${SCHEMA}/financeiro/contas-pagar`)
      .set('Authorization', `Bearer ${tokenPara('vendedor', 'SAFIRA1')}`);

    expect(res.status).toBe(403);
  });
});
