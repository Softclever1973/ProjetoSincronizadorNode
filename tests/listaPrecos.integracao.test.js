// Lista de preços: vincular produto pelo CRUD (PRECO calculado no servidor, sem duplicar, só gerente/dono) e rotas de leitura.
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { pool } = require('../src/server/infrastructure/db');
const { initializeDatabase, initializeTenantSchema } = require('../src/server/infrastructure/db-init');
const apiRouter = require('../src/server/interfaces/http/routes/api');
const { calcularPrecoLista } = require('../src/server/domain/listaPrecos');
const { fixarOverrides, limparOverrides } = require('./helpers/permissoesReais');

const SCHEMA = 'empresa_teste_lista_precos';

const app = express();
app.use(express.json());
app.use('/api', apiRouter);

const tokenPara = role => `Bearer ${jwt.sign(
  { id: 999998, schemas: [SCHEMA], roles: { [SCHEMA]: role }, lojas: { [SCHEMA]: 1 }, vendedores: {} },
  process.env.JWT_SECRET
)}`;

const vincular = (role, registro) => request(app)
  .post(`/api/${SCHEMA}/tabelas/PRODUTOS_X_LISTA`)
  .set('Authorization', tokenPara(role))
  .send({ pk: ['ID_PRODUTO_X_LISTA'], registro });

beforeAll(async () => {
  await initializeDatabase();
  await pool.query('DELETE FROM public.sync_tenants WHERE schema_name = $1', [SCHEMA]);
  await pool.query(
    'INSERT INTO public.sync_tenants (token, schema_name, nome, plano) VALUES ($1, $2, $3, $4)',
    ['TOKEN_TESTE_LISTA_PRECOS', SCHEMA, 'Empresa Teste Lista de Preços', 'LITE1']
  );
  await initializeTenantSchema(SCHEMA);
  // Níveis fixados só neste schema (a matriz global é editável pelo superadmin).
  await fixarOverrides(SCHEMA, 'vendedor', { lista_precos: 'r-' });
  await fixarOverrides(SCHEMA, 'gerente', { lista_precos: 'rw' });
  await fixarOverrides(SCHEMA, 'dono', { lista_precos: 'rw' });
  const s = SCHEMA;
  await pool.query(`CREATE TABLE ${s}.lista_precos (id_lista NUMERIC PRIMARY KEY, descricao TEXT, percentual_de_comissao NUMERIC, percentual_ou_valor TEXT,
    mostrar_no_relatorio TEXT, acrescimo_ou_reducao TEXT, percentual_comissao_repres NUMERIC, percentual_comissao_superv NUMERIC,
    percentual_de_comissao_gerente NUMERIC, percentual_acrescimo_reducao NUMERIC, id_ultima_atualizacao_matriz INTEGER)`);
  await pool.query(`CREATE TABLE ${s}.produtos (id_produto INTEGER PRIMARY KEY, codigo TEXT, descricao TEXT, unidade TEXT, preco_venda NUMERIC(15,2))`);
  await pool.query(`CREATE TABLE ${s}.produtos_x_lista (srv_id INTEGER PRIMARY KEY, id_produto_x_lista NUMERIC, id_lista NUMERIC, id_produto NUMERIC, preco NUMERIC, id_ultima_atualizacao_matriz INTEGER)`);
  await pool.query(`INSERT INTO ${s}.lista_precos (id_lista, descricao, percentual_acrescimo_reducao, percentual_ou_valor)
    VALUES (1, 'FABRICANTE', -11.5, 'P   '), (2, 'REP', 5, 'V')`);
  await pool.query(`INSERT INTO ${s}.produtos VALUES (10, 'P10', 'Parafuso', 'UN', 229), (20, 'P20', 'Porca', 'UN', 50)`);
}, 30000);

afterAll(async () => {
  for (const role of ['vendedor', 'gerente', 'dono']) await limparOverrides(SCHEMA, role, ['lista_precos']);
  await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await pool.query('DELETE FROM public.sync_tenants WHERE schema_name = $1', [SCHEMA]);
  await pool.end();
});

