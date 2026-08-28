/**
 * Testes de integração contra Postgres real focados especificamente no comportamento NOVO
 * introduzido pelo sistema de permissões por módulo no CRUD genérico (crud.js): o gate de
 * LEITURA em GET /api/:schema/tabelas/:tabela, que antes não existia (qualquer role lia
 * livremente). O comportamento de escrita (vendedor só escreve PEDIDOS) já é coberto por
 * crud.integracao.test.js — schema próprio aqui, não reaproveita TEST_SCHEMA/empresa_teste
 * pra não colidir com o truncate em beforeEach daquele arquivo (Jest roda em paralelo).
 */
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { pool } = require('../src/server/infrastructure/db');
const { initializeTenantSchema } = require('../src/server/infrastructure/db-init');
const crudRouter = require('../src/server/interfaces/http/routes/api/crud');

const SCHEMA = 'empresa_teste_crud_permissoes';

const app = express();
app.use(express.json());
app.use('/api', crudRouter);

function tokenPara(role) {
  return `Bearer ${jwt.sign(
    { id: 999999, schemas: [SCHEMA], roles: { [SCHEMA]: role }, lojas: {}, vendedores: {} },
    process.env.JWT_SECRET
  )}`;
}

beforeAll(async () => {
  await pool.query('DELETE FROM public.sync_tenants WHERE schema_name = $1', [SCHEMA]);
  await pool.query(
    'INSERT INTO public.sync_tenants (token, schema_name, nome, plano) VALUES ($1, $2, $3, $4)',
    ['TOKEN_TESTE_CRUD_PERMISSOES', SCHEMA, 'Empresa Teste CRUD Permissões', 'LITE1']
  );
  await initializeTenantSchema(SCHEMA);
  await pool.query(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.produtos (srv_id INTEGER PRIMARY KEY, codigo TEXT, nome TEXT)`);
  // Tabela deliberadamente FORA do mapeamento TABELA_MODULO — deve permanecer sem gate.
  await pool.query(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.aux_generica (id INTEGER PRIMARY KEY, descricao TEXT)`);
}, 30000);

afterAll(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await pool.query('DELETE FROM public.sync_tenants WHERE schema_name = $1', [SCHEMA]);
  await pool.end();
});

describe('GET /api/:schema/tabelas/:tabela — gate de leitura novo (antes não existia)', () => {
  test('vendedor lê PRODUTOS normalmente (nível r-, plano LITE1 libera rw)', async () => {
    const res = await request(app)
      .get(`/api/${SCHEMA}/tabelas/PRODUTOS`)
      .set('Authorization', tokenPara('vendedor'));
    expect(res.status).toBe(200);
  });

  test('vendedor lê PEDIDOS normalmente (nível rw)', async () => {
    const res = await request(app)
      .get(`/api/${SCHEMA}/tabelas/PEDIDOS`)
      .set('Authorization', tokenPara('vendedor'));
    expect(res.status).toBe(200);
  });

  test('tabela fora do mapeamento de módulos não é afetada pelo gate', async () => {
    const res = await request(app)
      .get(`/api/${SCHEMA}/tabelas/AUX_GENERICA`)
      .set('Authorization', tokenPara('vendedor'));
    expect(res.status).toBe(200);
  });

  test('dono lê qualquer tabela mapeada normalmente', async () => {
    const res = await request(app)
      .get(`/api/${SCHEMA}/tabelas/PRODUTOS`)
      .set('Authorization', tokenPara('dono'));
    expect(res.status).toBe(200);
  });
});
