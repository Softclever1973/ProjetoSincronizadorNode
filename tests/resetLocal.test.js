// Mesmo motivo do sync.conflitos.test.js/syncParametrosGlobais.test.js: factories explícitas
// evitam carregar ../db real (exige Firebird real no require).
jest.mock('../src/client/db', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  tabelaExiste: jest.fn(),
}));
jest.mock('../src/client/http', () => ({
  verificarStatusReset: jest.fn(),
}));

const { query, execute, tabelaExiste } = require('../src/client/db');
const { verificarStatusReset } = require('../src/client/http');
const { verificarResetServidor, aplicarResetLocal, emitter } = require('../src/client/resetLocal');
const TABELAS = require('../src/client/tabelas');

const db = {}; // opaco pro módulo — só repassado pra query/execute/tabelaExiste mockados
const baseURI = 'http://servidor.teste';
const noopLog = () => {};

beforeEach(() => {
  jest.clearAllMocks();
  execute.mockResolvedValue();
  tabelaExiste.mockResolvedValue(true);
  query.mockResolvedValue([]);
});

describe('verificarResetServidor', () => {
  test('servidor sem resetado_em não faz nada', async () => {
    verificarStatusReset.mockResolvedValue({});
    const ctx = {};
    await verificarResetServidor(db, baseURI, ctx, noopLog);
    expect(query).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(ctx.resetPendente).toBeUndefined();
  });

  test('primeira checagem (sem baseline local) semeia em silêncio, sem emitir', async () => {
    verificarStatusReset.mockResolvedValue({ resetado_em: '2026-08-14T10:00:00.000Z' });
    query.mockResolvedValue([]); // SYNC_RESET_STATUS ainda sem linha
    const onEvent = jest.fn();
    emitter.once('novo-reset-pendente', onEvent);

    const ctx = {};
    await verificarResetServidor(db, baseURI, ctx, noopLog);

    expect(execute).toHaveBeenCalledWith(
      db,
      expect.stringContaining('UPDATE OR INSERT INTO SYNC_RESET_STATUS'),
      [new Date('2026-08-14T10:00:00.000Z')]
    );
    expect(onEvent).not.toHaveBeenCalled();
    expect(ctx.resetPendente).toBeUndefined();
  });

  test('baseline igual ao servidor não emite e limpa resetPendente', async () => {
    const iso = '2026-08-14T10:00:00.000Z';
    verificarStatusReset.mockResolvedValue({ resetado_em: iso });
    query.mockResolvedValue([{ ULTIMO_RESET_CONHECIDO: new Date(iso) }]);
    const onEvent = jest.fn();
    emitter.once('novo-reset-pendente', onEvent);

    const ctx = { resetPendente: { resetadoEm: iso } };
    await verificarResetServidor(db, baseURI, ctx, noopLog);

    expect(onEvent).not.toHaveBeenCalled();
    expect(ctx.resetPendente).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  test('baseline diferente emite novo-reset-pendente e seta contextoSync, sem avançar o baseline', async () => {
    const antigo = new Date('2026-08-01T00:00:00.000Z');
    const novo = '2026-08-14T10:00:00.000Z';
    verificarStatusReset.mockResolvedValue({ resetado_em: novo });
    query.mockResolvedValue([{ ULTIMO_RESET_CONHECIDO: antigo }]);
    const onEvent = jest.fn();
    emitter.once('novo-reset-pendente', onEvent);

    const ctx = {};
    await verificarResetServidor(db, baseURI, ctx, noopLog);

    expect(onEvent).toHaveBeenCalledWith({ resetadoEm: novo });
    expect(ctx.resetPendente).toEqual({ resetadoEm: novo });
    expect(execute).not.toHaveBeenCalled();
  });

  test('não repete a emissão pro mesmo valor em ciclos consecutivos', async () => {
    const antigo = new Date('2026-08-01T00:00:00.000Z');
    const novo = '2026-08-14T10:00:00.000Z';
    verificarStatusReset.mockResolvedValue({ resetado_em: novo });
    query.mockResolvedValue([{ ULTIMO_RESET_CONHECIDO: antigo }]);
    const onEvent = jest.fn();
    emitter.on('novo-reset-pendente', onEvent);

    const ctx = {};
    await verificarResetServidor(db, baseURI, ctx, noopLog);
    await verificarResetServidor(db, baseURI, ctx, noopLog);

    expect(onEvent).toHaveBeenCalledTimes(1);
    emitter.off('novo-reset-pendente', onEvent);
  });
});

describe('aplicarResetLocal', () => {
  const tabelasComSrvId = TABELAS.filter(t => t.srvId).map(t => t.nome);

  test('busca o status na hora de aplicar, limpa as filas/cursores, anula SRV_ID e grava o novo baseline', async () => {
    verificarStatusReset.mockResolvedValue({ resetado_em: '2026-08-14T10:00:00.000Z' });

    const resultado = await aplicarResetLocal(db, baseURI);

    expect(verificarStatusReset).toHaveBeenCalledWith(baseURI);
    expect(execute).toHaveBeenCalledWith(db, 'DELETE FROM SYNC_ALTERACOES_PENDENTES');
    expect(execute).toHaveBeenCalledWith(db, 'DELETE FROM SYNC_VERSOES_SERVIDOR');
    expect(execute).toHaveBeenCalledWith(db, 'DELETE FROM SYNC_ERROS');
    expect(execute).toHaveBeenCalledWith(
      db, 'UPDATE ULTIMOS_REGISTROS_MATRIZ SET ULTIMO_REGISTRO_ATUALIZADO = 0, ULTIMO_REGISTRO_DELETADO = 0'
    );
    for (const nome of tabelasComSrvId) {
      expect(execute).toHaveBeenCalledWith(db, `UPDATE ${nome} SET SRV_ID = NULL WHERE SRV_ID IS NOT NULL`);
    }
    expect(execute).toHaveBeenCalledWith(
      db,
      expect.stringContaining('UPDATE OR INSERT INTO SYNC_RESET_STATUS'),
      [new Date('2026-08-14T10:00:00.000Z')]
    );
    expect(resultado).toEqual({ ok: true, resetadoEm: '2026-08-14T10:00:00.000Z' });
  });

  test('pula o UPDATE de SRV_ID numa tabela que não existe localmente', async () => {
    verificarStatusReset.mockResolvedValue({ resetado_em: '2026-08-14T10:00:00.000Z' });
    const primeira = tabelasComSrvId[0];
    tabelaExiste.mockImplementation((_db, nome) => Promise.resolve(nome !== primeira));

    await aplicarResetLocal(db, baseURI);

    expect(execute).not.toHaveBeenCalledWith(db, `UPDATE ${primeira} SET SRV_ID = NULL WHERE SRV_ID IS NOT NULL`);
  });

  test('uma falha isolada de execute não aborta os passos seguintes', async () => {
    verificarStatusReset.mockResolvedValue({ resetado_em: '2026-08-14T10:00:00.000Z' });
    execute.mockImplementation((_db, sql) => {
      if (sql === 'DELETE FROM SYNC_ERROS') return Promise.reject(new Error('travado'));
      return Promise.resolve();
    });

    const resultado = await aplicarResetLocal(db, baseURI);

    expect(execute).toHaveBeenCalledWith(
      db, 'UPDATE ULTIMOS_REGISTROS_MATRIZ SET ULTIMO_REGISTRO_ATUALIZADO = 0, ULTIMO_REGISTRO_DELETADO = 0'
    );
    expect(resultado.ok).toBe(true);
  });

  test('falha ao gravar o baseline propaga o erro (banner continua até novo clique)', async () => {
    verificarStatusReset.mockResolvedValue({ resetado_em: '2026-08-14T10:00:00.000Z' });
    execute.mockImplementation((_db, sql) => {
      if (typeof sql === 'string' && sql.includes('SYNC_RESET_STATUS')) return Promise.reject(new Error('disco cheio'));
      return Promise.resolve();
    });

    await expect(aplicarResetLocal(db, baseURI)).rejects.toThrow('disco cheio');
  });
});
