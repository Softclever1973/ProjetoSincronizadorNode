// Factories explícitas (em vez de automock): os módulos reais de ../db, ../cursor etc.
// exigem FIREBIRD_DATABASE/FIREBIRD_PASSWORD no .env no require — automock ainda carrega
// o módulo real para inspecionar o shape, o que dispararia esse erro fora de um Firebird real.
jest.mock('../src/client/infrastructure/firebird/db', () => ({
  query: jest.fn(),
  execute: jest.fn(),
}));
jest.mock('../src/client/cursor', () => ({
  getUltimaAtualizacao: jest.fn(),
  getUltimaDelecao: jest.fn(),
  salvarCursor: jest.fn(),
}));
jest.mock('../src/client/echos', () => ({
  consumirEcho: jest.fn(),
  registrarEcho: jest.fn(),
}));
jest.mock('../src/client/http', () => ({
  buscarRegistrosParaAtualizar: jest.fn(),
  buscarRegistrosParaDeletar: jest.fn(),
  buscarProdutosParaAtualizar: jest.fn(),
}));
jest.mock('../src/client/infrastructure/persistence/conflitos', () => ({
  salvarConflito: jest.fn(),
}));
jest.mock('../src/client/infrastructure/firebird/db-utils', () => ({
  getFKRefs: jest.fn().mockResolvedValue([]),
  gerarNovoPK: jest.fn(),
  renomearPKLocal: jest.fn(),
}));

const { query, execute } = require('../src/client/infrastructure/firebird/db');
const { getUltimaAtualizacao, getUltimaDelecao, salvarCursor } = require('../src/client/cursor');
const { consumirEcho } = require('../src/client/echos');
const { buscarRegistrosParaAtualizar, buscarRegistrosParaDeletar } = require('../src/client/http');
const { salvarConflito } = require('../src/client/infrastructure/persistence/conflitos');
const { sincronizarTabela, _resetCachesParaTeste } = require('../src/client/sync');

const noopLog = () => {};

const configBase = {
  nome: 'PRODUTOS',
  pk: 'ID_PRODUTO',
  temDelete: false,
  endpoint: null,
  filtroFilial: null,
  generator: null,
  colunaData: null,
};

// Roda sincronizarTabela por um único ciclo: o servidor devolve `registro` na
// primeira chamada e [] na segunda, para que o while() interno pare sozinho.
function rodarCiclo(registro, configOverrides = {}) {
  buscarRegistrosParaAtualizar
    .mockResolvedValueOnce([registro])
    .mockResolvedValueOnce([]);

  return sincronizarTabela(
    {}, 'http://servidor-teste', 1,
    { ...configBase, ...configOverrides },
    noopLog
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  // sync.js mantém caches de colunas por nome de tabela fora do jest.fn() (estado real
  // do módulo) — sem isso, um teste que reusa um nome de tabela herda o cache "quente"
  // do teste anterior e as mockResolvedValueOnce de metadado ficam sem consumidor,
  // vazando para as próximas queries do teste seguinte.
  _resetCachesParaTeste();
  getUltimaAtualizacao.mockResolvedValue(0);
  getUltimaDelecao.mockResolvedValue(0);
  salvarCursor.mockResolvedValue(undefined);
  execute.mockResolvedValue(undefined);
  consumirEcho.mockReturnValue(false);
});

