// SITUACAO de cliente nunca fica vazia: o site grava 'A' no cadastro e o script corrige os antigos.
const path = require('path');
const { execFileSync } = require('child_process');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { pool } = require('../src/server/infrastructure/db');
const { initializeTenantSchema } = require('../src/server/infrastructure/db-init');
const crudRouter = require('../src/server/interfaces/http/routes/api/crud');
const { fixarOverrides, limparOverrides } = require('./helpers/permissoesReais');

const SCHEMA = 'empresa_teste_cli_situacao';
const NIVEIS = { clientes: 'rw' };
const app = express();
app.use(express.json());
app.use('/api', crudRouter);

const token = role => `Bearer ${jwt.sign(
  { id: 999998, schemas: [SCHEMA], roles: { [SCHEMA]: role }, lojas: { [SCHEMA]: 1 }, vendedores: {} }, process.env.JWT_SECRET)}`;
const VENDEDOR = token('vendedor');
const GERENTE = token('gerente');
const listar = () => request(app).get(`/api/${SCHEMA}/tabelas/CLIENTES?statusCol=SITUACAO&statusVal=I`).set('Authorization', VENDEDOR);
const nomes = r => r.body.registros.map(x => x.RAZAO_SOCIAL).sort();
const situacao = async srvId => (await pool.query(`SELECT situacao FROM ${SCHEMA}.clientes WHERE srv_id = $1`, [srvId])).rows[0].situacao;
const salvar = (auth, metodo, registro) => request(app)[metodo](`/api/${SCHEMA}/tabelas/CLIENTES`).set('Authorization', auth)
  .send({ pk: 'SRV_ID', registro });

beforeAll(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.query('DELETE FROM public.sync_tenants WHERE schema_name = $1', [SCHEMA]);
  await pool.query('INSERT INTO public.sync_tenants (token, schema_name, nome, plano) VALUES ($1, $2, $3, $4)',
    ['TOKEN_TESTE_CLI_SITUACAO', SCHEMA, 'Teste situação de cliente', 'SAFIRA1']);
  await initializeTenantSchema(SCHEMA);
  await pool.query(`SET search_path TO ${SCHEMA};
    CREATE TABLE clientes (srv_id INTEGER PRIMARY KEY, id_cliente INTEGER, razao_social TEXT, situacao CHAR(1),
      id_loja INTEGER, id_ultima_atualizacao_matriz BIGINT);
    INSERT INTO clientes (srv_id, id_cliente, razao_social, situacao, id_loja) VALUES
      (1, 1, 'ATIVO', 'A', 1), (2, 2, 'INATIVO', 'I', 1), (3, NULL, 'SEM SITUACAO', NULL, 1),
      (4, 4, 'OUTRA LOJA', 'A', 2), (5, NULL, 'EM BRANCO', ' ', 1), (6, NULL, 'EDITADO SEM SITUACAO', NULL, 1);
    SET search_path TO public`);
  for (const role of ['vendedor', 'gerente']) await fixarOverrides(SCHEMA, role, NIVEIS);
}, 30000);

afterAll(async () => {
  for (const role of ['vendedor', 'gerente']) await limparOverrides(SCHEMA, role, Object.keys(NIVEIS));
  await pool.query('DELETE FROM public.audit_log WHERE schema_name = $1', [SCHEMA]);
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.query('DELETE FROM public.sync_tenants WHERE schema_name = $1', [SCHEMA]);
  await pool.end();
});

test("vendedor só vê SITUACAO 'A' da loja dele (ignora statusVal=I)", async () => {
  const r = await listar();
  expect(r.status).toBe(200);
  expect(nomes(r)).toEqual(['ATIVO']);
});

test("cliente cadastrado pelo vendedor nasce 'A' e continua na lista", async () => {
  const s = await salvar(VENDEDOR, 'post',
    { RAZAO_SOCIAL: 'NOVO DO SITE', FANTASIA: 'NOVO', PESSOA_P_CONTATO: 'FULANO', CONSUMIDOR_FINAL: 'S', CPF: '52998224725', SITUACAO: '' });
  expect([s.status, s.body.erro]).toEqual([200, undefined]);
  const { rows: [c] } = await pool.query(`SELECT situacao, id_loja FROM ${SCHEMA}.clientes WHERE razao_social = 'NOVO DO SITE'`);
  expect(c).toEqual({ situacao: 'A', id_loja: 1 });
  expect(nomes(await listar())).toContain('NOVO DO SITE');
});

test('edição com SITUACAO vazia não apaga nem reativa um inativo', async () => {
  expect((await salvar(GERENTE, 'put', { SRV_ID: 2, RAZAO_SOCIAL: 'INATIVO', SITUACAO: '' })).status).toBe(200);
  expect(await situacao(2)).toBe('I');
});

test("editar cliente antigo sem SITUACAO grava 'A'", async () => {
  expect((await salvar(GERENTE, 'put', { SRV_ID: 6, RAZAO_SOCIAL: 'EDITADO SEM SITUACAO' })).status).toBe(200);
  expect(await situacao(6)).toBe('A');
});

test("script corrige os vazios com 'A' e novo ID_ULTIMA_ATUALIZACAO_MATRIZ", async () => {
  const script = path.join(__dirname, '..', 'scripts', 'corrigir-situacao-clientes.js');
  const simulacao = execFileSync(process.execPath, [script, `--schema=${SCHEMA}`], { encoding: 'utf8' });
  expect(simulacao).toMatch(/2 cliente\(s\) sem SITUACAO/);
  expect(await situacao(3)).toBeNull();

  execFileSync(process.execPath, [script, `--schema=${SCHEMA}`, '--executar', '--force'], { encoding: 'utf8' });
  const { rows } = await pool.query(`SELECT srv_id, situacao, id_ultima_atualizacao_matriz AS id_ult FROM ${SCHEMA}.clientes WHERE srv_id IN (3, 5)`);
  expect(rows.map(r => r.situacao)).toEqual(['A', 'A']);
  expect(rows.every(r => r.id_ult != null)).toBe(true);
  expect(await situacao(2)).toBe('I');
}, 30000);
