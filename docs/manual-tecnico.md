# Manual Técnico — Sincronizador Matriz/Filiais

**Sistema:** ProjetoSincronizadorNode  
**Banco de dados:** Servidor (Matriz) — **PostgreSQL** via `pg`; Cliente (Filial) — **Firebird** via `node-firebird`  
**Arquitetura:** Servidor REST (Matriz) + Cliente long-running (Filial)  
**Origem:** Reescrita em Node.js do sistema Delphi/DataSnap original

---

## 1. Visão Geral

O sincronizador mantém dados consistentes entre o banco central (**Matriz** — PostgreSQL) e bancos locais instalados em cada filial (**Filial / PDV** — Firebird). A comunicação é HTTP — a filial sempre inicia as chamadas (pull e push); o servidor nunca empurra proativamente.

```
┌──────────────────────┐          HTTP          ┌──────────────────────┐
│   FILIAL (Cliente)   │  ──── pull ──────────► │  MATRIZ (Servidor)   │
│  node src/client/    │  ◄─── dados ────────── │  node src/server.js  │
│  index.js            │  ──── push ──────────► │  src/routes/         │
│  porta 3001 (WebUI)  │                        │  porta conforme .env │
└──────────────────────┘                        └──────────────────────┘
     Firebird (.fdb)                               PostgreSQL
```

**Ciclo:** a cada 30 segundos a filial executa Pull → Push para cada tabela ativa.

---

## 2. Configuração e Inicialização

### 2.1 Arquivos de configuração obrigatórios

**`.env`** (servidor — ao lado de `package.json`):
```
SYNC_TOKEN=token-secreto-aqui
DATABASE_URL=postgresql://postgres:senha@localhost:5432/matriz
PORT=8080
```
O token deve ser idêntico no servidor e no cliente. Toda requisição HTTP inclui `?token=<SYNC_TOKEN>`. `DATABASE_URL` é usado apenas pelo servidor. Ver `.env.example`.

**`sirius-client.ini`** (filial — mesmo diretório):
```
localhost/3050:C:\FDBS\FILIAL.FDB
3
```
- Linha 1: `host/porta_firebird:caminho_do_banco`
- Linha 2: versão do Firebird (`2` = senha `masterkey`, `3` = senha `Soft1973824650`)

> **Nota:** `sirius.ini` ainda é referenciado no README, mas o servidor atual usa `.env` + PostgreSQL. Ignorar `sirius.ini` para configuração do servidor.

### 2.2 Parâmetros lidos do banco da filial

O cliente lê da tabela `PARAMETROS` (pré-existente no banco Firebird da filial):

| ID_PARAMETRO | Significado |
|---|---|
| `60024` | URL base do servidor (ex.: `http://192.168.1.1:8080`) |
| `50003` | Número identificador desta filial/loja (`idLoja`) |
| `50004` | Número do PDV (`idPDV`) — opcional; `null` se ausente |

### 2.3 Startup da filial

```bash
npm run client   # ou npm run client:dev para auto-reload
```

1. Lê `sirius-client.ini` e conecta ao Firebird local
2. Lê `PARAMETROS` para obter `baseURI`, `idLoja` e `idPDV`
3. Chama `setup()` — cria tabelas e triggers de infraestrutura (idempotente)
4. Inicia a WebUI em `http://localhost:3001`
5. Executa o primeiro ciclo imediatamente
6. Agenda ciclos a cada 30 segundos

### 2.4 Startup do servidor

```bash
npm start   # ou npm run dev para auto-reload
```

1. Lê `.env` (`DATABASE_URL`, `PORT`, `SYNC_TOKEN`)
2. Chama `db-init.js` — cria `seq_atualizacao_matriz`, `FILIAIS_BLOQUEADAS` e `REGISTROS_DELETADOS` no PostgreSQL se não existirem
3. Sobe o Express nas rotas `/datasnap/rest/TSM*`
4. Aceita chamadas de qualquer filial com token válido

---

## 3. Infraestrutura de Sync (tabelas criadas pelo setup)

O `setup.js` cria as seguintes estruturas no banco da **filial** (Firebird) na primeira inicialização. Todas as criações são idempotentes.

### 3.1 `SYNC_ALTERACOES_PENDENTES`

Registra cada INSERT ou UPDATE local que ainda não foi enviado ao servidor.

