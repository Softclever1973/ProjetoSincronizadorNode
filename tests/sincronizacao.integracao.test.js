/**
 * Testes de integração (Fase 2) da rota POST /ReceberRegistro contra Postgres real —
 * reproduz exatamente a classe de bug do incidente real: reset-empresa.js (ou qualquer
 * outra causa) apaga uma sequência/tabela com o servidor no ar, deixando o cache em
 * memória do servidor desatualizado. Confirma que o retry embutido em sincronizacao.js
 * se recupera sozinho, sem intervenção manual.
 *
 * Usa tabelas com nomes exclusivos (PRODUTOS_SYNC_TESTE) para não colidir com as tabelas
 * pré-criadas por crud.integracao.test.js no mesmo schema empresa_teste.
 */
const express = require('express');
const request = require('supertest');

const { pool } = require('../src/db');
const sincronizacaoRouter = require('../src/routes/sincronizacao');
const { TEST_SCHEMA, TEST_TOKEN, setupTestSchema } = require('./helpers/testSchema');

const app = express();
app.use(express.json());
app.use('/datasnap/rest/TSMSincronizacao', sincronizacaoRouter);

function receberRegistro(body) {
  return request(app)
    .post('/datasnap/rest/TSMSincronizacao/ReceberRegistro')
    .query({ token: TEST_TOKEN, idLoja: 1 })
    .send(body);
}

beforeAll(async () => {
  await setupTestSchema();
  // Estado limpo exclusivo deste arquivo — não depende de execuções anteriores do
  // mesmo teste nem interfere com as tabelas de crud.integracao.test.js.
  await pool.query(`DROP TABLE IF EXISTS ${TEST_SCHEMA}.produtos_sync_teste CASCADE`);
  await pool.query(`DROP TABLE IF EXISTS ${TEST_SCHEMA}.a_receber CASCADE`);
  await pool.query(`DROP SEQUENCE IF EXISTS ${TEST_SCHEMA}.seq_srv_id_produtos_sync_teste`);
  await pool.query(`DROP SEQUENCE IF EXISTS ${TEST_SCHEMA}.seq_srv_id_a_receber`);
  await pool.query(`DELETE FROM ${TEST_SCHEMA}.srv_id_map WHERE tabela IN ('PRODUTOS_SYNC_TESTE', 'A_RECEBER')`);
}, 30000);

afterAll(async () => {
  await pool.end();
});

describe('POST /ReceberRegistro — recuperação de sequência seq_srv_id_<tabela> (bug do incidente real)', () => {
  test('sequência apagada com o servidor no ar é recriada automaticamente, sem colidir com SRV_ID já alocado', async () => {
    const push1 = await receberRegistro({
      tabela: 'PRODUTOS_SYNC_TESTE',
      pk: 'ID_PRODUTO',
      temSrvId: true,
      registro: { ID_PRODUTO: 1, CODIGO: 'P1', NOME: 'Produto 1' },
    });
    expect(push1.status).toBe(200);
    expect(push1.body.srvId).not.toBeNull();

    // Simula reset-empresa.js: dropa a sequência com o servidor rodando — o cache em
    // memória (seqsSrvIdInicializadas) continua achando que ela existe.
    await pool.query(`DROP SEQUENCE IF EXISTS ${TEST_SCHEMA}.seq_srv_id_produtos_sync_teste`);

    const push2 = await receberRegistro({
      tabela: 'PRODUTOS_SYNC_TESTE',
      pk: 'ID_PRODUTO',
      temSrvId: true,
      registro: { ID_PRODUTO: 2, CODIGO: 'P2', NOME: 'Produto 2' },
    });

    expect(push2.status).toBe(200);
    expect(push2.body.srvId).not.toBeNull();
    // recriada a partir do MAX(srv_id) já em srv_id_map — não reusa nem colide com o anterior
    expect(Number(push2.body.srvId)).toBeGreaterThan(Number(push1.body.srvId));

    const { rows } = await pool.query(
      `SELECT codigo FROM ${TEST_SCHEMA}.produtos_sync_teste WHERE srv_id = $1`,
      [push2.body.srvId]
    );
    expect(rows[0].codigo).toBe('P2');
  });
});

describe('POST /AtualizarPlano — PARAMETROS(45004) do Firebird → sync_tenants.plano', () => {
  afterEach(async () => {
    await pool.query(`UPDATE public.sync_tenants SET plano = 'LITE1' WHERE schema_name = $1`, [TEST_SCHEMA]);
  });

  function atualizarPlano(plano) {
    return request(app)
      .post('/datasnap/rest/TSMSincronizacao/AtualizarPlano')
      .query({ token: TEST_TOKEN })
      .send({ plano });
  }

  test('plano válido é gravado em sync_tenants.plano', async () => {
    const res = await atualizarPlano('SAFIRA1');

    expect(res.status).toBe(200);
    const { rows } = await pool.query(
      'SELECT plano FROM public.sync_tenants WHERE schema_name = $1', [TEST_SCHEMA]
    );
    expect(rows[0].plano).toBe('SAFIRA1');
  });

  test('normaliza minúsculas/espaços antes de gravar', async () => {
    const res = await atualizarPlano('  diamante1  ');

    expect(res.status).toBe(200);
    const { rows } = await pool.query(
      'SELECT plano FROM public.sync_tenants WHERE schema_name = $1', [TEST_SCHEMA]
    );
    expect(rows[0].plano).toBe('DIAMANTE1');
  });

  test('plano desconhecido é rejeitado e não altera o valor atual', async () => {
    const res = await atualizarPlano('PLATINA_QUE_NAO_EXISTE');

    expect(res.status).toBe(400);
    const { rows } = await pool.query(
      'SELECT plano FROM public.sync_tenants WHERE schema_name = $1', [TEST_SCHEMA]
    );
    expect(rows[0].plano).toBe('LITE1');
  });

  test('body sem plano retorna 400', async () => {
    const res = await atualizarPlano(undefined);
    expect(res.status).toBe(400);
  });
});
