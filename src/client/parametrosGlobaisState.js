const fs = require('fs');
const path = require('path');

const ARQUIVO = path.join(process.cwd(), 'parametros-sync.json');

function lerEstado() {
  if (!fs.existsSync(ARQUIVO)) return {};
  try {
    return JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
  } catch {
    return {};
  }
}

function salvarEstado(estado) {
  const tmp = ARQUIVO + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(estado, null, 2), 'utf8');
  fs.renameSync(tmp, ARQUIVO);
}

/**
 * Decide o que fazer com um parâmetro "global" num ciclo de sincronização.
 *
 * - local: valor atual no Firebird deste PDV (null se vazio/ilegível)
 * - conhecido: último valor que este PDV sabe que está sincronizado (undefined na 1ª vez)
 * - servidor: valor atual em sync_config (undefined se o servidor ainda não tem valor)
 *
 * Retorna { acao: 'push'|'pull'|'nenhuma', valor? }.
 * 'push'  -> enviar `valor` (= local) ao servidor via AtualizarParametros.
 * 'pull'  -> gravar `valor` (= servidor) no Firebird local via setParam.
 */
function decidirAcao({ local, conhecido, servidor }) {
  const localMudou = local !== null && local !== conhecido;

  if (localMudou) {
    // Nunca sincronizamos essa chave neste PDV, mas o servidor já tem valor
    // autoritativo -> servidor manda (evita corrida/duplo-seed no 1o ciclo).
    if (conhecido === undefined && servidor !== undefined) return { acao: 'pull', valor: servidor };
    return { acao: 'push', valor: local };
  }
  if (local === null && conhecido === undefined && servidor !== undefined) {
    return { acao: 'pull', valor: servidor }; // nunca configurado localmente, semeia do servidor
  }
  if (conhecido !== undefined && local === conhecido && servidor !== undefined && servidor !== local) {
    return { acao: 'pull', valor: servidor }; // inalterado aqui, outro PDV mudou -> puxa
  }
  return { acao: 'nenhuma' };
}

module.exports = { lerEstado, salvarEstado, decidirAcao };
