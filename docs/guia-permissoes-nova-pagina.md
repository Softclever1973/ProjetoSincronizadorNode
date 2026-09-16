# Guia — Adicionar uma Página Nova ao Sistema de Permissões

Passo a passo pra criar uma tela inteira nova (ex.: **Notas Fiscais**) e liberar o acesso só
pra planos/roles específicos. Assume que a tela já existe como conceito — o foco aqui é só a
integração com o sistema de permissões (módulo × plano, módulo × role).

Exemplo usado no guia inteiro: uma tela **Notas Fiscais** (`modulo: 'notasFiscais'`) que só os
planos **DIAMANTE1** e **SAFIRA1** devem enxergar, liberada pra `gerente`/`dono` mas não pra
`vendedor`.

---

## Como funciona hoje (contexto rápido)

O nível de acesso efetivo de um usuário a um módulo é a **interseção** entre dois níveis
independentes:

- **Plano contratado** (`permissoes_plano`) — o que a empresa pagou pra ter.
- **Role do usuário** (`permissoes_role`) — o que aquele cargo (`vendedor`/`gerente`/`dono`)
  pode ver dentro do que o plano libera.

Cada par (plano, módulo) ou (role, módulo) tem um nível: `'--'` (bloqueado), `'r-'` (só
leitura) ou `'rw'` (leitura + escrita). O nível final é o mínimo dos dois — se o plano libera
`rw` mas a role só tem `r-`, o usuário só lê; se a role tem `rw` mas o plano bloqueia (`--`), o
usuário não vê nada.

A fonte de verdade dos módulos é um único arquivo:
[`src/server/domain/modulos.js`](../src/server/domain/modulos.js). Tudo mais (seed no banco,
tela de Permissões do superadmin, cache) deriva dele.

---

## Passo 1 — Registrar o módulo

Em `src/server/domain/modulos.js`, adicione uma linha no `MODULOS_DEF`:

```js
const MODULOS_DEF = Object.freeze({
  // ...
  configuracoes: { label: 'Configurações', tipo: 'modulo' },
  notasFiscais:  { label: 'Notas Fiscais', tipo: 'modulo' },
});
```

`tipo: 'modulo'` é pra uma tela inteira do dashboard (o que você quer aqui). Use
`tipo: 'funcao'` só pra uma capacidade pontual sem tela própria (ex.: `exportacao`,
`imprimir`) — não é o seu caso.

Nada mais precisa saber dessa lista antecipadamente: a rota `GET /superadmin/permissoes` (que
alimenta a aba Permissões do `admin.html`) já lê `MODULOS_DEF` direto — o módulo novo aparece
lá sozinho, sem editar nada na tela do superadmin.

---

## Passo 2 — Definir quem começa com acesso

Sem entrada no seed, o módulo nasce **bloqueado (`'--'`) em todo plano/role** até alguém
liberar manualmente pela tela de Permissões. Pra já nascer liberado nalgum plano/role — que é
o seu caso ("só DIAMANTE1/SAFIRA1") — edite `src/server/infrastructure/db-init.js`:

```js
// SEED_PERMISSOES_PLANO — segue o padrão já usado por 'financeiro' e 'exportacao':
// bloqueado no _MOD_RW_TODOS (base de todos os planos) e liberado só nos dois planos
// top de linha, via spread.
const _MOD_RW_TODOS = { /* ...módulos existentes... */ notasFiscais: '--' };

const SEED_PERMISSOES_PLANO = {
  LITE1:     _MOD_RW_TODOS,
  BRONZE1:   _MOD_RW_TODOS,
  PRATA1:    _MOD_RW_TODOS,
  OURO1:     _MOD_RW_TODOS,
  DIAMANTE1: { ..._MOD_RW_TODOS, financeiro: 'rw', fornecedores: 'rw', exportacao: 'rw', notasFiscais: 'rw' },
  SAFIRA1:   { ..._MOD_RW_TODOS, financeiro: 'rw', fornecedores: 'rw', exportacao: 'rw', notasFiscais: 'rw' },
};

// SEED_PERMISSOES_ROLE — vendedor bloqueado, gerente/dono liberados (mesmo padrão de financeiro)
const SEED_PERMISSOES_ROLE = {
  vendedor: { /* ... */ notasFiscais: '--' },
  gerente:  { /* ... */ notasFiscais: 'rw' },
  dono:     { /* ... */ notasFiscais: 'rw' },
};
```

