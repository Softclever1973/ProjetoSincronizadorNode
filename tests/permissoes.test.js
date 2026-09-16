const { permissaoEfetiva, resolverPermissoesEfetivas, podeLer, podeEscrever } = require('../src/server/domain/permissoes');
const { MODULOS } = require('../src/server/domain/modulos');

function mapa(obj) { return new Map(Object.entries(obj)); }

describe('permissaoEfetiva — interseção plano ∩ role', () => {
  test.each([
    ['--', '--', '--'],
    ['--', 'r-', '--'],
    ['--', 'rw', '--'],
    ['r-', '--', '--'],
    ['r-', 'r-', 'r-'],
    ['r-', 'rw', 'r-'],
    ['rw', '--', '--'],
    ['rw', 'r-', 'r-'],
    ['rw', 'rw', 'rw'],
  ])('plano=%s, role=%s -> %s', (nivelPlano, nivelRole, esperado) => {
    const matrizPlano = mapa({ financeiro: nivelPlano });
    const matrizRole  = mapa({ financeiro: nivelRole });
    expect(permissaoEfetiva(matrizPlano, matrizRole, 'financeiro')).toBe(esperado);
  });

  test('plano desconhecido (Map ausente) é fail-closed para --, independente do role', () => {
    const matrizRole = mapa({ financeiro: 'rw' });
    expect(permissaoEfetiva(undefined, matrizRole, 'financeiro')).toBe('--');
  });

  test('role desconhecida (Map ausente) é fail-closed para --, independente do plano', () => {
    const matrizPlano = mapa({ financeiro: 'rw' });
    expect(permissaoEfetiva(matrizPlano, undefined, 'financeiro')).toBe('--');
  });

  test('módulo ausente em ambas as matrizes é fail-closed para --', () => {
    const matrizPlano = mapa({ produtos: 'rw' });
    const matrizRole  = mapa({ produtos: 'rw' });
    expect(permissaoEfetiva(matrizPlano, matrizRole, 'financeiro')).toBe('--');
  });
});

describe('resolverPermissoesEfetivas', () => {
  test('retorna uma entrada para cada módulo conhecido, mesmo com matrizes esparsas', () => {
    const matrizPlano = mapa({ produtos: 'rw' });
    const matrizRole  = mapa({ produtos: 'rw', financeiro: 'rw' });
    const resultado = resolverPermissoesEfetivas(matrizPlano, matrizRole);
    expect(Object.keys(resultado).sort()).toEqual([...MODULOS].sort());
    expect(resultado.produtos).toBe('rw');
    expect(resultado.financeiro).toBe('--'); // plano não libera, mesmo role liberando
    expect(resultado.clientes).toBe('--');   // ausente nas duas matrizes
  });
});

describe('podeLer / podeEscrever', () => {
  test.each([
    ['--', false, false],
    ['r-', true, false],
    ['rw', true, true],
  ])('nivel=%s -> podeLer=%s, podeEscrever=%s', (nivel, esperaLer, esperaEscrever) => {
    expect(podeLer(nivel)).toBe(esperaLer);
    expect(podeEscrever(nivel)).toBe(esperaEscrever);
  });
});
