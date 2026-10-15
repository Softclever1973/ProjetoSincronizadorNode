// Verificação de sincronização: pedido no admin → client pega o pedido, manda hashes e detalhes → resultado com as divergências.
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { pool } = require('../src/server/infrastructure/db');
const { initializeDatabase, initializeTenantSchema } = require('../src/server/infrastructure/db-init');
const authJwt = require('../src/server/interfaces/http/middleware/authJwt');
const requireSuperAdmin = require('../src/server/interfaces/http/middleware/requireSuperAdmin');
const adminVerificacao = require('../src/server/interfaces/http/routes/datasnap/adminVerificacao');
const verificacao = require('../src/server/interfaces/http/routes/datasnap/verificacao');
const { valorCanonico, hashLinha } = require('../src/client/domain/verificacao');

const SCHEMA = 'empresa_teste_verificacao';
const TOKEN = 'TOKEN_TESTE_VERIFICACAO';
const LOJA = 3;

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/superadmin', authJwt, requireSuperAdmin, adminVerificacao);
app.use('/datasnap/rest/TSMVerificacao', verificacao);

const superadmin = `Bearer ${jwt.sign({ id: 999997, isSuperAdmin: true }, process.env.JWT_SECRET)}`;
const sync = rota => `/datasnap/rest/TSMVerificacao/${rota}?token=${TOKEN}&idLoja=${LOJA}`;

// Colunas como o client mandaria (interseção Firebird × servidor, em ordem alfabética).
const COLUNAS = [
  { nome: 'DATA', categoria: 'data' }, { nome: 'HORA', categoria: 'hora' }, { nome: 'ID_LOJA', categoria: 'numero' },
  { nome: 'ID_MOVIMENTACAO', categoria: 'numero' }, { nome: 'ID_PRODUTO', categoria: 'numero' },
  { nome: 'QUANTIDADE', categoria: 'numero' }, { nome: 'TIPO_MOVIMENTACAO', categoria: 'texto' },
];
// Linha do Firebird já com as traduções do client (FK em SRV_ID).
const fb = (id, tipo, qtd, hora) => ({ DATA: '2026-10-14', HORA: hora, ID_LOJA: LOJA, ID_MOVIMENTACAO: id, ID_PRODUTO: 500, QUANTIDADE: qtd, TIPO_MOVIMENTACAO: tipo });
const canonico = r => Object.fromEntries(COLUNAS.map(c => [c.nome, valorCanonico(r[c.nome], c.categoria)]));
const hash = r => hashLinha(COLUNAS.map(c => canonico(r)[c.nome]));

beforeAll(async () => {
  await initializeDatabase();
  await pool.query('DELETE FROM public.verificacoes_sync WHERE schema_name = $1', [SCHEMA]);
  await pool.query('DELETE FROM public.sync_tenants WHERE schema_name = $1', [SCHEMA]);
  await pool.query('INSERT INTO public.sync_tenants (token, schema_name, nome) VALUES ($1, $2, $3)', [TOKEN, SCHEMA, 'Teste Verificação']);
  await initializeTenantSchema(SCHEMA);
  const s = SCHEMA;
  await pool.query(`CREATE TABLE ${s}.movimentacoes (srv_id INTEGER PRIMARY KEY, id_movimentacao NUMERIC, id_produto NUMERIC,
    tipo_movimentacao TEXT, quantidade NUMERIC, data TEXT, hora TEXT, id_loja NUMERIC, id_ultima_atualizacao_matriz INTEGER)`);
  // Formato do push: DATA/HORA em ISO UTC. Saída com quantidade positiva (pré-fix) → o pull nega.
  await pool.query(`INSERT INTO ${s}.movimentacoes VALUES
    (1, 1, 500, 'Entrada', 10, '2026-10-14T03:00:00.000Z', '1970-01-01T14:42:06.000Z', ${LOJA}, 1),
    (2, 2, 500, 'Saída',    5, '2026-10-14T03:00:00.000Z', '1970-01-01T14:42:06.000Z', ${LOJA}, 2),
    (3, 3, 500, 'Entrada',  7, '2026-10-14T03:00:00.000Z', '1970-01-01T17:42:06.000Z', ${LOJA}, 3),
    (4, 4, 500, 'Entrada',  1, '2026-10-14T03:00:00.000Z', '1970-01-01T14:00:00.000Z', ${LOJA}, 4),
    (5, NULL, 500, 'Entrada', 1, '2026-10-14', '11:00:00', ${LOJA}, 5),
    (6, 6, 500, 'Entrada',  1, '2019-01-01T03:00:00.000Z', '1970-01-01T14:00:00.000Z', ${LOJA}, 6)`);
  await pool.query(`INSERT INTO ${s}.sync_filiais (id_loja, nome) VALUES ($1, 'Loja Verificação') ON CONFLICT (id_loja) DO NOTHING`, [LOJA]);
}, 60000);

