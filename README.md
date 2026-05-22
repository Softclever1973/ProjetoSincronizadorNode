# Sincronizador Node.js — Matriz / Filial

Sistema de sincronização bidirecional de dados entre um servidor central PostgreSQL (matriz) e clientes Firebird (filiais). É uma reescrita em Node.js de um sistema originalmente desenvolvido em Delphi/DataSnap.

---

## Sumário

1. [Visão Geral](#visão-geral)
2. [Pré-requisitos](#pré-requisitos)
3. [Estrutura do Projeto](#estrutura-do-projeto)
4. [Configuração do Servidor (Matriz)](#configuração-do-servidor-matriz)
5. [Configuração do Cliente (Filial)](#configuração-do-cliente-filial)
6. [Referência de Variáveis de Ambiente](#referência-de-variáveis-de-ambiente)
7. [Multi-tenancy: Gerenciando Empresas](#multi-tenancy-gerenciando-empresas)
8. [Autenticação de Usuários (API Web)](#autenticação-de-usuários-api-web)
9. [API Web Frontend](#api-web-frontend)
10. [Interface Web da Filial](#interface-web-da-filial)
11. [Fluxo de Sincronização](#fluxo-de-sincronização)
12. [Resolução de Conflitos](#resolução-de-conflitos)
13. [Adicionando uma Nova Tabela ao Sync](#adicionando-uma-nova-tabela-ao-sync)
14. [Política de Retenção de 2 Anos](#política-de-retenção-de-2-anos)
15. [Scripts Utilitários](#scripts-utilitários)
16. [Solução de Problemas](#solução-de-problemas)

---

## Visão Geral

```
┌─────────────────────────────────────────────────────┐
│                 SERVIDOR (Matriz)                   │
│          Node.js + Express + PostgreSQL             │
│              porta padrão: 8080                     │
└──────────────────────┬──────────────────────────────┘
                       │ HTTP REST
          ┌────────────┴────────────┐
          │                         │
┌─────────▼───────────┐   ┌─────────▼───────────┐
│  CLIENTE (Filial 1) │   │  CLIENTE (Filial 2) │
│  Node.js + Firebird │   │  Node.js + Firebird │
│  WebUI: porta 3001  │   │  WebUI: porta 3001  │
└─────────────────────┘   └─────────────────────┘
```

**O servidor** expõe uma API REST no padrão `/datasnap/rest/{Classe}/{Método}` — compatível com os clientes Delphi originais. Cada empresa (CNPJ) ocupa um schema isolado no PostgreSQL (multi-tenancy schema-per-tenant).

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

```
├── src/
│   ├── server.js              # Ponto de entrada do servidor
│   ├── db.js                  # Pool PostgreSQL + helpers de query
│   ├── db-init.js             # Criação das tabelas de controle no startup
│   ├── config.js              # Lê DATABASE_URL e PORT do .env
│   ├── empresas.js            # Cache em memória: token → schema
│   ├── limpeza.js             # Job de limpeza de registros antigos (PostgreSQL)
│   ├── setup-wizard.js        # Wizard interativo de configuração do servidor
│   ├── middleware/
│   │   ├── auth.js            # Valida ?token= (clientes Delphi/Node)
│   │   ├── authJwt.js         # Valida Bearer JWT (usuários da API web)
│   │   ├── checkRole.js       # Verifica role mínimo (dono/gerente/vendedor)
│   │   └── filialBloqueada.js # Bloqueia filiais cadastradas
│   └── routes/
│       ├── sincronizacao.js   # Pull, push, status, auditoria (DataSnap)
│       ├── produtos.js        # Produtos com preço por loja
│       ├── pedidos.js         # Pedidos
│       ├── movimentacaoCaixas.js
│       ├── distribuicao.js
│       ├── auth.js            # Login JWT + /me
│       ├── userEmpresas.js    # CRUD de empresas por usuário
│       ├── tabelas.js         # CRUD genérico + pedidos + dashboard (/api/)
│       └── usuarios.js        # CRUD de usuários por schema (/api/:schema/usuarios)
│
├── src/client/
│   ├── index.js               # Loop principal de sync
│   ├── sync.js                # Fase pull (servidor → filial)
│   ├── push.js                # Fase push (filial → servidor)
│   ├── setup.js               # Cria infraestrutura no Firebird (idempotente)
│   ├── cursor.js              # Lê/grava ULTIMOS_REGISTROS_MATRIZ
│   ├── tabelas.js             # Lista de tabelas sincronizadas (ordem FK)
│   ├── tabelasConfig.js       # Ativa/desativa tabelas em runtime
│   ├── http.js                # Chamadas HTTP ao servidor
│   ├── db.js                  # Conexão Firebird
│   ├── conflitos.js           # Persistência de conflitos (conflitos.json)
│   ├── erros.js               # Persistência de erros (erros.json)
│   ├── limpeza.js             # Job de limpeza de registros antigos (Firebird)
│   ├── tray.js                # Bandeja do sistema Windows (somente .exe)
│   ├── setup-wizard.js        # Wizard interativo de configuração do cliente
│   ├── webui.js               # Interface web na porta 3001
│   └── views/                 # Templates EJS da WebUI
│
├── scripts/
│   ├── create-empresa.js      # Cria nova empresa/schema
│   └── create-usuario.js      # Cria usuário da API web
│
├── .env.example               # Modelo de configuração do servidor
└── src/client/.env.example    # Modelo de configuração do cliente
```

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

Na primeira inicialização, o servidor cria automaticamente as seguintes tabelas no schema `public`:

| Tabela | Descrição |
|---|---|
| `sync_tenants` | Mapeia token → schema (uma linha por empresa) |
| `usuarios` | Usuários da API web (login JWT) |
| `usuarios_empresas` | Relação N:N usuário ↔ empresa com `role` (`dono`, `gerente`, `vendedor`), `id_loja` e `id_vendedor` |
| `audit_log` | Histórico de operações INSERT/UPDATE/DELETE realizadas via API web; indexado por `schema_name`, `criado_em` e `id_usuario` |

Cada schema de empresa provisionado via `create-empresa.js` recebe também:

| Objeto | Descrição |
|---|---|
| `seq_atualizacao_matriz` | Sequência global do schema — incrementada por trigger em todo INSERT/UPDATE |
| `filiais_bloqueadas` | Filiais impedidas de sincronizar (`id_filial_bloqueada`) |
| `registros_deletados` | Log de deleções para propagação às filiais |
| `sync_filiais` | Filiais conectadas: `id_loja`, `nome`, `ultimo_sync` — atualizado a cada ciclo |
| `sync_config` | Configurações de sync por empresa (ex.: `filtro_filial_clientes`) |
| `fn_seq_atualizacao()` | Função de trigger que incrementa `ID_ULTIMA_ATUALIZACAO_MATRIZ` |
| `fn_registrar_delecao()` | Função de trigger que registra deleções em `registros_deletados` |

### 4. Criar a primeira empresa

Cada empresa (grupo de filiais) precisa de um **schema** próprio no PostgreSQL e um **token** de autenticação para os clientes.

```bash
node scripts/create-empresa.js \
  --schema=empresa_kr \
  --token=TOKEN_SEGURO_AQUI \
  --nome="KR Supermercados"
```

O script:
- Cria o schema `empresa_kr` no PostgreSQL
- Provisiona as tabelas internas de controle do schema
- Registra a empresa em `public.sync_tenants`

**Não é necessário reiniciar o servidor** — o cache de empresas é recarregado automaticamente na próxima requisição.

> Para forçar o reload do cache manualmente:
> ```bash
> curl -X POST http://localhost:8080/admin/reload-empresas \
>      -H "x-admin-token: SEU_ADMIN_TOKEN"
> ```

---

## Configuração do Cliente (Filial)

O cliente roda **na máquina da filial**, conectado ao banco Firebird local.

### 1. Configurar o cliente

Na primeira execução sem `.env`, o cliente inicia automaticamente um **wizard de configuração** interativo. Para configuração manual, crie o arquivo `src/client/.env`:

```env
# Token — deve ser idêntico ao cadastrado no servidor para esta empresa
SYNC_TOKEN=TOKEN_SEGURO_AQUI

# Conexão com o banco Firebird da filial
FIREBIRD_HOST=localhost
FIREBIRD_PORT=3050
FIREBIRD_DATABASE=C:\FDBS\FILIAL.FDB
FIREBIRD_USER=SYSDBA
FIREBIRD_PASSWORD=masterkey

# Intervalo entre ciclos de sync em milissegundos (padrão: 30000 = 30s)
INTERVALO_MS=30000
```

> **`FIREBIRD_DATABASE` e `FIREBIRD_PASSWORD` são obrigatórios.** O processo termina com mensagem clara se estiverem ausentes.

### 2. Parâmetros do banco Firebird

O cliente lê as seguintes configurações da tabela `PARAMETROS` do banco Firebird:

| ID | Exemplo | Descrição |
|---|---|---|
| `60024` | `http://192.168.1.100:8080` | URL base do servidor (sem barra final) — gravada pelo wizard |
| `50003` | `1` | Número da loja (`idLoja`) — **deve ser único por filial dentro da empresa** |
| `50004` | `1` | Número do PDV (`idPDV`) — opcional |
| `50005` | `Loja Centro` | Nome desta filial — identifica a filial na tabela `sync_filiais` do servidor |

> **Atenção:** o parâmetro `50005` é essencial para que o servidor identifique corretamente cada filial na tabela `sync_filiais`. Se duas filiais usarem o mesmo `idLoja` (parâmetro `50003`), os dados se sobrescreverão. Verifique os valores em cada banco Firebird antes de colocar uma nova filial em produção.

### 3. Iniciar o cliente

```bash
# Produção
npm run client

# Desenvolvimento (auto-reload)
npm run client:dev
```

**Na primeira execução**, o `setup.js` cria automaticamente no banco Firebird:

| Objeto criado | Descrição |
|---|---|
| `SYNC_ALTERACOES_PENDENTES` | Fila de alterações locais para enviar ao servidor |
| `SYNC_VERSOES_SERVIDOR` | Última versão recebida do servidor por registro (detecção de conflito) |
| `SYNC_ERROS` | Log de erros de sincronização (máx. 200 registros) |
| Triggers `SYNC_*` | Criados em cada tabela sincronizada para capturar INSERT/UPDATE |

Após o setup, o cliente entra no loop de sincronização e inicia a **interface web** em `http://localhost:3001`.

---

## Referência de Variáveis de Ambiente

### Servidor (`.env` na raiz do projeto)

| Variável | Obrigatório | Padrão | Descrição |
|---|---|---|---|
| `DATABASE_URL` | Sim | — | URL de conexão PostgreSQL |
| `PORT` | Não | `8080` | Porta HTTP do servidor |
| `JWT_SECRET` | Sim | — | Segredo para assinar JWTs |
| `ADMIN_TOKEN` | Não | — | Token para o endpoint `/admin/reload-empresas` |

### Cliente (`src/client/.env`)

| Variável | Obrigatório | Padrão | Descrição |
|---|---|---|---|
| `SYNC_TOKEN` | Sim | — | Token de autenticação com o servidor |
| `FIREBIRD_HOST` | Não | `localhost` | Host do servidor Firebird |
| `FIREBIRD_PORT` | Não | `3050` | Porta TCP do Firebird |
| `FIREBIRD_DATABASE` | Sim | — | Caminho completo do arquivo `.fdb` |
| `FIREBIRD_USER` | Não | `SYSDBA` | Usuário do Firebird |
| `FIREBIRD_PASSWORD` | Sim | — | Senha do usuário Firebird |
| `INTERVALO_MS` | Não | `30000` | Intervalo entre ciclos (ms) |

---

## Multi-tenancy: Gerenciando Empresas

O servidor suporta múltiplas empresas simultaneamente. Cada empresa tem:
- Um **schema PostgreSQL** isolado (ex: `empresa_kr`, `empresa_jb`)
- Um **token único** usado pelos clientes das filiais

### Criar uma nova empresa

```bash
node scripts/create-empresa.js \
  --schema=empresa_jb \
  --token=NOVO_TOKEN_AQUI \
  --nome="JB Atacado"
```

**Regras para `--schema`:** apenas letras minúsculas, números e `_`; deve começar com letra ou `_`.

---

## Autenticação de Usuários (API Web)

Existe uma camada de autenticação JWT separada do token de sync, usada para acessar a API via browser ou ferramentas REST. São três roles: `dono`, `gerente` e `vendedor`.

### Criar um usuário (bootstrap)

Não há endpoint público de registro. Use o script CLI:

```bash
# Cria usuário dono vinculado a um schema
node scripts/create-usuario.js \
  --email=admin@empresa.com \
  --senha=senha123 \
  --schema=empresa_kr \
  --role=dono

# Cria gerente vinculado a uma loja específica
node scripts/create-usuario.js \
  --email=gerente@loja.com \
  --senha=senha123 \
  --schema=empresa_kr \
  --role=gerente \
  --loja=2
```

Após o primeiro usuário criado, os demais podem ser criados via API (`POST /api/:schema/usuarios`) por um `dono` ou `gerente`.

### Fazer login

```http
POST /auth/login
Content-Type: application/json

{
  "email": "admin@empresa.com",
  "senha": "senha123"
}
```

Resposta:
```json
{
  "token": "eyJhbGci...",
  "schemas": ["empresa_kr"]
}
```

### Verificar token

```http
GET /auth/me
Authorization: Bearer eyJhbGci...
```

### Gerenciar empresas do usuário

```http
GET /user/empresas
Authorization: Bearer eyJhbGci...
```

---

## API Web Frontend

Rotas usadas pela interface **SiriusWebFrontend** para CRUD genérico, pedidos e dashboards. Requerem `Authorization: Bearer <jwt>`. O schema da empresa é parte do path — o usuário só acessa schemas vinculados à sua conta.

### Sistema de roles

| Role | Permissões |
|---|---|
| `dono` | Acesso completo a todos os dados do schema |
| `gerente` | Acesso restrito à sua loja (`id_loja` no JWT) em tabelas transacionais; pode criar/gerenciar vendedores |
| `vendedor` | Leitura; vê apenas registros ativos de sua loja |

### CRUD genérico de tabelas

| Método | Rota | Role mínimo | Descrição |
|---|---|---|---|
| GET | `/api/:schema/tabelas/:tabela/colunas` | vendedor | Introspecção de colunas (nome, tipo, is_generated) |
| GET | `/api/:schema/tabelas/:tabela/next-pk` | vendedor | Próximo valor de PK disponível (`?pk=COLUNA`) |
| GET | `/api/:schema/tabelas/:tabela/by-pk` | vendedor | Registro único por PK (`?pk=COL&value=VAL`) |
| GET | `/api/:schema/tabelas/:tabela/distinct/:col` | vendedor | Valores distintos de uma coluna (máx. 200) |
| GET | `/api/:schema/tabelas/:tabela` | vendedor | Listagem paginada com busca e filtros |
| POST | `/api/:schema/tabelas/:tabela` | gerente | Upsert — body: `{ pk, registro }` (pk pode ser array) |
| DELETE | `/api/:schema/tabelas/:tabela` | gerente | Deleção por PK — body: `{ pk, pkValores }` |

Parâmetros de listagem (`GET`):

| Parâmetro | Descrição |
|---|---|
| `page`, `pageSize` | Paginação (pageSize máx. 500; `all=true` retorna até 10.000) |
| `q` | Busca textual |
| `cols` | Colunas onde buscar, separadas por vírgula |
| `statusCol`, `statusVal` | Filtro de status (`A` ou `I`; vendedor sempre vê só `A`) |
| `sortCol`, `sortDir` | Ordenação (ASC ou DESC) |
| `filtroLoja` | Filtro opcional por `ID_LOJA` (qualquer tabela que tenha a coluna) |
| `filtros` | Filtros extras por coluna — JSON serializado: `{"GRUPO":"BEBIDAS"}` ou range `{"DATA":{"gte":"2024-01-01"}}` |

O upsert incrementa automaticamente `ID_ULTIMA_ATUALIZACAO_MATRIZ` via `seq_atualizacao_matriz` quando a coluna existe, garantindo que a alteração seja propagada para as filiais no próximo pull.

### Audit log

| Método | Rota | Role mínimo | Descrição |
|---|---|---|---|
| GET | `/api/:schema/audit-log` | gerente | Log de auditoria paginado |

Parâmetros de filtro: `tabela`, `operacao` (INSERT/UPDATE/DELETE), `dataInicio`, `dataFim`, `page`, `pageSize` (máx. 100).

Retorna `{ registros, total }`. Cada registro inclui:
- `dados` — campos do formulário (`null` em DELETE)
- `dados_antes` — snapshot completo antes da operação (`null` em INSERT)
- `email`, `tabela`, `operacao`, `pk_valor`, `ip_cliente`, `criado_em`

Gerentes veem apenas registros cuja `ID_LOJA` corresponde à sua loja.

### Gestão de usuários

| Método | Rota | Role mínimo | Descrição |
|---|---|---|---|
| GET | `/api/:schema/usuarios` | gerente | Lista usuários do schema |
| POST | `/api/:schema/usuarios` | gerente | Cria usuário e vincula ao schema |
| PATCH | `/api/:schema/usuarios/:id/ativo` | gerente | Ativa/desativa usuário |
| PATCH | `/api/:schema/usuarios/:id/perfil` | gerente | Edita nome, email ou senha |
| PATCH | `/api/:schema/usuarios/:id/role` | dono | Altera role e loja do usuário |
| GET | `/api/:schema/vendedores-disponiveis` | gerente | Lista vendedores da tabela VENDEDORES do tenant |

### Endpoints de pedidos

| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/:schema/pedidos-lista` | Lista simplificada com `VALOR_TOTAL` calculado; suporta `?q=`, `?status=`, `?dataInicio=`, `?dataFim=`, filtro por vendedor e faixa de valor |
| GET | `/api/:schema/pedidos-completo` | JOIN flat PEDIDOS + PEDIDOS_ITENS + PEDIDOS_PARCELAS_PAGAMENTOS + PRODUTOS; colunas ausentes ignoradas |
| GET | `/api/:schema/pedidos/:id/itens` | Itens com JOIN em PRODUTOS (resolve descrição, unidade, valor total do item) |
| GET | `/api/:schema/pedidos/:id/pagamentos` | Parcelas de pagamento (`PEDIDOS_PARCELAS_PAGAMENTOS`) |

### Endpoints de dashboard

| Método | Rota | Role mínimo | Descrição |
|---|---|---|---|
| GET | `/api/:schema/dashboard` | vendedor | Totais do dia: clientes ativos, pedidos hoje, faturamento hoje, produtos ativos |
| GET | `/api/:schema/dashboard/faturamento-por-loja` | gerente | Faturamento e contagem de pedidos por loja; filtros de data e período |
| GET | `/api/:schema/dashboard/evolucao-mensal` | gerente | Faturamento e contagem mensal; suporta filtro por mês exato ou intervalo |
| GET | `/api/:schema/dashboard/evolucao-mensal-por-loja` | dono | Evolução mensal por loja (série histórica multi-loja) |
| GET | `/api/:schema/dashboard/top-produtos` | gerente | Top 10 produtos por faturamento e quantidade |
| GET | `/api/:schema/dashboard/pedidos-por-status` | gerente | Contagem de pedidos por status |
| GET | `/api/:schema/dashboard/faturamento-por-vendedor` | gerente | Top 10 vendedores por faturamento |

### Outros endpoints

| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/:schema/filiais` | Lista filiais registradas em `sync_filiais` |
| GET | `/api/:schema/admin/sync-config` | Lê configurações de sync do schema (role: dono) |
| PUT | `/api/:schema/admin/sync-config` | Atualiza configuração de sync (role: dono) |

---

## Interface Web da Filial

Após iniciar o cliente, acesse `http://localhost:3001` no navegador da filial.

### `/` — Conflitos

Lista registros em conflito entre a filial e o servidor (alterados nos dois lados desde a última sync). Para cada conflito são exibidos os campos divergentes com opções:

| Ação | O que faz |
|---|---|
| **Manter local** | Envia a versão da filial ao servidor (força sobrescrita) |
| **Manter servidor** | Aplica a versão do servidor no banco Firebird local |
| **Mesclar campos** | Resolução campo-a-campo — o usuário escolhe cada valor individualmente |

### `/status` — Status de Sincronização

Exibe por tabela: total no servidor vs. total local, último cursor sincronizado, pendentes de envio.

### `/auditoria` — Auditoria de Dados

Comparação registro a registro entre servidor e filial para qualquer tabela. Linhas divergentes ficam em destaque. Use **Aplicar Matriz em Tudo** para sincronizar em lote ou **Resolver um por um** para encaminhar cada divergência à fila de conflitos.

### `/configuracoes` — Habilitar/Desabilitar Tabelas

Ativa ou desativa tabelas do sync sem reiniciar o processo. Estado persiste em `tabelas-config.json`.

### `/erros` — Log de Erros

Exibe os últimos 200 erros de sincronização com tabela, operação e mensagem.

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

A cada ciclo, para cada tabela ativa:

1. Lê todos os registros de `SYNC_ALTERACOES_PENDENTES` para a tabela
2. Para cada pendente:
   - Se o registro **não existe mais localmente** (deletado): envia `{ deletar: true }`. O servidor deleta o registro e insere em `REGISTROS_DELETADOS`, propagando a deleção para as demais filiais no próximo pull
   - Se existe: envia para `POST /datasnap/rest/TSMSincronizacao/ReceberRegistro` com a última versão conhecida do servidor
3. O servidor verifica conflito comparando versões:
   - **Sem conflito** → aplica o upsert e retorna `{ ok: true, idAtualizacaoMatriz: N }`
   - **Com conflito** → retorna `{ conflito: true, versaoServidor: {...} }`; cliente salva em `conflitos.json`
4. Registros enviados com sucesso são removidos de `SYNC_ALTERACOES_PENDENTES`

---

## Resolução de Conflitos

Um conflito ocorre quando um registro foi alterado **tanto na filial quanto no servidor** desde a última sincronização.

Acesse `http://localhost:3001` na filial e use a página **Conflitos** para resolver cada um. Opções disponíveis:

- **Manter local** — versão da filial sobrescreve o servidor
- **Manter servidor** — versão do servidor sobrescreve o Firebird local
- **Mesclar campos** — resolução campo-a-campo granular

**Prevenção:** o sistema usa `SYNC_VERSOES_SERVIDOR` para rastrear a última versão recebida por registro. No push, essa versão é enviada ao servidor para detecção de divergência.

---

## Adicionando uma Nova Tabela ao Sync

### Passo 1 — `src/client/tabelas.js`

Adicione a entrada respeitando a **ordem de FK** (tabelas pai antes das filhas):

```js
{
  nome: 'NOME_DA_TABELA',
  pk: 'ID_NOME_DA_TABELA',     // string simples ou array para PK composta: ['COL1', 'COL2']
  temDelete: true,              // true se a tabela tem rastreamento de deleção no servidor
  filtroFilial: null,          // nome da coluna para filtrar por loja, ou null para tabelas globais
  grupo: 'Cadastros',          // grupo exibido na WebUI (/configuracoes)
  generator: null,             // nome do generator Firebird; null se a filial não cria registros
  colunaData: null,            // coluna de data de negócio para retenção de 2 anos; null = sem expiração
  defaultAtivo: true,          // estado inicial na primeira carga
}
```

**Grupos existentes:** `Auxiliares`, `Cadastros`, `Produtos`, `Clientes`, `Fornecedores`, `Transportadores`, `Vendedores`, `Pedidos`, `Kits`.

### Passo 2 — `src/routes/sincronizacao.js`

Adicione o nome à lista de tabelas permitidas:

```js
const TABELAS_PERMITIDAS = new Set([
  // ... tabelas existentes ...
  'NOME_DA_TABELA',
]);
```

### Passo 3 — Garantir a coluna no PostgreSQL

A tabela no servidor precisa ter a coluna `ID_ULTIMA_ATUALIZACAO_MATRIZ INTEGER` e um trigger que a incrementa a cada INSERT/UPDATE usando `nextval('schema.seq_atualizacao_matriz')`.

> Se a tabela **não existe** no PostgreSQL, ela será criada automaticamente no primeiro push da filial, com tipos de coluna inferidos dos valores do primeiro registro recebido.

### Passo 4 — Reiniciar servidor e cliente

O `setup.js` cria o trigger `SYNC_NOME_DA_TABELA` no Firebird automaticamente na próxima inicialização do cliente.

---

## Política de Retenção de 2 Anos

O sistema limita automaticamente o histórico sincronizado a **2 anos** em tabelas transacionais. Tabelas de cadastro (`PRODUTOS`, `CLIENTES`, etc.) não são afetadas — `colunaData: null`.

| Momento | O que acontece |
|---|---|
| **Durante o pull** | O servidor não envia registros cuja `colunaData` seja anterior a 2 anos |
| **Limpeza diária** | 24h após a inicialização, e a cada 24h, registros antigos são removidos do servidor e da filial |

Por padrão, somente `PEDIDOS` tem `colunaData: 'DATA_HORA'`. As filhas `PEDIDOS_ITENS` e `PEDIDOS_PARCELAS_PAGAMENTOS` são limpas em cascata (filhas antes do pai).

Para aplicar a política a outra tabela transacional, defina `colunaData` em `tabelas.js` e adicione o grupo em **ambos** `src/limpeza.js` (PostgreSQL) e `src/client/limpeza.js` (Firebird), com filhas listadas antes do pai.

---

## Scripts Utilitários

### `scripts/create-empresa.js`

Cria um novo schema de empresa no PostgreSQL com todas as tabelas de controle necessárias.

```bash
node scripts/create-empresa.js \
  --schema=empresa_jb \
  --token=MEU_TOKEN \
  --nome="JB Atacado"
```

Pré-requisito: o servidor deve ter sido inicializado ao menos uma vez (para que `public.sync_tenants` exista).

### `scripts/create-usuario.js`

Cria um usuário para a API web (autenticação JWT). Use para o primeiro usuário (bootstrap) — não há endpoint público de registro.

```bash
# Usuário dono
node scripts/create-usuario.js \
  --email=admin@empresa.com \
  --senha=senha123 \
  --schema=empresa_kr \
  --role=dono

# Gerente vinculado a uma loja
node scripts/create-usuario.js \
  --email=ger@empresa.com \
  --senha=senha123 \
  --schema=empresa_kr \
  --role=gerente \
  --loja=2
```

Roles disponíveis: `dono`, `gerente`, `vendedor`. `--loja` é obrigatório para gerente e vendedor.

---

## Solução de Problemas

### `FIREBIRD_DATABASE não definido`

Crie ou complete o arquivo `src/client/.env` adicionando:
```
FIREBIRD_DATABASE=C:\FDBS\FILIAL.FDB
```

### `FIREBIRD_PASSWORD não definido`

Adicione ao `src/client/.env`:
```
FIREBIRD_PASSWORD=suasenha
```

### `Your user name and password are not defined` (Firebird)

O Firebird rejeitou as credenciais. Verifique `FIREBIRD_USER` e `FIREBIRD_PASSWORD` em `src/client/.env`.

### `Table unknown, ULTIMOS_REGISTROS_MATRIZ`

O banco Firebird é de uma instalação nova. Reinicie o cliente — o `setup.js` cria a tabela automaticamente na inicialização.

### `relação "nome_tabela" não existe` (erro 400 no pull)

A tabela ainda não existe no servidor PostgreSQL. O cliente retorna array vazio e continua. A tabela será criada automaticamente no primeiro push da filial.

### `Filial bloqueada (401)`

A filial está na tabela `FILIAIS_BLOQUEADAS` do schema da empresa. Para desbloquear:

```sql
DELETE FROM empresa_kr.filiais_bloqueadas WHERE id_filial_bloqueada = <numero_loja>;
```

### Conflitos acumulando

Acesse `http://localhost:3001` na filial e resolva cada conflito.

### Ciclos lentos ou saltados

O sistema protege contra ciclos sobrepostos com a flag `rodando` — se um ciclo levar mais que `INTERVALO_MS`, o próximo é descartado. Aumente `INTERVALO_MS` no `.env` do cliente:

```
INTERVALO_MS=60000   # 60 segundos
```

### Recarregar lista de empresas sem reiniciar o servidor

```bash
curl -X POST http://localhost:8080/admin/reload-empresas \
     -H "x-admin-token: SEU_ADMIN_TOKEN"
```
