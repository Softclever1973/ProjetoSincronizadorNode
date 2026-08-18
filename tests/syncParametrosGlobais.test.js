// Mesmo motivo do sync.conflitos.test.js/push.conflitos.test.js: factories explícitas evitam
// carregar ../db real (exige Firebird real no require) e ../parametrosGlobaisState real
// (escreve parametros-sync.json em disco).
jest.mock('../src/client/infrastructure/firebird/db', () => ({
  getParam: jest.fn(),
  setParam: jest.fn(),
}));
jest.mock('../src/client/http', () => ({
  buscarParametros: jest.fn(),
  atualizarParametros: jest.fn(),
}));
jest.mock('../src/client/parametrosGlobaisState', () => ({
  lerEstado: jest.fn(),
  salvarEstado: jest.fn(),
  decidirAcao: jest.requireActual('../src/client/parametrosGlobaisState').decidirAcao,
}));

const { getParam, setParam } = require('../src/client/infrastructure/firebird/db');
const { buscarParametros, atualizarParametros } = require('../src/client/http');
const { lerEstado, salvarEstado } = require('../src/client/parametrosGlobaisState');
const { syncParametrosGlobais } = require('../src/client/application/syncParametrosGlobais');

const db = {}; // opaco pro módulo — só repassado pra getParam/setParam mockados
const baseURI = 'http://servidor.teste';
const noopLog = () => {};

// paramsSyncMap real: 4 globais (utilizar_codigo_interno=67, codigo_interno_unico=122,
// venda_saldo_negativo=71, forma_preenchimento_pedido=91) + 1 legado (modalidade_frete=45051).
const FB_IDS = { utilizar_codigo_interno: 67, codigo_interno_unico: 122, venda_saldo_negativo: 71, modalidade_frete: 45051, forma_preenchimento_pedido: 91 };

function mockFirebird(valoresPorFbId) {
  getParam.mockImplementation((_db, fbId) => Promise.resolve(valoresPorFbId[fbId] ?? null));
}

function novoContexto() {
  return { parametrosSincronizados: {} };
}

beforeEach(() => {
  jest.clearAllMocks();
  lerEstado.mockReturnValue({});
  buscarParametros.mockResolvedValue([{ parametros: {} }]);
  atualizarParametros.mockResolvedValue({});
  setParam.mockResolvedValue();
});

