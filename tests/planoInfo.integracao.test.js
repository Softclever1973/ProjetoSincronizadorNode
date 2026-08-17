// GET /api/:schema/plano lê de sync_tenants, não do claim do JWT — testes setam o plano no
// banco com um claim diferente de propósito. Schema fictício próprio pra não colidir com TEST_SCHEMA.
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const adminRouter = require('../src/routes/resources/admin');
const { pool } = require('../src/server/infrastructure/db');
const { PLANO_PADRAO } = require('../src/planos');

const SCHEMA = 'empresa_teste_plano_info';

const app = express();
app.use(express.json());
app.use('/api', adminRouter);

function tokenComPlanoClaim(planoNoClaim) {
  return jwt.sign(
    { id: 999999, nome: 'Teste', schemas: [SCHEMA], roles: {}, lojas: {}, vendedores: {}, planos: { [SCHEMA]: planoNoClaim } },
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
    ['TOKEN_TESTE_PLANO_INFO', SCHEMA, 'Empresa Teste Plano Info', 'LITE1']
  );
}, 30000);

afterAll(async () => {
  await pool.query('DELETE FROM public.sync_tenants WHERE schema_name = $1', [SCHEMA]);
  await pool.end();
});

describe('GET /api/:schema/plano', () => {
  test('retorna plano/nome/features do banco (não do claim do JWT)', async () => {
    await setPlanoNoBanco('DIAMANTE1');

    const res = await request(app)
      .get(`/api/${SCHEMA}/plano`)
      // claim do JWT propositalmente diferente do banco — a resposta deve ignorá-lo
      .set('Authorization', `Bearer ${tokenComPlanoClaim('LITE1')}`);

    expect(res.status).toBe(200);
    expect(res.body.plano).toBe('DIAMANTE1');
    expect(res.body.features).toContain('financeiro');
    expect(res.body.features).toContain('exportacao');
  });

  test('plano abaixo de Safira não tem financeiro nem exportacao', async () => {
    await setPlanoNoBanco('OURO1');

    const res = await request(app)
      .get(`/api/${SCHEMA}/plano`)
      .set('Authorization', `Bearer ${tokenComPlanoClaim('DIAMANTE1')}`);

    expect(res.status).toBe(200);
    expect(res.body.plano).toBe('OURO1');
    expect(res.body.features).not.toContain('financeiro');
    expect(res.body.features).not.toContain('exportacao');
  });

  test('mudança de plano no banco reflete na próxima chamada, mesmo com o mesmo JWT (sem reemitir token)', async () => {
    await setPlanoNoBanco('LITE1');
    const token = `Bearer ${tokenComPlanoClaim('LITE1')}`;

    const antes = await request(app).get(`/api/${SCHEMA}/plano`).set('Authorization', token);
    expect(antes.body.plano).toBe('LITE1');
    expect(antes.body.features).not.toContain('financeiro');

    await setPlanoNoBanco('SAFIRA1');

    const depois = await request(app).get(`/api/${SCHEMA}/plano`).set('Authorization', token);
    expect(depois.body.plano).toBe('SAFIRA1');
    expect(depois.body.features).toContain('financeiro');
  });

  test('schema sem linha em sync_tenants cai para o plano padrão', async () => {
    const SCHEMA_FANTASMA = 'schema_que_nao_existe_em_sync_tenants';
    // checkSchema só exige o schema na lista de schemas do usuário — não que a linha
    // exista em sync_tenants — então esse token inclui o schema fantasma de propósito.
    const token = jwt.sign(
      { id: 999999, schemas: [SCHEMA_FANTASMA], roles: {}, lojas: {}, vendedores: {}, planos: {} },
      process.env.JWT_SECRET
    );
    const res = await request(app)
      .get(`/api/${SCHEMA_FANTASMA}/plano`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.plano).toBe(PLANO_PADRAO);
  });

  test('sem token retorna 401', async () => {
    const res = await request(app).get(`/api/${SCHEMA}/plano`);
    expect(res.status).toBe(401);
  });
});
