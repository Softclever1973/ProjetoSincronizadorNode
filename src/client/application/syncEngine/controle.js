const fs   = require('fs');
const path = require('path');

// Pausas da sincronização, gravadas em arquivo pra sobreviver a reinício/auto-atualização.
// `pausado` para tudo (pull+push); `envioPausado` para só o push, o pull continua.
const CAMINHO = path.join(process.cwd(), 'sync-pausa.json');

const VAZIO = { pausado: false, desde: null, por: null, envioPausado: false, envioDesde: null, envioPor: null };

let _pausa = _ler();

function _ler() {
  try {
    return { ...VAZIO, ...JSON.parse(fs.readFileSync(CAMINHO, 'utf8')) };
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

function pausarEnvio(por = null) {
  _pausa = { ..._pausa, envioPausado: true, envioDesde: new Date().toISOString(), envioPor: por };
  _gravar();
}

function retomarEnvio() {
  _pausa = { ..._pausa, envioPausado: false, envioDesde: null, envioPor: null };
  _gravar();
}

function estaPausado() { return _pausa.pausado; }

// Push para com qualquer uma das duas pausas.
function envioEstaPausado() { return _pausa.pausado || _pausa.envioPausado; }

function estadoPausa() { return { ..._pausa }; }

module.exports = { pausar, retomar, pausarEnvio, retomarEnvio, estaPausado, envioEstaPausado, estadoPausa };
