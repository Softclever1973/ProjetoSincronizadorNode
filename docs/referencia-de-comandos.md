# Referência de Comandos

Guia completo de todos os comandos disponíveis no ProjetoSincronizadorNode: scripts CLI, npm scripts e endpoints HTTP (servidor e web UI do cliente).

---

## Sumário

1. [npm scripts](#1-npm-scripts)
2. [Scripts CLI](#2-scripts-cli)
   - [create-empresa](#create-empresajs)
   - [create-usuario](#create-usuariojs)
   - [reset-empresa](#reset-empresajs)
   - [migrate-data](#migrate-datajs)
   - [migrate-public-to-schema](#migrate-public-to-schemajs)
   - [export-schema](#export-schemajs)
3. [Endpoints HTTP — Servidor](#3-endpoints-http--servidor)
   - [Sync (DataSnap)](#sync-datasnap--datasnap-rest-tsmsincronizacao)
   - [Admin](#admin--adminreload-empresas)
   - [API REST (JWT)](#api-rest-jwt--apischema)
4. [Endpoints HTTP — Web UI do Cliente](#4-endpoints-http--web-ui-do-cliente-localhost3001)
   - [Carga inicial completa](#carga-inicial-completa)
   - [Carga parcial (últimos X registros)](#carga-parcial--ltimos-x-registros)
   - [Progresso de envio](#progresso-de-envio)
   - [Configuração de tabelas](#configuração-de-tabelas)
5. [Variáveis de ambiente](#5-variáveis-de-ambiente)

---

## 1. npm scripts

Execute a partir do diretório `ProjetoSincronizadorNode/`.

| Comando | O que faz |
|---------|-----------|
| `npm start` | Inicia o servidor em modo produção |
| `npm run dev` | Inicia o servidor com nodemon (auto-reload ao salvar) |
| `npm run client` | Inicia o cliente Firebird |
| `npm run client:dev` | Inicia o cliente Firebird com nodemon |
| `npm run build:server` | Compila `dist/server.exe` (Windows x64, Node 22, autônomo) |
| `npm run build:client` | Compila `dist/client.exe` (Windows x64, Node 22, autônomo) |
| `npm run generate-secret` | Gera string hex aleatória de 64 caracteres (uso: JWT_SECRET, ADMIN_TOKEN) |

---

## 2. Scripts CLI

Todos rodam com `node scripts/<nome>.js` a partir do diretório `ProjetoSincronizadorNode/`.  
Por padrão leem `DATABASE_URL` do arquivo `.env` na raiz.

---

### create-empresa.js

Cria uma nova empresa (tenant) no sistema multi-tenant. Provisiona o schema no PostgreSQL com toda a infraestrutura de sync e registra o token. **O servidor detecta o novo token automaticamente** — não precisa reiniciar.

**Pré-requisito:** o servidor deve ter sido iniciado ao menos uma vez (para que `public.sync_tenants` exista).

```bash
node scripts/create-empresa.js --schema=empresa_jb --token=TOKEN_NOVO [--nome="JB Atacado"]
```

| Parâmetro | Obrigatório | Descrição |
|-----------|:-----------:|-----------|
| `--schema=NAME` | Sim | Nome do schema PostgreSQL. Apenas letras minúsculas, números e underscore. Ex: `empresa_jb` |
| `--token=STRING` | Sim | Token de sincronização. Deve ser único no sistema. |
| `--nome=TEXT` | Não | Nome de exibição da empresa. Padrão: mesmo que `--schema` |

**O que é criado no PostgreSQL:**

- Schema isolado com o nome informado
- Sequências: `seq_atualizacao_matriz`, `seq_srv_id`
- Tabelas: `filiais_bloqueadas`, `registros_deletados`, `sync_filiais`, `sync_config`, `srv_id_map`
- Funções de trigger: `fn_seq_atualizacao()`, `fn_registrar_delecao()`
- Registro em `public.sync_tenants`

---

### create-usuario.js

Cria credenciais de acesso à API REST e ao painel web. **Não há endpoint público de registro** — novos usuários só são criados por este script.

```bash
# Usuário sem vínculo de empresa
node scripts/create-usuario.js --email=admin@empresa.com --senha=senha123

# Usuário dono vinculado a uma empresa
node scripts/create-usuario.js --email=admin@empresa.com --senha=senha123 \
  --schema=empresa_kr --role=dono

# Gerente de loja específica
node scripts/create-usuario.js --email=ger@empresa.com --senha=senha123 \
  --schema=empresa_kr --role=gerente --loja=2
```

| Parâmetro | Obrigatório | Descrição |
|-----------|:-----------:|-----------|
| `--email=ADDR` | Sim | E-mail do usuário (deve ser único) |
| `--senha=PASS` | Sim | Senha em texto plano (armazenada como hash bcrypt) |
| `--schema=NAME` | Não | Vincula o usuário a este schema existente |
| `--role=ROLE` | Não | `dono` \| `gerente` \| `vendedor`. Padrão: `dono` |
| `--loja=ID` | Condicional | ID da loja (inteiro). **Obrigatório para `gerente` e `vendedor`** |

---

### reset-empresa.js

Restaura um schema ao estado imediatamente após o `create-empresa`. Remove todas as tabelas de dados sincronizados, limpa as tabelas de infraestrutura, reinicia as sequências e, opcionalmente, zera o estado de sync no Firebird do cliente.

**Atenção:** operação irreversível. Pare o servidor antes de executar.

```bash
# Apenas PostgreSQL (usa DATABASE_URL do .env)
node scripts/reset-empresa.js --schema=empresa_jb

# PostgreSQL + Firebird + JSON (reset completo)
node scripts/reset-empresa.js --schema=empresa_jb ^
  --fb-database=C:\FDBS\filial.fdb ^
  --fb-password=masterkey

# Com todos os parâmetros explícitos, sem confirmação interativa
node scripts/reset-empresa.js --schema=empresa_jb ^
  --pg-url=postgresql://postgres:senha@localhost:5432/matriz ^
  --fb-database=C:\FDBS\filial.fdb ^
  --fb-password=masterkey ^
  --fb-host=192.168.1.10 ^
  --fb-port=3050 ^
  --fb-user=SYSDBA ^
  --json-dir=C:\Projetos\ProjetoSincronizadorNode ^
  --force
```

| Parâmetro | Obrigatório | Descrição |
|-----------|:-----------:|-----------|
| `--schema=NAME` | Sim | Schema a resetar |
| `--pg-url=URL` | Não | String de conexão PostgreSQL. Padrão: `DATABASE_URL` do `.env` |
| `--fb-database=PATH` | Não | Caminho completo do `.fdb` do cliente. Se omitido, pula o reset Firebird |
| `--fb-password=PASS` | Condicional | **Obrigatório se `--fb-database` for informado** |
| `--fb-host=ADDR` | Não | Host Firebird. Padrão: `localhost` |
| `--fb-port=PORT` | Não | Porta Firebird. Padrão: `3050` |
| `--fb-user=USER` | Não | Usuário Firebird. Padrão: `SYSDBA` |
| `--json-dir=PATH` | Não | Diretório dos arquivos `.json` de runtime. Padrão: diretório atual |
| `--force` | Não | Pula a confirmação interativa (útil em automação) |

**O que é resetado:**

| Parte | Ação |
|-------|------|
| PostgreSQL — tabelas de dados | `DROP TABLE ... CASCADE` para todas as tabelas fora da infraestrutura (PRODUTOS, CLIENTES, etc.) |
| PostgreSQL — infraestrutura | `TRUNCATE` de `filiais_bloqueadas`, `registros_deletados`, `sync_filiais`, `sync_config`, `srv_id_map` |
| PostgreSQL — sequências | `seq_atualizacao_matriz` e `seq_srv_id` reiniciadas em 1 |
| Firebird | `DELETE` de `SYNC_ALTERACOES_PENDENTES`, `SYNC_VERSOES_SERVIDOR`, `SYNC_ERROS` |
| Firebird | `ULTIMOS_REGISTROS_MATRIZ` cursores zerados |
| JSON | `conflitos.json` e `erros.json` resetados para `{}` |

---

### migrate-data.js

Importa em massa dados do Firebird (KR_CENTRAL.FDB) para o PostgreSQL. Destinado ao setup inicial. Processa 500 linhas por vez no Firebird e grava 200 por vez no PostgreSQL.

```bash
# Todas as tabelas
node scripts/migrate-data.js

# Apenas tabelas específicas
node scripts/migrate-data.js --tables=PRODUTOS,CLIENTES

# Excluir tabelas específicas
node scripts/migrate-data.js --skip=SYNC_ERROS,PARAMETROS
```

| Parâmetro | Obrigatório | Descrição |
|-----------|:-----------:|-----------|
| `--tables=T1,T2,...` | Não | Migra somente estas tabelas (case-insensitive). Padrão: todas |
| `--skip=T1,T2,...` | Não | Exclui estas tabelas da migração. Padrão: nenhuma |

**Comportamento:** usa `ON CONFLICT DO NOTHING` — PKs duplicadas são ignoradas silenciosamente. Tabelas inexistentes no PostgreSQL são puladas. Erros são gravados em `migrate-errors.log`.

---

### migrate-public-to-schema.js

Migração de schema único para multi-tenant. Move todas as tabelas de negócio do schema `public` para um schema nomeado e registra o token. Operação de setup único — não use após a estrutura multi-tenant já estar ativa.

```bash
node scripts/migrate-public-to-schema.js \
  --schema=empresa_kr \
  --token=TOKEN_INICIAL \
  --nome="KR Supermercados"
```

| Parâmetro | Obrigatório | Descrição |
|-----------|:-----------:|-----------|
| `--schema=NAME` | Sim | Schema de destino (mesmo formato que `create-empresa`) |
| `--token=STRING` | Sim | Token a registrar para este tenant |
| `--nome=TEXT` | Não | Nome de exibição. Padrão: mesmo que `--schema` |

**Idempotente:** tabelas já existentes no destino são puladas. Seguro re-executar.

---

### export-schema.js

Lê a estrutura do Firebird matriz (KR_CENTRAL.FDB) e gera um arquivo SQL com `CREATE TABLE IF NOT EXISTS` equivalentes em PostgreSQL. Usado para criar a estrutura inicial antes de migrar dados.

```bash
node scripts/export-schema.js
# Gera: schema-matriz.sql na raiz do projeto

# Em seguida, aplique no PostgreSQL:
psql -U postgres -d matriz -f schema-matriz.sql
```

Sem parâmetros. As credenciais do Firebird estão embutidas no script.

---

## 3. Endpoints HTTP — Servidor

Base URL padrão: `http://localhost:8080`  
Todos os endpoints de sync exigem `?token=<SYNC_TOKEN>` na query string.

---

### Sync (DataSnap) — `/datasnap/rest/TSMSincronizacao`

#### `GET /RegistrosParaAtualizar`

Busca registros alterados no servidor para download pelo cliente (pull). Retorna no máximo 50 registros por chamada, ordenados por `ID_ULTIMA_ATUALIZACAO_MATRIZ`.

| Parâmetro | Obrigatório | Descrição |
|-----------|:-----------:|-----------|
| `token` | Sim | Token de sync |
| `nomeTabela` | Sim | Nome da tabela (ex: `PRODUTOS`) |
| `idUltimaAtualizacaoMatriz` | Não | Cursor — busca registros com ID maior que este. Padrão: `0` |
| `idLoja` | Não | Número da loja para filtro por filial |
| `nomeFilial` | Não | Nome da filial (registrado em `sync_filiais`) |
| `filtroFilial` | Não | Coluna para filtrar por loja (ex: `ID_LOJA`). Requer `idLoja` |
| `filtroFilialViaFK` | Não | Para tabelas filhas sem `ID_LOJA`: coluna de FK para PEDIDOS (ex: `ID_PEDIDO`) |
| `colunaData` | Não | Coluna de data para política de retenção de 2 anos (ex: `DATA_HORA`) |

```bash
curl "http://localhost:8080/datasnap/rest/TSMSincronizacao/RegistrosParaAtualizar?token=xyz&nomeTabela=PRODUTOS&idUltimaAtualizacaoMatriz=100&idLoja=1"
```

---

#### `GET /RegistrosParaDeletar`

Busca registros deletados no servidor para remoção pelo cliente.

| Parâmetro | Obrigatório | Descrição |
|-----------|:-----------:|-----------|
| `token` | Sim | Token de sync |
| `nomeTabela` | Sim | Nome da tabela |
| `idUltimoRegistroDeletado` | Não | Cursor. Padrão: `0` |

```bash
curl "http://localhost:8080/datasnap/rest/TSMSincronizacao/RegistrosParaDeletar?token=xyz&nomeTabela=PRODUTOS&idUltimoRegistroDeletado=50"
```

---

#### `GET /StatusTabelas`

Retorna status de sync de todas as tabelas do tenant: total de registros e ID máximo de atualização.

```bash
curl "http://localhost:8080/datasnap/rest/TSMSincronizacao/StatusTabelas?token=xyz"
```

Resposta:
```json
[
  { "tabela": "PRODUTOS", "total": 1523, "maxId": 98741 },
  { "tabela": "CLIENTES", "total": 832,  "maxId": 97200 }
]
```

---

#### `GET /RegistrosPaginados`

Retorna registros paginados de uma tabela para auditoria manual.

| Parâmetro | Obrigatório | Descrição |
|-----------|:-----------:|-----------|
| `token` | Sim | Token de sync |
| `nomeTabela` | Sim | Nome da tabela |
| `pk` | Sim | Coluna(s) PK. Pode repetir para PKs compostas: `&pk=CATEGORIA&pk=ID_ITEM` |
| `offset` | Não | Deslocamento de linhas. Padrão: `0` |
| `limit` | Não | Máximo de linhas. Padrão: `200`, máximo: `500` |

```bash
curl "http://localhost:8080/datasnap/rest/TSMSincronizacao/RegistrosPaginados?token=xyz&nomeTabela=PRODUTOS&pk=ID_PRODUTO&offset=0&limit=100"
```

---

#### `GET /FiliaisRegistradas`

Retorna lista de filiais que já conectaram ao servidor.

```bash
curl "http://localhost:8080/datasnap/rest/TSMSincronizacao/FiliaisRegistradas?token=xyz"
```

Resposta:
```json
[
  { "ID_LOJA": 1, "NOME": "Loja Centro" },
  { "ID_LOJA": 2, "NOME": "Loja Norte" }
]
```

---

#### `POST /ReceberRegistro`

Recebe um registro do cliente (filial → servidor). Cria a tabela no PostgreSQL automaticamente se for o primeiro push.

Query params: `token`, `idLoja`, `idPDV` (opcional), `nomeFilial` (opcional).

Body JSON:

```json
{
  "tabela": "PRODUTOS",
  "pk": "ID_PRODUTO",
  "registro": {
    "ID_PRODUTO": 123,
    "DESCRICAO": "Produto A",
    "PRECO_VENDA": 99.99
  },
  "ultimaVersaoConhecida": 456,
  "forcar": false,
  "deletar": false,
  "temSrvId": false
}
```

| Campo | Obrigatório | Descrição |
|-------|:-----------:|-----------|
| `tabela` | Sim | Nome da tabela |
| `pk` | Sim | Coluna(s) PK: string ou array `["COL1","COL2"]` |
| `registro` | Sim | Objeto com os campos (chaves em maiúsculas) |
| `ultimaVersaoConhecida` | Não | Última versão do servidor conhecida pelo cliente (para detecção de conflito). Padrão: `0` |
| `forcar` | Não | `true` para aplicar sem verificar conflito. Padrão: `false` |
| `deletar` | Não | `true` para deletar o registro no servidor. Padrão: `false` |
| `temSrvId` | Não | `true` para tabelas com PK gerada pelo servidor (`SRV_ID`). Padrão: `false` |

Resposta de sucesso:
```json
{ "ok": true, "novoId": 789, "srvId": 42 }
```

Resposta de conflito (quando `forcar=false` e servidor tem versão mais nova):
```json
{
  "conflito": true,
  "versaoServidor": { "ID_PRODUTO": 123, "DESCRICAO": "Versão do servidor", ... }
}
```

---

### Admin — `/admin/reload-empresas`

#### `POST /admin/reload-empresas`

Recarrega o cache de tenants em memória sem reiniciar o servidor. Use após adicionar uma empresa via `create-empresa.js` se a detecção automática não ocorrer.

```bash
curl -X POST http://localhost:8080/admin/reload-empresas \
  -H "x-admin-token: SEU_ADMIN_TOKEN"
```

Resposta: `{ "ok": true }`

---

### API REST (JWT) — `/api/:schema`

Requerem header `Authorization: Bearer <token>` (JWT obtido via `POST /auth/login`).

#### `POST /auth/login`

```bash
curl -X POST http://localhost:8080/auth/login \
  -H "Content-Type: application/json" \
  -d '{ "email": "admin@empresa.com", "senha": "senha123" }'
```

Resposta:
```json
{ "token": "eyJ...", "schemas": ["empresa_kr", "empresa_jb"] }
```

---

#### `GET /api/:schema/admin/sync-config`

Lê as configurações de sync do schema.

```bash
curl -H "Authorization: Bearer $JWT" \
  http://localhost:8080/api/empresa_kr/admin/sync-config
```

---

#### `PUT /api/:schema/admin/sync-config`

Atualiza uma configuração de sync.

```bash
curl -X PUT http://localhost:8080/api/empresa_kr/admin/sync-config \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{ "chave": "filtro_filial_clientes", "valor": "ID_LOJA" }'
```

---

#### `GET /api/:schema/filiais`

Lista filiais registradas no schema.

```bash
curl -H "Authorization: Bearer $JWT" \
  http://localhost:8080/api/empresa_kr/filiais
```

---

## 4. Endpoints HTTP — Web UI do Cliente (`localhost:3001`)

Servidos pelo cliente Firebird. Acesso local apenas (sem autenticação).

---

### Carga inicial completa

#### `POST /configuracoes/carga-inicial`

Re-enfileira **todos** os registros do Firebird para envio ao servidor. Zera os cursores de sync, limpa pendentes, erros e conflitos. Retorna progresso via **Server-Sent Events (SSE)**.

Body JSON (opcional):
```json
{ "tabelas": ["PRODUTOS", "CLIENTES"] }
```

Se `tabelas` for omitido ou vazio, todas as tabelas são processadas e o histórico de erros/conflitos é limpo. Se informado, apenas as tabelas listadas são resetadas.

**Exemplo com curl (recebe SSE):**
```bash
curl -X POST http://localhost:3001/configuracoes/carga-inicial \
  -H "Content-Type: application/json" \
  -d '{}'
```

**Exemplo com fetch (JavaScript):**
```javascript
const res = await fetch('http://localhost:3001/configuracoes/carga-inicial', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ tabelas: ['PRODUTOS'] }),
});

const reader = res.body.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  process.stdout.write(decoder.decode(value));
}
```

**Eventos SSE emitidos:**

| Evento | Dados |
|--------|-------|
| `progresso` | `{ processadas, total, tabela, enfileiradosNaTabela, totalEnfileirados, porcentagem, restanteSegundos }` |
| `concluido` | `{ totalEnfileirados, duracaoSegundos }` |
| `erro` | `{ message }` |

---

### Carga parcial — últimos X registros

#### `POST /api/carga-parcial`

Enfileira apenas os **últimos `limite` registros** de cada tabela sem zerar o estado de sync completo. É o equivalente a "forçar carga inicial com X registros".

Body JSON:
```json
{
  "limite": 5000,
  "tabelas": ["PRODUTOS", "CLIENTES"]
}
```

| Campo | Obrigatório | Descrição |
|-------|:-----------:|-----------|
| `limite` | Sim | Número máximo de registros por tabela (inteiro positivo) |
| `tabelas` | Não | Array de nomes de tabelas. Se omitido, processa todas |

**Exemplo com curl:**
```bash
# Últimos 1000 registros de todas as tabelas
curl -X POST http://localhost:3001/api/carga-parcial \
  -H "Content-Type: application/json" \
  -d '{ "limite": 1000 }'

# Últimos 500 registros apenas de PRODUTOS e CLIENTES
curl -X POST http://localhost:3001/api/carga-parcial \
  -H "Content-Type: application/json" \
  -d '{ "limite": 500, "tabelas": ["PRODUTOS", "CLIENTES"] }'
```

**Resposta:**
```json
{
  "ok": true,
  "limite": 500,
  "tabelas": ["PRODUTOS", "CLIENTES"],
  "totalEnfileirados": 923,
  "tabelasProcessadas": [
    { "tabela": "PRODUTOS", "enfileirados": 500 },
    { "tabela": "CLIENTES", "enfileirados": 423 }
  ]
}
```

**Diferença em relação à carga inicial completa:**

| | `carga-inicial` | `carga-parcial` |
|-|:-:|:-:|
| Zera cursores de pull | Sim | Não |
| Limpa conflitos e erros | Sim (se sem filtro) | Não |
| Limpa `SYNC_VERSOES_SERVIDOR` | Sim | Não |
| Permite limitar quantidade | Não | **Sim (`limite`)** |
| Retorna progresso em tempo real (SSE) | Sim | Não |

---

### Progresso de envio

#### `GET /api/carga-inicial/progresso`

Retorna o progresso do envio em andamento após uma carga inicial ou parcial.

```bash
curl http://localhost:3001/api/carga-inicial/progresso
```

Resposta (enquanto ativo):
```json
{
  "ativo": true,
  "total": 50000,
  "enviados": 12345,
  "pendentes": 37655,
  "porcentagem": 25,
  "decorrido": 30
}
```

Resposta (quando inativo):
```json
{ "ativo": false }
```

---

### Configuração de tabelas

#### `POST /configuracoes/toggle`

Ativa ou desativa uma tabela específica no ciclo de sync.

```bash
curl -X POST http://localhost:3001/configuracoes/toggle \
  -H "Content-Type: application/json" \
  -d '{ "tabela": "PRODUTOS", "ativo": false }'
```

---

#### `POST /configuracoes/toggle-todos`

Ativa ou desativa todas as tabelas de uma vez.

```bash
curl -X POST http://localhost:3001/configuracoes/toggle-todos \
  -H "Content-Type: application/json" \
  -d '{ "ativo": true }'
```

---

### Resolução de conflitos

#### `POST /conflitos/:id/resolver`

Resolve um conflito com uma das três estratégias.

```bash
# Usar versão local (força push com forcar=true)
curl -X POST http://localhost:3001/conflitos/abc123/resolver \
  -H "Content-Type: application/json" \
  -d '{ "estrategia": "local" }'

# Usar versão do servidor (aplica localmente)
curl -X POST http://localhost:3001/conflitos/abc123/resolver \
  -H "Content-Type: application/json" \
  -d '{ "estrategia": "servidor" }'

# Mesclar campo a campo
curl -X POST http://localhost:3001/conflitos/abc123/resolver \
  -H "Content-Type: application/json" \
  -d '{ "estrategia": "mesclar", "campos": { "DESCRICAO": "local", "PRECO": "servidor" } }'
```

---

### Outros endpoints da Web UI

| Endpoint | Descrição |
|----------|-----------|
| `GET /` | Página de conflitos |
| `GET /status` | Dashboard de status de sync por tabela |
| `GET /auditoria` | Comparação servidor vs local para divergências |
| `POST /auditoria/corrigir` | Corrige divergências em lote |
| `POST /auditoria/resolver-unico` | Corrige uma única divergência |
| `GET /erros` | Log de erros de sync |
| `POST /erros/limpar` | Limpa o log de erros |
| `GET /eventos` | Stream SSE de erros e conflitos em tempo real |
| `GET /api/conflitos/count` | Contagem de conflitos ativos |
| `GET /api/erros/count` | Contagem de erros recentes |

---

## 5. Variáveis de ambiente

### Servidor — `.env` (raiz do projeto)

```env
DATABASE_URL=postgresql://postgres:senha@localhost:5432/matriz
PORT=8080
JWT_SECRET=<hex-64-chars>
ADMIN_TOKEN=<hex-32-chars>
SYNC_TOKEN=seu-token-aqui
```

| Variável | Obrigatória | Descrição |
|----------|:-----------:|-----------|
| `DATABASE_URL` | Sim | String de conexão PostgreSQL |
| `PORT` | Não | Porta HTTP do servidor. Padrão: `8080` |
| `JWT_SECRET` | Sim | Segredo para assinar JWTs (gerado pelo wizard ou `npm run generate-secret`) |
| `ADMIN_TOKEN` | Sim | Token para endpoints `/admin/*` |
| `SYNC_TOKEN` | Sim | Token compartilhado com os clientes Firebird |

### Cliente — `src/client/.env`

```env
SYNC_TOKEN=seu-token-aqui
FIREBIRD_HOST=localhost
FIREBIRD_PORT=3050
FIREBIRD_DATABASE=C:\FDBS\FILIAL.FDB
FIREBIRD_USER=SYSDBA
FIREBIRD_PASSWORD=masterkey
INTERVALO_MS=30000
```

| Variável | Obrigatória | Descrição |
|----------|:-----------:|-----------|
| `SYNC_TOKEN` | Sim | Deve ser idêntico ao do servidor |
| `FIREBIRD_DATABASE` | Sim | Caminho completo do arquivo `.fdb` |
| `FIREBIRD_PASSWORD` | Sim | Senha do Firebird (sem fallback) |
| `FIREBIRD_HOST` | Não | Host Firebird. Padrão: `localhost` |
| `FIREBIRD_PORT` | Não | Porta Firebird. Padrão: `3050` |
| `FIREBIRD_USER` | Não | Usuário Firebird. Padrão: `SYSDBA` |
| `INTERVALO_MS` | Não | Intervalo do ciclo de sync em milissegundos. Padrão: `30000` |