afterAll(async () => {
  await pool.query('DELETE FROM public.verificacoes_sync WHERE schema_name = $1', [SCHEMA]);
  await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await pool.query('DELETE FROM public.sync_tenants WHERE schema_name = $1', [SCHEMA]);
  await pool.end();
});

test('admin: lista as tabelas e recusa pedido inválido ou de não superadmin', async () => {
  const tabelas = await request(app).get('/superadmin/verificacoes/tabelas').set('Authorization', superadmin);
  expect(tabelas.body.map(t => t.nome)).toContain('MOVIMENTACOES');
  expect((await request(app).post(`/superadmin/empresas/${SCHEMA}/verificacoes`).set('Authorization', superadmin).send({ tabelas: [] })).status).toBe(400);
  expect((await request(app).post(`/superadmin/empresas/${SCHEMA}/verificacoes`).set('Authorization', superadmin).send({ tabelas: ['USUARIOS'] })).status).toBe(400);
  const comum = `Bearer ${jwt.sign({ id: 1, schemas: [SCHEMA], roles: { [SCHEMA]: 'dono' } }, process.env.JWT_SECRET)}`;
  expect((await request(app).get('/superadmin/verificacoes/tabelas').set('Authorization', comum)).status).toBe(403);
});

test('sem pedido, o client recebe vazio', async () => {
  const r = await request(app).get(sync('Pendente'));
  expect(r.status).toBe(200);
  expect(r.body).toEqual({});
});