```sql
CREATE TABLE SYNC_ALTERACOES_PENDENTES (
  NOME_TABELA         VARCHAR(50)  NOT NULL,
  PK_VALOR            VARCHAR(250) NOT NULL,  -- ex.: "42" ou "CATEGORIA|42" (PK composta)
  TIMESTAMP_ALTERACAO TIMESTAMP    DEFAULT CURRENT_TIMESTAMP NOT NULL,
  PRIMARY KEY (NOME_TABELA, PK_VALOR)
)
```

Populada por **triggers** (ver §3.4). Consumida e limpa pelo módulo `push.js`.

### 3.2 `SYNC_VERSOES_SERVIDOR`

Registra a última versão recebida do servidor para cada registro. Usada para detectar conflito no momento do push.

```sql
CREATE TABLE SYNC_VERSOES_SERVIDOR (
  NOME_TABELA                  VARCHAR(50)  NOT NULL,
  PK_VALOR                     VARCHAR(250) NOT NULL,
  ID_ULTIMA_ATUALIZACAO_MATRIZ INTEGER      NOT NULL,
  PRIMARY KEY (NOME_TABELA, PK_VALOR)
)
```

Atualizada pelo `sync.js` após cada UPSERT bem-sucedido na filial.

### 3.3 `SYNC_ERROS`

Log de erros do ciclo de sincronização (máx. 200 registros; os mais antigos são descartados).

```sql
CREATE TABLE SYNC_ERROS (
  ID        VARCHAR(40)   NOT NULL PRIMARY KEY,
  TABELA    VARCHAR(50),
  OPERACAO  VARCHAR(20),
  MENSAGEM  VARCHAR(2000) NOT NULL,
  CRIADO_EM TIMESTAMP     DEFAULT CURRENT_TIMESTAMP NOT NULL
)
```

### 3.4 Triggers `SYNC_<TABELA>`

Criados em cada tabela sincronizada. Detectam alterações locais e enfileiram na `SYNC_ALTERACOES_PENDENTES`.

```sql
CREATE TRIGGER SYNC_PRODUTOS AFTER INSERT OR UPDATE ON PRODUTOS
AS BEGIN
  IF (RDB$GET_CONTEXT('USER_SESSION', 'SYNC_SKIP') IS NULL) THEN
    UPDATE OR INSERT INTO SYNC_ALTERACOES_PENDENTES
      (NOME_TABELA, PK_VALOR, TIMESTAMP_ALTERACAO)
    VALUES
      ('PRODUTOS', CAST(NEW.ID_PRODUTO AS VARCHAR(100)), CURRENT_TIMESTAMP)
    MATCHING (NOME_TABELA, PK_VALOR);
END
```

**Supressão de trigger durante o pull:** antes de cada lote de UPSERTs recebidos do servidor, o `sync.js` executa:
```sql
EXECUTE BLOCK AS BEGIN
  RDB$SET_CONTEXT('USER_SESSION', 'SYNC_SKIP', '1');
END
```
Isso impede que dados vindos do servidor sejam re-enfileirados para push. O contexto é **session-scoped** — deve ser resetado para `NULL` após o lote para não suprimir operações subsequentes em conexões reutilizadas.

### 3.5 Tabela pré-existente: `ULTIMOS_REGISTROS_MATRIZ`

Cursor de sincronização por tabela. **Não criada pelo setup** — deve existir previamente no banco da filial.

```
ULTIMOS_REGISTROS_MATRIZ (
  ID_ULTIMO_REGISTRO_MATRIZ  INTEGER  PK
  NOME_TABELA                VARCHAR(50)
  ULTIMO_REGISTRO_ATUALIZADO INTEGER   -- cursor de updates
  ULTIMO_REGISTRO_DELETADO   INTEGER   -- cursor de deleções
)
```

---

## 4. Fluxo Pull — Servidor → Filial

**Arquivo:** `src/client/sync.js` → função `sincronizarTabela()`

