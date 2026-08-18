const crypto = require('crypto');

// Para alterar a senha do admin, modifique SENHA_ADMIN abaixo e reinicie.
const SENHA_ADMIN = 'admin';

const USUARIOS = [
  { usuario: 'admin', senhaHash: crypto.createHash('sha256').update(SENHA_ADMIN).digest('hex'), role: 'admin' },
];

// Abas visíveis por role — extensível para novos perfis futuros
const ABAS_POR_ROLE = {
  admin: new Set(['conflitos', 'status', 'auditoria', 'configuracoes', 'erros', 'parametros']),
};

const _sessions = new Map(); // sid → { usuario, role, expira }
const SESSION_TTL = 8 * 60 * 60 * 1000; // 8 horas

function _gerarSid() { return crypto.randomBytes(32).toString('hex'); }

function _parseCookies(h) {
  const r = {};
  if (!h) return r;
  h.split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    if (k) r[k.trim()] = v.join('=').trim();
  });
  return r;
}

function autenticar(usuario, senha) {
  const hash = crypto.createHash('sha256').update(senha || '').digest('hex');
  return USUARIOS.find(u => u.usuario === usuario && u.senhaHash === hash) || null;
}

function criarSessao(user) {
  const sid = _gerarSid();
  _sessions.set(sid, { usuario: user.usuario, role: user.role, expira: Date.now() + SESSION_TTL });
  return sid;
}

function obterSessao(req) {
  const sid = _parseCookies(req.headers.cookie).sid;
  if (!sid) return null;
  const s = _sessions.get(sid);
  if (!s) return null;
  if (Date.now() > s.expira) { _sessions.delete(sid); return null; }
  return s;
}

function destruirSessao(req) {
  const { sid } = _parseCookies(req.headers.cookie);
  if (sid) _sessions.delete(sid);
}

module.exports = { ABAS_POR_ROLE, autenticar, criarSessao, obterSessao, destruirSessao };
