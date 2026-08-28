/**
 * Testes de integração contra Postgres real (mesmo banco de dev de .env) para o sistema
 * unificado de permissões por módulo (plano × módulo, role × módulo) — substitui
 * requireRole/requireRoleOuVendedorEm/requirePlanFeature('financeiro') hardcoded.
 * Ver plano em C:\Users\USUARIO021\.claude\plans\jaunty-nibbling-rabbit.md.
 */
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { pool } = require('../src/server/infrastructure/db');
const { initializeDatabase } = require('../src/server/infrastructure/db-init');
const adminRouter = require('../src/server/interfaces/http/routes/api/admin');
const adminEmpresasRouter = require('../src/server/interfaces/http/routes/datasnap/adminEmpresas');
const authJwt = require('../src/server/interfaces/http/middleware/authJwt');
const requireSuperAdmin = require('../src/server/interfaces/http/middleware/requireSuperAdmin');
const { recarregarPermissoes } = require('../src/server/infrastructure/cache/permissoesCache');

const app = express();
app.use(express.json());
app.use('/api', adminRouter);
app.use('/superadmin', authJwt, requireSuperAdmin, adminEmpresasRouter);

const SCHEMA = 'empresa_teste_permissoes';

function tokenSuperAdmin() {
  return `Bearer ${jwt.sign({ id: 999999, isSuperAdmin: true }, process.env.JWT_SECRET)}`;
}
function tokenPara(role) {
  return `Bearer ${jwt.sign(
    { id: 999999, schemas: [SCHEMA], roles: { [SCHEMA]: role }, lojas: {}, vendedores: {} },
    process.env.JWT_SECRET
  )}`;
}

beforeAll(async () => {
  await initializeDatabase();
  await pool.query('DELETE FROM public.sync_tenants WHERE schema_name = $1', [SCHEMA]);
  await pool.query(
    'INSERT INTO public.sync_tenants (token, schema_name, nome, plano) VALUES ($1, $2, $3, $4)',
    ['TOKEN_TESTE_PERMISSOES', SCHEMA, 'Empresa Teste Permissões', 'LITE1']
  );
}, 30000);

afterAll(async () => {
  await pool.query('DELETE FROM public.sync_tenants WHERE schema_name = $1', [SCHEMA]);
  await recarregarPermissoes(); // não deixa a célula de teste (financeiro=rw) vazando pra outros arquivos de teste
  await pool.end();
});

describe('Seed de permissoes_plano/permissoes_role — reproduz o comportamento anterior', () => {
  test.each([
    ['vendedor', 'pedidos', 'rw'],
    ['vendedor', 'produtos', 'r-'],
    ['vendedor', 'clientes', 'r-'],
    ['vendedor', 'fornecedores', '--'],
    ['vendedor', 'financeiro', '--'],
    ['vendedor', 'usuarios', '--'],
    ['gerente', 'configuracoes', '--'],
    ['gerente', 'financeiro', 'rw'],
    ['dono', 'configuracoes', 'rw'],
  ])('role=%s, modulo=%s -> nivel=%s', async (role, modulo, nivelEsperado) => {
    const { rows } = await pool.query(
      'SELECT nivel FROM public.permissoes_role WHERE role = $1 AND modulo = $2', [role, modulo]
    );
    expect(rows[0]?.nivel).toBe(nivelEsperado);
  });

  test.each([
    ['LITE1', 'financeiro', '--'],
    ['BRONZE1', 'financeiro', '--'],
    ['PRATA1', 'financeiro', '--'],
    ['OURO1', 'financeiro', '--'],
    ['SAFIRA1', 'financeiro', 'rw'],
    ['DIAMANTE1', 'financeiro', 'rw'],
  ])('plano=%s, financeiro -> nivel=%s', async (plano, modulo, nivelEsperado) => {
    const { rows } = await pool.query(
      'SELECT nivel FROM public.permissoes_plano WHERE plano = $1 AND modulo = $2', [plano, modulo]
    );
    expect(rows[0]?.nivel).toBe(nivelEsperado);
  });
});

describe('GET /api/:schema/plano — campo modulos', () => {
  test('retorna a permissão efetiva (plano ∩ role) de cada módulo', async () => {
    const res = await request(app)
      .get(`/api/${SCHEMA}/plano`)
      .set('Authorization', tokenPara('vendedor'));

    expect(res.status).toBe(200);
    expect(res.body.modulos.pedidos).toBe('rw');
    expect(res.body.modulos.produtos).toBe('r-');
    expect(res.body.modulos.financeiro).toBe('--');
  });
});

describe('PUT /superadmin/permissoes/plano — escreve e reflete sem restart', () => {
  // Usa o módulo "auditoria" em vez de "financeiro" de propósito: permissoes_plano/
  // permissoes_role são tabelas GLOBAIS (não isoladas por schema de teste) — outros
  // arquivos de teste de integração rodam em workers Jest paralelos e checam a célula
  // (plano, 'financeiro') o tempo todo (financeiro.plano/planoInfo.integracao). Mutar essa
  // célula, mesmo temporariamente, já causou uma falha real por corrida entre arquivos.
  // Nenhum outro teste depende do valor de (LITE1, auditoria), então é seguro escrever aqui.
  afterEach(async () => {
    await pool.query(
      `INSERT INTO public.permissoes_plano (plano, modulo, nivel) VALUES ('LITE1', 'auditoria', 'rw')
       ON CONFLICT (plano, modulo) DO UPDATE SET nivel = EXCLUDED.nivel`
    );
    await recarregarPermissoes();
  });

  test('upsert de uma célula é refletido na próxima chamada a /plano', async () => {
    const antes = await request(app).get(`/api/${SCHEMA}/plano`).set('Authorization', tokenPara('dono'));
    expect(antes.body.modulos.auditoria).toBe('rw');

    const put = await request(app)
      .put('/superadmin/permissoes/plano')
      .set('Authorization', tokenSuperAdmin())
      .send({ plano: 'LITE1', modulo: 'auditoria', nivel: '--' });
    expect(put.status).toBe(200);

    const depois = await request(app).get(`/api/${SCHEMA}/plano`).set('Authorization', tokenPara('dono'));
    expect(depois.body.modulos.auditoria).toBe('--');
  });

  test('rejeita módulo inválido', async () => {
    const res = await request(app)
      .put('/superadmin/permissoes/plano')
      .set('Authorization', tokenSuperAdmin())
      .send({ plano: 'LITE1', modulo: 'nao_existe', nivel: 'rw' });
    expect(res.status).toBe(400);
  });

  test('rejeita nível inválido', async () => {
    const res = await request(app)
      .put('/superadmin/permissoes/plano')
      .set('Authorization', tokenSuperAdmin())
      .send({ plano: 'LITE1', modulo: 'financeiro', nivel: 'x' });
    expect(res.status).toBe(400);
  });
});

describe('GET /superadmin/permissoes', () => {
  test('lista os módulos e as duas matrizes completas', async () => {
    const res = await request(app).get('/superadmin/permissoes').set('Authorization', tokenSuperAdmin());
    expect(res.status).toBe(200);
    expect(res.body.modulos).toContain('financeiro');
    expect(Array.isArray(res.body.planos)).toBe(true);
    expect(Array.isArray(res.body.roles)).toBe(true);
  });
});
