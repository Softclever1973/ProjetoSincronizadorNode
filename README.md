# Sincronizador Firebird — Matriz/Filiais

Sistema de sincronização bidirecional de banco de dados Firebird entre uma matriz central e múltiplas filiais. Reescrita em Node.js de uma aplicação Delphi/DataSnap original.

---

## Visão Geral

```
┌─────────────┐        HTTP/REST        ┌──────────────────┐
│   MATRIZ    │ ◄────────────────────── │    FILIAL(IS)    │
│  (Servidor) │ ──────────────────────► │    (Cliente)     │
│  porta 8080 │                         │  webui: 3001     │
└─────────────┘                         └──────────────────┘
   Firebird MATRIZ.FDB                   Firebird FILIAL.FDB
```

- **Servidor (Matriz):** expõe o banco da matriz via REST. Deve rodar na máquina central.
- **Cliente (Filial):** processo contínuo que sincroniza com o servidor a cada 30 segundos e disponibiliza uma interface web local em `http://localhost:3001`.

---

## Pré-requisitos

- Node.js 18+
- Firebird 2.5 ou 3.0 acessível via rede (ou local)
- Bancos `.fdb` já existentes (o sincronizador não cria o schema)

---

## Instalação

```bash
git clone <repositório>
cd ProjetoSincronizadorNode
npm install
```

---

## Configuração

Crie os arquivos `.ini` na raiz do projeto (junto ao `package.json`). Eles **não são versionados** (estão no `.gitignore`).

### Servidor — `sirius.ini`

```
localhost/3050:C:\FDBS\MATRIZ.FDB
3
8080
```

| Linha | Conteúdo |
|-------|----------|
| 1 | `host/portaFirebird:caminho_do_banco` |
| 2 | Versão do Firebird (`2` ou `3`) |
| 3 | Porta HTTP do servidor Express |

> **Senha Firebird:** versão 2 usa `masterkey`, versão 3 usa `Soft1973824650`.

### Cliente — `sirius-client.ini`

Mesmo formato, sem a linha 3 (porta HTTP não se aplica ao cliente):

```
localhost/3050:C:\FDBS\FILIAL.FDB
3
```

---

## Executando

### Servidor (Matriz)

```bash
# Produção
npm start

# Desenvolvimento (auto-reload)
npm run dev
```

### Cliente (Filial)

```bash
# Produção
npm run client

# Desenvolvimento (auto-reload)
npm run client:dev
```

> Os dois processos são **independentes** e devem ser iniciados separadamente — normalmente o servidor na máquina da matriz e o cliente em cada filial.

---

## Interface Web do Cliente

Após iniciar o cliente, acesse `http://localhost:3001` no navegador da filial.

### Conflitos (`/`)

Exibe registros onde a filial e a matriz divergem e precisam de decisão manual.

Cada conflito mostra:
- Tabela e chave primária do registro
- Quantos campos estão diferentes
- Tabela de campos divergentes com os valores de cada lado

**Opções de resolução por conflito:**

| Botão | Ação |
|-------|------|
| Manter versão local | Envia o valor da filial ao servidor (força sobrescrita) |
| Manter versão do servidor | Aplica o valor do servidor no banco local |
| Aplicar seleção campo a campo | Para cada campo divergente, você escolhe qual versão manter usando os radio buttons da tabela |

> Clique no cabeçalho do card para expandir/recolher os detalhes. As seções **Identificação** e **Outros campos** ficam colapsadas por padrão; só os campos divergentes ficam abertos.

---

### Status (`/status`)

Tabela com o estado de sincronização de cada tabela configurada:

- **Total matriz / Total local** — comparação de volume
- **Cursor local** — último ID recebido da matriz
- **Pendentes envio** — registros locais ainda não enviados ao servidor
- **Status** — `OK` (sincronizado) | `Pendente` | `N/D` (tabela inacessível)

---

### Auditoria (`/auditoria`)

Comparação registro a registro entre matriz e filial para uma tabela escolhida.

1. Selecione a tabela no seletor
2. Clique em **Comparar**
3. Linhas em vermelho indicam divergência (passe o mouse para ver o valor do servidor)
4. Use **Aplicar Matriz em Tudo** para sobrescrever todos os registros da página com os valores do servidor
5. Use **Resolver um por um** para enviar os divergentes para a fila de conflitos

> A auditoria pagina de 200 em 200 registros. Use os botões de navegação no rodapé.

---

### Configurações (`/configuracoes`)

Ativa ou desativa tabelas individualmente sem reiniciar o processo.

- Use os toggles por tabela ou os botões **Ativar Todas / Desativar Todas** por grupo
- Tabelas desativadas são ignoradas no próximo ciclo de 30 segundos
- O estado persiste em `tabelas-config.json` na raiz do projeto