```
Para cada tabela ativa:
  1. Lê cursor atual (ULTIMOS_REGISTROS_MATRIZ)
  2. GET /RegistrosParaAtualizar?nomeTabela=X&idUltimaAtualizacaoMatriz=cursor
  3. Para cada registro retornado:
     a. Há pendente local (SYNC_ALTERACOES_PENDENTES)?
        → SIM e nunca veio do servidor (sem entrada em SYNC_VERSOES_SERVIDOR):
          PK COLLISION — renomeia PK local (MAX+1 numérico / val_1 string)
          com cascade de FKs filhas → aplica registro do servidor
          → sincronizarGenerator(db, generator, novoPK)
        → SIM e já veio antes (entrada em SYNC_VERSOES_SERVIDOR existe):
          CONFLICT — salva em conflitos.json, pula o UPSERT
        → NÃO:
          UPSERT normal (UPDATE OR INSERT MATCHING PK)
          Atualiza SYNC_VERSOES_SERVIDOR
          → sincronizarGenerator(db, generator, registro[pk])
  4. Salva cursor atualizado
  5. Se retornou 50 registros → busca próximo lote (paginação automática)
  6. Busca deletados → DELETE local para cada entrada em REGISTROS_DELETADOS
```

### 4.1 Renomeação de PK com cascade FK

Quando há colisão de PK (registro local com mesmo ID nunca veio do servidor), o sistema precisa renomear o PK local para liberar o ID para o servidor. Como o Firebird valida FK por instrução (não por commit), o processo é:

1. `INSERT INTO tabela (...) SELECT ... FROM tabela WHERE pk = antigo` (cria cópia com novo PK)
2. `UPDATE tabela_filha SET fk = novo WHERE fk = antigo` (atualiza filhos)
3. `DELETE FROM tabela WHERE pk = antigo` (remove original)

FKs filhas são descobertas automaticamente via `RDB$RELATION_CONSTRAINTS / RDB$REF_CONSTRAINTS / RDB$INDEX_SEGMENTS` — sem hardcoding.

Implementado em `renomearPKLocal()` em `sync.js`.

### 4.2 Sincronização de Generators Firebird

Após cada upsert (normal ou pós-colisão), `sincronizarGenerator()` é chamada:

```js
async function sincronizarGenerator(db, nomeGenerator, novoValor) {
  // Avança o generator apenas se estiver atrás do ID recebido
  const atual = GEN_ID(nomeGenerator, 0);
  if (atual < novoValor) SET GENERATOR nomeGenerator TO novoValor;
}
```

Isso garante que o próximo `GEN_ID(nome, 1)` do Delphi retorne um ID maior que qualquer ID já atribuído pelo servidor, prevenindo colisões futuras. O nome do generator por tabela é declarado no campo `generator` em `tabelas.js`.

### 4.3 Colunas nunca gravadas na filial (`COLUNAS_SEMPRE_IGNORADAS`)

```
ID_ULTIMA_ATUALIZACAO_MATRIZ   -- controle interno da matriz
ID_ULTIMA_ATUALIZACAO_WEB      -- controle de outros sistemas
ID_ULTIMA_ATT_IFOOD            -- gerado por trigger/generator local (divergiria)
DATA_INCLUSAO_SIRIUS           -- metadata local
DATA_ALTERACAO_SIRIUS          -- metadata local
ULTIMA_ALTERACAO               -- metadata local
DATA_PRECO_VENDA               -- gerenciado por trigger local
DATA_ULTIMA_ATUAL_IMP_ENTRADA  -- gerenciado por trigger local
DATA_PRECO_CUSTO               -- gerenciado por trigger local
```

**Colunas COMPUTED BY** (Firebird read-only): consultadas via `RDB$RELATION_FIELDS JOIN RDB$FIELDS` e cacheadas por tabela — nunca incluídas no UPSERT.

---

## 5. Fluxo Push — Filial → Servidor

**Arquivo:** `src/client/push.js` → função `empurrarTabela()`

```
Para cada tabela ativa:
  1. Lê SYNC_ALTERACOES_PENDENTES WHERE NOME_TABELA = tabela
  2. Para cada pendente:
     a. Busca registro completo no banco local
     b. Se não encontrar (foi deletado localmente): remove dos pendentes, não envia
     c. Lê versão conhecida em SYNC_VERSOES_SERVIDOR
     d. POST /ReceberRegistro { tabela, pk, registro, ultimaVersaoConhecida }
        → 200 { ok: true }:       remove dos pendentes
        → 200 { conflito: true }: remove dos pendentes + salva conflito em conflitos.json
        → erro de rede:           mantém nos pendentes (tentará no próximo ciclo)
```

### 5.1 Detecção de conflito no servidor

