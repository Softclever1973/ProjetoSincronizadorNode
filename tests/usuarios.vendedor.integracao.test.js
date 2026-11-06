// O servidor não cria vendedor: login do dono não gera "DONO" negativo e o cadastro de usuário só vincula vendedor existente.
const express = require('express');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { pool } = require('../src/server/infrastructure/db');
const { initializeDatabase, initializeTenantSchema } = require('../src/server/infrastructure/db-init');
const authRouter = require('../src/server/interfaces/http/routes/datasnap/auth');
const usuariosRouter = require('../src/server/interfaces/http/routes/datasnap/usuarios');
const { fixarOverrides, limparOverrides } = require('./helpers/permissoesReais');

const SCHEMA = 'empresa_teste_usu_vendedor';
const EMAIL_DONO = 'dono.vendedor.teste@example.com';
const SENHA = 'senhaTeste123';
const EMAILS_CRIADOS = ['novo.vend.a@example.com', 'novo.vend.b@example.com', 'novo.vend.c@example.com'];
const NIVEIS = { usuarios: 'rw' };

const app = express();
app.use(express.json());
app.use('/auth', authRouter);
app.use('/api', usuariosRouter);

let idDono;
const AUTH_DONO = () => `Bearer ${jwt.sign(
  { id: idDono, schemas: [SCHEMA], roles: { [SCHEMA]: 'dono' }, lojas: {}, vendedores: {} }, process.env.JWT_SECRET)}`;
const vendedores = async () => (await pool.query(`SELECT id_vendedor, nome FROM ${SCHEMA}.vendedores ORDER BY id_vendedor`)).rows;

beforeAll(async () => {
  await initializeDatabase();
  await pool.query('DELETE FROM public.usuarios_empresas WHERE schema_name = $1', [SCHEMA]);
  await pool.query('DELETE FROM public.sync_tenants WHERE schema_name = $1', [SCHEMA]);
  await pool.query('INSERT INTO public.sync_tenants (token, schema_name, nome, plano) VALUES ($1, $2, $3, $4)',
    ['TOKEN_TESTE_USU_VENDEDOR', SCHEMA, 'Empresa Teste Usuário Vendedor', 'LITE1']);
  await initializeTenantSchema(SCHEMA);
  await pool.query(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.vendedores (
    id_vendedor INTEGER PRIMARY KEY, nome TEXT, status TEXT, id_loja INTEGER, id_ultima_atualizacao_matriz INTEGER)`);
  await pool.query(`TRUNCATE ${SCHEMA}.vendedores`);
  await pool.query(`INSERT INTO ${SCHEMA}.vendedores (id_vendedor, nome, status) VALUES (7, 'VENDEDOR DO SIRIUS', 'A'), (8, 'INATIVO', 'I')`);

  await pool.query('DELETE FROM public.audit_log WHERE schema_name = $1', [SCHEMA]);
  await pool.query('DELETE FROM public.usuarios WHERE email = ANY($1)', [[EMAIL_DONO, ...EMAILS_CRIADOS]]);
  idDono = (await pool.query('INSERT INTO public.usuarios (nome, email, senha_hash, ativo) VALUES ($1, $2, $3, TRUE) RETURNING id',
    ['Dono Teste Vendedor', EMAIL_DONO, await bcrypt.hash(SENHA, 4)])).rows[0].id;
  await pool.query("INSERT INTO public.usuarios_empresas (id_usuario, schema_name, role) VALUES ($1, $2, 'dono')", [idDono, SCHEMA]);
  await fixarOverrides(SCHEMA, 'dono', NIVEIS);
}, 30000);

afterAll(async () => {
  await limparOverrides(SCHEMA, 'dono', Object.keys(NIVEIS));
  await pool.query('DELETE FROM public.usuarios_empresas WHERE schema_name = $1', [SCHEMA]);
  await pool.query('DELETE FROM public.audit_log WHERE schema_name = $1', [SCHEMA]);
  await pool.query('DELETE FROM public.usuarios WHERE email = ANY($1)', [[EMAIL_DONO, ...EMAILS_CRIADOS]]);
  await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await pool.query('DELETE FROM public.sync_tenants WHERE schema_name = $1', [SCHEMA]);
  await pool.end();
});

const criarUsuario = body => request(app).post(`/api/${SCHEMA}/usuarios`).set('Authorization', AUTH_DONO())
  .send({ senha: SENHA, role: 'vendedor', id_loja: 1, ...body });

test('login do dono não cria vendedor "DONO" negativo nem vincula vendedor', async () => {
  const r = await request(app).post('/auth/login').send({ email: EMAIL_DONO, senha: SENHA });
  expect(r.status).toBe(200);
  expect((await vendedores()).map(v => v.id_vendedor)).toEqual([7, 8]);
  const { rows: [ue] } = await pool.query('SELECT id_vendedor FROM public.usuarios_empresas WHERE id_usuario = $1 AND schema_name = $2', [idDono, SCHEMA]);
  expect(ue.id_vendedor).toBeNull();
});

test('criarVendedor (site antigo) é ignorado: nenhum vendedor é criado', async () => {
  const r = await criarUsuario({ nome: 'Novo Vend A', email: EMAILS_CRIADOS[0], criarVendedor: true });
  expect(r.status).toBe(201);
  expect(r.body.id_vendedor).toBeNull();
  expect(await vendedores()).toHaveLength(2);
});

test.each([[999, 'não existe'], [8, 'inativo']])('vincular a vendedor %s (%s) é recusado', async id => {
  const r = await criarUsuario({ nome: 'Novo Vend B', email: EMAILS_CRIADOS[1], id_vendedor: id });
  expect(r.status).toBe(400);
  expect(r.body.erro).toMatch(/Cadastre o vendedor no Sirius/);
});

test('vincular a vendedor do Sirius grava o vínculo', async () => {
  const r = await criarUsuario({ nome: 'Novo Vend C', email: EMAILS_CRIADOS[2], id_vendedor: 7 });
  expect(r.status).toBe(201);
  expect(r.body.id_vendedor).toBe(7);
});
