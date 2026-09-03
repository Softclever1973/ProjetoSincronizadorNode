const { renderCampos } = require('../src/client/interfaces/webui/viewHelpers');

describe('renderCampos — colunas de controle não devem contar como campo divergente', () => {
  test('ID_ULTIMA_ATUALIZACAO_MATRIZ (local NULL, servidor com valor) não gera divergência', () => {
    const versaoLocal    = { ID_PRODUTO: 1, NOME: 'Produto X', ID_ULTIMA_ATUALIZACAO_MATRIZ: null };
    const versaoServidor = { ID_PRODUTO: 1, NOME: 'Produto X', ID_ULTIMA_ATUALIZACAO_MATRIZ: 1925 };

    const { numDivergentes, divergentesTable } = renderCampos(versaoLocal, versaoServidor, 'c1');

    expect(numDivergentes).toBe(0);
    expect(divergentesTable).not.toContain('ID_ULTIMA_ATUALIZACAO_MATRIZ');
  });

  test('campo de negócio realmente diferente continua sendo reportado', () => {
    const versaoLocal    = { ID_PRODUTO: 1, NOME: 'Produto X', ID_ULTIMA_ATUALIZACAO_MATRIZ: null };
    const versaoServidor = { ID_PRODUTO: 1, NOME: 'Produto Y', ID_ULTIMA_ATUALIZACAO_MATRIZ: 1925 };

    const { numDivergentes, divergentesTable } = renderCampos(versaoLocal, versaoServidor, 'c2');

    expect(numDivergentes).toBe(1);
    expect(divergentesTable).toContain('NOME');
    expect(divergentesTable).not.toContain('ID_ULTIMA_ATUALIZACAO_MATRIZ');
  });
});
