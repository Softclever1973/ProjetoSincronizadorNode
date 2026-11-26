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
const { initializeDatabase, SEED_PERMISSOES_PLANO, SEED_PERMISSOES_ROLE } = require('../src/server/infrastructure/db-init');
const { nivelEsperado } = require('./helpers/permissoesReais');
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

// A matriz real é editada pela tela: aqui se testa o seed (constantes) e que toda célula dele existe no banco.
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
  ])('role=%s, modulo=%s -> nivel=%s', (role, modulo, nivel) => {
    expect(SEED_PERMISSOES_ROLE[role][modulo]).toBe(nivel);
  });

  test.each([
    ['LITE1', '--'], ['BRONZE1', '--'], ['PRATA1', '--'], ['OURO1', '--'], ['SAFIRA1', 'rw'], ['DIAMANTE1', 'rw'],
  ])('plano=%s, financeiro -> nivel=%s', (plano, nivel) => {
    expect(SEED_PERMISSOES_PLANO[plano].financeiro).toBe(nivel);
  });

  test('toda célula do seed existe no banco depois do initializeDatabase', async () => {
    const [{ rows: rp }, { rows: rr }] = await Promise.all([
      pool.query('SELECT plano, modulo FROM public.permissoes_plano'),
      pool.query('SELECT role, modulo FROM public.permissoes_role'),
    ]);
    const temPlano = new Set(rp.map(r => `${r.plano}|${r.modulo}`));
    const temRole = new Set(rr.map(r => `${r.role}|${r.modulo}`));
    const faltando = [
      ...Object.entries(SEED_PERMISSOES_PLANO).flatMap(([p, m]) => Object.keys(m).map(x => `${p}|${x}`)).filter(k => !temPlano.has(k)),
      ...Object.entries(SEED_PERMISSOES_ROLE).flatMap(([r, m]) => Object.keys(m).map(x => `${r}|${x}`)).filter(k => !temRole.has(k)),
    ];
    expect(faltando).toEqual([]);
  });
});

describe('GET /api/:schema/plano — campo modulos', () => {
  test('retorna a permissão efetiva (plano ∩ role) de cada módulo', async () => {
    const res = await request(app)
      .get(`/api/${SCHEMA}/plano`)
      .set('Authorization', tokenPara('vendedor'));

    expect(res.status).toBe(200);
    for (const modulo of ['pedidos', 'produtos', 'financeiro']) {
      expect(res.body.modulos[modulo]).toBe(await nivelEsperado('LITE1', 'vendedor', modulo));
    }
  });
});

describe('PUT /superadmin/permissoes/plano — escreve e reflete sem restart', () => {
  // permissoes_plano é GLOBAL e outros arquivos rodam em paralelo checando financeiro/produtos/pedidos/exportacao:
  // usa um módulo fora desses que esteja liberado hoje pra LITE1×dono, e restaura o valor original no fim.
  const CANDIDATOS = ['auditoria', 'faturamento', 'imprimir', 'configuracoes', 'usuarios', 'produtos_movimentacao'];
  let modulo;
  let original;

  beforeAll(async () => {
    for (const m of CANDIDATOS) {
      if (await nivelEsperado('LITE1', 'dono', m) === 'rw') { modulo = m; break; }
    }
    if (!modulo) throw new Error(`Nenhum de ${CANDIDATOS.join(', ')} está rw pra LITE1×dono — ajuste CANDIDATOS`);
    const { rows } = await pool.query(`SELECT nivel FROM public.permissoes_plano WHERE plano = 'LITE1' AND modulo = $1`, [modulo]);
    original = rows[0].nivel;
  });

  afterEach(async () => {
    await pool.query(
      `INSERT INTO public.permissoes_plano (plano, modulo, nivel) VALUES ('LITE1', $1, $2)
       ON CONFLICT (plano, modulo) DO UPDATE SET nivel = EXCLUDED.nivel`,
      [modulo, original]
    );
    await recarregarPermissoes();
  });

  test('upsert de uma célula é refletido na próxima chamada a /plano', async () => {
    const antes = await request(app).get(`/api/${SCHEMA}/plano`).set('Authorization', tokenPara('dono'));
    expect(antes.body.modulos[modulo]).toBe('rw');

    const put = await request(app)
      .put('/superadmin/permissoes/plano')
      .set('Authorization', tokenSuperAdmin())
      .send({ plano: 'LITE1', modulo, nivel: '--' });
    expect(put.status).toBe(200);

    const depois = await request(app).get(`/api/${SCHEMA}/plano`).set('Authorization', tokenPara('dono'));
    expect(depois.body.modulos[modulo]).toBe('--');
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
    expect(res.body.modulos).toContainEqual({ chave: 'financeiro', label: expect.any(String), tipo: 'modulo', binario: false });
    expect(res.body.modulos).toContainEqual({ chave: 'exportacao', label: expect.any(String), tipo: 'funcao', binario: true });
    expect(Array.isArray(res.body.planos)).toBe(true);
    expect(Array.isArray(res.body.roles)).toBe(true);
  });
});