test('fluxo completo: hashes → detalhes → resultado com traduções aplicadas', async () => {
  const criado = await request(app).post(`/superadmin/empresas/${SCHEMA}/verificacoes`).set('Authorization', superadmin)
    .send({ tabelas: ['MOVIMENTACOES', 'UNIDADES'] }); // sem idLoja = todas as lojas (sync_filiais)
  expect(criado.status).toBe(201);
  expect(criado.body.map(c => c.idLoja)).toEqual([LOJA]);
  const id = criado.body[0].id;

  const pend = await request(app).get(sync('Pendente'));
  expect(pend.body).toMatchObject({ id, tabelas: ['UNIDADES', 'MOVIMENTACOES'] }); // ordem do tabelas.js
  expect(pend.body.colunasServidor.MOVIMENTACOES).toEqual(expect.arrayContaining(['DATA', 'HORA', 'QUANTIDADE']));
  expect(pend.body.colunasServidor.MOVIMENTACOES).not.toContain('ID_ULTIMA_ATUALIZACAO_MATRIZ');
  expect((await request(app).get(sync('Pendente'))).body).toEqual({}); // já entregue

  const firebird = {
    1: fb(1, 'Entrada', 10, '11:42:06'),   // igual (ISO UTC × hora local)
    2: fb(2, 'Saída', -5, '11:42:06'),     // igual (sinal invertido no pull)
    3: fb(3, 'Entrada', 7, '11:42:06'),    // servidor com +3h
    7: fb(7, 'Entrada', 2, '10:00:00'),    // só no Firebird
    8: fb(8, 'Entrada', 2, '10:00:00'),    // só no Firebird, mas na fila de envio
  };
  await request(app).post(sync('Tabela')).send({ id, tabela: 'UNIDADES', motivo: 'Tabela não existe no Firebird desta loja' }).expect(200);
  const tab = await request(app).post(sync('Tabela')).send({
    id, tabela: 'MOVIMENTACOES', colunas: COLUNAS, pendentes: ['8'],
    hashes: Object.entries(firebird).map(([k, r]) => [k, hash(r)]),
  });
  expect(tab.status).toBe(200);
  expect(tab.body.detalhes.sort()).toEqual(['3', '7']);

  await request(app).post(sync('Detalhes')).send({ id, tabela: 'MOVIMENTACOES', registros: { 3: canonico(firebird[3]), 7: canonico(firebird[7]) } }).expect(200);
  await request(app).post(sync('Concluir')).send({ id }).expect(200);

  const det = await request(app).get(`/superadmin/verificacoes/${id}`).set('Authorization', superadmin);
  expect(det.body.status).toBe('concluida');
  expect(det.body.detalhes.UNIDADES).toMatchObject({ status: 'ignorada', motivo: expect.stringContaining('não existe') });
  const m = det.body.detalhes.MOVIMENTACOES;
  // Registro 5 (site, sem ID) fica fora; 6 tem mais de 2 anos (retenção do pull).
  expect(m).toMatchObject({ status: 'ok', totalServidor: 4, totalFirebird: 5, semIdServidor: 1,
    iguais: 2, diferentes: 1, soServidor: 1, soFirebird: 1, aguardandoEnvio: 1 });
  expect(m.amostras.diferentes).toEqual([{ chave: '3', campos: [{ coluna: 'HORA', servidor: '14:42:06', firebird: '11:42:06' }] }]);
  expect(m.amostras.soServidor[0]).toMatchObject({ chave: '4', valores: expect.objectContaining({ HORA: '11:00:00' }) });
  expect(m.amostras.soFirebird[0]).toMatchObject({ chave: '7', valores: expect.objectContaining({ QUANTIDADE: '2' }) });
  expect(m._servidor).toBeUndefined();

  const lista = await request(app).get(`/superadmin/empresas/${SCHEMA}/verificacoes`).set('Authorization', superadmin);
  expect(lista.body[0]).toMatchObject({ id, status: 'concluida' });
  expect(lista.body[0].resultado.MOVIMENTACOES.amostras).toBeUndefined();

  // Pedido encerrado não aceita mais dados.
  expect((await request(app).post(sync('Tabela')).send({ id, tabela: 'MOVIMENTACOES', hashes: [] })).status).toBe(404);
});

