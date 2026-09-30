// Gerente/vendedor só enxergam e alteram dados da loja do vínculo (JWT); dono vê todas.
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { pool } = require('../src/server/infrastructure/db');
const { initializeTenantSchema } = require('../src/server/infrastructure/db-init');
const crudRouter = require('../src/server/interfaces/http/routes/api/crud');
const financeiroRouter = require('../src/server/interfaces/http/routes/datasnap/financeiro');
const { fixarOverrides, limparOverrides } = require('./helpers/permissoesReais');

const SCHEMA = 'empresa_teste_escopo_loja';
const app = express();
app.use(express.json());
app.use('/api', crudRouter);
app.use('/api', financeiroRouter);

const token = (role, lojas) => `Bearer ${jwt.sign(
  { id: 999999, schemas: [SCHEMA], roles: { [SCHEMA]: role }, lojas, vendedores: {} }, process.env.JWT_SECRET)}`;
const GERENTE_LOJA1 = token('gerente', { [SCHEMA]: 1 });
const DONO = token('dono', {});
const NIVEIS = { pedidos: 'rw', pedidos_inserir: 'rw', pedidos_editar: 'rw', notas_fiscais: 'rw', financeiro: 'rw' };

const get = (caminho, auth = GERENTE_LOJA1) => request(app).get(`/api/${SCHEMA}/${caminho}`).set('Authorization', auth);
const ids = (r, col) => r.body.registros.map(x => Number(x[col])).sort();

beforeAll(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.query('DELETE FROM public.permissoes_empresa WHERE schema_name = $1', [SCHEMA]);
  await pool.query('DELETE FROM public.sync_tenants WHERE schema_name = $1', [SCHEMA]);
  await pool.query('INSERT INTO public.sync_tenants (token, schema_name, nome, plano) VALUES ($1, $2, $3, $4)',
    ['TOKEN_TESTE_ESCOPO_LOJA', SCHEMA, 'Teste escopo de loja', 'SAFIRA1']);
  await initializeTenantSchema(SCHEMA);
  for (const ddl of [
    'CREATE TABLE pedidos (id_pedido INTEGER PRIMARY KEY, id_loja INTEGER, status TEXT)',
    'CREATE TABLE pedidos_itens (id_pedido_item INTEGER PRIMARY KEY, id_pedido INTEGER, quantidade NUMERIC)',
    'CREATE TABLE notas_fiscais (id_nota_fiscal INTEGER PRIMARY KEY, id_loja INTEGER, serie TEXT)',
    'CREATE TABLE notas_fiscais_itens (id_nota_fiscal_item INTEGER PRIMARY KEY, id_nota_fiscal INTEGER, quantidade NUMERIC)',
    `CREATE TABLE a_receber (srv_id INTEGER PRIMARY KEY, id_a_receber NUMERIC, descricao TEXT, id_cliente INTEGER,
       valor NUMERIC(12,2), vencimento DATE, data_realizado DATE, status TEXT, id_forma_de_pagamento INTEGER,
       parcela INTEGER, observacao TEXT, id_loja INTEGER, id_vendedor NUMERIC, id_condicao_pagamento NUMERIC)`,
    'CREATE TABLE clientes (srv_id INTEGER PRIMARY KEY, razao_social TEXT, fantasia TEXT)',
    `INSERT INTO pedidos VALUES (1, 1, 'P'), (2, 2, 'P')`,
    'INSERT INTO pedidos_itens VALUES (11, 1, 1), (12, 2, 1)',
    `INSERT INTO notas_fiscais VALUES (1, 1, '1'), (2, 2, '1')`,
    'INSERT INTO notas_fiscais_itens VALUES (21, 1, 1), (22, 2, 1)',
    `INSERT INTO a_receber (srv_id, descricao, valor, vencimento, status, id_loja) VALUES
       (1, 'loja 1', 10, '2026-01-01', 'Pendente', 1), (2, 'loja 2', 20, '2026-01-01', 'Pendente', 2)`,
  ]) await pool.query(`SET search_path TO ${SCHEMA}; ${ddl}; SET search_path TO public`);
  await fixarOverrides(SCHEMA, 'gerente', NIVEIS);
}, 30000);

afterAll(async () => {
  await limparOverrides(SCHEMA, 'gerente', Object.keys(NIVEIS));
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.query('DELETE FROM public.sync_tenants WHERE schema_name = $1', [SCHEMA]);
  await pool.end();
});

