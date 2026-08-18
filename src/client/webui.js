const express = require('express');
const path = require('path');
const { ABAS_POR_ROLE, autenticar, criarSessao, obterSessao, destruirSessao } = require('./interfaces/webui/authSession');
const { criarConflitosRouter } = require('./interfaces/webui/routes/conflitos.routes');
const { criarStatusRouter } = require('./interfaces/webui/routes/status.routes');
const { criarAuditoriaRouter } = require('./interfaces/webui/routes/auditoria.routes');
const { criarConfiguracoesRouter } = require('./interfaces/webui/routes/configuracoes.routes');
const { criarErrosRouter } = require('./interfaces/webui/routes/erros.routes');
const { criarParametrosRouter } = require('./interfaces/webui/routes/parametros.routes');
const { criarAtualizacaoRouter } = require('./interfaces/webui/routes/atualizacao.routes');
const { criarEventosRouter } = require('./interfaces/webui/routes/eventos.routes');

const PORTA_PADRAO = 3001;

function iniciarWebUI(porta = PORTA_PADRAO, contexto = {}) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.use(express.static(path.join(__dirname, 'public')));
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // ── Rotas públicas: login / logout ────────────────────────────────────────
  app.get('/login', (req, res) => {
    if (obterSessao(req)) return res.redirect('/');
    res.render('login', { erro: null });
  });

  app.post('/login', (req, res) => {
    const { usuario, senha } = req.body || {};
    const user = autenticar(usuario, senha);
    if (!user) return res.render('login', { erro: 'Usuário ou senha incorretos.' });
    const sid = criarSessao(user);
    res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; Path=/; Max-Age=28800`);
    res.redirect('/');
  });

  app.post('/logout', (req, res) => {
    destruirSessao(req);
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
    res.redirect('/login');
  });

  // ── Middleware de autenticação ────────────────────────────────────────────
  app.use((req, res, next) => {
    if (['/login', '/logout'].includes(req.path)) return next();
    const sess = obterSessao(req);
    if (!sess) {
      // POST/PATCH/DELETE são endpoints JSON — retorna 401 em vez de redirect HTML
      if (req.path.startsWith('/api/') || req.path === '/eventos' || req.method !== 'GET') {
        return res.status(401).json({ error: 'não autenticado' });
      }
      return res.redirect('/login');
    }
    res.locals.usuarioLogado        = sess.usuario;
    res.locals.abasPermitidas       = ABAS_POR_ROLE[sess.role] || new Set();
    res.locals.atualizacaoDisponivel = contexto.atualizacaoDisponivel || null;
    res.locals.atualizacaoStatus = contexto.atualizacaoStatus || null;
    res.locals.resetPendente = contexto.resetPendente || null;
    next();
  });

  // Middleware: injeta currentPage em todas as views para aria-current="page" no nav
  app.use((req, res, next) => {
    const pathMap = { '/': 'conflitos', '/status': 'status', '/auditoria': 'auditoria', '/configuracoes': 'configuracoes', '/erros': 'erros', '/parametros': 'parametros' };
    res.locals.currentPage = pathMap[req.path] || '';
    next();
  });

  // ── Rotas por área — cada módulo é um express.Router() fino sobre o mesmo `contexto` ──
  app.use(criarConflitosRouter(contexto));
  app.use(criarStatusRouter(contexto));
  app.use(criarAuditoriaRouter(contexto));
  app.use(criarConfiguracoesRouter(contexto));
  app.use(criarErrosRouter());
  app.use(criarParametrosRouter(contexto));
  app.use(criarAtualizacaoRouter(contexto));
  app.use(criarEventosRouter());

  // Durante um respawn de atualização (updater.js), o processo antigo ainda segura a
  // porta por até JANELA_LIVENESS_MS (~10s) enquanto observa se o novo se mantém de pé —
  // então o primeiro listen() aqui costuma bater num EADDRINUSE transitório. Sem retry,
  // isso vira exceção não tratada, é engolida pelo handler global process.on('uncaughtException')
  // em index.js e a web UI nunca mais sobe nesse processo. Tenta de novo por ~20s antes de desistir.
  const escutar = (tentativasRestantes = 20) => {
    const server = app.listen(porta, () => {
      console.log(`[WEBUI] Interface de conflitos: http://localhost:${porta}`);
    });
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && tentativasRestantes > 0) {
        setTimeout(() => escutar(tentativasRestantes - 1), 1000);
      } else {
        console.error(`[WEBUI] Nao foi possivel escutar na porta ${porta}: ${err.message}`);
      }
    });
  };
  escutar();
}

module.exports = { iniciarWebUI };
