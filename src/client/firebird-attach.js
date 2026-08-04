const Firebird = require('node-firebird');

const TIMEOUT_PADRAO_MS = 10000;

// Firebird.attach() não tem timeout próprio — se o TCP não completar o handshake (porta
// errada, serviço parado, firewall derrubando o pacote em silêncio), o callback nunca
// dispara e quem chamou fica travado pra sempre, sem erro. Envolve num timeout manual pra
// falhar rápido com uma mensagem que aponta o problema em vez de uma tela congelada.
function attachComTimeout(opcoes, timeoutMs = TIMEOUT_PADRAO_MS) {
  return new Promise((resolve, reject) => {
    let liquidado = false;
    const timer = setTimeout(() => {
      if (liquidado) return;
      liquidado = true;
      reject(new Error(
        `Timeout ao conectar no Firebird (${opcoes.host}:${opcoes.port}) após ${timeoutMs / 1000}s — ` +
        'verifique se o serviço do Firebird está rodando, a porta está correta e não há firewall bloqueando.'
      ));
    }, timeoutMs);

    Firebird.attach(opcoes, (err, db) => {
      if (liquidado) {
        // resposta chegou depois do timeout já ter rejeitado — não deixa a conexão pendurada
        if (!err && db) db.detach(() => {});
        return;
      }
      liquidado = true;
      clearTimeout(timer);
      if (err) return reject(err);
      resolve(db);
    });
  });
}

module.exports = { attachComTimeout, TIMEOUT_PADRAO_MS };