describe('gerente da loja 1 — leitura', () => {
  test.each([
    ['PEDIDOS', 'ID_PEDIDO', [1]],
    ['PEDIDOS_ITENS', 'ID_PEDIDO_ITEM', [11]],
    ['NOTAS_FISCAIS', 'ID_NOTA_FISCAL', [1]],
    ['NOTAS_FISCAIS_ITENS', 'ID_NOTA_FISCAL_ITEM', [21]],
  ])('listagem de %s só traz a loja 1, mesmo pedindo filtroLoja=2', async (tabela, pk, esperado) => {
    const r = await get(`tabelas/${tabela}?filtroLoja=2`);
    expect(r.status).toBe(200);
    expect(ids(r, pk)).toEqual(esperado);
  });

  test('by-pk de nota da loja 2 responde null; da loja 1 traz o registro', async () => {
    expect((await get('tabelas/NOTAS_FISCAIS/by-pk?pk=ID_NOTA_FISCAL&value=2')).body).toBeNull();
    expect((await get('tabelas/NOTAS_FISCAIS/by-pk?pk=ID_NOTA_FISCAL&value=1')).body).toMatchObject({ ID_NOTA_FISCAL: 1 });
  });

  test('distinct só enxerga a loja 1', async () => {
    expect((await get('tabelas/NOTAS_FISCAIS/distinct/ID_LOJA')).body.map(Number)).toEqual([1]);
  });

  test('contas a receber só da loja 1, mesmo pedindo filtroLoja=2', async () => {
    const r = await get('financeiro/contas-receber?filtroLoja=2');
    expect(r.status).toBe(200);
    expect(r.body.registros.map(x => x.id)).toEqual([1]);
  });
});

describe('gerente da loja 1 — escrita', () => {
  const salvar = (metodo, tabela, pk, registro) => request(app)[metodo](`/api/${SCHEMA}/tabelas/${tabela}`)
    .set('Authorization', GERENTE_LOJA1).send({ pk, registro });

  test('editar pedido da loja 2 é recusado e não "rouba" o pedido pra loja 1', async () => {
    expect((await salvar('put', 'PEDIDOS', 'ID_PEDIDO', { ID_PEDIDO: 2, STATUS: 'P' })).status).toBe(403);
    const { rows } = await pool.query(`SELECT id_loja FROM ${SCHEMA}.pedidos WHERE id_pedido = 2`);
    expect(rows[0].id_loja).toBe(2);
  });

  test('editar pedido da própria loja continua funcionando', async () => {
    expect((await salvar('put', 'PEDIDOS', 'ID_PEDIDO', { ID_PEDIDO: 1, STATUS: 'P' })).status).toBe(200);
  });

  test('item novo em nota da loja 2 é recusado; na nota da loja 1 é aceito', async () => {
    expect((await salvar('post', 'NOTAS_FISCAIS_ITENS', 'ID_NOTA_FISCAL_ITEM', { ID_NOTA_FISCAL_ITEM: 23, ID_NOTA_FISCAL: 2, QUANTIDADE: 1 })).status).toBe(403);
    expect((await salvar('post', 'NOTAS_FISCAIS_ITENS', 'ID_NOTA_FISCAL_ITEM', { ID_NOTA_FISCAL_ITEM: 24, ID_NOTA_FISCAL: 1, QUANTIDADE: 1 })).status).toBe(200);
  });

  test('excluir item de pedido da loja 2 é recusado', async () => {
    const r = await request(app).delete(`/api/${SCHEMA}/tabelas/PEDIDOS_ITENS`).set('Authorization', GERENTE_LOJA1)
      .send({ pk: 'ID_PEDIDO_ITEM', pkValores: [12] });
    expect(r.status).toBe(403);
    expect((await pool.query(`SELECT 1 FROM ${SCHEMA}.pedidos_itens WHERE id_pedido_item = 12`)).rows).toHaveLength(1);
  });

  test('editar/excluir conta a receber da loja 2 é recusado', async () => {
    const patch = await request(app).patch(`/api/${SCHEMA}/financeiro/contas-receber/2`).set('Authorization', GERENTE_LOJA1).send({ descricao: 'x' });
    const del = await request(app).delete(`/api/${SCHEMA}/financeiro/contas-receber/2`).set('Authorization', GERENTE_LOJA1);
    expect([patch.status, del.status]).toEqual([403, 403]);
    const { rows } = await pool.query(`SELECT descricao FROM ${SCHEMA}.a_receber WHERE srv_id = 2`);
    expect(rows[0].descricao).toBe('loja 2');
  });
});

describe('dono e vínculo sem loja', () => {
  test('dono vê todas as lojas e pode filtrar', async () => {
    expect(ids(await get('tabelas/PEDIDOS', DONO), 'ID_PEDIDO')).toEqual([1, 2]);
    expect(ids(await get('tabelas/PEDIDOS?filtroLoja=2', DONO), 'ID_PEDIDO')).toEqual([2]);
  });

  test('gerente sem loja no vínculo não vê nada (em vez de ver tudo)', async () => {
    const semLoja = token('gerente', {});
    expect((await get('tabelas/PEDIDOS', semLoja)).status).toBe(403);
    expect((await get('financeiro/contas-receber', semLoja)).body.registros).toEqual([]);
  });
});
