// Tabelas com parametroAtivo: o PARAMETROS do Firebird decide o sync, não o toggle (ex.: 117 = S → listas de preço).
jest.mock('../src/client/infrastructure/firebird/db.js', () => ({ getParam: jest.fn() }));
const fs = require('fs');
const { getParam } = require('../src/client/infrastructure/firebird/db.js');
const { tabelaAtiva, atualizarParametrosTabelas, controlePorParametro } = require('../src/client/infrastructure/config/tabelasConfig.js');
const TABELAS = require('../src/client/domain/tabelas.js');

const comParam117 = valor => getParam.mockImplementation(async (_db, id) => (id === 117 ? valor : ''));

beforeEach(() => jest.restoreAllMocks());

test('LISTA_PRECOS e PRODUTOS_X_LISTA dependem do parâmetro 117', () => {
  const condicionadas = TABELAS.filter(t => t.parametroAtivo).map(t => t.nome).sort();
  expect(condicionadas).toEqual(['LISTA_PRECOS', 'PRODUTOS_X_LISTA']);
  for (const nome of condicionadas) expect(TABELAS.find(t => t.nome === nome).parametroAtivo).toEqual({ id: 117, valor: 'S' });
});

test('117 = S ativa, mesmo com o toggle salvo como desligado', async () => {
  jest.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({ LISTA_PRECOS: false, PRODUTOS_X_LISTA: false }));
  comParam117('s');
  await atualizarParametrosTabelas({});
  expect(tabelaAtiva('LISTA_PRECOS')).toBe(true);
  expect(tabelaAtiva('PRODUTOS_X_LISTA')).toBe(true);
  expect(controlePorParametro('LISTA_PRECOS')).toMatchObject({ id: 117, atual: 'S', ativa: true });
});

test.each(['N', ''])('117 = "%s" desativa, mesmo com o toggle salvo como ligado', async valor => {
  jest.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({ LISTA_PRECOS: true, PRODUTOS_X_LISTA: true }));
  comParam117(valor);
  await atualizarParametrosTabelas({});
  expect(tabelaAtiva('LISTA_PRECOS')).toBe(false);
  expect(tabelaAtiva('PRODUTOS_X_LISTA')).toBe(false);
});

test('falha ao ler o parâmetro deixa a tabela inativa', async () => {
  comParam117('S');
  await atualizarParametrosTabelas({});
  getParam.mockRejectedValue(new Error('Firebird fora'));
  await atualizarParametrosTabelas({});
  expect(tabelaAtiva('LISTA_PRECOS')).toBe(false);
});

test('tabela sem parametroAtivo continua seguindo o toggle', () => {
  jest.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({ PRODUTOS: false }));
  expect(controlePorParametro('PRODUTOS')).toBeNull();
  expect(tabelaAtiva('PRODUTOS')).toBe(false);
});
