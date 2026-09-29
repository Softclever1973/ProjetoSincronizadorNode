const fs   = require('fs');
const path = require('path');

// Pausa global da sincronização, gravada em arquivo pra sobreviver a reinício/auto-atualização.
const CAMINHO = path.join(process.cwd(), 'sync-pausa.json');

let _pausa = _ler();

function _ler() {
  try {
    const d = JSON.parse(fs.readFileSync(CAMINHO, 'utf8'));
    return d?.pausado ? { pausado: true, desde: d.desde || null, por: d.por || null } : { pausado: false };
  } catch {
    return { pausado: false };
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
  _pausa = { pausado: true, desde: new Date().toISOString(), por };
  _gravar();
}

function retomar() {
  _pausa = { pausado: false };
  _gravar();
}

function estaPausado() { return _pausa.pausado; }

function estadoPausa() { return { ..._pausa }; }

module.exports = { pausar, retomar, estaPausado, estadoPausa };
