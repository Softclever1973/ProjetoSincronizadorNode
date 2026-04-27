# Onboarding — Adicionando um Novo Banco ao Sincronizador

Este guia cobre o processo completo para conectar um novo banco Firebird (filial) ao servidor de sincronização, desde o cadastro no servidor até o primeiro ciclo rodando na máquina do cliente.

---

## Visão Geral

O sincronizador tem dois lados:

| Lado | Processo | Banco |
|---|---|---|
| **Servidor (Matriz)** | `npm start` (já em execução) | PostgreSQL |
| **Cliente (Filial)** | `npm run client` (instalado na máquina da loja) | Firebird `.fdb` |

Cada filial se identifica com um **token único** (`SYNC_TOKEN`). O servidor usa esse token para rotear os dados para o schema PostgreSQL correto da empresa.

---

## Passo 1 — Cadastrar a empresa no servidor

Execute no servidor (pasta `ProjetoSincronizadorNode`):

```bash
# Gere um token seguro para a filial
npm run generate-secret
# Exemplo de saída: a3f8c2d1e9b4...

# Cadastre a empresa no banco PostgreSQL
node scripts/create-empresa.js \
  --schema=empresa_kr \
  --token=a3f8c2d1e9b4... \
  --nome="KR Supermercados"
```

**Regras para `--schema`:**
- Apenas letras minúsculas, números e `_`
- Deve começar com letra ou `_`
- Exemplos válidos: `empresa_kr`, `filial_sp01`, `rede_jb`

**O que esse script faz:**
- Cria o schema PostgreSQL `empresa_kr`
- Cria dentro dele: `seq_atualizacao_matriz`, `filiais_bloqueadas`, `registros_deletados`
- Registra o par `(token, schema_name)` em `public.sync_tenants`
- O servidor detecta o novo token automaticamente — **não precisa reiniciar**

---

## Passo 2 — Instalar o cliente na máquina da filial

### 2.1 Pré-requisitos na máquina da filial

- Node.js 18 ou superior instalado
- Firebird instalado e o arquivo `.fdb` acessível localmente
- Acesso de rede ao servidor (porta configurada em `PORT`, padrão `8080`)

### 2.2 Copiar os arquivos do cliente

Copie para a máquina da filial apenas os arquivos necessários:

```
ProjetoSincronizadorNode/
├── src/
│   └── client/          ← pasta completa do cliente
├── package.json
├── package-lock.json
└── node_modules/        ← rodar npm install na máquina de destino
```

Ou clone o repositório completo e instale as dependências:

```bash
npm install
```

### 2.3 Criar o arquivo de configuração do cliente

Crie o arquivo `src/client/.env` com base no exemplo:

```bash
cp src/client/.env.example src/client/.env
```

Edite `src/client/.env` com os dados da filial:

```env
# Token gerado no Passo 1 — deve ser idêntico ao cadastrado no servidor
SYNC_TOKEN=a3f8c2d1e9b4...

# Endereço do servidor (Matriz)
# Substitua pelo IP ou hostname real do servidor
# Não inclua barra no final
SERVER_URL=http://192.168.1.100:8080

# Conexão com o Firebird local
FIREBIRD_HOST=localhost
FIREBIRD_PORT=3050
FIREBIRD_DATABASE=C:\FDBS\KR_FILIAL.FDB
FIREBIRD_VERSION=3
# FIREBIRD_PASSWORD=senha-customizada   # opcional

# Intervalo do ciclo de sync em milissegundos (padrão: 30000 = 30s)
INTERVALO_MS=30000
```

> **Atenção:** `SYNC_TOKEN` precisa ser exatamente igual ao cadastrado com `create-empresa.js` no Passo 1.

---

## Passo 3 — Iniciar o cliente

```bash
# Produção
npm run client

# Com auto-reload (desenvolvimento)
npm run client:dev
```