O servidor (`sincronizacao.js`) compara a versão enviada pelo cliente com o `ID_ULTIMA_ATUALIZACAO_MATRIZ` atual do registro:

```
versaoServidor > ultimaVersaoConhecida → conflito
                                        → retorna { conflito: true, versaoServidor: {...} }
```

Para forçar a aplicação (resolução "manter local"), o cliente envia `forcar: true`.

### 5.2 Colunas nunca sobrescritas pelo servidor ao receber push (`COLUNAS_IGNORADAS_SERVIDOR`)

```
ID_ULTIMA_ATUALIZACAO_MATRIZ   -- autoincrement interno (sequência PostgreSQL)
ID_ULTIMA_ATUALIZACAO_WEB      -- outro sistema
```

Esta lista é intencionalmente menor que `COLUNAS_SEMPRE_IGNORADAS` do cliente.

O servidor também filtra colunas que não existem no schema PostgreSQL via `information_schema.columns` antes do UPSERT, prevenindo erros quando a filial tem colunas extras.

---

## 6. Tabelas Sincronizadas

38 tabelas em 9 grupos, ordenadas por dependência FK:

| Grupo | Tabelas |
|---|---|
| **Auxiliares** | UNIDADES, AUX_CLASSIFICACOES_FISCAIS, AUX_CODIFICACAO_GRUPOS, AUX_ESPECIES_EMBALAGENS, AUX_GENERICA, AUX_PAISES_BACEN, AUX_PARCELAS_PAGAMENTOS, AUX_SITUACOES_TRIBUTARIAS, AUX_SUB_GRUPOS, AUX_MOEDAS |
| **Cadastros** | CENTROS_DE_CUSTO, CLASSIFICACOES, CODIGOS_REGIMES_TRIBUTARIOS, CONTAS, DEPARTAMENTOS, LISTA_PRECOS, TIPOS_PRODUTOS |
| **Produtos** | PRODUTOS ¹, PRODUTOS_GRADES, PRODUTOS_X_LISTA |
| **Clientes** | CLIENTES, CLIENTES_X_ENTREGA, ENDERECOS_DE_RETIRADA |
| **Fornecedores** | FORNECEDORES, FORN_CONTATOS_ADICIONAIS, FORMAS_DE_PAGAMENTOS_SISPAG |
| **Transportadores** | TRANSPORTADORES, TRANSP_CONTATOS_ADICIONAIS, TRANSPORTADORES_PLACAS |
| **Vendedores** | VENDEDORES, REPRESENTANTES, SUPERVISORES |
| **Pedidos** | PEDIDOS ², PEDIDOS_ITENS, PEDIDOS_PARCELAS_PAGAMENTOS |
| **Kits** | KITS_PRODUTOS, KITS_ITENS_PROD, KITS_ITENS_SUB_PROD |

¹ PRODUTOS usa endpoint customizado `TSMProdutos/ProdutosParaAtualizar` que substitui `PRECO_VENDA` pelo preço específico da filial (tabela `PRODUTOS_PRECOS_LOJAS`).

² PEDIDOS usa `filtroFilial: 'ID_LOJA'` — o servidor adiciona `AND ID_LOJA = idLoja` para restringir o pull aos pedidos da loja local.

### 6.1 PKs compostas

`pk` pode ser array: `pk: ['SUB_TABELA', 'ID_SUB_TABELA']` ou `pk: ['ID_PEDIDO', 'PARCELA']`. Nas tabelas de rastreamento, o valor é concatenado com `|`: `CATEGORIA|42`. Apenas o **último** campo do array é incrementado/renomeado em colisões.

---

## 7. Rotas do Servidor

Base: `/datasnap/rest/{Classe}/{Metodo}?token=<SYNC_TOKEN>`

### 7.1 TSMSincronizacao (`src/routes/sincronizacao.js`)

| Método | Rota | Descrição |
|---|---|---|
| GET | `/RegistrosParaAtualizar` | Retorna até 50 registros alterados desde `idUltimaAtualizacaoMatriz` |
| GET | `/RegistrosParaDeletar` | Retorna até 10 registros deletados desde `idUltimoRegistroDeletado` |
| GET | `/StatusTabelas` | Contagem e max-ID de cada tabela (painel de status) |
| GET | `/RegistrosPaginados` | Registros paginados para auditoria lado-a-lado |
| POST | `/ReceberRegistro` | Recebe alteração da filial; detecta conflito |

