// Mesmo motivo do sync.conflitos.test.js: factories explícitas evitam carregar os módulos
// reais (../db exige Firebird real no require).
jest.mock('../src/client/db', () => ({
  query: jest.fn(),
  execute: jest.fn(),
}));
jest.mock('../src/client/http', () => ({
  enviarRegistro: jest.fn(),
}));
jest.mock('../src/client/conflitos', () => ({
  atualizarOuSalvarConflito: jest.fn(),
}));
jest.mock('../src/client/echos', () => ({
  registrarEcho: jest.fn(),
}));
jest.mock('../src/client/erros', () => ({
  salvarErro: jest.fn(),
}));

const { query, execute } = require('../src/client/db');
const { enviarRegistro } = require('../src/client/http');
const { atualizarOuSalvarConflito } = require('../src/client/conflitos');
const { registrarEcho } = require('../src/client/echos');
const { empurrarTabela } = require('../src/client/push');
const { mockQueryPorSql: mockQueryPorSqlHelper } = require('./helpers/mockQuery');

const noopLog = () => {};

const configBase = {
  nome: 'MOVIMENTACOES',
  pk: 'ID_MOVIMENTACAO',
};

function mockQueryPorSql(respostas) {
  mockQueryPorSqlHelper(query, respostas);
}

function mockExecuteRejeitandoSql(trechoQueDeveFalhar, erro) {
  execute.mockImplementation((db, sql) => {
    if (sql.includes(trechoQueDeveFalhar)) return Promise.reject(erro);
    return Promise.resolve(undefined);
  });
}

function chamadasExecuteComTrecho(trecho) {
  return execute.mock.calls.filter(([, sql]) => sql.includes(trecho));
}

beforeEach(() => {
  jest.clearAllMocks();
  execute.mockResolvedValue(undefined);
});