describe('syncParametrosGlobais — parâmetro global', () => {
  test('1ª vez que este PDV vê a chave, servidor já tem valor -> pull (semeia do servidor, não duplica push)', async () => {
    mockFirebird({ [FB_IDS.venda_saldo_negativo]: null });
    buscarParametros.mockResolvedValue([{ parametros: { venda_saldo_negativo: 'S' } }]);

    const contexto = novoContexto();
    await syncParametrosGlobais(db, baseURI, contexto, noopLog);

    expect(setParam).toHaveBeenCalledWith(db, FB_IDS.venda_saldo_negativo, 'S');
    expect(atualizarParametros).not.toHaveBeenCalled();
    expect(contexto.parametrosSincronizados.venda_saldo_negativo).toMatchObject({ valor: 'S', origem: 'pull', status: 'ok' });

    const [estadoSalvo] = salvarEstado.mock.calls[0];
    expect(estadoSalvo.venda_saldo_negativo).toMatchObject({ valor: 'S', origem: 'pull' });
  });

  test('valor local mudou -> push pro servidor', async () => {
    mockFirebird({ [FB_IDS.venda_saldo_negativo]: 'N' });
    lerEstado.mockReturnValue({ venda_saldo_negativo: { valor: 'S', origem: 'pull' } });

    const contexto = novoContexto();
    await syncParametrosGlobais(db, baseURI, contexto, noopLog);

    expect(atualizarParametros).toHaveBeenCalledWith(baseURI, { venda_saldo_negativo: 'N' });
    expect(setParam).not.toHaveBeenCalled();
    expect(contexto.parametrosSincronizados.venda_saldo_negativo).toMatchObject({ valor: 'N', origem: 'push', status: 'ok' });
  });

  test('inalterado aqui, outro PDV mudou no servidor -> pull', async () => {
    mockFirebird({ [FB_IDS.venda_saldo_negativo]: 'S' });
    lerEstado.mockReturnValue({ venda_saldo_negativo: { valor: 'S', origem: 'push' } });
    buscarParametros.mockResolvedValue([{ parametros: { venda_saldo_negativo: 'N' } }]);

    const contexto = novoContexto();
    await syncParametrosGlobais(db, baseURI, contexto, noopLog);

    expect(setParam).toHaveBeenCalledWith(db, FB_IDS.venda_saldo_negativo, 'N');
    expect(atualizarParametros).not.toHaveBeenCalled();
  });

  test('setParam falha no pull -> reverte confirmação otimista do estado e marca status erro', async () => {
    mockFirebird({ [FB_IDS.venda_saldo_negativo]: null });
    buscarParametros.mockResolvedValue([{ parametros: { venda_saldo_negativo: 'S' } }]);
    setParam.mockRejectedValue(new Error('firebird indisponível'));

    const contexto = novoContexto();
    await syncParametrosGlobais(db, baseURI, contexto, noopLog);

    expect(contexto.parametrosSincronizados.venda_saldo_negativo).toMatchObject({ status: 'erro', erro: 'firebird indisponível' });
    const [estadoSalvo] = salvarEstado.mock.calls[0];
    expect(estadoSalvo.venda_saldo_negativo).toBeUndefined(); // volta ao estado anterior (chave nunca existiu)
  });

  test('atualizarParametros falha no push -> reverte confirmação otimista e marca status erro', async () => {
    mockFirebird({ [FB_IDS.venda_saldo_negativo]: 'N' });
    lerEstado.mockReturnValue({ venda_saldo_negativo: { valor: 'S', origem: 'pull' } });
    atualizarParametros.mockRejectedValue(new Error('servidor fora do ar'));

    const contexto = novoContexto();
    await syncParametrosGlobais(db, baseURI, contexto, noopLog);

    expect(contexto.parametrosSincronizados.venda_saldo_negativo).toMatchObject({ status: 'erro', erro: 'servidor fora do ar' });
    const [estadoSalvo] = salvarEstado.mock.calls[0];
    expect(estadoSalvo.venda_saldo_negativo).toMatchObject({ valor: 'S', origem: 'pull' }); // volta ao estado anterior
  });

  test('busca de parâmetros do servidor falha -> não interrompe o ciclo, segue com parametrosServidor vazio', async () => {
    mockFirebird({ [FB_IDS.venda_saldo_negativo]: 'S' });
    buscarParametros.mockRejectedValue(new Error('timeout'));

    const contexto = novoContexto();
    await expect(syncParametrosGlobais(db, baseURI, contexto, noopLog)).resolves.toBeUndefined();
    // sem servidor conhecido e sem estado anterior, local != conhecido(undefined) => push
    expect(atualizarParametros).toHaveBeenCalledWith(baseURI, { venda_saldo_negativo: 'S' });
  });
});

describe('syncParametrosGlobais — parâmetro não-global (comportamento legado)', () => {
  test('sempre envia unidirecionalmente quando presente, ignorando decidirAcao', async () => {
    mockFirebird({ [FB_IDS.modalidade_frete]: 'S' });

    const contexto = novoContexto();
    await syncParametrosGlobais(db, baseURI, contexto, noopLog);

    expect(atualizarParametros).toHaveBeenCalledWith(baseURI, expect.objectContaining({ modalidade_frete: 'S' }));
    expect(setParam).not.toHaveBeenCalledWith(db, FB_IDS.modalidade_frete, expect.anything());
  });

  test('não envia quando ausente no Firebird local', async () => {
    mockFirebird({ [FB_IDS.modalidade_frete]: null });

    const contexto = novoContexto();
    await syncParametrosGlobais(db, baseURI, contexto, noopLog);

    expect(atualizarParametros).not.toHaveBeenCalledWith(baseURI, expect.objectContaining({ modalidade_frete: expect.anything() }));
  });
});