**Na primeira execução**, o cliente:
1. Valida `SYNC_TOKEN` e `FIREBIRD_DATABASE` — encerra com mensagem clara se ausentes
2. Conecta ao Firebird e executa `setup.js` — cria tabelas e triggers de rastreamento (`SYNC_ALTERACOES_PENDENTES`, `SYNC_VERSOES_SERVIDOR`, etc.) — operação idempotente
3. Inicia a WebUI de conflitos em `http://localhost:3001`
4. Executa o primeiro ciclo pull → push

**Saída esperada no terminal:**
```
[HH:MM:SS] Cliente de sincronização iniciado. Intervalo: 30s
[HH:MM:SS] Iniciando ciclo — servidor: http://192.168.1.100:8080 | loja: 1
[HH:MM:SS] Ciclo concluído.
```

---

## Passo 4 — Verificar a sincronização

### No cliente (filial)

Abra `http://localhost:3001/status` no navegador da máquina da filial. Deve mostrar as tabelas ativas e o último registro sincronizado de cada uma.

### No servidor (matriz)

Confirme que o schema foi criado e os dados estão chegando:

```sql
-- Lista empresas cadastradas
SELECT token, schema_name, nome, ativo FROM public.sync_tenants;

-- Verifica se há dados no schema da empresa
SELECT COUNT(*) FROM empresa_kr."PRODUTOS";
```

---

## Passo 5 — Criar usuário para acesso à API (opcional)

Se o responsável pela empresa precisar de acesso à API de gestão (listar/criar empresas via `GET /user/empresas`):

```bash
# No servidor
node scripts/create-usuario.js \
  --email=gerente@empresa.com \
  --senha=SenhaSegura123 \
  --schema=empresa_kr
```

O usuário poderá autenticar via:

```http
POST /auth/login
Content-Type: application/json

{ "email": "gerente@empresa.com", "senha": "SenhaSegura123" }
```

Resposta:
```json
{ "token": "<jwt>", "schemas": ["empresa_kr"] }
```

---

## Referência rápida — comandos do servidor

| Ação | Comando |
|---|---|
| Gerar token seguro | `npm run generate-secret` |
| Cadastrar nova empresa | `node scripts/create-empresa.js --schema=X --token=Y --nome="Z"` |
| Criar usuário de acesso | `node scripts/create-usuario.js --email=X --senha=Y [--schema=Z]` |
| Recarregar cache de empresas sem reiniciar | `curl -X POST http://localhost:8080/admin/reload-empresas -H "x-admin-token: <ADMIN_TOKEN>"` |

---

## Troubleshooting

### `[ERRO] SYNC_TOKEN não configurado`
O arquivo `src/client/.env` não existe ou está vazio. Verifique se foi criado corretamente.

### `[ERRO] FIREBIRD_DATABASE não definido`
Adicione `FIREBIRD_DATABASE=C:\caminho\para\banco.fdb` no `src/client/.env`.

### `Error: Connection refused` ao conectar no servidor
- Verifique se o servidor está rodando (`npm start` na matriz)
- Confirme o IP/porta em `SERVER_URL` no `.env` do cliente
- Verifique firewall da máquina do servidor liberando a porta `PORT`

### Token rejeitado (HTTP 401 ou 403)
- Confirme que o token em `SYNC_TOKEN` do cliente é **idêntico** ao cadastrado com `create-empresa.js`
- Verifique se a empresa está ativa: `SELECT ativo FROM public.sync_tenants WHERE token = '...'`
- Se o token foi cadastrado recentemente sem reiniciar o servidor, force o reload: `POST /admin/reload-empresas`

### Filial aparece como bloqueada (HTTP 401 nas rotas de sync)
O número da loja está na tabela `filiais_bloqueadas` do schema. Para desbloquear:

```sql
DELETE FROM empresa_kr.filiais_bloqueadas WHERE id_filial_bloqueada = <numero_loja>;
```
