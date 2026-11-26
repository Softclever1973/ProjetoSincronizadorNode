// Limite de tentativas de login erradas, em memória (mesma limitação de tokenBlacklist.js: por processo, zera no restart).
const JANELA_MS     = 15 * 60 * 1000;
const MAX_POR_EMAIL = 5;  // trava a conta por e-mail: senha adivinhada devagar, de vários IPs
const MAX_POR_IP    = 30; // trava o IP: vários e-mails testados da mesma origem

const _falhas = new Map(); // chave -> { n, inicio }

const chaveEmail = email => `e:${String(email).trim().toLowerCase()}`;
const chaveIp    = ip => `i:${ip}`;

function _ativa(chave, agora) {
  const f = _falhas.get(chave);
  if (f && agora - f.inicio < JANELA_MS) return f;
  if (f) _falhas.delete(chave);
  return null;
}

// Segundos até liberar (0 = liberado).
function segundosBloqueado(email, ip, agora = Date.now()) {
  let fim = 0;
  for (const [chave, max] of [[chaveEmail(email), MAX_POR_EMAIL], [chaveIp(ip), MAX_POR_IP]]) {
    const f = _ativa(chave, agora);
    if (f && f.n >= max) fim = Math.max(fim, f.inicio + JANELA_MS);
  }
  return fim ? Math.ceil((fim - agora) / 1000) : 0;
}

function registrarFalha(email, ip, agora = Date.now()) {
  for (const chave of [chaveEmail(email), chaveIp(ip)]) {
    const f = _ativa(chave, agora);
    if (f) f.n++;
    else _falhas.set(chave, { n: 1, inicio: agora });
  }
  if (_falhas.size > 10_000) for (const chave of _falhas.keys()) _ativa(chave, agora);
}

// Login certo zera a conta (o IP continua contando, senão um login válido "limparia" um ataque em massa).
function registrarSucesso(email) {
  _falhas.delete(chaveEmail(email));
}

function _limparTudo() { _falhas.clear(); }

module.exports = { segundosBloqueado, registrarFalha, registrarSucesso, _limparTudo, JANELA_MS, MAX_POR_EMAIL, MAX_POR_IP };