test.each([
  ['229', { PERCENTUAL_ACRESCIMO_REDUCAO: '-6.00', PERCENTUAL_OU_VALOR: 'P   ' }, 215.26],
  ['100', { PERCENTUAL_ACRESCIMO_REDUCAO: '10', PERCENTUAL_OU_VALOR: 'P' }, 110],
  ['229', { PERCENTUAL_ACRESCIMO_REDUCAO: '-10', PERCENTUAL_OU_VALOR: 'V' }, 219],
  ['5',   { PERCENTUAL_ACRESCIMO_REDUCAO: '-10', PERCENTUAL_OU_VALOR: 'V' }, 0],
])('calcularPrecoLista(%s, %o) = %d', (preco, lista, esperado) => {
  expect(calcularPrecoLista(preco, lista)).toBe(esperado);
});

test('gerente vincula produto e o PRECO é calculado no servidor (ignora o enviado)', async () => {
  const res = await vincular('gerente', { ID_PRODUTO_X_LISTA: 1, ID_LISTA: 1, ID_PRODUTO: 10, PRECO: 1 });
  expect(res.status).toBe(200);
  const { rows } = await pool.query(`SELECT preco, srv_id, id_ultima_atualizacao_matriz FROM ${SCHEMA}.produtos_x_lista WHERE id_produto_x_lista = 1`);
  expect(Number(rows[0].preco)).toBe(202.67); // 229 − 11,5%
  expect(rows[0].srv_id).not.toBeNull();
  expect(rows[0].id_ultima_atualizacao_matriz).not.toBeNull(); // entra no pull das filiais
});

test('mesmo produto não entra duas vezes na mesma lista', async () => {
  const res = await vincular('dono', { ID_PRODUTO_X_LISTA: 2, ID_LISTA: 1, ID_PRODUTO: 10 });
  expect(res.status).toBe(400);
  expect(res.body.erro).toMatch(/já está nesta lista/);
});

test('lista ou produto inexistente é recusado', async () => {
  expect((await vincular('dono', { ID_PRODUTO_X_LISTA: 3, ID_LISTA: 99, ID_PRODUTO: 10 })).body.erro).toMatch(/Lista de preço não encontrada/);
  expect((await vincular('dono', { ID_PRODUTO_X_LISTA: 3, ID_LISTA: 1, ID_PRODUTO: 99 })).body.erro).toMatch(/Produto não encontrado/);
});

test('vendedor só lê: não vincula nem remove', async () => {
  expect((await vincular('vendedor', { ID_PRODUTO_X_LISTA: 4, ID_LISTA: 2, ID_PRODUTO: 20 })).status).toBe(403);
  const del = await request(app).delete(`/api/${SCHEMA}/tabelas/PRODUTOS_X_LISTA`)
    .set('Authorization', tokenPara('vendedor')).send({ pk: ['ID_PRODUTO_X_LISTA'], pkValores: [1] });
  expect(del.status).toBe(403);
  const lista = await request(app).get(`/api/${SCHEMA}/listas-precos`).set('Authorization', tokenPara('vendedor'));
  expect(lista.status).toBe(200);
});

test('GET /listas-precos traz a quantidade de produtos e /:id/produtos faz o JOIN com busca', async () => {
  await vincular('dono', { ID_PRODUTO_X_LISTA: 5, ID_LISTA: 2, ID_PRODUTO: 20 });
  const listas = await request(app).get(`/api/${SCHEMA}/listas-precos`).set('Authorization', tokenPara('gerente'));
  expect(listas.body.map(l => [Number(l.ID_LISTA), l.QTD_PRODUTOS])).toEqual([[1, 1], [2, 1]]);

  const prod = await request(app).get(`/api/${SCHEMA}/listas-precos/2/produtos?q=porc`).set('Authorization', tokenPara('gerente'));
  expect(prod.body.total).toBe(1);
  expect(prod.body.registros[0]).toMatchObject({ DESCRICAO: 'Porca', CODIGO: 'P20' });
  expect(Number(prod.body.registros[0].PRECO)).toBe(55); // 50 + R$ 5,00

  const vazio = await request(app).get(`/api/${SCHEMA}/listas-precos/2/produtos?q=parafuso`).set('Authorization', tokenPara('gerente'));
  expect(vazio.body.total).toBe(0);
});

