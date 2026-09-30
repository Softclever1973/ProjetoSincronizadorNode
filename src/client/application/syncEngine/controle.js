const fs   = require('fs');
const path = require('path');

// Pausas da sincronização, gravadas em arquivo pra sobreviver a reinício/auto-atualização.
// `pausado` para tudo (pull+push); `cargaPausada` segura só os pendentes da carga inicial
// (filaCarga.js) — alterações do dia a dia e o recebimento continuam.
const CAMINHO = path.join(process.cwd(), 'sync-pausa.json');

const VAZIO = { pausado: false, desde: null, por: null, cargaPausada: false, cargaDesde: null, cargaPor: null };

let _pausa = _ler();

function _ler() {
  try {
    const salvo = JSON.parse(fs.readFileSync(CAMINHO, 'utf8'));
    // Versão anterior pausava todo o envio (usado pra segurar a carga): vira pausa da carga.
    if (salvo.envioPausado && salvo.cargaPausada === undefined) {
      Object.assign(salvo, { cargaPausada: true, cargaDesde: salvo.envioDesde ?? null, cargaPor: salvo.envioPor ?? null });
    }
    const { envioPausado, envioDesde, envioPor, ...resto } = salvo; // eslint-disable-line no-unused-vars
    return { ...VAZIO, ...resto };
  } catch {
    return { ...VAZIO };
  }
}

function _gravar() {
  try {
    const tmp = CAMINHO + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(_pausa), 'utf8');
    fs.renameSync(tmp, CAMINHO);
  } catch (e) {
    console.error(`[Controle] não foi possível gravar ${CAMINHO}: ${e.message}`);
  }
}

function pausar(por = null) {
  _pausa = { ..._pausa, pausado: true, desde: new Date().toISOString(), por };
  _gravar();
}

function retomar() {
  _pausa = { ..._pausa, pausado: false, desde: null, por: null };
  _gravar();
}

function pausarCarga(por = null) {
  _pausa = { ..._pausa, cargaPausada: true, cargaDesde: new Date().toISOString(), cargaPor: por };
  _gravar();
}

function retomarCarga() {
  _pausa = { ..._pausa, cargaPausada: false, cargaDesde: null, cargaPor: null };
  _gravar();
}

function estaPausado() { return _pausa.pausado; }

// Push inteiro só para com a pausa geral; a da carga filtra os pendentes (push.js).
function envioEstaPausado() { return _pausa.pausado; }

function cargaEstaPausada() { return _pausa.pausado || _pausa.cargaPausada; }

function estadoPausa() { return { ..._pausa }; }

// "Parar" da carga: incrementa a geração pra o push em andamento largar o lote já carregado na memória.
let _geracaoEnvio = 0;
function interromperEnvioAtual() { _geracaoEnvio++; }
function geracaoEnvio() { return _geracaoEnvio; }

module.exports = {
  pausar, retomar, pausarCarga, retomarCarga, estaPausado, envioEstaPausado, cargaEstaPausada, estadoPausa,
  interromperEnvioAtual, geracaoEnvio,
};
