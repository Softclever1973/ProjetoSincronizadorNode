// updater.js não requer Firebird (só https/fs/child_process), então diferente de
// sync.conflitos.test.js/push.conflitos.test.js não precisamos mockar ../db — só a rede
// (https) e o spawn de processo (child_process). fs/fs.promises usam um diretório temp
// real, para exercitar o truque de rename de verdade em vez de reimplementá-lo em mocks.
jest.mock('child_process');
jest.mock('https');

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const EventEmitter = require('events');
const https = require('https');
const { spawn } = require('child_process');

const {
  aplicarAtualizacaoComRespawn,
  limparExeAntigo,
  lerEstadoPendente,
  confirmarAtualizacao,
  emitter,
} = require('../src/client/application/updater');

const TAMANHO_VALIDO = 1024 * 1024 + 1024; // > 1MB, passa no sanity check de aplicarAtualizacaoComRespawn

function mockDownload(buffer, statusCode = 200) {
  https.get.mockImplementation((_url, _opts, cb) => {
    const res = Readable.from([buffer]);
    res.statusCode = statusCode;
    res.headers = {};
    process.nextTick(() => cb(res));
    const req = new EventEmitter();
    req.destroy = jest.fn();
    return req;
  });
}

function mockSpawnChild() {
  const child = new EventEmitter();
  child.unref = jest.fn();
  spawn.mockReturnValue(child);
  return child;
}