### 7.2 TSMProdutos (`src/routes/produtos.js`)

| Método | Rota | Descrição |
|---|---|---|
| GET | `/ProdutosParaAtualizar` | Produtos com substituição de preço por filial (`PRODUTOS_PRECOS_LOJAS`) |
| GET | `/getCountProdutosParaSincronizar` | Contagem de produtos pendentes |
| GET | `/getProdutosSincronizadosByFilial` | Apenas CODIGOs (verificação leve) |

### 7.3 TSMPedidos (`src/routes/pedidos.js`)

| Método | Rota | Descrição |
|---|---|---|
| GET | `/getPedidos` | Pedidos por filial, status e intervalo de datas |
| GET | `/getPedidosSincronizadosByFilial` | Apenas IDs (verificação leve) |
| POST | `/updatePedido` | Atualiza STATUS e DATA_DO_PEDIDO (INSERT não implementado) |

### 7.4 TSMMovimetacaoCaixas (`src/routes/movimentacaoCaixas.js`)

| Método | Rota | Descrição |
|---|---|---|
| POST | `/updateMovimentacaoCaixa` | Insere movimentação em `MOV_CAIXA` (idempotente) |

### 7.5 TSMDistribuicaoDeMercadorias (`src/routes/distribuicao.js`)

| Método | Rota | Descrição |
|---|---|---|
| GET | `/ListarDistribuicaoDeMercadorias` | Lista paginada (30/página) com filtro de status |
| GET | `/ListarDistribuicaoDeMercadoriasPorID` | Registro único |
| GET | `/QuantidadeDeRegistros` | Contagem por status |
| POST | `/acceptAlterarStatus` | Atualiza status da distribuição |

---

## 8. Interface Web da Filial (WebUI)

Acessível em `http://localhost:3001`. Iniciada por `webui.js`. Templates EJS em `src/client/views/`, assets em `src/client/public/`.

| Rota | Descrição |
|---|---|
| `/` | Resolução de conflitos — diff campo-a-campo, opções "manter local" / "manter servidor" / "mesclar" |
| `/status` | Status de sync por tabela: total no servidor, total local, cursor, pendentes |
| `/auditoria` | Comparação paginada (200/página) registro-a-registro entre servidor e filial |
| `/configuracoes` | Habilitar/desabilitar tabelas por nome ou grupo (persiste em `tabelas-config.json`) |
| `/erros` | Log de erros do ciclo; badge em tempo real via SSE |
| `/eventos` | Stream SSE — emite eventos `novo-erro` e `novo-conflito` |
| `/api/conflitos/count` | JSON `{ total: N }` para badge de navegação |
| `/api/erros/count` | JSON `{ total: N }` para badge de navegação |

### 8.1 Resolução de conflitos via WebUI

1. O conflito aparece em `/` com as duas versões lado-a-lado
2. O usuário escolhe campo-a-campo ou em bloco:
   - **Manter local** → `forcar: true` no próximo push
   - **Manter servidor** → aplica versão do servidor localmente
3. Após resolução, o conflito é removido de `conflitos.json`

---

## 9. Arquivos de Estado em Runtime

Ficam no diretório de trabalho (`cwd`, ao lado de `package.json`):

| Arquivo | Conteúdo | Limite |
|---|---|---|
| `conflitos.json` | Conflitos pendentes de resolução. Escrita atômica (`.tmp` → rename) | Sem limite |
| `erros.json` | Últimos 200 erros de sync | 200 registros |
| `tabelas-config.json` | Estado enable/disable por tabela | Sem limite |

---

## 10. Como Adicionar uma Nova Tabela ao Sync

1. Adicione entrada em `src/client/tabelas.js` respeitando a ordem FK:
   ```js
   {
     nome: 'NOVA_TABELA',
     pk: 'ID_NOVA_TABELA',
     temDelete: true,
     filtroFilial: null,        // ou 'ID_LOJA' para tabelas com dados por filial
     grupo: 'GrupoExistente',
     generator: 'NOVO_NOME',    // nome do generator Firebird; null se a filial nunca cria registros
   }
   ```
