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

describe('permissaoEfetiva — funções binárias (Liberado)', () => {
  const plano = mapa({ pedidos: 'rw', pedidos_inserir: 'rw' });

  test("'r-' herdado do role vale como liberado ('rw'), igual a tela mostra", () => {
    const role = mapa({ pedidos: 'rw', pedidos_inserir: 'r-' });
    expect(permissaoEfetiva(plano, role, 'pedidos_inserir')).toBe('rw');
  });

  test("override de empresa 'r-' também vale como liberado", () => {
    const role = mapa({ pedidos: 'rw', pedidos_inserir: '--' });
    expect(permissaoEfetiva(plano, role, 'pedidos_inserir', mapa({ pedidos_inserir: 'r-' }))).toBe('rw');
  });

  test("pai em 'r-' continua capando a função binária (sem escrita)", () => {
    const role = mapa({ pedidos: 'r-', pedidos_inserir: 'rw' });
    expect(podeEscrever(permissaoEfetiva(plano, role, 'pedidos_inserir'))).toBe(false);
  });

  test("função não binária mantém 'r-' (produtos_movimentacao)", () => {
    const p = mapa({ produtos: 'rw', produtos_movimentacao: 'rw' });
    const role = mapa({ produtos: 'rw', produtos_movimentacao: 'r-' });
    expect(permissaoEfetiva(p, role, 'produtos_movimentacao')).toBe('r-');
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
