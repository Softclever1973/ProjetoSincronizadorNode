// MOVIMENTACOES com DATA/HORA em texto: o ORDER BY compara site (hora local simples) e client (ISO UTC) na mesma base.
const { expressaoOrdenacao } = require('../src/server/interfaces/http/routes/api/hooks/movimentacoes.hooks');

test('DATA e HORA em texto ganham expressão; outras colunas e tipos não', () => {
  expect(expressaoOrdenacao('DATA', 'text')).toBe('LEFT(DATA, 10)');
  expect(expressaoOrdenacao('HORA', 'text')).toMatch(/to_char\(HORA::timestamptz, 'HH24:MI:SS'\)/);
  expect(expressaoOrdenacao('HORA', 'character varying')).not.toBeNull();
  expect(expressaoOrdenacao('HORA', 'timestamp without time zone')).toBeNull();
  expect(expressaoOrdenacao('SRV_ID', 'integer')).toBeNull();
  expect(expressaoOrdenacao('OBS', 'text')).toBeNull();
});
