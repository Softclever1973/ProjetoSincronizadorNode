/**
 * Testes de integração da Fase 2: contra Postgres real (schema empresa_teste no mesmo
 * banco de dev configurado em .env), diferente dos testes de mock das Fases 0/1.
 * Exercita crud.js/handleSave: sequência SRV_ID, unicidade via SELECT prévio, e as
 * regras de transição de status de PEDIDOS que dependem de estado real no banco.
 */
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { pool } = require('../src/db');
const crudRouter = require('../src/routes/resources/crud');
const { TEST_SCHEMA, setupTestSchema, truncateTestSchema } = require('./helpers/testSchema');

const app = express();
app.use(express.json());
app.use('/api', crudRouter);

function tokenPara(role) {
  return jwt.sign(
    { id: 999999, nome: 'Teste', schemas: [TEST_SCHEMA], roles: { [TEST_SCHEMA]: role }, lojas: {}, vendedores: {} },
    process.env.JWT_SECRET
  );
}
const AUTH_DONO = `Bearer ${tokenPara('dono')}`;

beforeAll(async () => {
  await setupTestSchema();
}, 30000);

beforeEach(async () => {
  await truncateTestSchema();
});

afterAll(async () => {
  await pool.end();
});

describe('PEDIDOS — transições de status (crud.js:401-424)', () => {
  test('Realizado não pode ir direto para Cancelado', async () => {
    await pool.query(
      `INSERT INTO ${TEST_SCHEMA}.pedidos (id_pedido, id_cliente, status) VALUES (1, 1, 'R')`
    );

    const res = await request(app)
      .put(`/api/${TEST_SCHEMA}/tabelas/PEDIDOS`)
      .set('Authorization', AUTH_DONO)
      .send({ pk: 'ID_PEDIDO', registro: { ID_PEDIDO: 1, STATUS: 'C' } });

    expect(res.status).toBe(400);
    expect(res.body.erro).toMatch(/volte para pendente primeiro/);

    const [row] = (await pool.query(`SELECT status FROM ${TEST_SCHEMA}.pedidos WHERE id_pedido = 1`)).rows;
    expect(row.status).toBe('R'); // nada foi alterado no banco
  });

  test('Realizado não pode voltar a Pendente se já existe parcela paga', async () => {
    await pool.query(`INSERT INTO ${TEST_SCHEMA}.pedidos (id_pedido, id_cliente, status) VALUES (2, 1, 'R')`);
    await pool.query(
      `INSERT INTO ${TEST_SCHEMA}.pedidos_parcelas_pagamentos (id_pedido, parcela, valor, status) VALUES (2, 1, 100, 'R')`
    );

    const res = await request(app)
      .put(`/api/${TEST_SCHEMA}/tabelas/PEDIDOS`)
      .set('Authorization', AUTH_DONO)
      .send({ pk: 'ID_PEDIDO', registro: { ID_PEDIDO: 2, STATUS: 'P' } });

    expect(res.status).toBe(400);
    expect(res.body.erro).toMatch(/já existe pagamento registrado/);
  });

  test('Realizado pode voltar a Pendente quando não há parcela paga', async () => {
    await pool.query(`INSERT INTO ${TEST_SCHEMA}.pedidos (id_pedido, id_cliente, status) VALUES (3, 1, 'R')`);

    const res = await request(app)
      .put(`/api/${TEST_SCHEMA}/tabelas/PEDIDOS`)
      .set('Authorization', AUTH_DONO)
      .send({ pk: 'ID_PEDIDO', registro: { ID_PEDIDO: 3, STATUS: 'P' } });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const [row] = (await pool.query(`SELECT status FROM ${TEST_SCHEMA}.pedidos WHERE id_pedido = 3`)).rows;
    expect(row.status).toBe('P');
  });

  test('Pedido cancelado não pode ser editado de jeito nenhum', async () => {
    await pool.query(`INSERT INTO ${TEST_SCHEMA}.pedidos (id_pedido, id_cliente, status) VALUES (4, 1, 'C')`);

    const res = await request(app)
      .put(`/api/${TEST_SCHEMA}/tabelas/PEDIDOS`)
      .set('Authorization', AUTH_DONO)
      .send({ pk: 'ID_PEDIDO', registro: { ID_PEDIDO: 4, ID_CLIENTE: 2 } }); // nem tenta mudar STATUS

    expect(res.status).toBe(400);
    expect(res.body.erro).toMatch(/Pedido cancelado não pode ser editado/);
  });
});