describe('empurrarTabela — sem pendentes', () => {
  test('não faz nenhuma chamada de rede quando não há pendentes', async () => {
    mockQueryPorSql([['SYNC_ALTERACOES_PENDENTES', []]]);

    await empurrarTabela({}, 'http://servidor-teste', 5, configBase, noopLog);

    expect(enviarRegistro).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('empurrarTabela — registro deletado localmente antes do push', () => {
  test('envia a deleção ao servidor e limpa o pendente', async () => {
    mockQueryPorSql([
      ['SYNC_ALTERACOES_PENDENTES', [{ PK_VALOR: '14760' }]],
      [`SELECT * FROM ${configBase.nome}`, []], // não existe mais localmente
    ]);
    enviarRegistro.mockResolvedValue({});

    await empurrarTabela({}, 'http://servidor-teste', 5, configBase, noopLog);

    expect(enviarRegistro).toHaveBeenCalledWith(
      'http://servidor-teste', 5, 'MOVIMENTACOES', 'ID_MOVIMENTACAO',
      { ID_MOVIMENTACAO: '14760' }, 0, false, null, '', true
    );
    expect(chamadasExecuteComTrecho('DELETE FROM SYNC_ALTERACOES_PENDENTES')).toHaveLength(1);
  });
});

describe('empurrarTabela — FK referenciando um pai sem SRV_ID ainda (o caso do print)', () => {
  const configComFk = {
    ...configBase,
    fks: [{ coluna: 'ID_PRODUTO', tabela: 'PRODUTOS', traduzirSrvId: true, pkRef: 'ID_PRODUTO' }],
  };

  test('reenfileira o produto pai e pula o envio deste registro', async () => {
    mockQueryPorSql([
      ['SYNC_ALTERACOES_PENDENTES', [{ PK_VALOR: '14760' }]],
      [`SELECT * FROM ${configBase.nome}`, [{ ID_MOVIMENTACAO: 14760, ID_PRODUTO: 777, ID_LOJA: 5 }]],
      // PRODUTOS existe localmente mas ainda não foi pushado — SRV_ID nulo, não linha ausente
      ['SELECT FIRST 1 SRV_ID FROM PRODUTOS', [{ SRV_ID: null }]],
    ]);

    await empurrarTabela({}, 'http://servidor-teste', 5, configComFk, noopLog);

    expect(enviarRegistro).not.toHaveBeenCalled();
    const reenfileiramentos = chamadasExecuteComTrecho('UPDATE OR INSERT INTO SYNC_ALTERACOES_PENDENTES');
    expect(reenfileiramentos).toHaveLength(1);
    expect(reenfileiramentos[0][2]).toEqual(['PRODUTOS', '777']);
  });

  test('produto pai não existe mais localmente (deletado): envia o registro mesmo assim, sem o vínculo (FK=null)', async () => {
    mockQueryPorSql([
      ['SYNC_ALTERACOES_PENDENTES', [{ PK_VALOR: '14760' }]],
      [`SELECT * FROM ${configBase.nome}`, [{ ID_MOVIMENTACAO: 14760, ID_PRODUTO: 777, ID_LOJA: 5 }]],
      ['SELECT FIRST 1 SRV_ID FROM PRODUTOS', []], // produto 777 não existe mais (foi deletado)
      ['SYNC_VERSOES_SERVIDOR', []],
    ]);
    const { salvarErro } = require('../src/client/erros');
    enviarRegistro.mockResolvedValue({ novoId: 999 });

    await empurrarTabela({}, 'http://servidor-teste', 5, configComFk, noopLog);

    // FK não é obrigatória: o registro é enviado do mesmo jeito, com o campo em branco
    expect(enviarRegistro).toHaveBeenCalledWith(
      'http://servidor-teste', 5, 'MOVIMENTACOES', 'ID_MOVIMENTACAO',
      expect.objectContaining({ ID_MOVIMENTACAO: 14760, ID_PRODUTO: null }),
      0, false, null, '', false, false
    );
    // não reenfileira o pai — ele nunca vai existir de novo, reenfileirar causaria loop infinito
    expect(chamadasExecuteComTrecho('UPDATE OR INSERT INTO SYNC_ALTERACOES_PENDENTES')).toHaveLength(0);
    expect(salvarErro).not.toHaveBeenCalled();
  });

  test('FK resolvida: traduz o ID local para SRV_ID antes de enviar', async () => {
    mockQueryPorSql([
      ['SYNC_ALTERACOES_PENDENTES', [{ PK_VALOR: '14760' }]],
      [`SELECT * FROM ${configBase.nome}`, [{ ID_MOVIMENTACAO: 14760, ID_PRODUTO: 777, ID_LOJA: 5 }]],
      ['SELECT FIRST 1 SRV_ID FROM PRODUTOS', [{ SRV_ID: 500 }]],
      ['SYNC_VERSOES_SERVIDOR', []],
    ]);
    enviarRegistro.mockResolvedValue({ novoId: 999 });

    await empurrarTabela({}, 'http://servidor-teste', 5, configComFk, noopLog);

    expect(enviarRegistro).toHaveBeenCalledWith(
      'http://servidor-teste', 5, 'MOVIMENTACOES', 'ID_MOVIMENTACAO',
      expect.objectContaining({ ID_PRODUTO: 500 }), // traduzido de 777 (local) para 500 (SRV_ID)
      0, false, null, '', false, false
    );
    expect(registrarEcho).toHaveBeenCalledWith('MOVIMENTACOES', '14760', 999);
  });
});

describe('empurrarTabela — múltiplos pendentes no mesmo ciclo', () => {
  test('um registro bloqueado por FK não impede o envio dos demais', async () => {
    const configComFk = {
      ...configBase,
      fks: [{ coluna: 'ID_PRODUTO', tabela: 'PRODUTOS', traduzirSrvId: true, pkRef: 'ID_PRODUTO' }],
    };

    mockQueryPorSql([
      ['SYNC_ALTERACOES_PENDENTES', [{ PK_VALOR: '100' }, { PK_VALOR: '200' }]],
      [`SELECT * FROM ${configBase.nome}`, (params) => (
        params[0] === '100'
          ? [{ ID_MOVIMENTACAO: 100, ID_PRODUTO: 111, ID_LOJA: 5 }]
          : [{ ID_MOVIMENTACAO: 200, ID_PRODUTO: 222, ID_LOJA: 5 }]
      )],
      // produto 111 já foi pushado (tem SRV_ID) — produto 222 existe mas ainda não
      ['SELECT FIRST 1 SRV_ID FROM PRODUTOS', (params) => (params[0] === 111 ? [{ SRV_ID: 500 }] : [{ SRV_ID: null }])],
      ['SYNC_VERSOES_SERVIDOR', []],
    ]);
    enviarRegistro.mockResolvedValue({ novoId: 1 });

    await empurrarTabela({}, 'http://servidor-teste', 5, configComFk, noopLog);

    // registro 100: FK resolvida → enviado normalmente, com o ID já traduzido para SRV_ID
    expect(enviarRegistro).toHaveBeenCalledWith(
      'http://servidor-teste', 5, 'MOVIMENTACOES', 'ID_MOVIMENTACAO',
      expect.objectContaining({ ID_MOVIMENTACAO: 100, ID_PRODUTO: 500 }),
      0, false, null, '', false, false
    );
    // registro 200 nunca chega a ser enviado — só o 100 gerou uma chamada de rede
    expect(enviarRegistro).toHaveBeenCalledTimes(1);
    // o produto 222 (pai não resolvido) foi reenfileirado para o próximo ciclo
    const reenfileiramentos = chamadasExecuteComTrecho('UPDATE OR INSERT INTO SYNC_ALTERACOES_PENDENTES');
    expect(reenfileiramentos.some(([, , params]) => params[0] === 'PRODUTOS' && params[1] === '222')).toBe(true);
  });
});

describe('empurrarTabela — conflito retornado pelo servidor', () => {
  test('salva o conflito e limpa o pendente, sem lançar exceção', async () => {
    const versaoServidor = { ID_MOVIMENTACAO: 14760, VALOR: 'do servidor' };
    mockQueryPorSql([
      ['SYNC_ALTERACOES_PENDENTES', [{ PK_VALOR: '14760' }]],
      [`SELECT * FROM ${configBase.nome}`, [{ ID_MOVIMENTACAO: 14760, ID_LOJA: 5 }]],
    ]);
    enviarRegistro.mockResolvedValue({ conflito: true, versaoServidor });

    await empurrarTabela({}, 'http://servidor-teste', 5, configBase, noopLog);

    expect(atualizarOuSalvarConflito).toHaveBeenCalledWith(
      expect.objectContaining({ tabela: 'MOVIMENTACOES', pkValor: '14760', versaoServidor })
    );
    expect(chamadasExecuteComTrecho('DELETE FROM SYNC_ALTERACOES_PENDENTES')).toHaveLength(1);
  });
});

describe('empurrarTabela — colunasAbsolutas (lado "push" do par de inversão de sinal de estoque)', () => {
  const configComAbsoluta = { ...configBase, colunasAbsolutas: ['QUANTIDADE'] };

  test('Saída negativa gravada no Firebird é enviada ao servidor como positiva', async () => {
    mockQueryPorSql([
      ['SYNC_ALTERACOES_PENDENTES', [{ PK_VALOR: '14760' }]],
      [`SELECT * FROM ${configBase.nome}`, [{ ID_MOVIMENTACAO: 14760, QUANTIDADE: -5, ID_LOJA: 5 }]],
    ]);
    enviarRegistro.mockResolvedValue({});

    await empurrarTabela({}, 'http://servidor-teste', 5, configComAbsoluta, noopLog);

    expect(enviarRegistro).toHaveBeenCalledWith(
      'http://servidor-teste', 5, 'MOVIMENTACOES', 'ID_MOVIMENTACAO',
      expect.objectContaining({ QUANTIDADE: 5 }), // -5 (Firebird) → 5 (servidor só aceita positivo)
      0, false, null, '', false, false
    );
  });

  test('Entrada já positiva é enviada sem alteração', async () => {
    mockQueryPorSql([
      ['SYNC_ALTERACOES_PENDENTES', [{ PK_VALOR: '14761' }]],
      [`SELECT * FROM ${configBase.nome}`, [{ ID_MOVIMENTACAO: 14761, QUANTIDADE: 5, ID_LOJA: 5 }]],
    ]);
    enviarRegistro.mockResolvedValue({});

    await empurrarTabela({}, 'http://servidor-teste', 5, configComAbsoluta, noopLog);

    expect(enviarRegistro).toHaveBeenCalledWith(
      'http://servidor-teste', 5, 'MOVIMENTACOES', 'ID_MOVIMENTACAO',
      expect.objectContaining({ QUANTIDADE: 5 }),
      0, false, null, '', false, false
    );
  });
});

describe('empurrarTabela — grava SRV_ID local após push, mas o UPDATE falha', () => {
  test('re-enfileira o registro para o próximo ciclo tentar de novo (não perde o SRV_ID)', async () => {
    const configComSrvId = { ...configBase, srvId: true };
    mockQueryPorSql([
      ['SYNC_ALTERACOES_PENDENTES', [{ PK_VALOR: '14760' }]],
      [`SELECT * FROM ${configBase.nome}`, [{ ID_MOVIMENTACAO: 14760, ID_LOJA: 5 }]],
    ]);
    enviarRegistro.mockResolvedValue({ srvId: 321 });
    mockExecuteRejeitandoSql('SET SRV_ID', new Error('lock timeout'));

    await empurrarTabela({}, 'http://servidor-teste', 5, configComSrvId, noopLog);

    const reenfileiramentos = chamadasExecuteComTrecho('UPDATE OR INSERT INTO SYNC_ALTERACOES_PENDENTES');
    expect(reenfileiramentos).toHaveLength(1);
    expect(reenfileiramentos[0][2]).toEqual(['MOVIMENTACOES', '14760']);
  });
});
