// Isolamento de tenant: nome de tabela vindo do cliente nunca pode alcançar public.* (usuarios, sync_tenants...).
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { pool } = require('../src/server/infrastructure/db');
const sincronizacaoRouter = require('../src/server/interfaces/http/routes/datasnap/sincronizacao');
const crudRouter = require('../src/server/interfaces/http/routes/api/crud');
const { TEST_SCHEMA, TEST_TOKEN, setupTestSchema } = require('./helpers/testSchema');
const { fixarOverrides, limparOverrides } = require('./helpers/permissoesReais');

const app = express();
app.use(express.json());
app.use('/datasnap/rest/TSMSincronizacao', sincronizacaoRouter);
app.use('/api', crudRouter);
app.use('/user/empresas', require('../src/server/interfaces/http/routes/datasnap/userEmpresas'));

const ALVO = 'alvo_seguranca_teste'; // tabela só em public, criada por este teste
const AUTH_VENDEDOR = `Bearer ${jwt.sign(
  { id: 999999, schemas: [TEST_SCHEMA], roles: { [TEST_SCHEMA]: 'vendedor' }, lojas: {}, vendedores: {} },
  process.env.JWT_SECRET
)}`;

const sync = (rota, q) => request(app).get(`/datasnap/rest/TSMSincronizacao/${rota}`).query({ token: TEST_TOKEN, ...q });
const web = caminho => request(app).get(`/api/${TEST_SCHEMA}/tabelas/${caminho}`).set('Authorization', AUTH_VENDEDOR);
const texto = r => JSON.stringify(r.body || '').toLowerCase();

beforeAll(async () => {
  await setupTestSchema();
  for (const t of ['usuarios', 'sync_tenants', ALVO]) {
    await pool.query(`DROP TABLE IF EXISTS ${TEST_SCHEMA}.${t} CASCADE`);
  }
  await pool.query(`DROP TABLE IF EXISTS public.${ALVO}`);
  await pool.query(`CREATE TABLE public.${ALVO} (id INTEGER PRIMARY KEY, segredo TEXT)`);
  await pool.query(`INSERT INTO public.${ALVO} VALUES (1, 'nao-pode-vazar')`);
}, 30000);

afterAll(async () => {
  await pool.query(`DROP TABLE IF EXISTS public.${ALVO}`);
  await pool.query(`DROP TABLE IF EXISTS ${TEST_SCHEMA}.${ALVO} CASCADE`);
  await pool.end();
});

describe('token de sync não alcança public', () => {
  test('RegistrosPaginados de USUARIOS não devolve senha_hash', async () => {
    const r = await sync('RegistrosPaginados', { nomeTabela: 'USUARIOS', pk: 'ID' });
    expect(texto(r)).not.toContain('senha_hash');
  });

  test('RegistrosPaginados de SYNC_TENANTS não devolve tokens', async () => {
    const r = await sync('RegistrosPaginados', { nomeTabela: 'SYNC_TENANTS', pk: 'SCHEMA_NAME' });
    expect(texto(r)).not.toContain(TEST_TOKEN.toLowerCase());
  });

  test('RegistrosPaginados de tabela só de public não vaza o conteúdo', async () => {
    const r = await sync('RegistrosPaginados', { nomeTabela: ALVO.toUpperCase(), pk: 'ID' });
    expect(texto(r)).not.toContain('nao-pode-vazar');
  });

  test('deleção via ReceberRegistro não apaga linha de public', async () => {
    await request(app)
      .post('/datasnap/rest/TSMSincronizacao/ReceberRegistro')
      .query({ token: TEST_TOKEN, idLoja: 1 })
      .send({ tabela: ALVO.toUpperCase(), pk: 'ID', registro: { ID: 1 }, deletar: true });
    const { rows } = await pool.query(`SELECT 1 FROM public.${ALVO} WHERE id = 1`);
    expect(rows).toHaveLength(1);
  });
});

