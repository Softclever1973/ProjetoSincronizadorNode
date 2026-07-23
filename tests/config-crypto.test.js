// config-crypto.js chama powershell/DPAPI de verdade — a única coisa que faz sentido
// mockar é o processo filho (child_process), já que DPAPI real só existe no Windows e
// depende do usuário logado. O teste verifica a fiação (o que é passado pro PowerShell
// e como o retorno é decodificado), não a criptografia do Windows em si.
jest.mock('child_process');

const fs = require('fs');
const { execFileSync } = require('child_process');
const { protegerConfig, desprotegerConfig } = require('../src/client/config-crypto');

describe('config-crypto', () => {
  beforeEach(() => {
    execFileSync.mockReset();
    jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('protegerConfig grava o script e chama powershell em modo protect com o payload em base64 via stdin', () => {
    execFileSync.mockReturnValue('CIFRADO_BASE64');

    const resultado = protegerConfig({ FIREBIRD_PASSWORD: 'segredo123' });

    expect(resultado).toBe('CIFRADO_BASE64');
    expect(execFileSync).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = execFileSync.mock.calls[0];
    expect(cmd).toBe('powershell');
    expect(args).toEqual(expect.arrayContaining(['-File', expect.any(String), 'protect']));
    // nunca deve ir por argumento de linha de comando — só por stdin
    expect(args.join(' ')).not.toContain('segredo123');
    const jsonDecodificado = Buffer.from(opts.input, 'base64').toString('utf8');
    expect(JSON.parse(jsonDecodificado)).toEqual({ FIREBIRD_PASSWORD: 'segredo123' });
  });

  test('desprotegerConfig chama powershell em modo unprotect e decodifica o JSON retornado', () => {
    const jsonBase64 = Buffer.from(JSON.stringify({ FIREBIRD_PASSWORD: 'segredo123' }), 'utf8').toString('base64');
    execFileSync.mockReturnValue(jsonBase64);

    const dados = desprotegerConfig('QUALQUER_CIFRADO');

    expect(dados).toEqual({ FIREBIRD_PASSWORD: 'segredo123' });
    const [, args, opts] = execFileSync.mock.calls[0];
    expect(args).toEqual(expect.arrayContaining(['-File', expect.any(String), 'unprotect']));
    expect(opts.input).toBe('QUALQUER_CIFRADO');
  });

  test('round-trip: desprotegerConfig reconstrói exatamente o que protegerConfig recebeu', () => {
    // Sem DPAPI real disponível no mock, simula "identidade": o que entra no stdin sai no stdout.
    execFileSync.mockImplementation((_cmd, _args, opts) => opts.input);

    const original = { SYNC_TOKEN: 'abc', FIREBIRD_DATABASE: 'C:\\FDBS\\LOJA.FDB', NOME_FILIAL: 'Loja Vitor' };
    const cifrado = protegerConfig(original);
    const resultado = desprotegerConfig(cifrado);

    expect(resultado).toEqual(original);
  });

  test('desprotegerConfig propaga o erro quando o powershell falha (ex.: config.enc de outra máquina/usuário)', () => {
    execFileSync.mockImplementation(() => { throw new Error('Key not valid for use in specified state'); });

    expect(() => desprotegerConfig('CIFRADO_DE_OUTRA_MAQUINA')).toThrow('Key not valid');
  });
});
