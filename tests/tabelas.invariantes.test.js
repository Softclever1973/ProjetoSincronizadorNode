const TABELAS = require('../src/client/domain/tabelas');

describe('tabelas.js — invariantes da configuração', () => {
  test('todo filtroFilialViaFK aponta para uma tabela pai com filtroFilial, declarada antes', () => {
    TABELAS.filter(t => t.filtroFilialViaFK).forEach(t => {
      const idxPai = TABELAS.findIndex(p => p.nome === t.filtroFilialViaTabela);
      expect({ tabela: t.nome, paiExiste: idxPai >= 0 }).toEqual({ tabela: t.nome, paiExiste: true });
      expect({ tabela: t.nome, paiTemFiltro: !!TABELAS[idxPai].filtroFilial }).toEqual({ tabela: t.nome, paiTemFiltro: true });
      expect(idxPai).toBeLessThan(TABELAS.indexOf(t));
    });
  });

  test('NOTAS_FISCAIS_ITENS filtra via NOTAS_FISCAIS (bug antigo: PEDIDOS)', () => {
    expect(TABELAS.find(t => t.nome === 'NOTAS_FISCAIS_ITENS').filtroFilialViaTabela).toBe('NOTAS_FISCAIS');
  });

  test('FK com traduzirSrvId sempre informa pkRef', () => {
    TABELAS.forEach(t => t.fks.filter(f => f.traduzirSrvId).forEach(f => {
      expect({ tabela: t.nome, coluna: f.coluna, pkRef: !!f.pkRef }).toEqual({ tabela: t.nome, coluna: f.coluna, pkRef: true });
    }));
  });
});