---

## Tabelas Sincronizadas

As tabelas são sincronizadas na ordem abaixo (respeita dependências de FK):

| Grupo | Tabelas |
|-------|---------|
| Auxiliares | UNIDADES, AUX_CLASSIFICACOES_FISCAIS, AUX_CODIFICACAO_GRUPOS, AUX_ESPECIES_EMBALAGENS, AUX_GENERICA, AUX_PAISES_BACEN, AUX_PARCELAS_PAGAMENTOS, AUX_SITUACOES_TRIBUTARIAS, AUX_SUB_GRUPOS, AUX_MOEDAS |
| Cadastros | CENTROS_DE_CUSTO, CLASSIFICACOES, CODIGOS_REGIMES_TRIBUTARIOS, CONTAS, DEPARTAMENTOS, LISTA_PRECOS, TIPOS_PRODUTOS |
| Produtos | PRODUTOS, PRODUTOS_GRADES, PRODUTOS_X_LISTA |
| Clientes | CLIENTES, CLIENTES_X_ENTREGA, ENDERECOS_DE_RETIRADA |
| Fornecedores | FORNECEDORES, FORN_CONTATOS_ADICIONAIS, FORMAS_DE_PAGAMENTOS_SISPAG |
| Transportadores | TRANSPORTADORES, TRANSP_CONTATOS_ADICIONAIS, TRANSPORTADORES_PLACAS |
| Vendedores | VENDEDORES, REPRESENTANTES, SUPERVISORES |
| Kits | KITS_PRODUTOS, KITS_ITENS_PROD, KITS_ITENS_SUB_PROD |

---

## Como Funciona a Sincronização

### Pull (Matriz → Filial)

A cada ciclo, o cliente busca registros novos/alterados da matriz (baseado em cursor por tabela). Antes de gravar localmente, verifica:

- **Colisão de PK:** registro local com mesmo ID nunca veio do servidor → renomeia a PK local (incrementa ou adiciona sufixo `_1`) e aplica o registro do servidor.
- **Conflito de conteúdo:** registro já recebido do servidor, mas filial o alterou → salva em `conflitos.json` para resolução manual.
- **Normal:** nenhuma das situações acima → aplica o `UPDATE OR INSERT` diretamente.

### Push (Filial → Matriz)

Registros alterados localmente ficam na tabela `SYNC_ALTERACOES_PENDENTES` (criada automaticamente). O cliente envia cada um ao servidor, que retorna conflito se sua versão for mais nova.

---

## Adicionando uma Nova Tabela

1. Adicione a entrada em [src/client/tabelas.js](src/client/tabelas.js) respeitando a ordem de FKs:
   ```js
   { nome: 'NOME_TABELA', pk: 'ID_CAMPO', temDelete: true, grupo: 'GrupoExistente' }
   ```
2. Adicione o nome à constante `TABELAS_PERMITIDAS` em [src/routes/sincronizacao.js](src/routes/sincronizacao.js).
3. Reinicie servidor e cliente — os triggers de rastreamento são criados automaticamente pelo `setup.js`.

---

## Arquivos Gerados em Runtime

Estes arquivos são criados automaticamente e estão no `.gitignore`:

| Arquivo | Descrição |
|---------|-----------|
| `conflitos.json` | Fila de conflitos pendentes de resolução |
| `tabelas-config.json` | Estado ativo/inativo de cada tabela (configurações) |
| `sirius.ini` | Configuração do servidor |
| `sirius-client.ini` | Configuração do cliente |

---

## Estrutura do Projeto

```
src/
├── server.js              # Entry point do servidor
├── config.js              # Leitura do sirius.ini
├── db.js                  # Conexão Firebird (servidor)
├── middleware/
│   ├── auth.js            # Validação do token
│   └── filialBloqueada.js # Verificação de filiais bloqueadas
└── routes/
    ├── sincronizacao.js   # Pull, push, auditoria
    ├── produtos.js        # Produtos com preços por loja
    ├── pedidos.js         # Pedidos
    ├── movimentacaoCaixas.js
    └── distribuicao.js

src/client/
├── index.js               # Loop principal (30s)
├── tabelas.js             # Lista de tabelas configuradas
├── tabelasConfig.js       # Ativa/desativa tabelas em runtime
├── sync.js                # Lógica de pull
├── push.js                # Lógica de push
├── http.js                # Chamadas HTTP ao servidor
├── db.js                  # Conexão Firebird (cliente)
├── cursor.js              # Controle de cursor por tabela
├── setup.js               # Cria infra de sync no banco local
├── conflitos.js           # Persistência de conflitos
└── webui.js               # Interface web (porta 3001)
```
