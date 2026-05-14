# Onboarding — Adicionando um Novo Banco ao Sincronizador

Este guia cobre o processo completo para conectar um novo banco Firebird (filial) ao servidor de sincronização, desde o cadastro no servidor até o primeiro ciclo rodando na máquina do cliente.

---

## Visão Geral

O sincronizador tem dois lados:

| Lado | Processo | Banco |
|---|---|---|
| **Servidor (Matriz)** | `npm start` (já em execução) | PostgreSQL |
| **Cliente (Filial)** | `npm run client` ou `client.exe` (instalado na máquina da loja) | Firebird `.fdb` |

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

- Firebird instalado e em execução
- **O arquivo `.fdb` da filial já deve existir** — o sincronizador **não cria** o banco de dados. Ele conecta a um banco Firebird pré-existente (o banco da filial já em uso pelo sistema Sirius/Delphi). Se o banco ainda não existir na máquina, ele precisa ser criado ou copiado antes de continuar
- Acesso de rede ao servidor (porta configurada em `PORT`, padrão `8080`)
- **Se usar `npm run client`:** Node.js 18 ou superior instalado
- **Se usar `client.exe`:** nenhuma dependência adicional

### 2.2 Obter o cliente

**Opção A — Executável** (recomendado para produção): copie o `client.exe` gerado pelo build para uma pasta na máquina da filial.

**Opção B — Node.js**: clone o repositório e instale as dependências:

```bash
npm install
```

### 2.3 Configurar o cliente

Na primeira execução, o cliente inicia automaticamente um **assistente de configuração** interativo no terminal. Basta responder às perguntas:

```
+--------------------------------------+
|   Configuracao inicial do Cliente    |
+--------------------------------------+

SYNC_TOKEN (fornecido pelo administrador do servidor):
> a3f8c2d1e9b4...

URL do servidor
  ex: http://192.168.1.100:8080
> http://192.168.1.100:8080

Caminho do banco Firebird
  ex: C:\FDBS\FILIAL.FDB
> C:\FDBS\KR_FILIAL.FDB

Senha do Firebird:
> masterkey

Host do Firebird [localhost]:
>

Porta do Firebird [3050]:
>

Usuario do Firebird [SYSDBA]:
>

Intervalo entre ciclos em ms [30000]:
>
```

Campos entre `[colchetes]` têm valor padrão — pressione Enter para aceitar. **Ctrl+V** funciona para colar (Windows).

O wizard cria `src/client/.env` (ou `.env` ao lado do `client.exe`) e grava a URL do servidor em `PARAMETROS(60024)` no banco Firebird automaticamente.

> Para reconfigurar, apague o `.env` e reinicie o cliente.

**Configuração manual** (alternativa ao wizard): crie o arquivo `.env` diretamente:

```env
SYNC_TOKEN=a3f8c2d1e9b4...
FIREBIRD_HOST=localhost
FIREBIRD_PORT=3050
FIREBIRD_DATABASE=C:\FDBS\KR_FILIAL.FDB
FIREBIRD_USER=SYSDBA
FIREBIRD_PASSWORD=masterkey
INTERVALO_MS=30000
```

> `FIREBIRD_PASSWORD` é **obrigatório** — o cliente falha na conexão sem ele.

---

## Passo 3 — Iniciar o cliente

```bash
# Produção (Node.js)
npm run client

# Com auto-reload (desenvolvimento)
npm run client:dev

# Executável
client.exe
```

**Na primeira execução**, o cliente:
1. Executa o wizard de configuração (se `.env` ausente)
2. Conecta ao Firebird e executa `setup.js` — cria tabelas e triggers de rastreamento (`SYNC_ALTERACOES_PENDENTES`, `SYNC_VERSOES_SERVIDOR`, etc.) — operação idempotente
3. Inicia a WebUI de conflitos em `http://localhost:3001`
4. Executa o primeiro ciclo pull → push

**Saída esperada no terminal:**
```
[HH:MM:SS] Cliente de sincronização iniciado. Intervalo: 30s
[HH:MM:SS] Iniciando ciclo — servidor: http://192.168.1.100:8080 | loja: 1
[HH:MM:SS] Ciclo concluído.
```

### 3.1 Modo em segundo plano (`client.exe`)

Ao fechar a janela do CMD, o cliente continua rodando silenciosamente com apenas o ícone na **bandeja do sistema** (canto inferior direito do Windows). Os logs passam a ser gravados em `client.log` na mesma pasta do executável.

Para interagir com o cliente em segundo plano, clique com o botão direito no ícone da bandeja:

| Item | Ação |
|---|---|
| **Abrir Console** | Abre um CMD mostrando o `client.log` em tempo real |
| **Abrir Web UI** | Abre `http://localhost:3001` no navegador |
| **Iniciar com o Windows** | Liga/desliga a inicialização automática na próxima vez que o Windows ligar (✓ = ativo) |
| **Parar cliente** | Encerra o processo completamente |

### 3.2 Inicialização automática com o Windows

Para que o cliente suba automaticamente ao ligar o computador, clique com o botão direito no ícone da bandeja → **Iniciar com o Windows**. Um ✓ confirma que está ativo. O cliente iniciará em segundo plano (sem CMD) na próxima vez que o Windows for ligado.

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
O arquivo `.env` não existe ou está vazio. Execute o cliente sem `.env` para que o wizard de configuração seja iniciado automaticamente.

### `[ERRO] FIREBIRD_DATABASE não definido`
Adicione `FIREBIRD_DATABASE=C:\caminho\para\banco.fdb` no `.env`.

### `Error: Connection refused` ao conectar no servidor
- Verifique se o servidor está rodando (`npm start` na matriz)
- Confirme o IP/porta que foi informado no wizard (ou em `PARAMETROS(60024)` no banco Firebird)
- Verifique firewall da máquina do servidor liberando a porta `PORT`

### Token rejeitado (HTTP 401 ou 403)
- Confirme que o `SYNC_TOKEN` no `.env` do cliente é **idêntico** ao cadastrado com `create-empresa.js`
- Verifique se a empresa está ativa: `SELECT ativo FROM public.sync_tenants WHERE token = '...'`
- Se o token foi cadastrado recentemente sem reiniciar o servidor, force o reload: `POST /admin/reload-empresas`

### Filial aparece como bloqueada (HTTP 401 nas rotas de sync)
O número da loja está na tabela `filiais_bloqueadas` do schema. Para desbloquear:

```sql
DELETE FROM empresa_kr.filiais_bloqueadas WHERE id_filial_bloqueada = <numero_loja>;
```

### Ícone da bandeja não aparece
O ícone da bandeja só é exibido quando o cliente roda como `client.exe` (modo empacotado). Em `npm run client` o ícone não é carregado.
