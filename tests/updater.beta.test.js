// Versões beta (teste interno): comparação semver, opções da faixa e rota /atualizacao/aplicar.
const express = require('express');
const request = require('supertest');
const { compararVersoes, escolherOpcoesBeta, ehBeta } = require('../src/client/application/updater');
const { criarAtualizacaoRouter } = require('../src/client/interfaces/webui/routes/atualizacao.routes');

const rel = (tag, { prerelease = /-/.test(tag), draft = false, exe = true } = {}) => ({
  tag_name: `v${tag}`, prerelease, draft, html_url: `https://github.com/x/releases/v${tag}`, body: '',
  assets: exe ? [{ name: 'client.exe', browser_download_url: `https://github.com/x/v${tag}/client.exe` }] : [],
});

describe('compararVersoes', () => {
  test.each([
    ['1.10.0', '1.2.3', 1],
    ['1.6.0', '1.6.0-beta.1', 1],
    ['1.6.0-beta.1', '1.6.0', -1],
    ['1.6.0-beta.10', '1.6.0-beta.2', 1],
    ['1.6.0-beta.2', '1.5.9', 1],
    ['1.6.0-alpha.1', '1.6.0-beta.1', -1],
    ['1.6.0-rc-1', '1.6.0-rc-1', 0],
    ['v1.6.0', '1.6.0', 0],
  ])('%s × %s = %i', (a, b, esperado) => {
    expect(compararVersoes(a, b)).toBe(esperado);
  });

  test('ehBeta', () => {
    expect([ehBeta('1.6.0-beta.1'), ehBeta('1.6.0')]).toEqual([true, false]);
  });
});

describe('escolherOpcoesBeta', () => {
  const releases = [rel('1.6.0-beta.3'), rel('1.6.0-beta.2'), rel('1.5.0'), rel('1.4.0'), rel('1.6.0-beta.4', { draft: true })];

  test('beta mais nova que a instalada + estável mais nova (volta de versão sinalizada)', () => {
    const o = escolherOpcoesBeta(releases, '1.6.0-beta.2');
    expect(o.beta.versao).toBe('1.6.0-beta.3');
    expect(o.estavel).toMatchObject({ versao: '1.5.0', voltaVersao: true });
  });

  test('já na beta mais nova: só a estável', () => {
    const o = escolherOpcoesBeta(releases, '1.6.0-beta.3');
    expect(o.beta).toBeNull();
    expect(o.estavel.versao).toBe('1.5.0');
  });

  test('estável depois da beta não é volta de versão', () => {
    const o = escolherOpcoesBeta([...releases, rel('1.6.0')], '1.6.0-beta.3');
    expect(o.estavel).toMatchObject({ versao: '1.6.0', voltaVersao: false });
  });

  test('ignora rascunho e release sem client.exe', () => {
    const o = escolherOpcoesBeta([rel('1.6.0-beta.9', { exe: false }), rel('1.7.0', { exe: false }), ...releases], '1.6.0-beta.3');
    expect(o.beta).toBeNull();
    expect(o.estavel.versao).toBe('1.5.0');
  });
});

describe('POST /atualizacao/aplicar', () => {
  const app = contexto => express().use(express.json()).use(criarAtualizacaoRouter(contexto));

  test('PC em beta exige escolher beta ou estável', async () => {
    const aplicar = jest.fn(async () => {});
    const r = await request(app({ ehBeta: true, _aplicarAtualizacao: aplicar })).post('/atualizacao/aplicar').send({});
    expect(r.status).toBe(400);
    expect(aplicar).not.toHaveBeenCalled();
  });

  test('PC em beta repassa o alvo escolhido', async () => {
    const aplicar = jest.fn(async () => {});
    const r = await request(app({ ehBeta: true, _aplicarAtualizacao: aplicar })).post('/atualizacao/aplicar').send({ alvo: 'estavel' });
    expect(r.body.ok).toBe(true);
    expect(aplicar).toHaveBeenCalledWith('estavel');
  });

  test('PC normal continua sem alvo', async () => {
    const aplicar = jest.fn(async () => {});
    const r = await request(app({ ehBeta: false, _aplicarAtualizacao: aplicar })).post('/atualizacao/aplicar').send({});
    expect(r.body.ok).toBe(true);
    expect(aplicar).toHaveBeenCalledWith(undefined);
  });
});