describe('updater — atualização automática', () => {
  let tmpDir, exePath, exitSpy;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sirius-updater-test-'));
    exePath = path.join(tmpDir, 'client.exe');
    fs.writeFileSync(exePath, 'CONTEUDO-VERSAO-ANTIGA');
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    jest.clearAllMocks();
  });

  afterEach(() => {
    exitSpy.mockRestore();
    emitter.removeAllListeners('status');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('lerEstadoPendente', () => {
    test('retorna null quando o arquivo não existe', () => {
      expect(lerEstadoPendente(exePath)).toBeNull();
    });

    test('retorna null para JSON corrompido — não deve travar o boot', () => {
      fs.writeFileSync(path.join(tmpDir, '.update-pending.json'), '{ isso não é json');
      expect(lerEstadoPendente(exePath)).toBeNull();
    });

    test('retorna null quando faltam campos obrigatórios', () => {
      fs.writeFileSync(path.join(tmpDir, '.update-pending.json'), JSON.stringify({ versaoNova: '2.0.0' }));
      expect(lerEstadoPendente(exePath)).toBeNull();
    });

    test('retorna null quando passou do TTL (24h)', () => {
      const antigoPath = path.join(tmpDir, 'client.old.1.exe');
      fs.writeFileSync(antigoPath, 'x');
      fs.writeFileSync(path.join(tmpDir, '.update-pending.json'), JSON.stringify({
        versaoAnterior: '1.0.0', versaoNova: '2.0.0', exeAntigoPath: antigoPath,
        criadoEm: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      }));
      expect(lerEstadoPendente(exePath)).toBeNull();
    });

    test('retorna o estado quando válido', () => {
      const antigoPath = path.join(tmpDir, 'client.old.1.exe');
      fs.writeFileSync(antigoPath, 'x');
      const estado = { versaoAnterior: '1.0.0', versaoNova: '2.0.0', exeAntigoPath: antigoPath, criadoEm: new Date().toISOString() };
      fs.writeFileSync(path.join(tmpDir, '.update-pending.json'), JSON.stringify(estado));
      expect(lerEstadoPendente(exePath)).toEqual(estado);
    });
  });

  describe('confirmarAtualizacao', () => {
    test('sem estado pendente: retorna null e não emite status', () => {
      const onStatus = jest.fn();
      emitter.on('status', onStatus);
      expect(confirmarAtualizacao(exePath)).resolves.toBeNull();
      expect(onStatus).not.toHaveBeenCalled();
    });

    test('com estado pendente: apaga o exe antigo, apaga o estado, emite sucesso', async () => {
      const antigoPath = path.join(tmpDir, 'client.old.1.exe');
      fs.writeFileSync(antigoPath, 'x');
      fs.writeFileSync(path.join(tmpDir, '.update-pending.json'), JSON.stringify({
        versaoAnterior: '1.0.0', versaoNova: '2.0.0', exeAntigoPath: antigoPath, criadoEm: new Date().toISOString(),
      }));

      const onStatus = jest.fn();
      emitter.on('status', onStatus);

      const resultado = await confirmarAtualizacao(exePath);

      expect(resultado).toMatchObject({ status: 'sucesso', versao: '2.0.0' });
      expect(fs.existsSync(antigoPath)).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, '.update-pending.json'))).toBe(false);
      expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ status: 'sucesso', versao: '2.0.0' }));
    });
  });

  describe('limparExeAntigo', () => {
    test('remove sobras old/new/broken, mas preserva o exe referenciado por um estado pendente válido', async () => {
      const preservado = path.join(tmpDir, 'client.old.111.exe');
      const descartavel1 = path.join(tmpDir, 'client.new.222.exe');
      const descartavel2 = path.join(tmpDir, 'client.broken.333.exe');
      fs.writeFileSync(preservado, 'x');
      fs.writeFileSync(descartavel1, 'x');
      fs.writeFileSync(descartavel2, 'x');
      fs.writeFileSync(path.join(tmpDir, '.update-pending.json'), JSON.stringify({
        versaoAnterior: '1.0.0', versaoNova: '2.0.0', exeAntigoPath: preservado, criadoEm: new Date().toISOString(),
      }));

      limparExeAntigo(exePath); // fire-and-forget (fs.readdir com callback)
      await new Promise(r => setTimeout(r, 150));

      expect(fs.existsSync(preservado)).toBe(true);
      expect(fs.existsSync(descartavel1)).toBe(false);
      expect(fs.existsSync(descartavel2)).toBe(false);
    });
  });

  describe('aplicarAtualizacaoComRespawn', () => {
    test('rejeita sem urlDownload, sem tocar em nada', async () => {
      await expect(aplicarAtualizacaoComRespawn({ urlDownload: null, exePath, versaoAtual: '1.0.0', versaoNova: '2.0.0' }))
        .rejects.toThrow('Release não possui client.exe');
      expect(spawn).not.toHaveBeenCalled();
    });

    test('rejeita quando o download tem tamanho suspeito, e não mexe no exe atual', async () => {
      mockDownload(Buffer.from('pagina de erro html, nao um exe'));
      const conteudoOriginal = fs.readFileSync(exePath, 'utf8');

      await expect(aplicarAtualizacaoComRespawn({
        urlDownload: 'http://fake/client.exe', exePath, versaoAtual: '1.0.0', versaoNova: '2.0.0',
      })).rejects.toThrow('tamanho inesperado');

      expect(fs.readFileSync(exePath, 'utf8')).toBe(conteudoOriginal);
      expect(fs.existsSync(path.join(tmpDir, '.update-pending.json'))).toBe(false);
      expect(spawn).not.toHaveBeenCalled();
    });

    test('impede duas atualizações concorrentes', async () => {
      mockDownload(Buffer.from('pequeno demais'));
      const p1 = aplicarAtualizacaoComRespawn({ urlDownload: 'http://fake/client.exe', exePath, versaoAtual: '1.0.0', versaoNova: '2.0.0' });
      await expect(aplicarAtualizacaoComRespawn({ urlDownload: 'http://fake/client.exe', exePath, versaoAtual: '1.0.0', versaoNova: '2.0.0' }))
        .rejects.toThrow('já está em andamento');
      await expect(p1).rejects.toThrow(); // libera o lock pro afterEach não vazar pro próximo teste
    });

    test('reverte automaticamente quando o processo novo morre dentro da janela de watchdog', async () => {
      mockDownload(Buffer.alloc(TAMANHO_VALIDO, 'B'));
      const child = mockSpawnChild();

      const statusEmitidos = [];
      emitter.on('status', s => statusEmitidos.push(s.status));

      const promise = aplicarAtualizacaoComRespawn({
        urlDownload: 'http://fake/client.exe', exePath, versaoAtual: '1.0.0', versaoNova: '2.0.0',
      });

      // Deixa o download/swap/spawn acontecerem (I/O real em disco) antes de matar o child.
      await new Promise(r => setTimeout(r, 500));
      child.emit('exit', 1);

      await expect(promise).rejects.toThrow('não permaneceu em execução');

      expect(fs.readFileSync(exePath, 'utf8')).toBe('CONTEUDO-VERSAO-ANTIGA'); // restaurado
      expect(fs.existsSync(path.join(tmpDir, '.update-pending.json'))).toBe(false);
      expect(fs.readdirSync(tmpDir).some(n => /^client\.broken\.\d+\.exe$/.test(n))).toBe(true);
      expect(statusEmitidos).toEqual(['aplicando', 'revertida']);
      expect(exitSpy).not.toHaveBeenCalled();
    }, 10000);

    test('aplica, relança e confirma quando o processo novo sobrevive à janela de watchdog', async () => {
      mockDownload(Buffer.alloc(TAMANHO_VALIDO, 'B'));
      const child = mockSpawnChild(); // nunca emite exit/error — representa um processo saudável

      const statusEmitidos = [];
      emitter.on('status', s => statusEmitidos.push(s.status));

      await aplicarAtualizacaoComRespawn({
        urlDownload: 'http://fake/client.exe', exePath, versaoAtual: '1.0.0', versaoNova: '2.0.0',
      });

      expect(fs.readFileSync(exePath, 'utf8')).toBe('B'.repeat(TAMANHO_VALIDO));
      expect(fs.readdirSync(tmpDir).some(n => /^client\.old\.\d+\.exe$/.test(n))).toBe(true);
      const estado = lerEstadoPendente(exePath);
      expect(estado).toMatchObject({ versaoAnterior: '1.0.0', versaoNova: '2.0.0' });
      expect(child.unref).toHaveBeenCalled();
      expect(statusEmitidos).toEqual(['aplicando', 'respawned']);

      // process.exit(0) é agendado 500ms depois, sem bloquear quem chamou (ver comentário
      // em aplicarAtualizacaoComRespawn) — espera esse timer disparar antes do afterEach
      // restaurar o spy, senão o process.exit real dispararia fora do teste.
      await new Promise(r => setTimeout(r, 700));
      expect(exitSpy).toHaveBeenCalledWith(0);
    }, 15000); // janela de liveness real de 10s + margem
  });
});