describe('sincronizarTabela — colisão de PK (pendente local + nunca recebido do servidor)', () => {
  test('registro deletado localmente: apenas avança o cursor, sem conflito', async () => {
    const registro = { ID_PRODUTO: 99, ID_ULTIMA_ATUALIZACAO_MATRIZ: 500 };

    query
      .mockResolvedValueOnce([{}])   // SYNC_ALTERACOES_PENDENTES → pendente=true
      .mockResolvedValueOnce([])     // SYNC_VERSOES_SERVIDOR → nunca recebido (versaoConhecida=[])
      .mockResolvedValueOnce([]);    // SELECT * FROM PRODUTOS WHERE PK → não existe local (foi deletado)

    await rodarCiclo(registro);

    expect(salvarConflito).not.toHaveBeenCalled();
    expect(salvarCursor).toHaveBeenCalledWith({}, 'PRODUTOS', 500, 0);
  });

  test('colisão real: dois registros criados independentemente com o mesmo PK gera conflito', async () => {
    const registro = { ID_PRODUTO: 99, ID_ULTIMA_ATUALIZACAO_MATRIZ: 500 };
    const localExistente = { ID_PRODUTO: 99, NOME: 'Criado localmente' };

    query
      .mockResolvedValueOnce([{}])                // pendente=true
      .mockResolvedValueOnce([])                  // nunca recebido
      .mockResolvedValueOnce([localExistente]);    // SELECT local → existe (colisão real)

    await rodarCiclo(registro);

    expect(salvarConflito).toHaveBeenCalledWith(
      expect.objectContaining({
        tabela: 'PRODUTOS',
        pkValor: '99',
        versaoLocal: localExistente,
        versaoServidor: registro,
      })
    );
    expect(salvarCursor).toHaveBeenCalledWith({}, 'PRODUTOS', 500, 0);
  });
});

describe('sincronizarTabela — pendente local + registro já conhecido dos dois lados', () => {
  test('servidor não mudou desde o último sync: avança cursor sem conflito (push local vai resolver)', async () => {
    const registro = { ID_PRODUTO: 10, ID_ULTIMA_ATUALIZACAO_MATRIZ: 500 };

    query
      .mockResolvedValueOnce([{}])                                  // pendente=true
      .mockResolvedValueOnce([{ ID_ULTIMA_ATUALIZACAO_MATRIZ: 500 }]); // versaoConhecida == versaoServidor

    await rodarCiclo(registro);

    expect(salvarConflito).not.toHaveBeenCalled();
    expect(salvarCursor).toHaveBeenCalledWith({}, 'PRODUTOS', 500, 0);
  });

  test('servidor tem versão mais nova E há mudança local pendente: conflito real', async () => {
    const registro = { ID_PRODUTO: 20, ID_ULTIMA_ATUALIZACAO_MATRIZ: 200 };
    const localRow = { ID_PRODUTO: 20, NOME: 'Alterado localmente' };

    query
      .mockResolvedValueOnce([{}])                                  // pendente=true
      .mockResolvedValueOnce([{ ID_ULTIMA_ATUALIZACAO_MATRIZ: 100 }]) // versaoConhecida=100 < versaoServidor=200
      .mockResolvedValueOnce([localRow]);                           // SELECT local → encontrado

    await rodarCiclo(registro);

    expect(salvarConflito).toHaveBeenCalledWith(
      expect.objectContaining({
        tabela: 'PRODUTOS',
        pkValor: '20',
        versaoLocal: localRow,
        versaoServidor: registro,
      })
    );
    // remove o registro de SYNC_ALTERACOES_PENDENTES para não reenviar a versão antiga
    expect(execute).toHaveBeenCalledWith(
      {},
      expect.stringContaining('DELETE FROM SYNC_ALTERACOES_PENDENTES'),
      ['PRODUTOS', '20']
    );
    expect(salvarCursor).toHaveBeenCalledWith({}, 'PRODUTOS', 200, 0);
  });
});

