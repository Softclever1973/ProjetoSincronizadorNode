# Sincronizador Node.js — Matriz / Filial

Sistema de sincronização bidirecional de dados entre um servidor central PostgreSQL (matriz) e clientes Firebird (filiais), com um dashboard web para donos/gerentes/vendedores. É uma reescrita em Node.js de um sistema originalmente desenvolvido em Delphi/DataSnap.

Este repositório contém o **servidor** e o **cliente de sincronização** (dois processos Node separados). O dashboard web (`SiriusWebFrontend`) é um repositório irmão — veja a seção [Frontend Web](#frontend-web).
---   


## Sumário

1. [Visão Geral](#visão-geral)
2. [Pré-requisitos](#pré-requisitos)
3. [Estrutura do Projeto](#estrutura-do-projeto)
4. [Configuração do Servidor (Matriz)](#configuração-do-servidor-matriz)
5. [Configuração do Cliente (Filial)](#configuração-do-cliente-filial)
6. [Referência de Variáveis de Ambiente](#referência-de-variáveis-de-ambiente)
7. [Multi-tenancy: Gerenciando Empresas](#multi-tenancy-gerenciando-empresas)
8. [Autenticação e Permissões (API Web)](#autenticação-e-permissões-api-web)
9. [API Web Frontend](#api-web-frontend)
10. [Painel Superadmin](#painel-superadmin)
11. [Interface Web da Filial](#interface-web-da-filial)
12. [Fluxo de Sincronização](#fluxo-de-sincronização)
13. [Resolução de Conflitos](#resolução-de-conflitos)
14. [Adicionando uma Nova Tabela ao Sync](#adicionando-uma-nova-tabela-ao-sync)
15. [Política de Retenção de 2 Anos](#política-de-retenção-de-2-anos)
16. [Testes](#testes)
17. [Cliente empacotado (.exe)](#cliente-empacotado-exe)
18. [Scripts Utilitários](#scripts-utilitários)
19. [Frontend Web](#frontend-web)
20. [Solução de Problemas](#solução-de-problemas)

---

## Visão Geral

```
┌─────────────────────────────────────────────────────┐
│                 SERVIDOR (Matriz)                   │
│          Node.js + Express + PostgreSQL             │
│              porta padrão: 8080                     │
└──────────────────────┬──────────────────────────────┘
                       │ HTTP REST
          ┌────────────┼────────────────────┐
          │            │                    │
┌─────────▼───────────┐│         ┌──────────▼───────────┐
│  CLIENTE (Filial 1) ││         │  SiriusWebFrontend    │
│  Node.js + Firebird ││         │  Dashboard (HTML/JS)  │
│  WebUI: porta 3001  ││         │  porta padrão: 3000   │
└─────────────────────┘│         └───────────────────────┘
              ┌─────────▼───────────┐
              │  CLIENTE (Filial 2) │
              │  Node.js + Firebird │
              │  WebUI: porta 3001  │
              └─────────────────────┘
```

**O servidor** expõe uma API REST no padrão `/datasnap/rest/{Classe}/{Método}` — compatível com os clientes Delphi originais — mais uma API `/api/:schema/...` consumida pelo dashboard web. Cada empresa (CNPJ) ocupa um schema isolado no PostgreSQL (multi-tenancy schema-per-tenant).

**O cliente** roda como processo contínuo na filial. A cada intervalo configurável (padrão 30 segundos), ele executa:
1. **Pull** — busca registros novos/atualizados no servidor e aplica no Firebird local
2. **Push** — envia alterações locais do Firebird ao servidor

---

## Pré-requisitos

| Componente | Versão mínima |
|---|---|
| Node.js | 18+ |
| PostgreSQL | 12+ (no servidor/matriz) |
| Firebird | 2.5 ou 3.x (nas filiais) |

Instale as dependências do projeto:

```bash
npm install
```

---

## Estrutura do Projeto

O código segue uma organização em camadas (domain / application / infrastructure / interfaces), separada entre `server` (matriz) e `client` (filial):

```
├── src/
│   ├── server.js                       # Ponto de entrada do servidor (monta o Express app)
│   └── server/
│       ├── domain/                     # Regras de negócio puras, sem I/O
│       │   ├── validacao.js            # Regex de nome, regras por tabela, colunas ocultas
│       │   ├── schema.js
│       │   ├── financeiro.js
│       │   ├── planos.js               # Planos de assinatura (LITE1..SAFIRA1)
│       │   ├── modulos.js              # Registro central do sistema de permissões
│       │   ├── permissoes.js           # Interseção plano × role → nível efetivo
│       │   └── tabelaModulo.js         # Mapa tabela → módulo (CRUD genérico)
│       ├── application/                # Casos de uso que orquestram domain + infra
│       │   ├── financeiro/             # Geração de contas a receber, fluxo de caixa
│       │   ├── onboarding/             # Vínculo automático dono ↔ vendedor
│       │   └── sync/                   # Controller de push do sync
│       ├── infrastructure/
│       │   ├── db.js                   # Pool PostgreSQL + helpers de query
│       │   ├── db-init.js              # DDL + seed de todas as tabelas de controle
│       │   ├── timeService.js
│       │   ├── email/                  # Cliente de API de e-mail (recuperação de senha)
│       │   ├── cache/                  # empresasCache, tenantCache, tokenBlacklist, permissoesCache
│       │   └── repositories/           # colunasRepository, auditLogRepository, pedidosRepository
│       └── interfaces/http/
│           ├── erroServidor.js
│           ├── middleware/             # authJwt, checkSchema, checkRole, requireModulo,
│           │                          # requireSuperAdmin, filialBloqueada, auth (token de sync)
│           └── routes/
│               ├── api/                # crud.js, pedidos.js, dashboard.js, audit.js, admin.js
│               └── datasnap/           # sincronizacao, produtos, pedidos, auth, adminEmpresas,
│                                        # usuarios, financeiro, distribuicao, movimentacaoCaixas
│
├── src/client/
│   ├── index.js                        # Loop principal: setup → pull → push a cada ciclo
│   ├── domain/                         # tabelas.js (lista mestra), auditoria.js
│   ├── application/
│   │   ├── syncEngine/                 # sync.js (pull), push.js, cursor.js, echos.js, resolverConflito.js
│   │   ├── updater.js                  # Auto-update do client.exe empacotado
│   │   ├── resetLocal.js
│   │   └── syncParametrosGlobais.js    # Sync bidirecional de parâmetros entre PDVs
│   ├── infrastructure/
│   │   ├── firebird/                   # db.js, db-utils.js, firebird-attach.js
│   │   ├── config/                     # tabelasConfig.js, paramsSyncMap.js, config-crypto.js
│   │   ├── persistence/                # conflitos.js, erros.js
│   │   ├── notificar.js                # Notificações nativas do Windows
│   │   └── tray.js                     # Ícone na bandeja (apenas client.exe empacotado)
│   └── interfaces/webui/
│       ├── routes/                     # status, auditoria, configuracoes, conflitos, erros,
│       │                                # eventos, parametros, atualizacao (8 arquivos, ~100 linhas cada)
│       └── (views/ e public/ na raiz de src/client/)
│
├── scripts/                            # ver "Scripts Utilitários"
├── tests/                              # suíte Jest (unitários + integração contra Postgres real)
├── .env.example                        # Modelo de configuração do servidor
└── src/client/.env.example             # Modelo de configuração do cliente
```

> Em modo empacotado (`client.exe`), credenciais ficam em `config.enc` (criptografado via DPAPI do Windows) em vez de `.env` — veja [Cliente empacotado (.exe)](#cliente-empacotado-exe).

---

## Configuração do Servidor (Matriz)

### 1. Criar o arquivo `.env` na raiz do projeto

Na primeira inicialização sem `.env`, o servidor executa automaticamente um **wizard de configuração** interativo. Para configuração manual, copie o modelo:

```bash
cp .env.example .env
```

Conteúdo do `.env`:

```env
# URL de conexão PostgreSQL
DATABASE_URL=postgresql://postgres:suasenha@localhost:5432/matriz

# Porta HTTP do servidor Express (padrão: 8080)
PORT=8080

# Segredo para assinar JWTs de usuários
# Gere um valor forte com: npm run generate-secret
JWT_SECRET=cole-aqui-o-secret-gerado

# Token de administrador para o endpoint /admin/reload-empresas
ADMIN_TOKEN=outro-secret-forte-aqui
```

> **Gerar valores seguros** para `JWT_SECRET` e `ADMIN_TOKEN`:
> ```bash
> npm run generate-secret
> ```

### 2. Criar o banco de dados PostgreSQL

```sql
CREATE DATABASE matriz;
```

### 3. Iniciar o servidor

```bash
# Produção
npm start

# Desenvolvimento (auto-reload com nodemon)
npm run dev
```

Na primeira inicialização, o servidor cria automaticamente (idempotente — seguro rodar em toda inicialização) as tabelas de controle no schema `public`:

| Tabela | Descrição |
|---|---|
| `sync_tenants` | Mapeia token → schema (uma linha por empresa); também guarda `plano`, `ativo`, `regime_tributario` |
| `usuarios` | Usuários da API web (login JWT), incluindo `is_super_admin` e campos de recuperação de senha |
| `usuarios_empresas` | Relação N:N usuário ↔ empresa com `role` (`dono`, `gerente`, `vendedor`), `id_loja` e `id_vendedor` |
| `audit_log` | Histórico de operações INSERT/UPDATE/DELETE via API web (`dados`, `dados_antes`, `ip_cliente`) |
| `permissoes_plano` | Nível (`--`/`r-`/`rw`) de cada módulo por plano — ver [Autenticação e Permissões](#autenticação-e-permissões-api-web) |
| `permissoes_role` | Nível de cada módulo por role (`dono`/`gerente`/`vendedor`) |

Cada schema de empresa provisionado via `create-empresa.js` recebe também `seq_atualizacao_matriz`, `filiais_bloqueadas`, `registros_deletados`, `sync_filiais`, `sync_config`, `srv_id_map` e as funções de trigger `fn_seq_atualizacao()`/`fn_registrar_delecao()`.

### 4. Criar a primeira empresa

```bash
node scripts/create-empresa.js \
  --schema=empresa_kr \
  --token=TOKEN_SEGURO_AQUI \
  --nome="KR Supermercados"
```

O script cria o schema, provisiona as tabelas internas de controle e registra a empresa em `public.sync_tenants`. **Não é necessário reiniciar o servidor** — o cache de empresas recarrega sozinho na próxima requisição (ou via `POST /admin/reload-empresas -H "x-admin-token: ..."`).

---

## Configuração do Cliente (Filial)

O cliente roda **na máquina da filial**, conectado ao banco Firebird local.

### 1. Configurar o cliente

Na primeira execução sem `.env`, o cliente inicia um **wizard de configuração** interativo (prompt para token, URL do servidor, caminho/credenciais do Firebird, loja e PDV). Para configuração manual, crie `src/client/.env`:

```env
SYNC_TOKEN=TOKEN_SEGURO_AQUI
FIREBIRD_HOST=localhost
FIREBIRD_PORT=3050
FIREBIRD_DATABASE=C:\FDBS\FILIAL.FDB
FIREBIRD_USER=SYSDBA
FIREBIRD_PASSWORD=masterkey
INTERVALO_MS=30000
AUTO_ATUALIZAR=true
```

> **`FIREBIRD_DATABASE` e `FIREBIRD_PASSWORD` são obrigatórios.** O processo termina com mensagem clara se estiverem ausentes. Esse `.env` só é usado em **desenvolvimento** (`npm run client`) — em `client.exe` empacotado, as mesmas chaves ficam em `config.enc`, criptografado (ver [Cliente empacotado (.exe)](#cliente-empacotado-exe)).

### 2. Parâmetros do banco Firebird

| ID | Exemplo | Descrição |
|---|---|---|
| `60024` | `http://192.168.1.100:8080` | URL base do servidor (sem barra final) — gravada pelo wizard |
| `50003` | `1` | Número da loja (`idLoja`) — **deve ser único por filial dentro da empresa** |
| `50004` | `1` | Número do PDV (`idPDV`) — opcional |
| `50005` | `Loja Centro` | Nome desta filial — identifica a filial na tabela `sync_filiais` do servidor |

> Se duas filiais usarem o mesmo `idLoja` (`50003`), os dados se sobrescreverão. Verifique antes de colocar uma nova filial em produção.

### 3. Iniciar o cliente

```bash
# Produção
npm run client

# Desenvolvimento (auto-reload)
npm run client:dev
```

**Na primeira execução**, o `setup.js` cria automaticamente no Firebird `SYNC_ALTERACOES_PENDENTES`, `SYNC_VERSOES_SERVIDOR`, `SYNC_ERROS` e os triggers `SYNC_*` em cada tabela sincronizada. Após o setup, o cliente entra no loop de sincronização e inicia a **interface web** em `http://localhost:3001`.

---

## Referência de Variáveis de Ambiente

### Servidor (`.env` na raiz do projeto)

| Variável | Obrigatório | Padrão | Descrição |
|---|---|---|---|
| `DATABASE_URL` | Sim | — | URL de conexão PostgreSQL |
| `PORT` | Não | `8080` | Porta HTTP do servidor |
| `JWT_SECRET` | Sim | — | Segredo para assinar JWTs |
| `ADMIN_TOKEN` | Não | — | Token para `/admin/reload-empresas` e `/admin/reload-permissoes` |

### Cliente (`src/client/.env`, apenas em desenvolvimento)

| Variável | Obrigatório | Padrão | Descrição |
|---|---|---|---|
| `SYNC_TOKEN` | Sim | — | Token de autenticação com o servidor |
| `FIREBIRD_HOST` | Não | `localhost` | Host do servidor Firebird |
| `FIREBIRD_PORT` | Não | `3050` | Porta TCP do Firebird |
| `FIREBIRD_DATABASE` | Sim | — | Caminho completo do arquivo `.fdb` |
| `FIREBIRD_USER` | Não | `SYSDBA` | Usuário do Firebird |
| `FIREBIRD_PASSWORD` | Sim | — | Senha do usuário Firebird |
| `INTERVALO_MS` | Não | `30000` | Intervalo entre ciclos (ms) |
| `AUTO_ATUALIZAR` | Não | ativado | Só a string `'false'` desativa o auto-update do `.exe` empacotado |

---

## Multi-tenancy: Gerenciando Empresas

O servidor suporta múltiplas empresas simultaneamente. Cada empresa tem um **schema PostgreSQL** isolado (ex: `empresa_kr`) e um **token único** usado pelos clientes das filiais.

```bash
node scripts/create-empresa.js --schema=empresa_jb --token=NOVO_TOKEN_AQUI --nome="JB Atacado"
```

**Regras para `--schema`:** apenas letras minúsculas, números e `_`; deve começar com letra ou `_`.

---

## Autenticação e Permissões (API Web)

Existe uma camada de autenticação JWT separada do token de sync (`?token=`), usada para acessar a API via browser ou ferramentas REST.

### Roles

Três roles por vínculo usuário↔empresa: `dono`, `gerente` (escopo de loja) e `vendedor` (escopo de loja, mais restrito).

### Sistema de permissões por módulo

Cada área do sistema é um **módulo** (`produtos`, `clientes`, `pedidos`, `fornecedores`, `usuarios`, `financeiro`, `faturamento`, `auditoria`, `configuracoes`) ou uma **função** pontual sem tela própria (hoje: `exportacao`, o botão de baixar CSV/Excel). Cada módulo/função tem um nível estilo Unix — `--` (bloqueado), `r-` (só leitura) ou `rw` (leitura + escrita) — definido **por plano** (`permissoes_plano`) e **por role** (`permissoes_role`). A **permissão efetiva** de um usuário é a interseção (o menor dos dois níveis): um plano Lite nunca libera Financeiro, mesmo para o dono; uma role vendedor nunca edita Configurações, mesmo num plano Diamante.

Isso é resolvido a cada requisição (`obterPermissoesEfetivas`, com cache invalidado ao editar permissões pelo superadmin) e aplicado via middleware:
- `requireModulo(modulo, 'r'|'w')` — rotas cujo módulo é fixo (financeiro, usuários, faturamento, auditoria, configurações).
- `requireModuloDaTabela('r'|'w')` — rotas do CRUD genérico (`/tabelas/:tabela`), que resolve o módulo a partir do nome da tabela (`domain/tabelaModulo.js`); uma tabela fora desse mapa não é gateada por módulo.

No frontend, o mesmo dado chega em `GET /api/:schema/plano` (campo `modulos`) e alimenta `AUTH.podeLerModulo(modulo)` / `AUTH.podeEscreverModulo(modulo)`, usados tanto pra esconder telas inteiras quanto botões específicos.

A matriz completa é editável ao vivo pela aba **Permissões** do [painel superadmin](#painel-superadmin) — não precisa de deploy pra mudar o que um plano ou role libera.

### Criar um usuário (bootstrap)

Não há endpoint público de registro. Use o script CLI:

```bash
node scripts/create-usuario.js \
  --email=admin@empresa.com --senha=senha123 --schema=empresa_kr --role=dono

node scripts/create-usuario.js \
  --email=gerente@loja.com --senha=senha123 --schema=empresa_kr --role=gerente --loja=2
```

Após o primeiro usuário criado, os demais podem ser criados via API (`POST /api/:schema/usuarios`, módulo `usuarios` em `rw`).

### Login, sessão e recuperação de senha

```http
POST /auth/login              { "email": "...", "senha": "..." }   → { token, schemas }
POST /auth/esqueci-senha      { "email": "..." }                    → sempre 200 (não revela se o e-mail existe)
POST /auth/redefinir-senha    { "token": "...", "novaSenha": "..." }
POST /auth/refresh            (Bearer) → reemite o JWT com role/loja/vendedor atuais
POST /auth/logout             (Bearer) → revoga o token (blacklist em memória, por processo)
GET  /auth/me                 (Bearer) → { id, schemas }
GET  /user/empresas           (Bearer) → empresas do usuário, com plano/modulos efetivos
```

---

## API Web Frontend

Rotas usadas pela interface **SiriusWebFrontend**. Requerem `Authorization: Bearer <jwt>`; o schema faz parte do path e só é aceito se vinculado à conta do usuário (`checkSchema`).

### CRUD genérico de tabelas

| Método | Rota | Gate | Descrição |
|---|---|---|---|
| GET | `/api/:schema/tabelas/:tabela/colunas` | schema | Introspecção de colunas (nome, tipo, is_generated) |
| GET | `/api/:schema/tabelas/:tabela/next-pk` | schema | Próximo valor de PK disponível (`?pk=COLUNA`) |
| GET | `/api/:schema/tabelas/:tabela/by-pk` | schema | Registro único por PK (`?pk=COL&value=VAL`) |
| GET | `/api/:schema/tabelas/:tabela/distinct/:col` | schema | Valores distintos de uma coluna (máx. 200) |
| GET | `/api/:schema/tabelas/:tabela` | módulo `r` | Listagem paginada com busca e filtros |
| POST/PUT | `/api/:schema/tabelas/:tabela` | módulo `w` | Upsert — body: `{ pk, registro }` (pk pode ser array) |
| DELETE | `/api/:schema/tabelas/:tabela` | módulo `w` | Deleção por PK — body: `{ pk, pkValores }` |

O módulo é resolvido a partir da tabela (`PRODUTOS`→`produtos`, `CLIENTES`→`clientes`, `PEDIDOS`/`PEDIDOS_ITENS`/`PEDIDOS_PARCELAS_PAGAMENTOS`→`pedidos`, `FORNECEDORES`→`fornecedores`); tabelas fora desse mapa não são gateadas por módulo, só por `checkSchema`.

Parâmetros de listagem (`GET`): `page`/`pageSize` (máx. 500; `all=true` até 10.000), `q` (busca textual), `cols`, `statusCol`/`statusVal`, `sortCol`/`sortDir`, `filtroLoja`, `filtros` (JSON: `{"GRUPO":"BEBIDAS"}` ou range `{"DATA":{"gte":"2024-01-01"}}`).

O upsert incrementa `ID_ULTIMA_ATUALIZACAO_MATRIZ` via `seq_atualizacao_matriz` quando a coluna existe, propagando a alteração às filiais no próximo pull.

### Pedidos

| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/:schema/pedidos-lista` | Lista simplificada com `VALOR_TOTAL` calculado; filtros de busca, status, data, vendedor, faixa de valor |
| GET | `/api/:schema/pedidos-completo` | JOIN flat PEDIDOS + PEDIDOS_ITENS + PEDIDOS_PARCELAS_PAGAMENTOS + PRODUTOS |
| GET | `/api/:schema/pedidos/:id/itens` | Itens com JOIN em PRODUTOS |
| GET | `/api/:schema/pedidos/:id/pagamentos` | Parcelas de pagamento |

Criação/edição/remoção de pedidos, itens e parcelas passam pelo CRUD genérico acima (módulo `pedidos`).

### Financeiro

Módulo `financeiro` (gate `requireModulo`, split por verbo — GET exige `r`, escrita exige `w`):

| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/:schema/financeiro/contas-receber` | Lista paginada de títulos a receber |
| POST/PATCH/DELETE | `/api/:schema/financeiro/contas-receber[/:id]` | CRUD de título a receber |
| GET | `/api/:schema/financeiro/contas-pagar` | Lista paginada de títulos a pagar |
| POST/PATCH/DELETE | `/api/:schema/financeiro/contas-pagar[/:id]` | CRUD de título a pagar (baixa aceita desconto/juros/multa) |
| GET | `/api/:schema/financeiro/fluxo-caixa` | Série de entradas/saídas por período |
| GET | `/api/:schema/financeiro/filiais` | Filiais para o filtro do módulo |
| POST/DELETE | `/api/:schema/financeiro/parcelas-pedido[/...]` | Gera/remove os A_RECEBER de um pedido — **sem gate de módulo de propósito**, é chamado pelo próprio fluxo de Pedidos (inclusive por vendedor) |

### Auditoria

| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/:schema/audit-log` | Log paginado (módulo `auditoria`, `r`); filtros `tabela`, `operacao`, `dataInicio`, `dataFim` |

Cada registro traz `dados` (campos enviados; `null` em DELETE), `dados_antes` (snapshot completo pré-operação; `null` em INSERT), `email`, `tabela`, `operacao`, `pk_valor`, `ip_cliente`, `criado_em`. Gerentes/vendedores veem apenas a própria loja.

### Usuários do tenant

Módulo `usuarios`:

| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/:schema/usuarios` | Lista usuários do schema |
| POST | `/api/:schema/usuarios` | Cria usuário e vincula ao schema |
| PATCH | `/api/:schema/usuarios/:id/ativo` | Ativa/desativa |
| PATCH | `/api/:schema/usuarios/:id/perfil` | Edita nome, email ou senha |
| PATCH | `/api/:schema/usuarios/:id/role` | Altera role/loja/vendedor — **também exige role `dono`**, mesmo com o módulo em `rw` |
| GET | `/api/:schema/vendedores-disponiveis` | Vendedores da tabela `VENDEDORES` do tenant |

### Dashboard / Faturamento

Módulo `faturamento` (leitura):

| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/:schema/dashboard` | Totais do dia (sem gate de módulo — página inicial) |
| GET | `/api/:schema/dashboard/faturamento-por-loja` | Faturamento e contagem por loja |
| GET | `/api/:schema/dashboard/evolucao-mensal` | Série mensal (mês exato ou intervalo) |
| GET | `/api/:schema/dashboard/evolucao-mensal-por-loja` | Série histórica multi-loja — **também exige role `dono`** |
| GET | `/api/:schema/dashboard/top-produtos` | Top 10 produtos |
| GET | `/api/:schema/dashboard/pedidos-por-status` | Contagem por status |
| GET | `/api/:schema/dashboard/faturamento-por-vendedor` | Top 10 vendedores |

### Configurações e outros

| Método | Rota | Descrição |
|---|---|---|
| GET/PUT | `/api/:schema/admin/sync-config` | Lê/edita `sync_config` (módulo `configuracoes`) |
| GET | `/api/:schema/sync-flags` | Flags de sync sem restrição de role (ex. `venda_saldo_negativo`) |
| GET | `/api/:schema/filiais` | Filiais registradas em `sync_filiais` |
| GET | `/api/:schema/plano` | Plano atual + `modulos` (permissão efetiva de cada módulo para o usuário) |

---

## Painel Superadmin

Cross-tenant, gated por `authJwt + requireSuperAdmin` (claim `isSuperAdmin`, setado no login quando `usuarios.is_super_admin = true`). Não usa o modelo de role dono/gerente/vendedor.

| Método | Rota | Descrição |
|---|---|---|
| GET | `/superadmin/empresas` | Lista empresas com contagem de usuários |
| POST | `/superadmin/empresas` | Cria empresa (schema + token) |
| PATCH | `/superadmin/empresas/:schema/ativo` | Ativa/desativa uma empresa |
| PUT | `/superadmin/empresas/:schema/plano` | Muda o plano de assinatura |
| POST | `/superadmin/empresas/:schema/reset` | Reseta os dados do tenant |
| GET | `/superadmin/empresas/:schema/filiais` | Filiais da empresa |
| GET | `/superadmin/planos` | Lista de planos disponíveis |
| GET | `/superadmin/permissoes` | Matriz completa plano×módulo + role×módulo, com labels e tipo |
| PUT | `/superadmin/permissoes/plano` | Upsert de uma célula `(plano, módulo) → nível` |
| PUT | `/superadmin/permissoes/role` | Upsert de uma célula `(role, módulo) → nível` |
| GET | `/superadmin/usuarios` | Lista super-admins globais |
| POST | `/superadmin/usuarios` | Cria um novo super-admin |

---

## Interface Web da Filial

Após iniciar o cliente, acesse `http://localhost:3001` (login por sessão-cookie).

| Página | Descrição |
|---|---|
| `/` — Conflitos | Registros alterados nos dois lados desde a última sync. Ações: **Manter local**, **Manter servidor**, **Mesclar campos** |
| `/status` | Total no servidor vs. local, cursor sincronizado, pendentes de envio, por tabela |
| `/auditoria` | Comparação registro a registro servidor × filial; **Aplicar Matriz em Tudo** ou **Resolver um por um** |
| `/configuracoes` | Ativa/desativa tabelas do sync sem reiniciar; carga inicial/parcial em lote |
| `/parametros` | Parâmetros globais sincronizados bidirecionalmente entre PDVs |
| `/erros` | Últimos 200 erros de sincronização |

Eventos de conflito/erro/atualização chegam em tempo real via SSE (`/eventos`).

---

## Fluxo de Sincronização

### Pull (Servidor → Filial)

A cada ciclo, para cada tabela ativa:

1. Busca até **50 registros** do servidor onde `ID_ULTIMA_ATUALIZACAO_MATRIZ > cursor_local`
2. Para cada registro recebido, verifica se há alteração local pendente:

   | Situação | Ação |
   |---|---|
   | Sem alteração local pendente | Upsert normal no Firebird; atualiza cursor |
   | Pendente + registro **nunca recebido do servidor** | **Colisão de PK** → renomeia PK local (MAX+1 para numérico, `val_1` para texto); aplica registro do servidor |
   | Pendente + registro **já recebido anteriormente** | **Conflito de conteúdo** → salva em `conflitos.json`; avança cursor sem upsert |
   | **Echo de push** (registro enviado por esta filial neste ciclo) | Avança cursor sem re-aplicar upsert |

3. Busca registros deletados (`REGISTROS_DELETADOS`) e remove do Firebird local

> Os triggers do Firebird são desabilitados durante o pull via `RDB$SET_CONTEXT('USER_SESSION', 'SYNC_SKIP', '1')` para evitar que registros vindos do servidor gerem novas entradas em `SYNC_ALTERACOES_PENDENTES`.

### Push (Filial → Servidor)

1. Lê todos os registros de `SYNC_ALTERACOES_PENDENTES` para a tabela
2. Para cada pendente: se não existe mais localmente, envia `{ deletar: true }`; senão envia para `POST /datasnap/rest/TSMSincronizacao/ReceberRegistro` com a última versão conhecida
3. O servidor compara versões: sem conflito → aplica e retorna `{ ok: true, idAtualizacaoMatriz }`; com conflito → `{ conflito: true, versaoServidor }`
4. Registros enviados com sucesso saem de `SYNC_ALTERACOES_PENDENTES`

FKs marcadas `traduzirSrvId` são resolvidas para o `SRV_ID` do pai antes do envio; um pai ainda sem `SRV_ID` reenfileira a si mesmo automaticamente.

---

## Resolução de Conflitos

Um conflito ocorre quando um registro foi alterado **tanto na filial quanto no servidor** desde a última sincronização. Resolva em `http://localhost:3001` (página Conflitos): **Manter local**, **Manter servidor** ou **Mesclar campos** (campo a campo). `SYNC_VERSOES_SERVIDOR` rastreia a última versão recebida por registro para detectar a divergência no push seguinte.

---

## Adicionando uma Nova Tabela ao Sync

### Passo 1 — `src/client/domain/tabelas.js`

Respeitando a **ordem de FK** (tabelas pai antes das filhas):

```js
{
  nome: 'NOME_DA_TABELA',
  pk: 'ID_NOME_DA_TABELA',     // string simples ou array para PK composta: ['COL1', 'COL2']
  temDelete: true,
  filtroFilial: null,          // nome da coluna pra restringir por loja, ou null
  endpoint: null,               // só se a tabela usa uma rota não-padrão
  grupo: 'Cadastros',
  generator: null,              // generator Firebird; null se a filial não cria registros
  colunaData: null,             // coluna de data de negócio p/ retenção de 2 anos; null = sem expiração
}
```

**Grupos existentes:** `Auxiliares`, `Cadastros`, `Produtos`, `Clientes`, `Fornecedores`, `Transportadores`, `Vendedores`, `Kits`.

### Passo 2 — `src/server/interfaces/http/routes/datasnap/sincronizacao.js`

Adicione o nome ao `Set` `TABELAS_PERMITIDAS`.

### Passo 3 — Garantir a coluna no PostgreSQL

A tabela precisa de `ID_ULTIMA_ATUALIZACAO_MATRIZ INTEGER` com trigger incrementando via `nextval('schema.seq_atualizacao_matriz')`. Se a tabela **não existe** ainda, ela é criada automaticamente no primeiro push da filial, com tipos inferidos do primeiro registro.

### Passo 4 — Reiniciar servidor e cliente

O `setup.js` cria o trigger `SYNC_NOME_DA_TABELA` no Firebird automaticamente.

---

## Política de Retenção de 2 Anos

Tabelas transacionais têm o histórico sincronizado limitado a **2 anos**; tabelas de cadastro (`colunaData: null`) não são afetadas.

| Momento | O que acontece |
|---|---|
| Durante o pull | O servidor não envia registros com `colunaData` anterior a 2 anos |
| Limpeza diária | A cada 24h, registros antigos são removidos do servidor e da filial |

`PEDIDOS` tem `colunaData: 'DATA_HORA'`; `PEDIDOS_ITENS`/`PEDIDOS_PARCELAS_PAGAMENTOS` são limpas em cascata. Para outra tabela, defina `colunaData` e adicione o grupo em **ambos** `src/server/infrastructure/limpeza.js`-equivalente (servidor) e `src/client/*/limpeza.js` (Firebird), filhas antes do pai.

---

## Testes

```bash
npm test                    # suíte Jest completa
npx jest validarRegistro    # um arquivo por nome parcial
npx jest --watch
```

- **Lógica pura, mockada** — `validarRegistro`, `authJwt`, `checkRole`, `checkSchema`, `permissoes` (interseção plano×role), árvore de decisão de conflito do sync (`sync.conflitos.test.js`/`push.conflitos.test.js`).
- **Integração real contra PostgreSQL** — schema dedicado `empresa_teste` no mesmo banco do `DATABASE_URL`, provisionado/truncado automaticamente (`tests/helpers/testSchema.js`). Cobre CRUD, sincronização (incluindo auto-cura de sequence/tabela), permissões (`permissoes.integracao.test.js`) e planos.
- **End-to-end (Playwright)** vive em `../SiriusWebFrontend/e2e/` — dirige um browser real contra este backend + o frontend dev server, com schema próprio `empresa_e2e`.

Arquivos de teste que tocam o mesmo schema **não devem** truncar tabelas usadas por outro arquivo — Jest roda arquivos em paralelo por padrão.

---

## Cliente empacotado (.exe)

```bash
npm run build:client   # → dist/client.exe (Node 22, Windows x64, via @yao-pkg/pkg)
npm run build:server   # → dist/server.exe
```

No `.exe` empacotado, o cliente:
- Guarda credenciais em **`config.enc`** (não `.env`), criptografado com **DPAPI do Windows** (`CurrentUser` scope — só decripta na mesma máquina/usuário que gerou). Uma instalação com `.env` legado é migrada automaticamente na primeira execução.
- Roda em **modo bandeja** (`--background`): ícone no system tray com "Abrir Console", "Abrir Web UI", "Iniciar com o Windows" e "Parar cliente".
- **Auto-atualiza** sozinho: verifica releases no GitHub a cada ciclo (throttled), aplica entre ciclos com jitter de 0–4h por loja, e tem rollback em duas camadas se a nova versão falhar ao iniciar. Desative com `AUTO_ATUALIZAR=false`.

Push de uma tag `v*` dispara `.github/workflows/build.yml`, que builda os dois executáveis, roda um smoke test em cada um e publica um GitHub Release com os `.zip`.

---

## Scripts Utilitários

| Script | Uso |
|---|---|
| `scripts/create-empresa.js` | Cria um novo schema de empresa (`--schema`, `--token`, `--nome`) |
| `scripts/create-usuario.js` | Cria um usuário da API web (`--email`, `--senha`, `--schema`, `--role`, `--loja`) |
| `scripts/reset-empresa.js` | Reseta os dados de uma empresa (usado também pelo painel superadmin) |
| `scripts/migrate-public-to-schema.js` | Migra dados de uma instalação antiga (schema `public`) pra um schema dedicado |
| `scripts/export-schema.js` | Exporta o schema do Firebird como DDL PostgreSQL (`schema-matriz.sql`) |
| `scripts/migrate-data.js` | Migra dados do Firebird pro PostgreSQL (`--tables=`/`--skip=` opcionais) |
| `scripts/seed-e2e-empresa.js` | Semeia o schema `empresa_e2e` usado pelos testes Playwright do frontend |
| `scripts/backfill-proximo-dia-util.js` | Backfill pontual de datas de vencimento em dia útil |
| `scripts/normalizar-movimentacoes-data-hora.js` | Normalização pontual de timestamps de movimentação |
| `npm run generate-secret` | Gera um valor hex aleatório forte (`JWT_SECRET`/`ADMIN_TOKEN`) |

---

## Frontend Web

O dashboard (`dono`/`gerente`/`vendedor`) é um app estático (HTML/JS puro, sem build) no repositório irmão `SiriusWebFrontend/`, que consome exclusivamente a [API Web Frontend](#api-web-frontend) deste servidor via JWT. Ver o `CLAUDE.md`/README daquele repositório para rodar localmente (`node dev.js`, porta 3000) e para os testes Playwright.

---

## Solução de Problemas

### `FIREBIRD_DATABASE não definido` / `FIREBIRD_PASSWORD não definido`

Complete `src/client/.env` (dev) ou rode o wizard novamente (`.exe`).

### `Your user name and password are not defined` (Firebird)

Credenciais rejeitadas — verifique `FIREBIRD_USER`/`FIREBIRD_PASSWORD`.

### `Table unknown, ULTIMOS_REGISTROS_MATRIZ`

Banco Firebird novo — reinicie o cliente; `setup.js` cria a tabela automaticamente.

### `relação "nome_tabela" não existe` (erro 400 no pull)

A tabela ainda não existe no servidor — o cliente segue em frente; ela é criada no primeiro push da filial.

### `Filial bloqueada (401)`

A filial está em `FILIAIS_BLOQUEADAS`:
```sql
DELETE FROM empresa_kr.filiais_bloqueadas WHERE id_filial_bloqueada = <numero_loja>;
```

### `permissão insuficiente` (403 na API web)

O módulo relevante está `--`/`r-` para o plano ou a role desse usuário — confira a aba Permissões do painel superadmin (a permissão efetiva é sempre o menor dos dois).

### Conflitos acumulando

Acesse `http://localhost:3001` e resolva cada um na página Conflitos.

### Ciclos lentos ou saltados

O cliente descarta um ciclo se o anterior ainda estiver rodando quando `INTERVALO_MS` vencer. Aumente `INTERVALO_MS` no `.env`.

### Recarregar cache sem reiniciar o servidor

```bash
curl -X POST http://localhost:8080/admin/reload-empresas    -H "x-admin-token: SEU_ADMIN_TOKEN"
curl -X POST http://localhost:8080/admin/reload-permissoes  -H "x-admin-token: SEU_ADMIN_TOKEN"
```