describe('CLIENTES — unicidade de CPF/CNPJ contra o banco real (crud.js:454-474)', () => {
  const clienteBase = {
    RAZAO_SOCIAL: 'Cliente Teste',
    FANTASIA: 'Cliente Teste',
    PESSOA_P_CONTATO: 'Fulano',
    CONSUMIDOR_FINAL: 'N',
  };

  test('bloqueia CPF duplicado mesmo com formatação diferente (regexp_replace ignora pontuação)', async () => {
    const criarA = await request(app)
      .post(`/api/${TEST_SCHEMA}/tabelas/CLIENTES`)
      .set('Authorization', AUTH_DONO)
      .send({ pk: 'SRV_ID', registro: { ...clienteBase, CPF: '111.111.111-11' } });
    expect(criarA.status).toBe(200);
    expect(criarA.body.srvId).not.toBeNull();

    const criarB = await request(app)
      .post(`/api/${TEST_SCHEMA}/tabelas/CLIENTES`)
      .set('Authorization', AUTH_DONO)
      .send({ pk: 'SRV_ID', registro: { ...clienteBase, CPF: '11111111111' } }); // mesmos dígitos, sem pontuação

    expect(criarB.status).toBe(400);
    expect(criarB.body.erro).toMatch(/CPF já está cadastrado/);
  });

  test('permite editar o próprio cliente mantendo o mesmo CPF (exclusão via SRV_ID != $2)', async () => {
    const criar = await request(app)
      .post(`/api/${TEST_SCHEMA}/tabelas/CLIENTES`)
      .set('Authorization', AUTH_DONO)
      .send({ pk: 'SRV_ID', registro: { ...clienteBase, CPF: '22222222222' } });
    const srvId = criar.body.srvId;

    const editar = await request(app)
      .put(`/api/${TEST_SCHEMA}/tabelas/CLIENTES`)
      .set('Authorization', AUTH_DONO)
      .send({ pk: 'SRV_ID', registro: { ...clienteBase, SRV_ID: srvId, CPF: '22222222222', FANTASIA: 'Nome Atualizado' } });

    expect(editar.status).toBe(200);
  });

  test('CNPJ duplicado é bloqueado independente de já existir um CPF diferente cadastrado', async () => {
    await request(app)
      .post(`/api/${TEST_SCHEMA}/tabelas/CLIENTES`)
      .set('Authorization', AUTH_DONO)
      .send({ pk: 'SRV_ID', registro: { ...clienteBase, CNPJ: '11222333000181' } });

    const res = await request(app)
      .post(`/api/${TEST_SCHEMA}/tabelas/CLIENTES`)
      .set('Authorization', AUTH_DONO)
      .send({ pk: 'SRV_ID', registro: { ...clienteBase, CNPJ: '11.222.333/0001-81' } });

    expect(res.status).toBe(400);
    expect(res.body.erro).toMatch(/CNPJ já está cadastrado/);
  });
});

describe('PRODUTOS — SRV_ID alocado por sequência real (crud.js:511-533)', () => {
  test('dois produtos criados em sequência recebem SRV_ID distintos e crescentes', async () => {
    const p1 = await request(app)
      .post(`/api/${TEST_SCHEMA}/tabelas/PRODUTOS`)
      .set('Authorization', AUTH_DONO)
      .send({ pk: 'SRV_ID', registro: { CODIGO: 'A1', NOME: 'Produto 1' } });
    const p2 = await request(app)
      .post(`/api/${TEST_SCHEMA}/tabelas/PRODUTOS`)
      .set('Authorization', AUTH_DONO)
      .send({ pk: 'SRV_ID', registro: { CODIGO: 'A2', NOME: 'Produto 2' } });

    expect(p1.status).toBe(200);
    expect(p2.status).toBe(200);
    expect(Number(p2.body.srvId)).toBeGreaterThan(Number(p1.body.srvId));
  });

  test('sequência avança além de um SRV_ID pré-existente inserido fora do fluxo normal (drift do push de sync)', async () => {
    // Simula o cenário real: o Firebird reenvia um registro que já tem SRV_ID atribuído
    // (ramo srvIdFilial em sincronizacao.js), inserido direto sem passar pela sequência.
    await pool.query(`INSERT INTO ${TEST_SCHEMA}.produtos (srv_id, codigo, nome) VALUES (500, 'PRE', 'Pré-existente')`);

    const res = await request(app)
      .post(`/api/${TEST_SCHEMA}/tabelas/PRODUTOS`)
      .set('Authorization', AUTH_DONO)
      .send({ pk: 'SRV_ID', registro: { CODIGO: 'NOVO', NOME: 'Novo Produto' } });

    expect(res.status).toBe(200);
    expect(Number(res.body.srvId)).toBeGreaterThan(500); // não colide com o SRV_ID pré-existente
  });

  test('CODIGO duplicado é bloqueado quando sync_config.codigo_interno_unico = S', async () => {
    // db-init.js não semeia 'codigo_interno_unico' por padrão (só chega via sync do Firebird)
    // — schema recém-criado não tem essa linha, então UPDATE não bastaria; precisa de upsert.
    await pool.query(`
      INSERT INTO ${TEST_SCHEMA}.sync_config (chave, valor) VALUES ('codigo_interno_unico', 'S')
      ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor
    `);

    await request(app)
      .post(`/api/${TEST_SCHEMA}/tabelas/PRODUTOS`)
      .set('Authorization', AUTH_DONO)
      .send({ pk: 'SRV_ID', registro: { CODIGO: 'DUP1', NOME: 'Original' } });

    const res = await request(app)
      .post(`/api/${TEST_SCHEMA}/tabelas/PRODUTOS`)
      .set('Authorization', AUTH_DONO)
      .send({ pk: 'SRV_ID', registro: { CODIGO: 'dup1', NOME: 'Duplicado (case diferente)' } }); // UPPER(TRIM()) ignora caixa

    expect(res.status).toBe(400);
    expect(res.body.erro).toMatch(/já está em uso por outro produto/);
  });

  test('CODIGO duplicado é permitido quando sync_config.codigo_interno_unico != S', async () => {
    await pool.query(`
      INSERT INTO ${TEST_SCHEMA}.sync_config (chave, valor) VALUES ('codigo_interno_unico', 'N')
      ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor
    `);

    await request(app)
      .post(`/api/${TEST_SCHEMA}/tabelas/PRODUTOS`)
      .set('Authorization', AUTH_DONO)
      .send({ pk: 'SRV_ID', registro: { CODIGO: 'DUP2', NOME: 'Original' } });

    const res = await request(app)
      .post(`/api/${TEST_SCHEMA}/tabelas/PRODUTOS`)
      .set('Authorization', AUTH_DONO)
      .send({ pk: 'SRV_ID', registro: { CODIGO: 'DUP2', NOME: 'Permitido' } });

    expect(res.status).toBe(200);
  });
});

