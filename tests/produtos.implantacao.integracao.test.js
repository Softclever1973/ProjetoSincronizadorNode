// Cadastrar produto não exige permissão de movimentação: o servidor grava a "Implantação" no hook de PRODUTOS.
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { pool } = require('../src/server/infrastructure/db');
const { initializeTenantSchema } = require('../src/server/infrastructure/db-init');
const crudRouter = require('../src/server/interfaces/http/routes/api/crud');
const { fixarOverrides, limparOverrides } = require('./helpers/permissoesReais');

const SCHEMA = 'empresa_teste_prod_implantacao';
// Vendedor cadastra produto mas não vê nem lança movimentação.
const NIVEIS = { produtos: 'rw', produtos_movimentacao: '--' };

const app = express();
app.use(express.json());
app.use('/api', crudRouter);

const AUTH_VENDEDOR = `Bearer ${jwt.sign(
  { id: 999999, schemas: [SCHEMA], roles: { [SCHEMA]: 'vendedor' }, lojas: { [SCHEMA]: 7 }, vendedores: {} },
  process.env.JWT_SECRET
)}`;

beforeAll(async () => {
  await pool.query('DELETE FROM public.sync_tenants WHERE schema_name = $1', [SCHEMA]);
  await pool.query(
    'INSERT INTO public.sync_tenants (token, schema_name, nome, plano) VALUES ($1, $2, $3, $4)',
    ['TOKEN_TESTE_PROD_IMPLANTACAO', SCHEMA, 'Empresa Teste Implantação', 'LITE1']
  );
  await initializeTenantSchema(SCHEMA);
  await pool.query(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.produtos (
    srv_id INTEGER PRIMARY KEY, id_produto INTEGER, codigo TEXT, descricao TEXT,
    saldo_atual NUMERIC(15,3), id_ultima_atualizacao_matriz INTEGER)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.movimentacoes (
    srv_id INTEGER PRIMARY KEY, id_movimentacao INTEGER, id_produto INTEGER, tipo_movimentacao TEXT,
    data TEXT, hora TEXT, quantidade NUMERIC(15,3), saldo_anterior NUMERIC(15,3), saldo_atual NUMERIC(15,3),
    usuario TEXT, origem_lancamento TEXT, id_loja INTEGER, id_ultima_atualizacao_matriz INTEGER)`);
  await fixarOverrides(SCHEMA, 'vendedor', NIVEIS);
}, 30000);

afterAll(async () => {
  await limparOverrides(SCHEMA, 'vendedor', Object.keys(NIVEIS));
  await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await pool.query('DELETE FROM public.sync_tenants WHERE schema_name = $1', [SCHEMA]);
  await pool.end();
});

const movimentacoesDo = async srvId =>
  (await pool.query(`SELECT * FROM ${SCHEMA}.movimentacoes WHERE id_produto = $1`, [srvId])).rows;

test('sem permissão de movimentação o vendedor não lança movimentação direto', async () => {
  const res = await request(app)
    .post(`/api/${SCHEMA}/tabelas/MOVIMENTACOES`)
    .set('Authorization', AUTH_VENDEDOR)
    .send({ pk: 'ID_MOVIMENTACAO', registro: { ID_MOVIMENTACAO: 999, ID_PRODUTO: 1, QUANTIDADE: 5 } });
  expect(res.status).toBe(403);
});

test('vendedor cadastra produto e o servidor grava a Implantação e o saldo 0', async () => {
  const res = await request(app)
    .post(`/api/${SCHEMA}/tabelas/PRODUTOS`)
    .set('Authorization', AUTH_VENDEDOR)
    .send({ pk: 'SRV_ID', registro: { ID_PRODUTO: 10, CODIGO: 'P10', DESCRICAO: 'Produto Implantação' } });
  expect(res.status).toBe(200);
  const srvId = res.body.srvId;
  expect(srvId).toBeTruthy();

  const movs = await movimentacoesDo(srvId);
  expect(movs).toHaveLength(1);
  expect(movs[0]).toMatchObject({ tipo_movimentacao: 'Implantação', origem_lancamento: 'Web', id_loja: 7 });
  expect(Number(movs[0].quantidade)).toBe(0);
  expect(movs[0].srv_id).not.toBeNull();
  expect(movs[0].id_ultima_atualizacao_matriz).not.toBeNull(); // desce para as lojas no pull
  expect(movs[0].data).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(movs[0].hora).toMatch(/^\d{2}:\d{2}:\d{2}$/);

  const { rows: [prod] } = await pool.query(`SELECT saldo_atual FROM ${SCHEMA}.produtos WHERE srv_id = $1`, [srvId]);
  expect(Number(prod.saldo_atual)).toBe(0);
});

test('editar o produto não cria outra Implantação', async () => {
  const novo = await request(app)
    .post(`/api/${SCHEMA}/tabelas/PRODUTOS`)
    .set('Authorization', AUTH_VENDEDOR)
    .send({ pk: 'SRV_ID', registro: { ID_PRODUTO: 11, CODIGO: 'P11', DESCRICAO: 'Antes' } });
  const srvId = novo.body.srvId;

  const edit = await request(app)
    .put(`/api/${SCHEMA}/tabelas/PRODUTOS`)
    .set('Authorization', AUTH_VENDEDOR)
    .send({ pk: 'SRV_ID', registro: { SRV_ID: srvId, DESCRICAO: 'Depois' } });
  expect(edit.status).toBe(200);
  expect(await movimentacoesDo(srvId)).toHaveLength(1);
});