Isso roda como `INSERT ... ON CONFLICT (chave, modulo) DO NOTHING` toda vez que o servidor
sobe — então é seguro: só cria a linha se ela ainda não existir, nunca sobrescreve uma
permissão que algum `dono` já tenha customizado pela tela. **O efeito só aparece depois do
próximo restart do servidor real** (não do seu servidor local de teste).

---

## Passo 3 — Proteger as rotas do backend

Duas opções, dependendo de como a tela busca dados:

**A) Rotas próprias (mais provável pra Notas Fiscais, que costuma ter lógica de negócio
própria)** — crie um arquivo novo, ex. `src/server/interfaces/http/routes/datasnap/notasFiscais.js`,
seguindo o modelo de `financeiro.js`:

```js
const authJwt = require('#server/interfaces/http/middleware/authJwt.js');
const { requireModulo } = require('#server/interfaces/http/middleware/requireModulo.js');
const { checkSchema } = require('#server/interfaces/http/middleware/checkSchema.js');

const guardRead  = [authJwt, checkSchema, requireModulo('notasFiscais', 'r')];
const guardWrite = [authJwt, checkSchema, requireModulo('notasFiscais', 'w')];

router.get('/:schema/notas-fiscais', ...guardRead, async (req, res) => { /* ... */ });
router.post('/:schema/notas-fiscais', ...guardWrite, async (req, res) => { /* ... */ });
```

**B) CRUD genérico numa tabela sincronizada** — se a tela é só listar/editar uma tabela que já
sincroniza do Firebird, não crie rotas novas: adicione a tabela em
`src/server/domain/tabelaModulo.js` (`TABELA_MODULO`) apontando pro módulo `notasFiscais`, e o
CRUD genérico (`routes/api/crud.js`) já aplica `requireModuloDaTabela` sozinho.

---

## Passo 4 — Conectar as rotas no servidor

Só necessário se você escolheu a opção A do Passo 3 (arquivo de rotas novo). Em
`src/server.js`, ao lado de onde `financeiro.js` é conectado:

```js
const financeiroRoutes    = require('./server/interfaces/http/routes/datasnap/financeiro');
const notasFiscaisRoutes  = require('./server/interfaces/http/routes/datasnap/notasFiscais');
// ...
app.use('/api', financeiroRoutes);
app.use('/api', notasFiscaisRoutes);
```

(Se fosse a opção B — CRUD genérico —, nada muda aqui: `routes/api/index.js` já está
conectado, e o `crud.js` dentro dele já cobre qualquer tabela nova.)

---

## Passo 5 — Criar a página HTML

Copie a estrutura de uma página existente (ex. `financeiro.html`) — ordem dos `<script>`
importa:

```html
<script src="js/presentation/utils.js"></script>
<script src="js/infrastructure/auth/session.js"></script>
<script src="js/presentation/modulosRegistry.js"></script>
<script src="js/presentation/sidebar.js"></script>
<script src="js/presentation/error-handler.js"></script>
<script src="js/infrastructure/api.js"></script>
<script src="js/presentation/masks.js"></script>          <!-- só se tiver campo com máscara -->
<script src="js/presentation/table.js"></script>          <!-- só se usar a tabela genérica -->
<script src="js/presentation/mobile-nav.js"></script>
<script src="js/application/notasFiscais/notasFiscaisPage.js"></script>
<script src="js/presentation/pwa.js"></script>
```

> **Não pule `utils.js`** mesmo que a página pareça não precisar — é ele que dá `_confirmar()`
> (modal de confirmação) e `_menuFormatoExport()` (exportar CSV/Excel). `faturamento.html` é a
> única página que hoje não o inclui, e isso parece esquecimento, não decisão — não copie esse
> detalhe de lá.

Corpo mínimo (`<body class="table-page">`):

```html
<div class="sidebar-backdrop" id="sidebar-backdrop"></div>
<div class="layout">
  <div id="sidebar-host"></div>
  <div class="main">
    <header class="header">
      <button class="menu-toggle" id="menu-toggle" aria-label="Abrir menu">&#9776;</button>
      <div>
        <div class="header-title">Notas Fiscais</div>
        <div class="header-subtitle">Gerencie as notas fiscais emitidas</div>
      </div>
      <div class="header-right"><span class="header-schema" id="header-schema"></span></div>
    </header>
    <main class="content">
      <!-- conteúdo da tela -->
    </main>
  </div>
</div>
```

`#sidebar-host` é onde `sidebar.js` injeta o menu; `#menu-toggle`/`#sidebar-backdrop` são o que
`mobile-nav.js` usa pro hambúrguer no celular; `#header-schema` é preenchido sozinho pelo
`initSidebar()`.

