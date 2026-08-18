/**
 * Reproduz e cobre o bug real: cadastrar um produto pela web (crud.js) numa empresa cujo
 * client Firebird ainda não sincronizou uma tabela nem uma vez (ex.: empresa nova, alguém
 * usando o painel web antes do client rodar o primeiro ciclo) batia em "relação X não
 * existe" — crud.js assumia que a tabela já existia, diferente de /ReceberRegistro
 * (sincronizacao.js), que já sabia criar a tabela na hora. Usa um nome de tabela exclusivo
 * (CRUD_AUTO_CRIACAO_TESTE) pra não colidir com as tabelas fixas de crud.integracao.test.js.
 */
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { pool } = require('../src/server/infrastructure/db');
const crudRouter = require('../src/server/interfaces/http/routes/api/crud');
const { TEST_SCHEMA, setupTestSchema } = require('./helpers/testSchema');

const app = express();
app.use(express.json());
app.use('/api', crudRouter);

const TABELA_TESTE = 'CRUD_AUTO_CRIACAO_TESTE';

function tokenPara(role) {
  return jwt.sign(
    { id: 999998, nome: 'Teste', schemas: [TEST_SCHEMA], roles: { [TEST_SCHEMA]: role }, lojas: {}, vendedores: {} },
    process.env.JWT_SECRET
  );
}
const AUTH_DONO = `Bearer ${tokenPara('dono')}`;

beforeAll(async () => {
  await setupTestSchema();
}, 30000);

beforeEach(async () => {
  await pool.query(`DROP TABLE IF EXISTS ${TEST_SCHEMA}.${TABELA_TESTE.toLowerCase()} CASCADE`);
});

afterAll(async () => {
  await pool.end();
});

describe('POST/PUT numa tabela ainda não sincronizada (crud.js cria automaticamente)', () => {
  test('cria a tabela com tipos inferidos do payload e salva o registro de primeira', async () => {
    const res = await request(app)
      .post(`/api/${TEST_SCHEMA}/tabelas/${TABELA_TESTE}`)
      .set('Authorization', AUTH_DONO)
      .send({
        pk: 'ID_REGISTRO',
        registro: { ID_REGISTRO: 1, DESCRICAO: 'Primeiro registro', VALOR: 12.5, ATIVO: true },
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const { rows } = await pool.query(
      `SELECT descricao, valor, ativo FROM ${TEST_SCHEMA}.${TABELA_TESTE.toLowerCase()} WHERE id_registro = 1`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].descricao).toBe('Primeiro registro');
    expect(Number(rows[0].valor)).toBe(12.5);
    expect(rows[0].ativo).toBe(true);

    const tipos = await pool.query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2`,
      [TEST_SCHEMA, TABELA_TESTE.toLowerCase()]
    );
    const porColuna = Object.fromEntries(tipos.rows.map(r => [r.column_name, r.data_type]));
    expect(porColuna.valor).toBe('numeric');
    expect(porColuna.ativo).toBe('boolean');
    expect(porColuna.descricao).toBe('text');

    // PK vem do pk[] da requisição (ID_REGISTRO), não de SRV_ID — coerente com o que o
    // resto do handler já assume quando a tabela não tem SRV_ID como PK real.
    const pk = await pool.query(
      `SELECT kcu.column_name FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema AND tc.table_name = kcu.table_name
       WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'PRIMARY KEY'`,
      [TEST_SCHEMA, TABELA_TESTE.toLowerCase()]
    );
    expect(pk.rows.map(r => r.column_name)).toEqual(['id_registro']);
  });

  test('chave de payload inválida não vira coluna (proteção contra injeção de identificador)', async () => {
    const res = await request(app)
      .post(`/api/${TEST_SCHEMA}/tabelas/${TABELA_TESTE}`)
      .set('Authorization', AUTH_DONO)
      .send({
        pk: 'ID_REGISTRO',
        registro: { ID_REGISTRO: 1, DESCRICAO: 'ok', 'X); DROP TABLE sync_tenants; --': 'malicioso' },
      });

    expect(res.status).toBe(200);
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
      [TEST_SCHEMA, TABELA_TESTE.toLowerCase()]
    );
    const nomes = cols.rows.map(r => r.column_name);
    expect(nomes).not.toContain('x'); // a chave inválida não virou coluna
    expect(nomes).toContain('descricao');

    const tenants = await pool.query(`SELECT 1 FROM public.sync_tenants LIMIT 1`);
    expect(tenants.rows.length).toBeGreaterThan(0); // sync_tenants sobreviveu incólume
  });

  test('segundo registro na mesma tabela recém-criada não tenta recriar (idempotente)', async () => {
    const registro = (id) => ({ pk: 'ID_REGISTRO', registro: { ID_REGISTRO: id, DESCRICAO: `Registro ${id}` } });

    const r1 = await request(app).post(`/api/${TEST_SCHEMA}/tabelas/${TABELA_TESTE}`).set('Authorization', AUTH_DONO).send(registro(1));
    expect(r1.status).toBe(200);
    const r2 = await request(app).post(`/api/${TEST_SCHEMA}/tabelas/${TABELA_TESTE}`).set('Authorization', AUTH_DONO).send(registro(2));
    expect(r2.status).toBe(200);

    const { rows } = await pool.query(`SELECT id_registro FROM ${TEST_SCHEMA}.${TABELA_TESTE.toLowerCase()} ORDER BY id_registro`);
    expect(rows.map(r => Number(r.id_registro))).toEqual([1, 2]);
  });
});
