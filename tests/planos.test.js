const { PLANOS, PLANO_PADRAO, planoValido, listarPlanos } = require('../src/server/domain/planos');

describe('planoValido', () => {
  test.each(Object.keys(PLANOS))('"%s" é válido', (plano) => {
    expect(planoValido(plano)).toBe(true);
  });

  test('plano inexistente é inválido', () => {
    expect(planoValido('plano_inexistente')).toBe(false);
  });

  test('undefined/null são inválidos', () => {
    expect(planoValido(undefined)).toBe(false);
    expect(planoValido(null)).toBe(false);
  });
});

describe('listarPlanos', () => {
  test('retorna todos os planos com chave/nome', () => {
    const lista = listarPlanos();
    expect(lista).toHaveLength(Object.keys(PLANOS).length);
    lista.forEach(p => {
      expect(p).toHaveProperty('chave');
      expect(p).toHaveProperty('nome');
    });
  });

  test('PLANO_PADRAO é um plano válido', () => {
    expect(planoValido(PLANO_PADRAO)).toBe(true);
  });
});

// Features booleanas por plano (ex.: antiga "exportacao") migraram pro sistema de módulos
// (plano × role, ver domain/permissoes.js e domain/modulos.js) — cobertura em
// permissoes.integracao.test.js e planoInfo.integracao.test.js.