test('chave SRV_ID: ID local repetido entre lojas não se mistura (pela PK aparece como repetida)', async () => {
  // Outra loja gerou o mesmo ID_MOVIMENTACAO 1 — MOVIMENTACOES não tem filtro de loja, então vem junto.
  await pool.query(`INSERT INTO ${SCHEMA}.movimentacoes VALUES (10, 1, 500, 'Entrada', 99, '2026-10-14T03:00:00.000Z', '1970-01-01T15:00:00.000Z', 9, 10)`);
  const pedir = async () => {
    const [{ id }] = (await request(app).post(`/superadmin/empresas/${SCHEMA}/verificacoes`).set('Authorization', superadmin)
      .send({ idLoja: LOJA, tabelas: ['MOVIMENTACOES'] })).body;
    await request(app).get(sync('Pendente')).expect(200);
    return id;
  };
  const linhaLoja9 = { ...fb(1, 'Entrada', 99, '12:00:00'), ID_LOJA: 9 };

  const porSrv = await pedir();
  await request(app).post(sync('Tabela')).send({
    id: porSrv, tabela: 'MOVIMENTACOES', chave: 'SRV_ID', colunas: COLUNAS,
    hashes: [['1', hash(fb(1, 'Entrada', 10, '11:42:06'))], ['10', hash(linhaLoja9)]],
  }).expect(200);
  await request(app).post(sync('Concluir')).send({ id: porSrv }).expect(200);
  const a = (await request(app).get(`/superadmin/verificacoes/${porSrv}`).set('Authorization', superadmin)).body.detalhes.MOVIMENTACOES;
  expect(a).toMatchObject({ chave: 'SRV_ID', repetidasServidor: 0, iguais: 2, totalServidor: 6, semIdServidor: 0 });
  expect(a.soServidor).toBe(4); // 2, 3, 4 e o 5 (criado no site): pelo SRV_ID ele também entra

  const porPk = await pedir();
  await request(app).post(sync('Tabela')).send({ id: porPk, tabela: 'MOVIMENTACOES', colunas: COLUNAS, hashes: [] }).expect(200);
  await request(app).post(sync('Concluir')).send({ id: porPk }).expect(200);
  const b = (await request(app).get(`/superadmin/verificacoes/${porPk}`).set('Authorization', superadmin)).body.detalhes.MOVIMENTACOES;
  expect(b).toMatchObject({ chave: 'PK', repetidasServidor: 1, amostraRepetidas: ['1'] });
  await pool.query(`DELETE FROM ${SCHEMA}.movimentacoes WHERE srv_id = 10`);
});

test('nomes de tabela e coluna vindos do client não chegam ao SQL', async () => {
  const [{ id }] = (await request(app).post(`/superadmin/empresas/${SCHEMA}/verificacoes`).set('Authorization', superadmin)
    .send({ idLoja: LOJA, tabelas: ['MOVIMENTACOES'] })).body;
  await request(app).get(sync('Pendente')).expect(200);
  for (const tabela of ['public.usuarios', 'USUARIOS', 'MOVIMENTACOES; DROP TABLE x']) {
    expect((await request(app).post(sync('Tabela')).send({ id, tabela, hashes: [] })).status).toBe(400);
  }
  const r = await request(app).post(sync('Tabela')).send({
    id, tabela: 'MOVIMENTACOES', hashes: [],
    colunas: [{ nome: 'QUANTIDADE', categoria: 'numero' }, { nome: '1; DROP TABLE movimentacoes', categoria: 'texto' },
      { nome: 'senha_hash FROM public.usuarios --', categoria: 'texto' }, { nome: 'OBS', categoria: 'sql' }],
  });
  expect(r.status).toBe(200);
  expect(r.body.detalhes).toEqual([]);
  const det = await request(app).get(`/superadmin/verificacoes/${id}`).set('Authorization', superadmin);
  // Nada vai ao SQL e a tabela fica com erro explicando (em vez de comparar com colunas a menos).
  expect(det.body.detalhes.MOVIMENTACOES.status).toBe('erro');
  expect(det.body.detalhes.MOVIMENTACOES.erro).toMatch(/não reconhece.*OBS \(sql\).*mesma versão/);
  const { rows } = await pool.query(`SELECT COUNT(*)::int n FROM ${SCHEMA}.movimentacoes`);
  expect(rows[0].n).toBe(6);
  await request(app).post(sync('Concluir')).send({ id }).expect(200);
});

test('client de outra loja não escreve no pedido desta', async () => {
  const [{ id }] = (await request(app).post(`/superadmin/empresas/${SCHEMA}/verificacoes`).set('Authorization', superadmin)
    .send({ idLoja: LOJA, tabelas: ['MOVIMENTACOES'] })).body;
  await request(app).get(sync('Pendente')).expect(200);
  const outraLoja = await request(app).post(`/datasnap/rest/TSMVerificacao/Tabela?token=${TOKEN}&idLoja=99`).send({ id, tabela: 'MOVIMENTACOES', hashes: [] });
  expect(outraLoja.status).toBe(404);
});
