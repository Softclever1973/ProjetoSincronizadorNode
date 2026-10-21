// BLOB de texto: o push lê o conteúdo inteiro (CAST em pedaços) em vez da função de leitura do driver.
jest.mock('../src/client/infrastructure/firebird/db', () => ({ query: jest.fn(), execute: jest.fn() }));

const { query } = require('../src/client/infrastructure/firebird/db');
const { lerRegistroLocal } = require('../src/client/infrastructure/firebird/db-utils');
const { mockQueryPorSql } = require('./helpers/mockQuery');

const funcaoBlob = () => {};

beforeEach(() => jest.clearAllMocks());

describe('lerRegistroLocal', () => {
  test('junta os pedaços do BLOB, tira o ignorado e deixa o binário como estava', async () => {
    mockQueryPorSql(query, [
      ['RDB$FIELD_SUB_TYPE = 1', [{ COLUNA: 'OBS' }, { COLUNA: 'XML_SAT' }]],
      ['SELECT * FROM PEDIDOS_BLOB', [{ ID_PEDIDO: 7, NOME: 'x', OBS: funcaoBlob, XML_SAT: funcaoBlob, FOTO: funcaoBlob }]],
      ['CHAR_LENGTH(OBS)', [{ TAM_BLOB_0: 9000, OBS: 'a'.repeat(4000) }]],
      ['SUBSTRING(OBS FROM 4001', [{ PEDACO: 'b'.repeat(4000) }]],
      ['SUBSTRING(OBS FROM 8001', [{ PEDACO: 'c'.repeat(1000) }]],
    ]);

    const r = await lerRegistroLocal({}, 'PEDIDOS_BLOB', ['ID_PEDIDO'], [7], { naoLer: ['XML_SAT'] });

    expect(r.OBS).toBe('a'.repeat(4000) + 'b'.repeat(4000) + 'c'.repeat(1000));
    expect('XML_SAT' in r).toBe(false);
    expect(r.FOTO).toBe(funcaoBlob);
    expect(query.mock.calls.some(([, sql]) => sql.includes('XML_SAT') && sql.includes('CAST'))).toBe(false);
  });

  test('BLOB null continua null; registro inexistente devolve null', async () => {
    mockQueryPorSql(query, [
      ['RDB$FIELD_SUB_TYPE = 1', [{ COLUNA: 'OBS' }]],
      ['SELECT * FROM CLIENTES_BLOB', p => (p[0] === 1 ? [{ ID_CLIENTE: 1, OBS: null }] : [])],
      ['CHAR_LENGTH(OBS)', [{ TAM_BLOB_0: null, OBS: null }]],
    ]);

    expect(await lerRegistroLocal({}, 'CLIENTES_BLOB', ['ID_CLIENTE'], [1])).toEqual({ ID_CLIENTE: 1, OBS: null });
    expect(await lerRegistroLocal({}, 'CLIENTES_BLOB', ['ID_CLIENTE'], [2])).toBeNull();
  });

  test('mais de 3 BLOBs são lidos em mais de um SELECT', async () => {
    const cols = ['B1', 'B2', 'B3', 'B4'];
    mockQueryPorSql(query, [
      ['RDB$FIELD_SUB_TYPE = 1', cols.map(COLUNA => ({ COLUNA }))],
      ['SELECT * FROM T_BLOB', [{ ID: 1, ...Object.fromEntries(cols.map(c => [c, funcaoBlob])) }]],
      ['CHAR_LENGTH(B1)', [{ TAM_BLOB_0: 1, B1: '1', TAM_BLOB_1: 1, B2: '2', TAM_BLOB_2: 1, B3: '3' }]],
      ['CHAR_LENGTH(B4)', [{ TAM_BLOB_0: 1, B4: '4' }]],
    ]);

    expect(await lerRegistroLocal({}, 'T_BLOB', ['ID'], [1])).toEqual({ ID: 1, B1: '1', B2: '2', B3: '3', B4: '4' });
  });
});
