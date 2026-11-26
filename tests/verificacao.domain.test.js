// Regras de comparação da verificação: os formatos de cada lado chegam no mesmo valor canônico.
const { valorCanonico: c, chaveRegistro, compararHashes, camposDiferentes, tipoComparacao } = require('../src/client/domain/verificacao');

test.each([
  ['ISO UTC do push', '1970-01-01T14:42:06.000Z', '11:42:06'],
  ['site (hora local)', '11:42:06', '11:42:06'],
  ['timestamp sem fuso', '1970-01-01 11:42:06', '11:42:06'],
  ['depois das 21h vira 1970-01-02 em UTC', '1970-01-02T01:54:11.000Z', '22:54:11'],
])('hora: %s', (_n, valor, esperado) => expect(c(valor, 'hora')).toBe(esperado));

test.each([
  ['ISO UTC do push', '2026-10-14T03:00:00.000Z', '2026-10-14'],
  ['site', '2026-10-14', '2026-10-14'],
  ['timestamp', '2026-10-14 03:00:00', '2026-10-14'],
])('data: %s', (_n, valor, esperado) => expect(c(valor, 'data')).toBe(esperado));

test('Date do driver usa as partes locais', () => {
  expect(c(new Date(2026, 9, 14), 'data')).toBe('2026-10-14');
  expect(c(new Date(1970, 0, 1, 8, 5, 9), 'hora')).toBe('08:05:09');
  expect(c(new Date(2026, 9, 14, 8, 5, 9), 'datahora')).toBe('2026-10-14 08:05:09');
});

test('número, texto, booleano e vazio', () => {
  expect(c('101.0000', 'numero')).toBe('101');
  expect(c(101, 'numero')).toBe('101');
  expect(c('0.1234567', 'numero')).toBe('0.123457');
  expect(c('ABC   ', 'texto')).toBe('ABC');
  expect(c('   ', 'texto')).toBeNull();
  expect(c('a\x00b', 'texto')).toBe('ab');
  expect(c(true, 'booleano')).toBe('1');
  expect(c(undefined, 'texto')).toBeNull();
});

test('tipos do Firebird', () => {
  expect([12, 13, 35, 8, 23, 37].map(t => tipoComparacao(t, 0))).toEqual(['data', 'hora', 'datahora', 'numero', 'booleano', 'texto']);
  expect(tipoComparacao(261, 0)).toBeNull(); // BLOB binário fica de fora
  expect(tipoComparacao(261, 1)).toBe('textoLongo');
});

test('BLOB de texto: compara os primeiros 4000 caracteres; função de leitura nunca vira texto', () => {
  const longo = 'a'.repeat(5000);
  expect(c(longo, 'textoLongo')).toHaveLength(4000);
  expect(c(Buffer.from('obs  ', 'latin1'), 'textoLongo')).toBe('obs');
  expect(c((transaction, callback) => callback(), 'textoLongo')).toBeNull();
  expect(c(() => {}, 'texto')).toBeNull();
});

test('chave do registro e comparação', () => {
  expect(chaveRegistro({ A: 10.0, B: 'X  ' }, ['A', 'B'])).toBe('10|X');
  expect(chaveRegistro({ A: '10.00' }, ['A'])).toBe('10'); // NUMERIC do Postgres
  expect(chaveRegistro({ A: '0010' }, ['A'])).toBe('0010'); // PK de texto
  expect(chaveRegistro({ A: null }, ['A'])).toBeNull();
  const r = compararHashes(new Map([['1', 'a'], ['2', 'b'], ['3', 'c']]), new Map([['1', 'a'], ['2', 'x'], ['4', 'd']]));
  expect(r).toEqual({ iguais: ['1'], diferentes: ['2'], soServidor: ['3'], soFirebird: ['4'] });
  expect(camposDiferentes({ A: '1', B: '2' }, { A: '1', B: '3' }, ['A', 'B'])).toEqual([{ coluna: 'B', servidor: '2', firebird: '3' }]);
});