---

## Passo 6 — Guard de página no JS

Em `js/application/notasFiscais/notasFiscaisPage.js`, **as duas primeiras linhas executáveis
do arquivo**, antes de qualquer outra coisa (senão o redirect acontece tarde demais e a página
chega a buscar dados antes de barrar):

```js
if (!AUTH.requireModulo('notasFiscais', 'r')) { /* redirected */ }

AUTH.initSidebar();

const schema = AUTH.getSchema();
const canWrite = AUTH.podeEscreverModulo('notasFiscais');
```

Use `canWrite` pra esconder/desabilitar botões de criar/editar/excluir onde fizer sentido —
mesmo padrão de `financeiroPage.js`.

---

## Passo 7 — Registrar no menu lateral

Sem isso a página **funciona pra quem tem acesso e digitar a URL direto, mas não aparece no
menu pra ninguém** — falha silenciosa, sem erro nenhum. Em
`js/presentation/modulosRegistry.js`:

```js
const MODULOS_REGISTRY = [
  // ...
  { modulo: 'notasFiscais', href: 'notas-fiscais.html', icon: 'file-text', label: 'Notas Fiscais', secao: 'analises' },
];
```

- `modulo` — tem que bater exatamente com a chave do Passo 1.
- `icon` — nome de um ícone do [Lucide](https://lucide.dev/icons/).
- `secao` — só existem três valores válidos: `'cadastros'`, `'analises'`, `'admin'`. Qualquer
  outro valor (ou erro de digitação) faz o link **sumir do menu pra todo mundo, sem aviso** —
  o sidebar filtra por essas três seções e descarta silenciosamente o que não bate.

Esse mesmo registro também alimenta os cards de navegação do `dashboard.html` — registrar aqui
já cobre os dois lugares.

---

## Passo 8 — Nada a fazer na tela de Permissões do superadmin

`admin.html` → aba Permissões é 100% automática: lê `MODULOS_DEF` via
`GET /superadmin/permissoes` e já renderiza uma linha nova pra `notasFiscais` — inclusive
separando visualmente `tipo:'modulo'` de `tipo:'funcao'`. Nenhum código lá precisa mudar.

---

## Passo 9 — Testar

1. Reinicie o servidor local (o restart aplica o seed do Passo 2 — sem restart o módulo nem
   existe no banco ainda).
2. Logue como `dono` de um tenant com plano que **não** deveria ter acesso (ex. `LITE1`) —
   confirme que "Notas Fiscais" não aparece no menu, e que acessar `notas-fiscais.html` direto
   redireciona pra `dashboard.html`.
3. Na tela de Permissões do superadmin, mude manualmente o plano desse tenant pra `DIAMANTE1`
   (ou libere `notasFiscais` direto ali) — **recarregue a página** (não precisa relogar,
   `sidebar.js` busca o plano/módulos atualizados a cada carregamento de página) e confirme que
   o link aparece.
4. Logue como `vendedor` no mesmo tenant já liberado — confirme que continua bloqueado (regra
   de role).

---

## Checklist rápido

| # | Arquivo | O que fazer |
|---|---|---|
| 1 | `src/server/domain/modulos.js` | Adicionar chave em `MODULOS_DEF` |
| 2 | `src/server/infrastructure/db-init.js` | Adicionar nível padrão em `SEED_PERMISSOES_PLANO`/`SEED_PERMISSOES_ROLE` |
| 3 | rota nova ou `tabelaModulo.js` | Gatear com `requireModulo`/`requireModuloDaTabela` |
| 4 | `src/server.js` | `require` + `app.use` (só se criou arquivo de rotas novo) |
| 5 | `<nome>.html` | Página nova, scripts na ordem certa |
| 6 | `js/application/.../xPage.js` | `AUTH.requireModulo(...)` + `AUTH.initSidebar()` como primeiras linhas |
| 7 | `js/presentation/modulosRegistry.js` | Entrada com `modulo`/`href`/`icon`/`label`/`secao` válida |
| 8 | `admin.html` | Nada — automático |

## Armadilhas silenciosas (sem erro, sem log)

- **Esqueceu o Passo 7** → página funciona por URL direta, mas não aparece no menu pra
  ninguém.
- **`secao` errada/digitada errado no Passo 7** → link some do menu pra todo mundo.
- **Esqueceu o Passo 2** → módulo nasce bloqueado em tudo; só quem for na tela de Permissões e
  liberar manualmente vê a página.
