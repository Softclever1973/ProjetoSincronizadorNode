// controle.js grava sync-pausa.json no cwd: cada teste roda numa pasta temporária própria.
const fs = require('fs');
const os = require('os');
const path = require('path');

const cwdOriginal = process.cwd();
let pasta;

function carregarControle(arquivo) {
  if (arquivo) fs.writeFileSync(path.join(pasta, 'sync-pausa.json'), JSON.stringify(arquivo));
  let mod;
  jest.isolateModules(() => { mod = require('../src/client/application/syncEngine/controle'); });
  return mod;
}

beforeEach(() => {
  pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-controle-'));
  process.chdir(pasta);
});

afterEach(() => {
  process.chdir(cwdOriginal);
  fs.rmSync(pasta, { recursive: true, force: true });
});

describe('controle — pausa da carga × pausa geral', () => {
  test('pausar a carga não pausa o envio nem a sincronização', () => {
    const c = carregarControle();
    c.pausarCarga('operador');
    expect([c.cargaEstaPausada(), c.envioEstaPausado(), c.estaPausado()]).toEqual([true, false, false]);
    expect(c.estadoPausa()).toMatchObject({ cargaPausada: true, cargaPor: 'operador' });
  });

  test('pausa geral segura tudo, inclusive a carga', () => {
    const c = carregarControle();
    c.pausar();
    expect([c.cargaEstaPausada(), c.envioEstaPausado(), c.estaPausado()]).toEqual([true, true, true]);
  });

  test('estado sobrevive a reinício (arquivo)', () => {
    carregarControle().pausarCarga('ana');
    const depois = carregarControle();
    expect(depois.cargaEstaPausada()).toBe(true);
    depois.retomarCarga();
    expect(carregarControle().cargaEstaPausada()).toBe(false);
  });

  test('arquivo da versão anterior (envioPausado) vira pausa da carga, sem segurar o dia a dia', () => {
    const c = carregarControle({ pausado: false, envioPausado: true, envioDesde: '2026-09-30T10:00:00.000Z', envioPor: 'ana' });
    expect(c.cargaEstaPausada()).toBe(true);
    expect(c.envioEstaPausado()).toBe(false);
    expect(c.estadoPausa()).toMatchObject({ cargaPor: 'ana', cargaDesde: '2026-09-30T10:00:00.000Z' });
    expect(c.estadoPausa()).not.toHaveProperty('envioPausado');
  });
});