describe('injeção de SQL por nome de coluna/PK vindo do cliente', () => {
  const MARCA = 'injetado_seguranca_teste';
  const injecao = `X TEXT); CREATE TABLE ${TEST_SCHEMA}.${MARCA} (a INT); --`;
  const existeMarca = async () => (await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`, [TEST_SCHEMA, MARCA])).rows.length > 0;
  const receber = (rota, body) => request(app).post(`/datasnap/rest/TSMSincronizacao/${rota}`).query({ token: TEST_TOKEN, idLoja: 1 }).send(body);

  beforeEach(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${TEST_SCHEMA}.${MARCA}`);
    await pool.query(`DROP TABLE IF EXISTS ${TEST_SCHEMA}.inj_sync_teste CASCADE`);
  });
  afterAll(() => pool.query(`DROP TABLE IF EXISTS ${TEST_SCHEMA}.${MARCA}`));

  test('chave maliciosa no registro (tabela nova) é recusada', async () => {
    const r = await receber('ReceberRegistro', { tabela: 'INJ_SYNC_TESTE', pk: 'ID', registro: { ID: 1, [injecao]: 1 } });
    expect(r.status).toBe(400);
    expect(await existeMarca()).toBe(false);
  });

  test('chave maliciosa no registro (tabela existente, coluna nova) é recusada', async () => {
    expect((await receber('ReceberRegistro', { tabela: 'INJ_SYNC_TESTE', pk: 'ID', registro: { ID: 1 } })).status).toBe(200);
    const r = await receber('ReceberRegistro', { tabela: 'INJ_SYNC_TESTE', pk: 'ID', registro: { ID: 2, [injecao]: 1 } });
    expect(r.status).toBe(400);
    expect(await existeMarca()).toBe(false);
  });

  test('pk maliciosa é recusada (unitário e lote)', async () => {
    const pk = `ID) ; CREATE TABLE ${TEST_SCHEMA}.${MARCA} (a INT); --`;
    expect((await receber('ReceberRegistro', { tabela: 'INJ_SYNC_TESTE', pk, registro: { ID: 1 } })).status).toBe(400);
    expect((await receber('ReceberRegistros', { tabela: 'INJ_SYNC_TESTE', pk: [pk], registros: [{ registro: { ID: 1 } }] })).status).toBe(400);
    expect(await existeMarca()).toBe(false);
  });

  test('GarantirTabela com pk maliciosa é recusado', async () => {
    const pks = [`ID) ; CREATE TABLE ${TEST_SCHEMA}.${MARCA} (a INT); --`];
    const r = await receber('GarantirTabela', { tabela: 'INJ_SYNC_TESTE', pks, colunas: [{ nome: 'ID', tipo: 'numero' }] });
    expect(r.status).toBe(400);
    expect(await existeMarca()).toBe(false);
  });
});

describe('schema reservado nunca vira empresa', () => {
  test.each(['public', 'information_schema', 'pg_catalog'])('POST /user/empresas com schema=%s é recusado', async schema => {
    const r = await request(app).post('/user/empresas').set('Authorization', AUTH_VENDEDOR)
      .send({ schema, token: `TOKEN_ATAQUE_${schema}`, nome: 'ataque' });
    expect(r.status).toBe(400);
    const { rows } = await pool.query('SELECT 1 FROM public.sync_tenants WHERE token = $1', [`TOKEN_ATAQUE_${schema}`]);
    expect(rows).toHaveLength(0);
  });

  test('JWT com vínculo a public não passa no checkSchema', async () => {
    const token = jwt.sign({ id: 999999, schemas: ['public'], roles: { public: 'dono' }, lojas: {}, vendedores: {} }, process.env.JWT_SECRET);
    const r = await request(app).get('/api/public/tabelas/USUARIOS/by-pk?pk=ID&value=1').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });
});

describe('by-pk/distinct/next-pk/colunas respeitam o módulo da tabela', () => {
  beforeAll(() => fixarOverrides(TEST_SCHEMA, 'vendedor', { fornecedores: '--' }));
  afterAll(() => limparOverrides(TEST_SCHEMA, 'vendedor', ['fornecedores']));

  test.each([
    'FORNECEDORES/by-pk?pk=ID_FORNECEDOR&value=1',
    'FORNECEDORES/distinct/NOME',
    'FORNECEDORES/next-pk?pk=ID_FORNECEDOR',
    'FORNECEDORES/colunas',
  ])('vendedor sem fornecedores recebe 403 em %s', async caminho => {
    expect((await web(caminho)).status).toBe(403);
  });
});

describe('usuário da web (vendedor) não alcança public', () => {
  test('by-pk em SYNC_TENANTS não devolve o token da empresa', async () => {
    const r = await web(`SYNC_TENANTS/by-pk?pk=SCHEMA_NAME&value=${TEST_SCHEMA}`);
    expect(texto(r)).not.toContain(TEST_TOKEN.toLowerCase());
  });

  test('distinct em USUARIOS.SENHA_HASH não devolve hashes', async () => {
    const r = await web('USUARIOS/distinct/SENHA_HASH');
    expect(Array.isArray(r.body) ? r.body : []).toEqual([]);
  });

  test('listagem de tabela só de public não vaza o conteúdo', async () => {
    const r = await web(ALVO.toUpperCase());
    expect(texto(r)).not.toContain('nao-pode-vazar');
  });
});