describe('Vendedor — escrita liberada só em PEDIDOS e subtabelas (checkRole.js: requireRoleOuVendedorEm)', () => {
  const AUTH_VENDEDOR = `Bearer ${tokenPara('vendedor')}`;

  test('vendedor consegue criar um pedido', async () => {
    const res = await request(app)
      .post(`/api/${TEST_SCHEMA}/tabelas/PEDIDOS`)
      .set('Authorization', AUTH_VENDEDOR)
      .send({ pk: 'ID_PEDIDO', registro: { ID_PEDIDO: 5001, ID_CLIENTE: 1, STATUS: 'P' } });

    expect(res.status).toBe(200);
  });

  test('vendedor consegue editar um pedido que ele mesmo criou', async () => {
    await pool.query(`INSERT INTO ${TEST_SCHEMA}.pedidos (id_pedido, id_cliente, status) VALUES (5002, 1, 'P')`);

    const res = await request(app)
      .put(`/api/${TEST_SCHEMA}/tabelas/PEDIDOS`)
      .set('Authorization', AUTH_VENDEDOR)
      .send({ pk: 'ID_PEDIDO', registro: { ID_PEDIDO: 5002, STATUS: 'R' } });

    expect(res.status).toBe(200);
  });

  test('vendedor consegue excluir uma parcela de pagamento (PEDIDOS_PARCELAS_PAGAMENTOS, PK composta)', async () => {
    await pool.query(`INSERT INTO ${TEST_SCHEMA}.pedidos (id_pedido, id_cliente, status) VALUES (5003, 1, 'P')`);
    await pool.query(`INSERT INTO ${TEST_SCHEMA}.pedidos_parcelas_pagamentos (id_pedido, parcela, valor) VALUES (5003, 1, 100)`);

    const res = await request(app)
      .delete(`/api/${TEST_SCHEMA}/tabelas/PEDIDOS_PARCELAS_PAGAMENTOS`)
      .set('Authorization', AUTH_VENDEDOR)
      .send({ pk: ['ID_PEDIDO', 'PARCELA'], pkValores: [5003, 1] });

    expect(res.status).toBe(200);
  });

  test('vendedor NÃO consegue criar/editar PRODUTOS (fora do Set liberado)', async () => {
    const res = await request(app)
      .post(`/api/${TEST_SCHEMA}/tabelas/PRODUTOS`)
      .set('Authorization', AUTH_VENDEDOR)
      .send({ pk: 'SRV_ID', registro: { CODIGO: 'VEND1', NOME: 'Tentativa vendedor' } });

    expect(res.status).toBe(403);
  });

  test('vendedor NÃO consegue excluir CLIENTES', async () => {
    await pool.query(`INSERT INTO ${TEST_SCHEMA}.clientes (srv_id, id_cliente, razao_social) VALUES (1, 1, 'Cliente Teste')`);

    const res = await request(app)
      .delete(`/api/${TEST_SCHEMA}/tabelas/CLIENTES`)
      .set('Authorization', AUTH_VENDEDOR)
      .send({ pk: 'SRV_ID', pkValores: [1] });

    expect(res.status).toBe(403);
  });
});
