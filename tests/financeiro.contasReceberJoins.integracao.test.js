// GET contas-receber deve trazer vendedor/condição de pagamento (JOIN em VENDEDORES/
// AUX_PARCELAS_PAGAMENTOS) e cair pra NULL, não 500, se essas tabelas não existirem ainda.
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const financeiroRouter = require('../src/routes/financeiro');
const { pool } = require('../src/db');
const { initializeTenantSchema } = require('../src/db-init');

const SCHEMA_COM      = 'empresa_teste_fin_joins_com';
const SCHEMA_SEM      = 'empresa_teste_fin_joins_sem';

const app = express();
app.use(express.json());
app.use('/api', financeiroRouter);

function authDono(schema) {
  return `Bearer ${jwt.sign(
    { id: 999999, nome: 'Teste', schemas: [schema], roles: { [schema]: 'dono' }, lojas: {}, vendedores: {}, planos: {} },
    process.env.JWT_SECRET
  )}`;
}

async function provisionarSchema(schema, { comTabelasAuxiliares }) {
  await initializeTenantSchema(schema);
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO ${schema}, public`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS a_receber (
        srv_id INTEGER PRIMARY KEY, id_a_receber NUMERIC, descricao TEXT, id_cliente INTEGER, id_pedido INTEGER,
        valor NUMERIC(12,2), vencimento DATE, data_realizado DATE, status TEXT,
        id_forma_de_pagamento INTEGER, parcela INTEGER, observacao TEXT, id_loja INTEGER,
        id_vendedor NUMERIC, id_condicao_pagamento NUMERIC
      )`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS clientes (
        srv_id INTEGER PRIMARY KEY, razao_social TEXT, fantasia TEXT
      )`);
    if (comTabelasAuxiliares) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS vendedores (
          id_vendedor NUMERIC PRIMARY KEY, nome TEXT
        )`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS aux_parcelas_pagamentos (
          id_aux_parcela_pagamento NUMERIC PRIMARY KEY, descricao TEXT
        )`);
    }
  } finally {
    await client.query('SET search_path TO public');
    client.release();
  }
  await pool.query('DELETE FROM public.sync_tenants WHERE schema_name = $1', [schema]);
  await pool.query(
    'INSERT INTO public.sync_tenants (token, schema_name, nome, plano) VALUES ($1, $2, $3, $4)',
    [`TOKEN_${schema}`, schema, schema, 'SAFIRA1']
  );
}

beforeAll(async () => {
  await provisionarSchema(SCHEMA_COM, { comTabelasAuxiliares: true });
  await provisionarSchema(SCHEMA_SEM, { comTabelasAuxiliares: false });

  // Schemas de teste já podem existir de uma execução anterior (initializeTenantSchema
  // usa CREATE TABLE IF NOT EXISTS — não recria do zero) — limpa antes de semear.
  await pool.query(`TRUNCATE TABLE ${SCHEMA_COM}.a_receber, ${SCHEMA_COM}.vendedores, ${SCHEMA_COM}.aux_parcelas_pagamentos`);
  await pool.query(`TRUNCATE TABLE ${SCHEMA_SEM}.a_receber`);

  await pool.query(`INSERT INTO ${SCHEMA_COM}.vendedores (id_vendedor, nome) VALUES (42, 'Fulano de Tal')`);
  await pool.query(`INSERT INTO ${SCHEMA_COM}.aux_parcelas_pagamentos (id_aux_parcela_pagamento, descricao) VALUES (7, '30/60/90 dias')`);
  await pool.query(`
    INSERT INTO ${SCHEMA_COM}.a_receber (srv_id, descricao, valor, vencimento, status, id_vendedor, id_condicao_pagamento)
    VALUES (1, 'Lançamento antigo sincronizado', 500, '2026-01-01', 'Pendente', 42, 7)
  `);
  await pool.query(`
    INSERT INTO ${SCHEMA_SEM}.a_receber (srv_id, descricao, valor, vencimento, status, id_vendedor, id_condicao_pagamento)
    VALUES (1, 'Lançamento sem tabelas auxiliares sincronizadas', 500, '2026-01-01', 'Pendente', 42, 7)
  `);
}, 30000);

afterAll(async () => {
  for (const schema of [SCHEMA_COM, SCHEMA_SEM]) {
    await pool.query('DELETE FROM public.sync_tenants WHERE schema_name = $1', [schema]);
  }
  await pool.end();
});

describe('GET contas-receber — vendedor e condição de pagamento', () => {
  test('traz nome do vendedor e descrição da condição de pagamento quando as tabelas existem', async () => {
    const res = await request(app)
      .get(`/api/${SCHEMA_COM}/financeiro/contas-receber`)
      .set('Authorization', authDono(SCHEMA_COM));

    expect(res.status).toBe(200);
    const reg = res.body.registros.find(r => r.id === 1);
    expect(reg.vendedor).toBe('Fulano de Tal');
    expect(reg.condicao_pagamento).toBe('30/60/90 dias');
  });

  test('cai pra vendedor/condicao_pagamento nulos (não 500) quando o tenant nunca sincronizou essas tabelas', async () => {
    const res = await request(app)
      .get(`/api/${SCHEMA_SEM}/financeiro/contas-receber`)
      .set('Authorization', authDono(SCHEMA_SEM));

    expect(res.status).toBe(200);
    const reg = res.body.registros.find(r => r.id === 1);
    expect(reg).toBeDefined();
    expect(reg.vendedor).toBeNull();
    expect(reg.condicao_pagamento).toBeNull();
  });
});