const salvarLista = (role, registro, metodo = 'post') => request(app)[metodo](`/api/${SCHEMA}/tabelas/LISTA_PRECOS`)
  .set('Authorization', tokenPara(role)).send({ pk: ['ID_LISTA'], registro });

describe('criar e editar lista', () => {
  test('gerente cria lista: A/R vem do sinal, valores normalizados, entra no pull das filiais', async () => {
    const res = await salvarLista('gerente', {
      ID_LISTA: 3, DESCRICAO: '  ATACADO  ', PERCENTUAL_OU_VALOR: 'p', PERCENTUAL_ACRESCIMO_REDUCAO: -7.556,
      ACRESCIMO_OU_REDUCAO: 'A', PERCENTUAL_DE_COMISSAO: 2, MOSTRAR_NO_RELATORIO: 's',
    });
    expect(res.status).toBe(200);
    const { rows: [l] } = await pool.query(`SELECT * FROM ${SCHEMA}.lista_precos WHERE id_lista = 3`);
    expect(l).toMatchObject({ descricao: 'ATACADO', percentual_ou_valor: 'P', acrescimo_ou_reducao: 'R', mostrar_no_relatorio: 'S' });
    expect(Number(l.percentual_acrescimo_reducao)).toBe(-7.56);
    expect(l.id_ultima_atualizacao_matriz).not.toBeNull();
  });

  test.each([
    [{ ID_LISTA: 4, DESCRICAO: '' }, /descrição/],
    [{ ID_LISTA: 4, DESCRICAO: 'X', PERCENTUAL_OU_VALOR: 'Z' }, /Tipo inválido/],
    [{ ID_LISTA: 4, DESCRICAO: 'X', PERCENTUAL_ACRESCIMO_REDUCAO: 1000 }, /Ajuste/],
    [{ ID_LISTA: 4, DESCRICAO: 'X', PERCENTUAL_DE_COMISSAO: -1 }, /não pode ser negativa/],
  ])('recusa cadastro inválido %o', async (registro, msg) => {
    const res = await salvarLista('dono', registro);
    expect(res.status).toBe(400);
    expect(res.body.erro).toMatch(msg);
  });

  test('vendedor não cria lista', async () => {
    expect((await salvarLista('vendedor', { ID_LISTA: 5, DESCRICAO: 'X' })).status).toBe(403);
  });

  test('editar o ajuste recalcula o PRECO dos produtos da lista; editar só a descrição não mexe', async () => {
    await vincular('dono', { ID_PRODUTO_X_LISTA: 30, ID_LISTA: 3, ID_PRODUTO: 20 }); // 50 − 7,56% = 46,22
    const preco = async () => Number((await pool.query(`SELECT preco FROM ${SCHEMA}.produtos_x_lista WHERE id_produto_x_lista = 30`)).rows[0].preco);
    expect(await preco()).toBe(46.22);

    await pool.query(`UPDATE ${SCHEMA}.produtos_x_lista SET preco = 1 WHERE id_produto_x_lista = 30`);
    expect((await salvarLista('gerente', { ID_LISTA: 3, DESCRICAO: 'ATACADO 2' }, 'put')).status).toBe(200);
    expect(await preco()).toBe(1);

    expect((await salvarLista('gerente', { ID_LISTA: 3, DESCRICAO: 'ATACADO 2', PERCENTUAL_OU_VALOR: 'V', PERCENTUAL_ACRESCIMO_REDUCAO: 10 }, 'put')).status).toBe(200);
    expect(await preco()).toBe(60); // 50 + R$ 10,00
    const { rows: [l] } = await pool.query(`SELECT acrescimo_ou_reducao FROM ${SCHEMA}.lista_precos WHERE id_lista = 3`);
    expect(l.acrescimo_ou_reducao).toBe('A');
  });
});

test('gerente remove o vínculo', async () => {
  const del = await request(app).delete(`/api/${SCHEMA}/tabelas/PRODUTOS_X_LISTA`)
    .set('Authorization', tokenPara('gerente')).send({ pk: ['ID_PRODUTO_X_LISTA'], pkValores: [5] });
  expect(del.status).toBe(200);
  const { rows } = await pool.query(`SELECT 1 FROM ${SCHEMA}.produtos_x_lista WHERE id_produto_x_lista = 5`);
  expect(rows).toHaveLength(0);
});
