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
  await pool.query(`DROP TABLE IF EXISTS ${TEST_SCHEMA}.financeiro_contas_receber CASCADE`);
  await pool.query(`DROP SEQUENCE IF EXISTS ${TEST_SCHEMA}.seq_srv_id_produtos_sync_teste`);
  await pool.query(`DROP SEQUENCE IF EXISTS ${TEST_SCHEMA}.seq_srv_id_a_receber`);
  await pool.query(`DELETE FROM ${TEST_SCHEMA}.srv_id_map WHERE tabela IN ('PRODUTOS_SYNC_TESTE', 'A_RECEBER')`);
  // Recria financeiro_contas_receber no estado normal (create-empresa) antes do teste B
  // dropá-la de propósito — deixa claro que o teste começa do estado correto.
  const { initializeTenantSchema } = require('../src/db-init');
  await initializeTenantSchema(TEST_SCHEMA);
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

describe('POST /ReceberRegistro — recuperação de financeiro_contas_receber ao espelhar A_RECEBER', () => {
  test('tabela apagada com o servidor no ar é recriada automaticamente e o espelho é aplicado', async () => {
    await pool.query(`DROP TABLE IF EXISTS ${TEST_SCHEMA}.financeiro_contas_receber CASCADE`);

    const push = await receberRegistro({
      tabela: 'A_RECEBER',
      pk: 'ID_A_RECEBER',
      temSrvId: true,
      registro: {
        ID_A_RECEBER: 1,
        DESCRICAO: 'Parcela 1/1',
        VALOR: 150.5,
        VENCIMENTO: '2026-08-01',
        STATUS: 'Pendente',
        PARCELA: 1,
        TOTAL_PARCELAS: 1,
        ID_LOJA: 1,
      },
    });

    expect(push.status).toBe(200);

    const { rows } = await pool.query(
      `SELECT descricao, valor, status FROM ${TEST_SCHEMA}.financeiro_contas_receber WHERE id_a_receber = 1`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].descricao).toBe('Parcela 1/1');
    expect(Number(rows[0].valor)).toBeCloseTo(150.5);
    expect(rows[0].status).toBe('pendente');
  });

  test('push seguinte (tabela já recriada) atualiza o espelho normalmente, sem novo warning', async () => {
    const push = await receberRegistro({
      tabela: 'A_RECEBER',
      pk: 'ID_A_RECEBER',
      temSrvId: true,
      registro: {
        ID_A_RECEBER: 1,
        DESCRICAO: 'Parcela 1/1',
        VALOR: 150.5,
        VENCIMENTO: '2026-08-01',
        STATUS: 'Recebido',
        PARCELA: 1,
        TOTAL_PARCELAS: 1,
        ID_LOJA: 1,
      },
    });

    expect(push.status).toBe(200);

    const { rows } = await pool.query(
      `SELECT status FROM ${TEST_SCHEMA}.financeiro_contas_receber WHERE id_a_receber = 1`
    );
    expect(rows[0].status).toBe('recebido');
  });
});
