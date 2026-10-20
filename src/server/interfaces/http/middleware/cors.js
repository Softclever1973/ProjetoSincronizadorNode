// CORS: só as origens de CORS_ORIGINS (vírgula) podem chamar a API pelo navegador; sem a variável, libera tudo ('*').
// "https://*.vercel.app" aceita qualquer subdomínio. O client da loja não manda Origin e não é afetado.

function normalizar(origem) {
  return String(origem).trim().replace(/\/+$/, '').toLowerCase();
}

function lerOrigens(valor) {
  return String(valor ?? '').split(',').map(normalizar).filter(Boolean);
}

function origemPermitida(origem, permitidas) {
  const o = normalizar(origem);
  return permitidas.some(p => {
    if (p === o) return true;
    const m = p.match(/^(https?:\/\/)\*\.(.+)$/);
    return Boolean(m) && o.startsWith(m[1]) && o.endsWith(`.${m[2]}`) && o.length > m[1].length + m[2].length + 1;
  });
}

function criarCors(permitidas) {
  const liberado = permitidas.length === 0;
  return function cors(req, res, next) {
    const origem = req.headers.origin;
    if (liberado) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else {
      res.setHeader('Vary', 'Origin');
      if (origem && origemPermitida(origem, permitidas)) res.setHeader('Access-Control-Allow-Origin', origem);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-token');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  };
}

module.exports = { criarCors, lerOrigens, origemPermitida };
