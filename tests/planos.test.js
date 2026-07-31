const { PLANOS, PLANO_PADRAO, planoValido, listarPlanos, featuresDoPlano, planoTemFeature } = require('../src/planos');

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
  test('retorna todos os planos com chave/nome/features', () => {
    const lista = listarPlanos();
    expect(lista).toHaveLength(Object.keys(PLANOS).length);
    lista.forEach(p => {
      expect(p).toHaveProperty('chave');
      expect(p).toHaveProperty('nome');
      expect(p).toHaveProperty('features');
    });
  });
});

describe('featuresDoPlano', () => {
  test.each(Object.keys(PLANOS))('"%s" inclui demo.relatorio_avancado', (plano) => {
    expect(featuresDoPlano(plano)).toContain('demo.relatorio_avancado');
  });

  test('plano desconhecido retorna [] (fail-closed, não cai para PLANO_PADRAO)', () => {
    expect(featuresDoPlano('plano_inexistente')).toEqual([]);
  });

  test('PLANO_PADRAO é um plano válido', () => {
    expect(planoValido(PLANO_PADRAO)).toBe(true);
  });
});

describe('planoTemFeature', () => {
  test('true quando o plano tem a feature', () => {
    expect(planoTemFeature(PLANO_PADRAO, 'demo.relatorio_avancado')).toBe(true);
  });

  test('false quando o plano não tem a feature', () => {
    expect(planoTemFeature(PLANO_PADRAO, 'feature_inexistente')).toBe(false);
  });

  test('false para plano desconhecido', () => {
    expect(planoTemFeature('plano_inexistente', 'demo.relatorio_avancado')).toBe(false);
  });
});