2. Adicione o nome da tabela ao Set `TABELAS_PERMITIDAS` em `src/routes/sincronizacao.js`
3. Garanta que a tabela no PostgreSQL (servidor) tenha coluna `ID_ULTIMA_ATUALIZACAO_MATRIZ INTEGER` e trigger que a incrementa via `nextval('seq_atualizacao_matriz')` em INSERT/UPDATE
4. Reinicie servidor e cliente — `setup.js` cria o trigger Firebird automaticamente na próxima inicialização

---

## 11. Como Habilitar/Desabilitar uma Tabela em Runtime

Acesse `http://localhost:3001/configuracoes`. O toggle persiste em `tabelas-config.json`. A função `tabelaAtiva(nome)` em `src/client/tabelasConfig.js` re-lê o arquivo a cada ciclo — sem necessidade de reiniciar.

---

## 12. Convenções de Código

### 12.1 Firebird (cliente — `src/client/db.js`)
- **Nomes de coluna:** sempre em UPPERCASE — `node-firebird` retorna colunas em maiúsculas
- **Conexões:** sempre libere com `try/finally → closeConnection(db)`. Use o helper `withConnection(fn)`
- **Scripts multi-statement:** use `EXECUTE BLOCK AS BEGIN ... END` (não `SET TERM`)
- **Generators:** `GEN_ID(nome, 0)` para ler sem avançar; `SET GENERATOR nome TO valor` para definir diretamente

### 12.2 PostgreSQL (servidor — `src/db.js`)
- **Parâmetros posicionais:** `$1, $2, ...`
- **Nomes de coluna:** normalizados para UPPERCASE pelo `src/db.js` após cada query
- **Upsert:** `INSERT ... ON CONFLICT (pk) DO UPDATE SET col = EXCLUDED.col`
- **Colunas geradas:** `information_schema.columns WHERE is_generated = 'ALWAYS'` — nunca incluídas em UPSERT

### 12.3 Timestamps
Firebird não armazena fuso horário. O servidor retorna objetos `Date` (UTC) via `pg`; o cliente retorna objetos `Date` em horário local via `node-firebird`. Use `toNaiveDateTime()` em `webui.js` para comparar — extrai apenas `YYYY-MM-DDTHH:MM:SS`, evitando falsos positivos por UTC-3 (Brasília).

---

## 13. Fluxo de Distribuição de Mercadorias

> Contexto: entradas são registradas no central e gerentes de loja confirmam o recebimento.

```
CENTRAL
  1. Registra entrada (NF-e de compra) → DISTRIBUICAO_MERCADORIAS
  2. Atribui itens a lojas → DISTRIB_MERCADORIAS_LOJAS (status inicial)

FILIAL (via pull automático)
  3. Recebe registros de distribuição atribuídos à sua loja
  4. Gerente acessa WebUI → vê distribuições pendentes

FILIAL → CENTRAL (via push)
  5. Gerente confirma recebimento → POST /acceptAlterarStatus
  6. Status atualizado no central
```

**Tabelas envolvidas:**
- `DISTRIBUICAO_MERCADORIAS` — cabeçalho da distribuição (`ID_DISTRIBUICAO_MERCADORIA`)
- `DISTRIB_MERCADORIAS_LOJAS` — atribuição por loja (`ID_DISTRIB_MERCADORIAS_LOJAS`, `ID_LOJA`, `STATUS`)

---

## 14. Bloqueio de Filial

O servidor verifica `FILIAIS_BLOQUEADAS` antes de responder. A coluna `ID_FILIAL_BLOQUEADA` armazena diretamente o número da filial (não um ID separado). Retorna HTTP 401 se bloqueada.

Aplicado nas rotas: `pedidos.js`, `movimentacaoCaixas.js`, `distribuicao.js`.

---

## 15. Limitações Conhecidas do Sistema Atual

| Área | Limitação |
|---|---|
| Estoque | Nenhuma tabela de saldo/movimentação de estoque é sincronizada |
| Pedidos | INSERT de pedido via push não implementado (somente UPDATE de status) |
| PDV | `idPDV` é repassado ao servidor mas sem lógica de negócio por PDV implementada (fase 2) |
| Multi-CNPJ | Sync não trafega CNPJ — cada banco é 1 empresa |
| Cancelamentos | Sem fluxo de cancelamento de NF-e/NFC-e |
| Caixa | Apenas INSERT de movimentação — sem update, estorno ou reconciliação |
| Distribuição | Sem rastreamento por item — somente cabeçalho e status |

Para roadmap de evolução deste sistema, consulte o plano KR de Oliveira.
