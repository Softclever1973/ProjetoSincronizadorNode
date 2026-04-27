require('dotenv').config();
const express = require('express');
const config = require('./config');
const { initializeDatabase } = require('./db-init');
const { recarregarEmpresas } = require('./empresas');

const sincronizacaoRoutes     = require('./routes/sincronizacao');
const produtosRoutes          = require('./routes/produtos');
const pedidosRoutes           = require('./routes/pedidos');
const movimentacaoCaixasRoutes = require('./routes/movimentacaoCaixas');
const distribuicaoRoutes      = require('./routes/distribuicao');
const authRoutes              = require('./routes/auth');
const userEmpresasRoutes      = require('./routes/userEmpresas');

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// Rotas — espelham o padrão DataSnap: /datasnap/rest/{Classe}/{Metodo}
// ---------------------------------------------------------------------------
app.use('/datasnap/rest/TSMSincronizacao',             sincronizacaoRoutes);
app.use('/datasnap/rest/TSMProdutos',                  produtosRoutes);
app.use('/datasnap/rest/TSMPedidos',                   pedidosRoutes);
app.use('/datasnap/rest/TSMMovimetacaoCaixas',         movimentacaoCaixasRoutes);
app.use('/datasnap/rest/TSMDistribuicaoDeMercadorias', distribuicaoRoutes);
app.use('/auth',          authRoutes);
app.use('/user/empresas', userEmpresasRoutes);

// ---------------------------------------------------------------------------
// Rota raiz — útil para confirmar que o servidor está ativo
// ---------------------------------------------------------------------------
app.get('/', (req, res) => {
  res.json({
    status: 'Sincronizador ativo',
    banco: config.databaseUrl.replace(/:\/\/[^@]+@/, '://***@'), // oculta credenciais
    porta: config.portaHttp,
  });
});

// ---------------------------------------------------------------------------
// Endpoint admin — recarrega o cache de empresas sem reiniciar o servidor
// Requer header: x-admin-token: <ADMIN_TOKEN>
// ---------------------------------------------------------------------------
app.post('/admin/reload-empresas', async (req, res) => {
  if (!process.env.ADMIN_TOKEN || req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ erro: 'acesso negado' });
  }
  await recarregarEmpresas();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Handler de rotas não encontradas
// ---------------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ message: `Rota não encontrada: ${req.method} ${req.path}` });
});

// ---------------------------------------------------------------------------
// Inicialização
// ---------------------------------------------------------------------------
initializeDatabase()
  .then(() => {
    app.listen(config.portaHttp, () => {
      console.log(`Sincronizador rodando em http://localhost:${config.portaHttp}`);
      console.log(`Banco: ${config.databaseUrl.replace(/:\/\/[^@]+@/, '://***@')}`);
    });
  })
  .catch((err) => {
    console.error(`Falha ao inicializar banco: ${err.message}`);
    process.exit(1);
  });
