// Status gravado em a_receber/a_pagar deve ficar em Title Case (convenção do Firebird legado).
// Cobre também as comparações que dependiam do valor minúsculo (cancelado, sync com pedido).
// Schema fictício próprio pra não colidir com TEST_SCHEMA nem outros testes de plano.
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const financeiroRouter = require('../src/routes/financeiro');
const { pool } = require('../src/server/infrastructure/db');
const { initializeTenantSchema } = require('../src/server/infrastructure/db-init');

const SCHEMA = 'empresa_teste_fin_status';

const app = express();
app.use(express.json());
app.use('/api', financeiroRouter);

const AUTH_DONO = `Bearer ${jwt.sign(
  { id: 999999, nome: 'Teste', schemas: [SCHEMA], roles: { [SCHEMA]: 'dono' }, lojas: {}, vendedores: {}, planos: {} },
  process.env.JWT_SECRET
)}`;

beforeAll(async () => {
  await initializeTenantSchema(SCHEMA);

  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO ${SCHEMA}, public`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS a_receber (
        srv_id INTEGER PRIMARY KEY, descricao TEXT, id_cliente INTEGER, id_pedido INTEGER,
        valor NUMERIC(12,2), vencimento DATE, data_realizado DATE, status TEXT,
        id_forma_de_pagamento INTEGER, parcela INTEGER, observacao TEXT, id_loja INTEGER,
        id_vendedor INTEGER
      )`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS a_pagar (
        srv_id INTEGER PRIMARY KEY, descricao TEXT, credor TEXT, id_fornecedor INTEGER,
        valor NUMERIC(12,2), vencimento DATE, data_realizado DATE, status TEXT,
        id_forma_de_pagamento INTEGER, observacao TEXT, id_loja INTEGER
      )`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS pedidos (
        id_pedido INTEGER PRIMARY KEY, id_cliente INTEGER, id_loja INTEGER, status TEXT
      )`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS pedidos_parcelas_pagamentos (
        id_pedido INTEGER, parcela INTEGER, valor NUMERIC(12,2), status TEXT,
        PRIMARY KEY (id_pedido, parcela)
      )`);
    await client.query(`ALTER TABLE a_receber ADD COLUMN IF NOT EXISTS proximo_dia_util DATE`);
    await client.query(`ALTER TABLE a_pagar ADD COLUMN IF NOT EXISTS proximo_dia_util DATE`);
  } finally {
    await client.query('SET search_path TO public');
    client.release();
  }

  await pool.query('DELETE FROM public.sync_tenants WHERE schema_name = $1', [SCHEMA]);
  await pool.query(
    'INSERT INTO public.sync_tenants (token, schema_name, nome, plano) VALUES ($1, $2, $3, $4)',
    ['TOKEN_TESTE_FIN_STATUS', SCHEMA, 'Empresa Teste Financeiro Status', 'SAFIRA1']
  );
}, 30000);

afterEach(async () => {
  await pool.query(`TRUNCATE TABLE ${SCHEMA}.a_receber, ${SCHEMA}.a_pagar, ${SCHEMA}.pedidos, ${SCHEMA}.pedidos_parcelas_pagamentos`);
});

afterAll(async () => {
  await pool.query('DELETE FROM public.sync_tenants WHERE schema_name = $1', [SCHEMA]);
  await pool.end();
});

async function statusBruto(tabela, srvId) {
  const { rows } = await pool.query(`SELECT status FROM ${SCHEMA}.${tabela} WHERE srv_id = $1`, [srvId]);
  return rows[0]?.status;
}

describe('POST — status gravado em Title Case', () => {
  test('contas a receber sem status explícito grava "Pendente"', async () => {
    const res = await request(app)
      .post(`/api/${SCHEMA}/financeiro/contas-receber`)
      .set('Authorization', AUTH_DONO)
      .send({ descricao: 'Teste CR', valor: 100, data_vencimento: '2026-01-01' });

    expect(res.status).toBe(201);
    // RETURNING do INSERT/UPDATE sempre devolveu o valor bruto (só o GET da listagem
    // normaliza via LOWER(...) — ver GET /contas-receber acima) — isso não muda aqui,
    // só o valor bruto em si passa a ser "Pendente" em vez de "pendente".
    expect(res.body.status).toBe('Pendente');
    expect(await statusBruto('a_receber', res.body.id)).toBe('Pendente');
  });

  test('contas a pagar com status "pago" (minúsculo, vindo do body) grava "Realizado"', async () => {
    const res = await request(app)
      .post(`/api/${SCHEMA}/financeiro/contas-pagar`)
      .set('Authorization', AUTH_DONO)
      .send({ descricao: 'Teste CP', valor: 50, data_vencimento: '2026-01-01', status: 'pago' });

    expect(res.status).toBe(201);
    expect(await statusBruto('a_pagar', res.body.id)).toBe('Realizado');
  });
});

describe('PATCH — status gravado em Title Case, guard de cancelado continua funcionando', () => {
  test('alterar pra "cancelado" grava "Cancelado", e depois bloqueia nova alteração de status', async () => {
    const criado = await request(app)
      .post(`/api/${SCHEMA}/financeiro/contas-pagar`)
      .set('Authorization', AUTH_DONO)
      .send({ descricao: 'Teste CP cancelar', valor: 50, data_vencimento: '2026-01-01' });
    const id = criado.body.id;

    const cancelado = await request(app)
      .patch(`/api/${SCHEMA}/financeiro/contas-pagar/${id}`)
      .set('Authorization', AUTH_DONO)
      .send({ status: 'cancelado' });
    expect(cancelado.status).toBe(200);
    expect(await statusBruto('a_pagar', id)).toBe('Cancelado');

    const tentativa = await request(app)
      .patch(`/api/${SCHEMA}/financeiro/contas-pagar/${id}`)
      .set('Authorization', AUTH_DONO)
      .send({ status: 'pago' });
    expect(tentativa.status).toBe(422);
  });
});

describe('PATCH contas-receber "recebido" — sincroniza PEDIDOS_PARCELAS_PAGAMENTOS e PEDIDOS (valor bruto Title Case)', () => {
  test('marcar como recebido fecha a parcela do pedido e realiza o pedido', async () => {
    await pool.query(`INSERT INTO ${SCHEMA}.pedidos (id_pedido, status) VALUES (7001, 'P')`);
    await pool.query(`INSERT INTO ${SCHEMA}.pedidos_parcelas_pagamentos (id_pedido, parcela, valor) VALUES (7001, 1, 100)`);
    await pool.query(`
      INSERT INTO ${SCHEMA}.a_receber (srv_id, descricao, valor, vencimento, status, id_pedido, observacao)
      VALUES (9001, 'Pedido #7001 - Parcela 1', 100, '2026-01-01', 'Pendente', 7001, 'pedido:7001:1')
    `);

    const res = await request(app)
      .patch(`/api/${SCHEMA}/financeiro/contas-receber/9001`)
      .set('Authorization', AUTH_DONO)
      .send({ status: 'recebido' });

    expect(res.status).toBe(200);
    expect(await statusBruto('a_receber', 9001)).toBe('Realizado');

    const { rows: [parcela] } = await pool.query(
      `SELECT status FROM ${SCHEMA}.pedidos_parcelas_pagamentos WHERE id_pedido = 7001 AND parcela = 1`
    );
    expect(parcela.status).toBe('R');

    const { rows: [pedido] } = await pool.query(`SELECT status FROM ${SCHEMA}.pedidos WHERE id_pedido = 7001`);
    expect(pedido.status).toBe('R');
  });
});

async function proximoDiaUtil(tabela, srvId) {
  const { rows } = await pool.query(
    `SELECT to_char(proximo_dia_util, 'YYYY-MM-DD') AS d FROM ${SCHEMA}.${tabela} WHERE srv_id = $1`, [srvId]
  );
  return rows[0]?.d;
}

describe('proximo_dia_util — calculado a partir do vencimento (fim de semana rola pra segunda)', () => {
  test('vencimento no sábado grava a segunda-feira seguinte', async () => {
    const res = await request(app)
      .post(`/api/${SCHEMA}/financeiro/contas-pagar`)
      .set('Authorization', AUTH_DONO)
      .send({ descricao: 'Vence sábado', valor: 10, data_vencimento: '2026-03-21' }); // sábado

    expect(res.status).toBe(201);
    expect(await proximoDiaUtil('a_pagar', res.body.id)).toBe('2026-03-23'); // segunda
  });

  test('vencimento em dia de semana grava a mesma data', async () => {
    const res = await request(app)
      .post(`/api/${SCHEMA}/financeiro/contas-pagar`)
      .set('Authorization', AUTH_DONO)
      .send({ descricao: 'Vence sexta', valor: 10, data_vencimento: '2026-03-06' }); // sexta

    expect(res.status).toBe(201);
    expect(await proximoDiaUtil('a_pagar', res.body.id)).toBe('2026-03-06');
  });

  test('PATCH que muda o vencimento recalcula proximo_dia_util', async () => {
    const criado = await request(app)
      .post(`/api/${SCHEMA}/financeiro/contas-receber`)
      .set('Authorization', AUTH_DONO)
      .send({ descricao: 'Recalcular', valor: 10, data_vencimento: '2026-03-06' }); // sexta

    const patch = await request(app)
      .patch(`/api/${SCHEMA}/financeiro/contas-receber/${criado.body.id}`)
      .set('Authorization', AUTH_DONO)
      .send({ data_vencimento: '2026-03-22' }); // domingo

    expect(patch.status).toBe(200);
    expect(await proximoDiaUtil('a_receber', criado.body.id)).toBe('2026-03-23'); // segunda
  });
});
