jest.mock('../src/client/infrastructure/firebird/db', () => ({
  getConnection: jest.fn(async () => ({})), closeConnection: jest.fn(async () => {}), query: jest.fn(),
}));
jest.mock('../src/client/interfaces/webui/shared/getJSON', () => ({ getJSON: jest.fn() }));

const express = require('express');
const request = require('supertest');
const { query } = require('../src/client/infrastructure/firebird/db');
const { getJSON } = require('../src/client/interfaces/webui/shared/getJSON');
const { mockQueryPorSql } = require('./helpers/mockQuery');
const { criarStatusRouter } = require('../src/client/interfaces/webui/routes/status.routes');

function montarApp() {
  const app = express();
  // Sem EJS no teste: devolve os dados que iriam pra view.
  app.use((req, res, next) => { res.render = (_v, dados) => res.json(dados); next(); });
  app.use(criarStatusRouter({ baseURI: 'http://srv', idLoja: 1 }));
  return app;
}

const SERVIDOR = [
  { tabela: 'PRODUTOS', total: null, maxId: 10 },
  { tabela: 'CLIENTES', total: null, maxId: 5 },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockQueryPorSql(query, [
    ['ULTIMOS_REGISTROS_MATRIZ', [{ NOME_TABELA: 'PRODUTOS  ', VALOR: 10 }, { NOME_TABELA: 'CLIENTES', VALOR: 3 }]],
    ['SYNC_ALTERACOES_PENDENTES', [{ NOME_TABELA: 'CLIENTES', VALOR: 7 }]],
    ['COUNT(*) AS TOTAL FROM PRODUTOS', [{ TOTAL: 100 }]],
    ['COUNT(*) AS TOTAL FROM CLIENTES', [{ TOTAL: 50 }]],
  ]);
});

describe('página Status', () => {
  test('abre sem COUNT(*): pede contar=0 e faz 1 consulta de cursor + 1 de pendentes pra todas as tabelas', async () => {
    getJSON.mockResolvedValue(SERVIDOR);

    const r = await request(montarApp()).get('/status');

    expect(r.status).toBe(200);
    expect(getJSON.mock.calls[0][0]).toContain('contar=0');
    const sqls = query.mock.calls.map(c => c[1]);
    expect(sqls).toHaveLength(2);
    expect(sqls.some(s => /COUNT\(\*\) AS TOTAL FROM (PRODUTOS|CLIENTES)/.test(s))).toBe(false);
    expect(r.body.tabelas).toEqual([
      expect.objectContaining({ nome: 'PRODUTOS', cursorLocal: 10, pendentesEnvio: 0, statusTexto: 'OK' }),
      expect.objectContaining({ nome: 'CLIENTES', cursorLocal: 3, pendentesEnvio: 7, statusTexto: 'Pendente' }),
    ]);
    expect([r.body.totalOk, r.body.totalPendente]).toEqual([1, 1]);
  });

  test('resposta de erro do servidor vira mensagem, não quebra a página', async () => {
    getJSON.mockResolvedValue({ message: 'boom' });
    const r = await request(montarApp()).get('/status');
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/boom/);
  });

  test('/status/totais conta servidor (contar=1) e local, e reaproveita o cálculo por 1 min', async () => {
    getJSON.mockResolvedValue([{ tabela: 'PRODUTOS', total: 99, maxId: 10 }, { tabela: 'CLIENTES', total: 50, maxId: 5 }]);
    const app = montarApp();

    const r1 = await request(app).get('/status/totais');
    expect(r1.status).toBe(200);
    expect(r1.body.servidor).toEqual({ PRODUTOS: 99, CLIENTES: 50 });
    expect(r1.body.local).toEqual({ PRODUTOS: 100, CLIENTES: 50 });
    expect(getJSON.mock.calls[0][0]).toContain('contar=1');

    await request(app).get('/status/totais');
    expect(getJSON).toHaveBeenCalledTimes(1);

    await request(app).get('/status/totais?recalcular=1');
    expect(getJSON).toHaveBeenCalledTimes(2);
  });

  test('/status/totais: chamadas simultâneas não disparam dois cálculos', async () => {
    let liberar;
    getJSON.mockReturnValue(new Promise(res => { liberar = () => res(SERVIDOR); }));
    const app = montarApp();

    const p1 = request(app).get('/status/totais').then(r => r);
    const p2 = request(app).get('/status/totais?recalcular=1').then(r => r);
    await new Promise(r => setTimeout(r, 50));
    liberar();
    await Promise.all([p1, p2]);

    expect(getJSON).toHaveBeenCalledTimes(1);
  });
});