describe('sincronizarTabela — eco de push (sem pendente local)', () => {
  test('registro é o eco do próprio push: avança cursor sem reaplicar upsert', async () => {
    const registro = { ID_PRODUTO: 30, ID_ULTIMA_ATUALIZACAO_MATRIZ: 300 };

    query
      .mockResolvedValueOnce([])                                    // sem pendente
      .mockResolvedValueOnce([{ ID_ULTIMA_ATUALIZACAO_MATRIZ: 10 }]); // irrelevante para este ramo
    consumirEcho.mockReturnValue(true);

    await rodarCiclo(registro);

    expect(consumirEcho).toHaveBeenCalledWith('PRODUTOS', '30', 300);
    expect(salvarCursor).toHaveBeenCalledWith({}, 'PRODUTOS', 300, 0);
    expect(salvarConflito).not.toHaveBeenCalled();
    // só as 2 queries de decisão rodaram — nenhuma query de metadado do upsertRegistro
    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe('sincronizarTabela — proteção contra overwrite (nunca visto do servidor, sem pendente)', () => {
  test('registro já existe localmente sem histórico de sync: salva conflito em vez de sobrescrever', async () => {
    const registro = { ID_PRODUTO: 40, ID_ULTIMA_ATUALIZACAO_MATRIZ: 400 };
    const localRow = { ID_PRODUTO: 40, NOME: 'Dado local não sincronizado' };

    query
      .mockResolvedValueOnce([])              // sem pendente
      .mockResolvedValueOnce([])              // nunca recebido do servidor
      .mockResolvedValueOnce([localRow]);     // mas já existe localmente

    await rodarCiclo(registro);

    expect(salvarConflito).toHaveBeenCalledWith(
      expect.objectContaining({
        tabela: 'PRODUTOS',
        pkValor: '40',
        versaoLocal: localRow,
        versaoServidor: registro,
      })
    );
    expect(salvarCursor).toHaveBeenCalledWith({}, 'PRODUTOS', 400, 0);
    // proteção age antes do upsertRegistro — nenhuma query de metadado deve rodar
    expect(query).toHaveBeenCalledTimes(3);
  });
});

describe('sincronizarTabela — caminho normal (sem pendente, sem eco, sem dado local prévio)', () => {
  test('aplica o upsert normalmente e registra a versão do servidor', async () => {
    const registro = { ID_PRODUTO: 55, NOME: 'Produto Novo', ID_ULTIMA_ATUALIZACAO_MATRIZ: 700 };

    query
      .mockResolvedValueOnce([])   // sem pendente
      .mockResolvedValueOnce([])   // nunca recebido do servidor
      .mockResolvedValueOnce([])   // proteção overwrite: não existe local → segue pro upsert
      .mockResolvedValueOnce([])                                     // getColunasComputadas → nenhuma
      .mockResolvedValueOnce([{ COLUNA: 'ID_PRODUTO' }, { COLUNA: 'NOME' }]) // getColunasExistentes
      .mockResolvedValueOnce([])   // getColunasNaoNulas → nenhuma
      .mockResolvedValueOnce([]);  // getTamanhosColunas → nenhuma

    await rodarCiclo(registro, { nome: 'PRODUTOS_TESTE_UPSERT' });

    expect(salvarConflito).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith(
      {},
      expect.stringContaining('UPDATE OR INSERT INTO PRODUTOS_TESTE_UPSERT'),
      expect.arrayContaining([55, 'Produto Novo'])
    );
    expect(salvarCursor).toHaveBeenCalledWith({}, 'PRODUTOS_TESTE_UPSERT', 700, 0);
  });
});

describe('sincronizarTabela — normalizarSinal (lado "pull" do par de inversão de sinal de estoque)', () => {
  test('Saída positiva vinda do servidor é gravada negativa no Firebird local', async () => {
    const registro = {
      ID_MOVIMENTACAO: 77,
      TIPO_MOVIMENTACAO: 'Saída',
      QUANTIDADE: 5, // servidor sempre manda positivo — quem indica direção é TIPO_MOVIMENTACAO
      ID_ULTIMA_ATUALIZACAO_MATRIZ: 900,
    };
    const configTabela = {
      nome: 'MOVIMENTACOES_TESTE',
      pk: 'ID_MOVIMENTACAO',
      normalizarSinal: { coluna: 'QUANTIDADE', colunaRef: 'TIPO_MOVIMENTACAO', negativoQuando: ['Saída'] },
    };

    query
      .mockResolvedValueOnce([])   // sem pendente
      .mockResolvedValueOnce([])   // nunca recebido do servidor
      .mockResolvedValueOnce([])   // proteção overwrite: não existe local → segue pro upsert
      .mockResolvedValueOnce([])   // getColunasComputadas → nenhuma
      .mockResolvedValueOnce([     // getColunasExistentes
        { COLUNA: 'ID_MOVIMENTACAO' }, { COLUNA: 'TIPO_MOVIMENTACAO' }, { COLUNA: 'QUANTIDADE' },
      ])
      .mockResolvedValueOnce([])   // getColunasNaoNulas → nenhuma
      .mockResolvedValueOnce([]);  // getTamanhosColunas → nenhuma

    await rodarCiclo(registro, configTabela);

    expect(execute).toHaveBeenCalledWith(
      {},
      expect.stringContaining('UPDATE OR INSERT INTO MOVIMENTACOES_TESTE'),
      expect.arrayContaining([77, 'Saída', -5]) // QUANTIDADE virou negativo — o Sirius Delphi espera assim
    );
  });

  test('Entrada positiva vinda do servidor permanece positiva (só Saída inverte)', async () => {
    const registro = {
      ID_MOVIMENTACAO: 78,
      TIPO_MOVIMENTACAO: 'Entrada',
      QUANTIDADE: 5,
      ID_ULTIMA_ATUALIZACAO_MATRIZ: 901,
    };
    const configTabela = {
      nome: 'MOVIMENTACOES_TESTE_2',
      pk: 'ID_MOVIMENTACAO',
      normalizarSinal: { coluna: 'QUANTIDADE', colunaRef: 'TIPO_MOVIMENTACAO', negativoQuando: ['Saída'] },
    };

    query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { COLUNA: 'ID_MOVIMENTACAO' }, { COLUNA: 'TIPO_MOVIMENTACAO' }, { COLUNA: 'QUANTIDADE' },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await rodarCiclo(registro, configTabela);

    expect(execute).toHaveBeenCalledWith(
      {},
      expect.stringContaining('UPDATE OR INSERT INTO MOVIMENTACOES_TESTE_2'),
      expect.arrayContaining([78, 'Entrada', 5])
    );
  });
});

describe('sincronizarTabela — PK pré-gerado (registro criado via web, sem ID Firebird)', () => {
  test('pré-gera o PK pelo generator, aplica o upsert e enfileira o registro para push', async () => {
    // ID_PRODUTO null → allPKsNull=true; SRV_ID presente → dispara o enfileiramento pós-upsert.
    const registro = { ID_PRODUTO: null, NOME: 'Do Site', SRV_ID: 555, ID_ULTIMA_ATUALIZACAO_MATRIZ: 1000 };
    const configTabela = { nome: 'PRODUTOS_WEB_TESTE', pk: 'ID_PRODUTO', generator: 'GEN_PRODUTOS' };

    query
      .mockResolvedValueOnce([])   // sem pendente
      .mockResolvedValueOnce([])   // nunca recebido do servidor
      .mockResolvedValueOnce([])   // proteção overwrite: não existe local (PK ainda nem existe)
      .mockResolvedValueOnce([{ NOVO_ID: 12345 }])                 // GEN_ID — pré-gera o PK
      .mockResolvedValueOnce([])                                   // getColunasComputadas
      .mockResolvedValueOnce([{ COLUNA: 'ID_PRODUTO' }, { COLUNA: 'NOME' }]) // getColunasExistentes (sem SRV_ID nesta filial)
      .mockResolvedValueOnce([])   // getColunasNaoNulas
      .mockResolvedValueOnce([])   // getTamanhosColunas
      // Verificação final de generator (sync.js:521-529), roda 1x por tabela após o while
      // de atualizações terminar. Retornar [] (sem MAXIMO) evita que o código avance para
      // dentro de sincronizarGenerator, que faria uma 2ª query (GEN_ID) sem mock — cairia
      // no catch-all de produção "tabela pode ainda não existir" e mascararia o buraco.
      .mockResolvedValueOnce([]);  // SELECT MAX(ID_PRODUTO) FROM PRODUTOS_WEB_TESTE

    await rodarCiclo(registro, configTabela);

    // upsert aplicado com o PK já traduzido de null para 12345
    expect(execute).toHaveBeenCalledWith(
      {},
      expect.stringContaining('UPDATE OR INSERT INTO PRODUTOS_WEB_TESTE'),
      expect.arrayContaining([12345, 'Do Site'])
    );
    // enfileirado para o próximo push, usando o PK recém-gerado (não o null original)
    expect(execute).toHaveBeenCalledWith(
      {},
      expect.stringContaining('UPDATE OR INSERT INTO SYNC_ALTERACOES_PENDENTES'),
      ['PRODUTOS_WEB_TESTE', '12345']
    );
    // versão do servidor registrada sob o PK gerado — evita falsa colisão no próximo pull
    expect(execute).toHaveBeenCalledWith(
      {},
      expect.stringContaining('UPDATE OR INSERT INTO SYNC_VERSOES_SERVIDOR'),
      ['PRODUTOS_WEB_TESTE', '12345', 1000]
    );
    expect(salvarCursor).toHaveBeenCalledWith({}, 'PRODUTOS_WEB_TESTE', 1000, 0);
  });
});

describe('sincronizarTabela — loop de deleções', () => {
  const configComDelete = { nome: 'PRODUTOS', pk: 'ID_PRODUTO', temDelete: true };

  test('deleta o registro local e avança o cursor de deleção', async () => {
    buscarRegistrosParaAtualizar.mockResolvedValueOnce([]); // sem atualizações neste ciclo
    buscarRegistrosParaDeletar
      .mockResolvedValueOnce([{ ID_REGISTROS: 501, ID_REGISTRO_DELETADO: 9001 }])
      .mockResolvedValueOnce([]); // encerra o while de deleção

    await sincronizarTabela({}, 'http://servidor-teste', 1, configComDelete, noopLog);

    expect(execute).toHaveBeenCalledWith(
      {}, expect.stringContaining('DELETE FROM PRODUTOS WHERE ID_PRODUTO = ?'), [501]
    );
    expect(salvarCursor).toHaveBeenCalledWith({}, 'PRODUTOS', 0, 9001);
  });

  test('erro ao deletar um registro não impede os demais nem trava o ciclo', async () => {
    buscarRegistrosParaAtualizar.mockResolvedValueOnce([]);
    buscarRegistrosParaDeletar
      .mockResolvedValueOnce([
        { ID_REGISTROS: 601, ID_REGISTRO_DELETADO: 9101 }, // vai falhar
        { ID_REGISTROS: 602, ID_REGISTRO_DELETADO: 9102 }, // deve ser processado mesmo assim
      ])
      .mockResolvedValueOnce([]);

    execute.mockImplementation((db, sql, params) => {
      if (sql.includes('DELETE FROM PRODUTOS WHERE') && params[0] === 601) {
        return Promise.reject(new Error('violação de FK'));
      }
      return Promise.resolve(undefined);
    });

    await expect(
      sincronizarTabela({}, 'http://servidor-teste', 1, configComDelete, noopLog)
    ).resolves.not.toThrow();

    // registro que falhou não avança o cursor de deleção...
    expect(salvarCursor).not.toHaveBeenCalledWith({}, 'PRODUTOS', 0, 9101);
    // ...mas o próximo da mesma leva é processado normalmente
    expect(salvarCursor).toHaveBeenCalledWith({}, 'PRODUTOS', 0, 9102);
  });

  test('não deleta nada quando o servidor não retorna registros para deletar', async () => {
    buscarRegistrosParaAtualizar.mockResolvedValueOnce([]);
    buscarRegistrosParaDeletar.mockResolvedValueOnce([]); // já encerra de cara

    await sincronizarTabela({}, 'http://servidor-teste', 1, configComDelete, noopLog);

    expect(execute).not.toHaveBeenCalledWith(
      {}, expect.stringContaining('DELETE FROM PRODUTOS WHERE'), expect.anything()
    );
    expect(salvarCursor).not.toHaveBeenCalled();
  });
});

describe('sincronizarTabela — versaoConhecida === null (erro ao consultar SYNC_VERSOES_SERVIDOR)', () => {
  test('erro na query de metadado cai para upsert por segurança, em vez de travar', async () => {
    const registro = { ID_PRODUTO: 88, NOME: 'Recuperado de erro', ID_ULTIMA_ATUALIZACAO_MATRIZ: 1200 };
    const configTabela = { nome: 'PRODUTOS_ERRO_VERSAO_TESTE', pk: 'ID_PRODUTO' };

    query
      .mockResolvedValueOnce([{}])                     // pendente=true
      .mockRejectedValueOnce(new Error('timeout Firebird')) // versaoConhecida: query falha → vira null (.catch(() => null) em sync.js)
      .mockResolvedValueOnce([])                        // getColunasComputadas
      .mockResolvedValueOnce([{ COLUNA: 'ID_PRODUTO' }, { COLUNA: 'NOME' }]) // getColunasExistentes
      .mockResolvedValueOnce([])                        // getColunasNaoNulas
      .mockResolvedValueOnce([]);                       // getTamanhosColunas

    await rodarCiclo(registro, configTabela);

    expect(salvarConflito).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith(
      {},
      expect.stringContaining('UPDATE OR INSERT INTO PRODUTOS_ERRO_VERSAO_TESTE'),
      expect.arrayContaining([88, 'Recuperado de erro'])
    );
    expect(salvarCursor).toHaveBeenCalledWith({}, 'PRODUTOS_ERRO_VERSAO_TESTE', 1200, 0);
  });
});

describe('sincronizarTabela — tradução de FK no lado pull (SRV_ID do servidor → PK local)', () => {
  const configComFkPull = {
    nome: 'MOVIMENTACOES_PULL_TESTE',
    pk: 'ID_MOVIMENTACAO',
    fks: [{ coluna: 'ID_PRODUTO', tabela: 'PRODUTOS', traduzirSrvId: true, pkRef: 'ID_PRODUTO' }],
  };

  test('FK resolvida: troca o SRV_ID recebido do servidor pelo ID_PRODUTO local antes do upsert', async () => {
    // ID_PRODUTO=500 como o servidor manda: é o SRV_ID, não o ID nativo do Firebird local.
    const registro = { ID_MOVIMENTACAO: 900, ID_PRODUTO: 500, ID_ULTIMA_ATUALIZACAO_MATRIZ: 1300 };

    query
      .mockResolvedValueOnce([])                              // sem pendente
      .mockResolvedValueOnce([])                              // nunca recebido do servidor
      .mockResolvedValueOnce([])                              // proteção overwrite: não existe local
      .mockResolvedValueOnce([{ ID_PRODUTO: 777 }])           // tradução FK: SRV_ID 500 → ID_PRODUTO local 777
      .mockResolvedValueOnce([])                              // getColunasComputadas
      .mockResolvedValueOnce([{ COLUNA: 'ID_MOVIMENTACAO' }, { COLUNA: 'ID_PRODUTO' }]) // getColunasExistentes
      .mockResolvedValueOnce([])                              // getColunasNaoNulas
      .mockResolvedValueOnce([]);                             // getTamanhosColunas

    await rodarCiclo(registro, configComFkPull);

    expect(execute).toHaveBeenCalledWith(
      {},
      expect.stringContaining('UPDATE OR INSERT INTO MOVIMENTACOES_PULL_TESTE'),
      expect.arrayContaining([900, 777]) // 777 (local), não 500 (SRV_ID recebido)
    );
  });

  test('FK não encontrada localmente: mantém o valor original recebido do servidor', async () => {
    const registro = { ID_MOVIMENTACAO: 901, ID_PRODUTO: 500, ID_ULTIMA_ATUALIZACAO_MATRIZ: 1301 };

    query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])   // tradução FK: produto com SRV_ID 500 ainda não chegou nesta filial
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ COLUNA: 'ID_MOVIMENTACAO' }, { COLUNA: 'ID_PRODUTO' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await rodarCiclo(registro, { ...configComFkPull, nome: 'MOVIMENTACOES_PULL_TESTE_2' });

    expect(execute).toHaveBeenCalledWith(
      {},
      expect.stringContaining('UPDATE OR INSERT INTO MOVIMENTACOES_PULL_TESTE_2'),
      expect.arrayContaining([901, 500]) // sem tradução disponível — mantém o SRV_ID como veio
    );
  });
});
