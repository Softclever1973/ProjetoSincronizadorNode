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
9. [Interface Web da Filial](#interface-web-da-filial)
10. [Fluxo de Sincronização](#fluxo-de-sincronização)
11. [Resolução de Conflitos](#resolução-de-conflitos)
12. [Adicionando uma Nova Tabela ao Sync](#adicionando-uma-nova-tabela-ao-sync)
13. [Política de Retenção de 2 Anos](#política-de-retenção-de-2-anos)
14. [Scripts Utilitários](#scripts-utilitários)
15. [Solução de Problemas](#solução-de-problemas)

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
│   ├── middleware/
│   │   ├── auth.js            # Valida ?token= (clientes Delphi/Node)
│   │   ├── authJwt.js         # Valida Bearer JWT (usuários da API web)
│   │   └── filialBloqueada.js # Bloqueia filiais cadastradas
│   └── routes/
│       ├── sincronizacao.js   # Pull, push, status, auditoria
│       ├── produtos.js        # Produtos com preço por loja
│       ├── pedidos.js         # Pedidos
│       ├── movimentacaoCaixas.js
│       ├── distribuicao.js
│       ├── auth.js            # Login JWT + /me
│       ├── userEmpresas.js    # CRUD de empresas por usuário
│       └── tabelas.js         # CRUD genérico + endpoints de pedidos para web frontend (/api/)
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
│   ├── webui.js               # Interface web na porta 3001
│   └── views/                 # Templates EJS da WebUI
│
├── scripts/
│   ├── create-empresa.js           # Cria nova empresa/schema
│   ├── create-usuario.js           # Cria usuário da API web
│   ├── migrate-public-to-schema.js # Migra dados do schema public
│   ├── migrate-data.js             # Migra dados do Firebird → PostgreSQL
│   └── export-schema.js            # Exporta DDL do Firebird → SQL PostgreSQL
│
├── .env.example               # Modelo de configuração do servidor
└── src/client/.env.example    # Modelo de configuração do cliente
```

---

## Configuração do Servidor (Matriz)

### 1. Criar o arquivo `.env` na raiz do projeto

Copie o modelo e preencha com seus dados:

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
| `usuarios_empresas` | Relação N:N usuário ↔ empresa |

Cada schema de empresa provisionado via `create-empresa.js` recebe também:

| Tabela | Descrição |
|---|---|
| `sync_filiais` | Rastreamento das filiais conectadas: `id_loja`, `nome`, `ultimo_sync` — atualizado a cada ciclo de pull/push |

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
- Provisiona as tabelas internas de controle do schema (sequências, registros deletados, filiais bloqueadas)
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

### 1. Criar o arquivo `src/client/.env`

```bash
cp src/client/.env.example src/client/.env
```

Preencha com os dados da filial:

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

> **`FIREBIRD_USER` e `FIREBIRD_PASSWORD` são obrigatórios.** O processo termina com mensagem clara se estiverem ausentes.

### 2. Configurar os parâmetros no banco Firebird

O cliente lê as seguintes configurações da tabela `PARAMETROS` do banco Firebird:

| ID | Exemplo de valor | Descrição |
|---|---|---|
| `60024` | `http://192.168.1.100:8080` | URL base do servidor (sem barra no final) |
| `50003` | `1` | Número da loja (`idLoja`) — **deve ser único por filial dentro da empresa** |
| `50004` | `1` | Número do PDV (`idPDV`) — opcional |
| `50005` | `Loja Centro` | Nome desta filial — gravado pelo wizard ou manualmente; identifica a filial em `sync_filiais` no servidor |

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
| `ULTIMOS_REGISTROS_MATRIZ` | Tabela de cursor de sync por tabela |
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

### Migrar dados do schema `public` (instalações legadas)

Se você tinha dados no schema `public` de uma instalação anterior ao multi-tenancy:

```bash
node scripts/migrate-public-to-schema.js \
  --schema=empresa_kr \
  --token=TOKEN \
  --nome="KR Supermercados"
```

Reinicie o servidor após a migração.

---

## Autenticação de Usuários (API Web)

Existe uma camada de autenticação JWT separada do token de sync, usada por donos de empresas para acessar a API via browser ou ferramentas REST.

### Criar um usuário

```bash
node scripts/create-usuario.js \
  --email=admin@empresa.com \
  --senha=senha123 \
  --schema=empresa_kr
```

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

Resposta:
```json
{
  "id": 1,
  "schemas": ["empresa_kr"]
}
```

### Listar empresas do usuário

```http
GET /user/empresas
Authorization: Bearer eyJhbGci...
```

### Criar empresa via API

```http
POST /user/empresas
Authorization: Bearer eyJhbGci...
Content-Type: application/json

{
  "schema": "empresa_nova",
  "token": "TOKEN_SYNC_NOVO",
  "nome": "Nova Empresa Ltda"
}
```

O schema deve ter apenas letras minúsculas, números e underscore, e começar com letra ou underscore (ex: `empresa_abc`).

---

## API Web Frontend (`/api/`)

Rotas usadas pela interface **SiriusWebFrontend** para CRUD genérico e consulta de pedidos. Requerem `Authorization: Bearer <jwt>` (mesmo JWT do `/auth/login`). O schema da empresa é parte do path — o usuário só acessa schemas vinculados à sua conta.

### CRUD genérico de tabelas

| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/:schema/tabelas/:tabela/colunas` | Introspecção de colunas (nome, tipo, is_generated) |
| GET | `/api/:schema/tabelas/:tabela/next-pk` | Próximo valor de PK disponível (`?pk=COLUNA`) |
| GET | `/api/:schema/tabelas/:tabela/by-pk` | Registro único por PK (`?pk=COL&value=VAL`) |
| GET | `/api/:schema/tabelas/:tabela` | Listagem paginada com busca e filtro de status |
| POST | `/api/:schema/tabelas/:tabela` | Upsert — body: `{ pk, registro }` (pk pode ser array para PK composta) |
| DELETE | `/api/:schema/tabelas/:tabela` | Deleção por PK — body: `{ pk, pkValores }` |

Parâmetros de listagem (`GET`):

| Parâmetro | Descrição |
|---|---|
| `page`, `pageSize` | Paginação (pageSize máx. 500) |
| `q` | Busca textual |
| `cols` | Colunas onde buscar, separadas por vírgula (padrão: primeiras 8 colunas texto) |
| `statusCol`, `statusVal` | Filtro de status (`statusVal` aceita apenas `A` ou `I`) |

O upsert incrementa automaticamente `ID_ULTIMA_ATUALIZACAO_MATRIZ` via `seq_atualizacao_matriz` quando a coluna existe na tabela, garantindo que a alteração seja propagada para as filiais no próximo pull.

### Endpoints de pedidos

| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/:schema/pedidos-lista` | Lista simplificada com `VALOR_TOTAL` calculado (soma `VALOR_UNITARIO × QUANTIDADE`); suporta `?q=` e `?status=` |
| GET | `/api/:schema/pedidos-completo` | JOIN flat das 3 tabelas de pedido (PEDIDOS + PEDIDOS_ITENS + PEDIDOS_PARCELAS_PAGAMENTOS + PRODUTOS); colunas ausentes no banco são ignoradas silenciosamente |
| GET | `/api/:schema/pedidos/:id/itens` | Itens de um pedido com JOIN em PRODUTOS (resolve `DESCRICAO`, `UNIDADE`, `VALOR_TOTAL_ITEM`) |
| GET | `/api/:schema/pedidos/:id/pagamentos` | Parcelas de pagamento de um pedido (`PEDIDOS_PARCELAS_PAGAMENTOS`) |

---

## Interface Web da Filial

Após iniciar o cliente, acesse `http://localhost:3001` no navegador da filial.

### `/` — Conflitos

Lista registros em conflito entre a filial e o servidor (alterados nos dois lados desde a última sync).

Para cada conflito são exibidos os campos divergentes. Ações disponíveis:

| Botão | O que faz |
|---|---|
| **Manter local** | Envia a versão da filial ao servidor (força sobrescrita) |
| **Manter servidor** | Aplica a versão do servidor no banco Firebird local |

### `/status` — Status de Sincronização

Exibe por tabela:
- Total de registros no servidor vs total local
- Último ID de cursor sincronizado
- Quantidade de registros pendentes de envio ao servidor
- Status geral: `OK`, `Pendente` ou `N/D` (tabela inacessível)

### `/auditoria` — Auditoria de Dados

Comparação registro a registro entre servidor e filial para qualquer tabela.

1. Selecione a tabela no seletor
2. Clique em **Comparar**
3. Linhas em vermelho indicam divergência — passe o mouse para ver o valor do servidor
4. Use **Aplicar Matriz em Tudo** para sobrescrever todos os registros divergentes da página
5. Use **Resolver um por um** para enviar cada divergência para a fila de conflitos

> A auditoria pagina de 200 em 200 registros. Use os botões de navegação no rodapé.

### `/configuracoes` — Habilitar/Desabilitar Tabelas

Ativa ou desativa tabelas do sync sem reiniciar o processo.

- Use os toggles individuais ou **Ativar Todas / Desativar Todas** por grupo
- Tabelas desativadas são ignoradas no próximo ciclo
- Estado persiste em `tabelas-config.json` no diretório de trabalho

### `/erros` — Log de Erros

Exibe os últimos 200 erros de sincronização com tabela, operação e mensagem de erro.

### `/eventos` — SSE

Endpoint de eventos em tempo real (`text/event-stream`). Browsers conectados recebem notificações instantâneas de novos conflitos e erros — usado internamente pela WebUI para atualizar contadores.

---

## Fluxo de Sincronização

### Pull (Servidor → Filial)

A cada ciclo, para cada tabela ativa:

1. Busca até **50 registros** do servidor onde `ID_ULTIMA_ATUALIZACAO_MATRIZ > cursor_local`
2. Para cada registro recebido, verifica se há alteração local pendente (`SYNC_ALTERACOES_PENDENTES`):

   | Situação | Ação |
   |---|---|
   | Sem alteração local pendente | Upsert normal no Firebird, atualiza cursor |
   | Pendente + registro **nunca recebido do servidor** | **Colisão de PK** → renomeia PK local (MAX+1 para numérico, `val_1` para texto), aplica registro do servidor |
   | Pendente + registro **já recebido anteriormente** | **Conflito de conteúdo** → salva em `conflitos.json`, avança cursor sem upsert |
   | **Echo de push** (registro enviado por esta filial neste ciclo) | Avança cursor sem re-aplicar upsert — o dado já está correto localmente |

3. Busca registros deletados (`REGISTROS_DELETADOS`) e remove do Firebird local

> Os triggers do Firebird são desabilitados durante o pull via `RDB$SET_CONTEXT('USER_SESSION', 'SYNC_SKIP', '1')` para evitar que registros vindos do servidor gerem novas entradas em `SYNC_ALTERACOES_PENDENTES`.

> **Echo registry:** quando o servidor retorna um registro cujo `ID_ULTIMA_ATUALIZACAO_MATRIZ` foi registrado como echo no push anterior (mesma filial, mesmo ciclo), o pull avança o cursor sem re-escrever o dado no Firebird. Isso evita uma escrita desnecessária por registro por ciclo.

### Push (Filial → Servidor)

A cada ciclo, para cada tabela ativa:

1. Lê todos os registros de `SYNC_ALTERACOES_PENDENTES` para a tabela
2. Para cada pendente:
   - Busca o dado completo no Firebird
   - Se o registro **não existe mais localmente** (foi deletado): envia `{ deletar: true }` ao servidor. O servidor deleta o registro e insere em `REGISTROS_DELETADOS`, propagando a deleção para as demais filiais no próximo pull
   - Se existe: envia para `POST /datasnap/rest/TSMSincronizacao/ReceberRegistro` com a última versão conhecida do servidor
3. O servidor verifica se houve alteração no servidor desde `ultimaVersaoConhecida`:
   - **Sem conflito** → aplica o upsert e retorna `{ ok: true, idAtualizacaoMatriz: N }`; o cliente registra `N` como echo
   - **Com conflito** → retorna `{ conflito: true, versaoServidor: {...} }` e o cliente salva em `conflitos.json`
4. Registros enviados com sucesso são removidos de `SYNC_ALTERACOES_PENDENTES`

---

## Resolução de Conflitos

Um conflito ocorre quando um registro foi alterado **tanto na filial quanto no servidor** desde a última sincronização.

### Via interface web

1. Acesse `http://localhost:3001` na filial
2. Na página **Conflitos**, os campos divergentes são exibidos lado a lado
3. Escolha:
   - **Manter local** — versão da filial sobrescreve o servidor
   - **Manter servidor** — versão do servidor sobrescreve o Firebird local

### Prevenção

O sistema evita conflitos usando `SYNC_VERSOES_SERVIDOR`: para cada registro recebido do servidor, armazena o `ID_ULTIMA_ATUALIZACAO_MATRIZ` como versão de referência. No push, essa versão é enviada ao servidor para que ele compare com a versão atual e detecte se houve alteração no servidor entre os dois eventos.

---

## Adicionando uma Nova Tabela ao Sync

### Passo 1 — `src/client/tabelas.js`

Adicione a entrada respeitando a **ordem de FK** (tabelas pai antes das filhas):

```js
{
  nome: 'NOME_DA_TABELA',
  pk: 'ID_NOME_DA_TABELA',     // string simples ou array para PK composta: ['COL1', 'COL2']
  temDelete: true,              // true se a tabela tem rastreamento de deleção no servidor
  filtroFilial: 'ID_LOJA',     // nome da coluna de filtro por loja, ou null para tabelas globais
  grupo: 'Cadastros',          // grupo exibido na WebUI (/configuracoes)
  generator: 'GEN_TABELA',     // nome do generator Firebird, ou null se a filial não cria registros
}
```

**Grupos existentes:** `Auxiliares`, `Cadastros`, `Produtos`, `Clientes`, `Fornecedores`, `Transportadores`, `Vendedores`, `Kits`.

> Use `filtroFilial: 'ID_LOJA'` se a tabela tem uma coluna por loja e você quer que cada filial receba apenas seus próprios registros. Para tabelas de referência globais (ex: `UNIDADES`), use `filtroFilial: null`.

### Passo 2 — `src/routes/sincronizacao.js`

Adicione o nome à lista de tabelas permitidas:

```js
const TABELAS_PERMITIDAS = new Set([
  // ... tabelas existentes ...
  'NOME_DA_TABELA',
]);
```

### Passo 3 — Garantir a coluna no PostgreSQL

A tabela no servidor precisa ter a coluna `ID_ULTIMA_ATUALIZACAO_MATRIZ INTEGER` e um trigger que a incrementa a cada INSERT/UPDATE usando a sequência compartilhada do schema.

> Se a tabela **não existe** no PostgreSQL, ela será criada automaticamente no primeiro push da filial, com tipos de coluna inferidos dos valores do primeiro registro recebido.

### Passo 4 — Reiniciar servidor e cliente

O `setup.js` cria o trigger `SYNC_NOME_DA_TABELA` no Firebird automaticamente na próxima inicialização do cliente.

---

## Política de Retenção de 2 Anos

O sistema limita automaticamente o histórico sincronizado a **2 anos**, tanto no servidor quanto nas filiais. O objetivo é manter o banco de dados operacional em tamanho gerenciável sem acumular dados históricos de pedidos indefinidamente.

### Como funciona

A política age em dois momentos distintos:

| Momento | O que acontece |
|---|---|
| **Durante o pull** | O servidor não envia registros cuja `colunaData` seja anterior a 2 anos. Tabelas de cadastro (sem `colunaData`) não são afetadas — PRODUTOS, CLIENTES, etc. sempre são sincronizados integralmente. |
| **Limpeza diária** | 24h após a inicialização, e a cada 24h, um job remove do servidor e da filial todos os registros transacionais mais antigos que 2 anos. |

### Tabelas afetadas

Apenas tabelas configuradas com o campo `colunaData` em `src/client/tabelas.js` estão sujeitas à política. Por padrão, somente `PEDIDOS` tem essa configuração:

```js
// src/client/tabelas.js
{ nome: 'PEDIDOS', ..., colunaData: 'DATA_HORA' }
```

As tabelas filhas `PEDIDOS_ITENS` e `PEDIDOS_PARCELAS_PAGAMENTOS` são deletadas em cascata (pela aplicação, antes do pai) durante a limpeza diária.

Tabelas de cadastro (`PRODUTOS`, `CLIENTES`, `FORNECEDORES`, etc.) têm `colunaData: null` e **nunca** são afetadas pela política de retenção.

### Ajustando o nome da coluna de data

Se a coluna de data do seu `PEDIDOS` não se chama `DATA_HORA`, edite o campo `colunaData` no `tabelas.js`:

```js
{ nome: 'PEDIDOS', ..., colunaData: 'DATA_EMISSAO' }
```

### Adicionando retenção a outras tabelas

Para aplicar a política a outra tabela transacional (ex: `MOVIMENTACOES`):

1. Defina `colunaData` na entrada de `tabelas.js`:
   ```js
   { nome: 'MOVIMENTACOES', ..., colunaData: 'DATA_MOVIMENTO' }
   ```

2. Se a tabela tiver filhas com FK, adicione o grupo em **ambos** os arquivos de limpeza:

   **`src/limpeza.js`** (servidor PostgreSQL):
   ```js
   const GRUPOS_LIMPEZA = [
     { pai: 'PEDIDOS', colunaData: 'DATA_HORA', filhas: [...] },
     { pai: 'MOVIMENTACOES', colunaData: 'DATA_MOVIMENTO', filhas: [] },
   ];
   ```

   **`src/client/limpeza.js`** (cliente Firebird):
   ```js
   const GRUPOS_LIMPEZA = [
     { pai: 'PEDIDOS', colunaData: 'DATA_HORA', filhas: [...] },
     { pai: 'MOVIMENTACOES', colunaData: 'DATA_MOVIMENTO', filhas: [] },
   ];
   ```

### Logs esperados

```
[LIMPEZA] Iniciando limpeza de registros com mais de 2 anos...
[LIMPEZA][empresa_kr] PEDIDOS_PARCELAS_PAGAMENTOS: 120 registro(s) antigo(s) removido(s)
[LIMPEZA][empresa_kr] PEDIDOS_ITENS: 430 registro(s) antigo(s) removido(s)
[LIMPEZA][empresa_kr] PEDIDOS: 85 registro(s) antigo(s) removido(s)
[LIMPEZA][empresa_kr] REGISTROS_DELETADOS: 12 entrada(s) antiga(s) removida(s)
[LIMPEZA] Limpeza concluída.
```

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

### `scripts/create-usuario.js`

Cria um usuário para a API web (autenticação JWT).

```bash
node scripts/create-usuario.js \
  --email=admin@empresa.com \
  --senha=senha123 \
  --schema=empresa_kr    # opcional: vincula o usuário a um schema
```

### `scripts/migrate-public-to-schema.js`

Migra dados do schema `public` (instalação legada) para um schema dedicado. Execute uma única vez na migração para multi-tenancy.

```bash
node scripts/migrate-public-to-schema.js \
  --schema=empresa_kr \
  --token=MEU_TOKEN \
  --nome="KR Supermercados"
```

### `scripts/export-schema.js`

Exporta o DDL do banco Firebird (estrutura de tabelas) para um arquivo SQL compatível com PostgreSQL. Útil para a configuração inicial do servidor.

```bash
node scripts/export-schema.js
# Gera: schema-matriz.sql

psql -U postgres -d matriz -f schema-matriz.sql
```

### `scripts/migrate-data.js`

Migra os dados do banco Firebird para o PostgreSQL. Operação única de setup inicial.

```bash
# Migrar todas as tabelas
node scripts/migrate-data.js

# Migrar apenas tabelas específicas
node scripts/migrate-data.js --tables=PRODUTOS,CLIENTES

# Excluir tabelas específicas
node scripts/migrate-data.js --skip=SYNC_ERROS,PARAMETROS
```

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

O Firebird rejeitou as credenciais. Verifique:
- `FIREBIRD_USER` — deve ser um usuário existente no Firebird (padrão: `SYSDBA`)
- `FIREBIRD_PASSWORD` — senha correspondente ao usuário

Ambos devem estar em `src/client/.env`.

### `Table unknown, ULTIMOS_REGISTROS_MATRIZ`

O banco Firebird é de uma instalação nova (sem histórico Delphi). Reinicie o cliente — o `setup.js` cria a tabela automaticamente na inicialização.

### `relação "nome_tabela" não existe` (erro 400 no pull)

A tabela ainda não existe no servidor PostgreSQL. O cliente retorna array vazio e continua normalmente. A tabela será criada automaticamente no **primeiro push** que a filial realizar para ela.

### `Filial bloqueada (401)`

A filial está na tabela `FILIAIS_BLOQUEADAS` do schema da empresa no PostgreSQL. Para desbloquear, remova o registro com o `ID_FILIAL_BLOQUEADA` correspondente ao número da loja.

### Conflitos acumulando

Acesse `http://localhost:3001` na filial e resolva cada conflito usando **Manter local** ou **Manter servidor**.

### Ciclos lentos ou saltados

O sistema protege contra ciclos sobrepostos com a flag `rodando` — se um ciclo levar mais que `INTERVALO_MS`, o próximo é descartado. Aumente `INTERVALO_MS` no `.env` do cliente se o ciclo estiver demorando demais.

```
INTERVALO_MS=60000   # 60 segundos
```

### Recarregar lista de empresas sem reiniciar o servidor

```bash
curl -X POST http://localhost:8080/admin/reload-empresas \
     -H "x-admin-token: SEU_ADMIN_TOKEN"
```
