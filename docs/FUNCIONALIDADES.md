# Funcionalidades do ProjetoSincronizadorNode

Documento de referência descrevendo todas as funcionalidades implementadas no sistema de sincronização de banco de dados entre servidor central (matriz — **PostgreSQL**) e clientes (filiais — **Firebird**).

---

## 1. Infraestrutura de Sincronização

### 1.1 Wizard de Configuração Inicial (`setup-wizard.js`)
- Executado **automaticamente** na primeira inicialização quando `.env` não existe
- Solicita via terminal: `SYNC_TOKEN`, URL do servidor, caminho do banco Firebird, senha e demais credenciais
- Cria `src/client/.env` (ou `.env` ao lado do `client.exe`) com os dados informados
- Grava a URL do servidor em `PARAMETROS(60024)` no Firebird via `UPDATE OR INSERT`
- Suporta Ctrl+V para colar no Windows (via `powershell Get-Clipboard`)
- Para reconfigurar: apague o `.env` e reinicie o cliente

### 1.2 Setup Automático da Filial (`setup.js`)
- Cria as tabelas de infraestrutura na filial de forma **idempotente** (seguro executar múltiplas vezes):
  - `SYNC_ALTERACOES_PENDENTES` — fila de mudanças locais aguardando envio ao servidor
  - `SYNC_VERSOES_SERVIDOR` — rastreia a última versão recebida do servidor por registro (usada na detecção de conflitos)
  - `SYNC_ERROS` — log persistente de erros de sincronização (máx. 200 registros)
- Cria automaticamente um **trigger de captura** em cada tabela configurada (`tabelas.js`), nomeado `SYNC_{TABELA}`
  - O trigger escreve em `SYNC_ALTERACOES_PENDENTES` em todo INSERT ou UPDATE
  - O trigger é suprimido durante o pull via `RDB$GET_CONTEXT('USER_SESSION', 'SYNC_SKIP')` para evitar auto-enfileiramento de registros recebidos do servidor

### 1.3 Cursor de Sincronização (`cursor.js`)
- Mantém a tabela `ULTIMOS_REGISTROS_MATRIZ` na filial
- Armazena o último `ID_ULTIMA_ATUALIZACAO_MATRIZ` processado por tabela (cursor de atualização)
- Armazena o último `ID_REGISTRO_DELETADO` processado por tabela (cursor de deleção)
- Persistência garantida em Firebird (não depende de arquivos externos)

---

## 2. Sincronização Pull (Servidor → Filial)

### 2.1 Busca de Registros Atualizados
- Endpoint servidor: `GET /RegistrosParaAtualizar`
- Busca até **50 registros por lote**, ordenados por `ID_ULTIMA_ATUALIZACAO_MATRIZ`
- Suporte a filtro por loja via `filtroFilial` (ex.: `AND ID_LOJA = ?` injetado dinamicamente)
- Parâmetro `idPDV` repassado ao servidor (suporte a multi-PDV, fase 2)
- Continua paginando até não haver mais registros no lote

### 2.2 Busca de Registros Deletados
- Endpoint servidor: `GET /RegistrosParaDeletar`
- Busca até **10 deleções por lote** da tabela `REGISTROS_DELETADOS`
- Aplica `DELETE` localmente para cada registro removido no servidor
- Ativo apenas em tabelas com `temDelete: true` em `tabelas.js`

### 2.3 Sincronização Especial de Produtos
- Endpoint servidor: `GET /ProdutosParaAtualizar` (rota TSMProdutos)
- Busca até **10 produtos por lote**
- Sobrescreve `PRECO_VENDA` com o preço específico da filial consultado em `PRODUTOS_PRECOS_LOJAS`
- Ativado nas tabelas com `endpoint` customizado em `tabelas.js`

### 2.5 Echo Registry — Supressão de Re-pull de Registros Recém-Enviados
- Após cada push bem-sucedido, o servidor retorna o `ID_ULTIMA_ATUALIZACAO_MATRIZ` que foi atribuído ao registro pelo trigger PostgreSQL
- O cliente armazena esse valor como echo em memória (`src/client/echos.js`), associado a `(tabela, pkValor, idServidor)`
- Durante o pull seguinte, se um registro recebido corresponder a um echo registrado, o cliente avança o cursor e atualiza `SYNC_VERSOES_SERVIDOR` **sem re-aplicar o upsert** no Firebird
- Evita uma escrita desnecessária no banco local por registro por ciclo, sem risco para pushes concorrentes de outras filiais (que não terão o echo)

### 2.6 Supressão de Triggers durante Pull
- Antes de cada lote de upserts, executa:
  ```sql
  EXECUTE BLOCK AS BEGIN RDB$SET_CONTEXT('USER_SESSION', 'SYNC_SKIP', '1'); END
  ```
- Impede que os triggers de captura re-enfilerem os registros recebidos do servidor como mudanças locais pendentes
- O contexto é **session-scoped** — deve ser resetado para `NULL` após o lote para não suprimir operações subsequentes em conexões reutilizadas

### 2.5 Sincronização de Generators Firebird
- Após cada upsert bem-sucedido de um registro do servidor, `sincronizarGenerator()` é chamada com o ID recebido
- Verifica o valor atual do generator via `GEN_ID(nome, 0)` e avança com `SET GENERATOR nome TO valor` **somente se** o generator estiver atrás do ID recebido (operação não-destrutiva)
- Garante que o próximo `GEN_ID(nome, 1)` do Delphi retorne um ID maior que qualquer ID já atribuído pelo servidor, prevenindo colisões futuras
- O nome do generator por tabela é declarado no campo `generator` em `tabelas.js`; tabelas onde a filial nunca cria registros localmente têm `generator: null`

---

## 3. Sincronização Push (Filial → Servidor)

### 3.1 Envio de Alterações Locais
- Lê `SYNC_ALTERACOES_PENDENTES` para cada tabela ativa
- Para cada registro pendente:
  - Busca o dado completo localmente
  - Se o registro **não existe mais no Firebird** (foi deletado localmente): envia `{ deletar: true }` ao servidor (ver §3.4)
  - Se existe: envia via `POST /ReceberRegistro` com `ultimaVersaoConhecida` (de `SYNC_VERSOES_SERVIDOR`) para detecção de conflito
  - Resposta com sucesso inclui `idAtualizacaoMatriz` — registrado como echo para o pull (ver §2.5)
- Remove da fila após envio bem-sucedido ou após envio de deleção

### 3.2 Detecção de Conflito no Servidor
- O servidor retorna `{ conflito: true, versaoServidor: {...} }` quando a versão no servidor é mais nova que `ultimaVersaoConhecida`
- O cliente registra o conflito via `atualizarOuSalvarConflito()` e remove o registro da fila de pendentes (evita re-envios em loop)

### 3.4 Propagação de Deleção Local
- Quando um registro está em `SYNC_ALTERACOES_PENDENTES` mas não é encontrado no banco Firebird local (deletado após ter sido enfileirado), o push envia `{ deletar: true }` ao servidor
- O servidor executa `DELETE` na linha correspondente e insere em `REGISTROS_DELETADOS`, propagando a deleção para as demais filiais no próximo pull
- Garante consistência bidirecional: deleções locais são refletidas no servidor e nas demais filiais

### 3.5 Forçar Envio (Resolução de Conflito)
- Push com `forcar: true` bypassa a verificação de versão no servidor
- Usado pela Web UI quando o usuário escolhe "manter versão local" na resolução de conflito

---

## 4. Detecção e Resolução de Conflitos

### 4.1 Colisão de PK (PK Collision)
- Ocorre quando: registro criado localmente na filial tem o mesmo PK que um registro recebido do servidor (nunca sincronizado antes)
- Ação: renomeia o PK local para `MAX+1` (numérico) ou `valor_1` (string) e aplica o registro do servidor com o PK original
- Suporte a **cascade FK**: usa INSERT-cópia → UPDATE filhos → DELETE original (Firebird valida FK por statement, não por commit)
- Após renomear, `sincronizarGenerator()` é chamada com o novo PK para manter o generator à frente
- Apenas o último campo do PK composto é renomeado em PKs compostos

### 4.2 Conflito de Conteúdo (Content Conflict)
- Ocorre quando: mesmo registro foi editado localmente e também modificado no servidor desde a última sincronização
- Ação: salva em `conflitos.json`, avança o cursor, não aplica o dado do servidor
- Notifica a Web UI em tempo real via SSE

### 4.3 Web UI de Resolução de Conflitos (`http://localhost:3001`)
- Lista todos os conflitos pendentes (`resolvido: false`)
- Exibe comparação lado a lado: versão local vs. versão do servidor
- Opções de resolução:
  - **Manter versão local**: força push ao servidor com `forcar: true`
  - **Manter versão do servidor**: aplica o dado do servidor localmente
  - **Mesclar campos**: resolução campo a campo (interface granular)
- Deduplica conflitos por `(tabela, pkValor)` — re-conflito no mesmo registro atualiza o existente

---

## 5. Endpoints REST do Servidor

Todos os endpoints requerem `?token=<SYNC_TOKEN>`. URL base: `/datasnap/rest/`.

### 5.1 TSMSincronizacao (`routes/sincronizacao.js`)

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| GET | `/RegistrosParaAtualizar` | Pull de registros alterados (50/lote, cursor-based) |
| GET | `/RegistrosParaDeletar` | Pull de registros deletados (10/lote) |
| POST | `/ReceberRegistro` | Recebe push da filial; detecta e reporta conflitos |
| GET | `/StatusTabelas` | Retorna `total` e `maxId` para todas as tabelas permitidas (auditoria) |
| GET | `/RegistrosPaginados` | Lista paginada de registros de uma tabela (máx. 500/página) para auditoria |

### 5.2 TSMProdutos (`routes/produtos.js`)

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| GET | `/ProdutosParaAtualizar` | Pull de produtos com preço sobrescrito por filial (10/lote) |
| GET | `/getCountProdutosParaSincronizar` | Contagem de produtos a sincronizar |
| GET | `/getProdutosSincronizadosByFilial` | Lista de códigos de produtos já sincronizados |

### 5.3 TSMPedidos (`routes/pedidos.js`)

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| GET | `/getPedidos` | Lista pedidos por loja, com filtros de status e data |
| GET | `/getPedidosSincronizadosByFilial` | Lista IDs de pedidos sincronizados |
| POST | `/updatePedido` | Atualiza status, data e loja de um pedido existente |

### 5.4 TSMMovimetacaoCaixas (`routes/movimentacaoCaixas.js`)

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| POST | `/updateMovimentacaoCaixa` | Insere movimentação de caixa de forma idempotente (não duplica por ID_MOV_CAIXA) |

### 5.5 TSMDistribuicaoDeMercadorias (`routes/distribuicao.js`)

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| GET | `/ListarDistribuicaoDeMercadorias` | Lista paginada com JOIN (máx. 30/página) |
| GET | `/ListarDistribuicaoDeMercadoriasPorID` | Busca registro único com JOIN |
| GET | `/QuantidadeDeRegistros` | Contagem total com JOIN |
| POST | `/acceptAlterarStatus` | Atualiza status de distribuição |

### 5.6 API Web Frontend (`/api/`) (`routes/tabelas.js`)

Rotas para a interface **SiriusWebFrontend**. Requerem `Authorization: Bearer <jwt>` (mesmo JWT do `/auth/login`). O schema da empresa é parte do path.

**CRUD genérico de tabelas:**

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| GET | `/api/:schema/tabelas/:tabela/colunas` | Introspecção de colunas (nome, tipo, is_generated) |
| GET | `/api/:schema/tabelas/:tabela/next-pk` | Próximo valor de PK disponível (`?pk=COLUNA`) |
| GET | `/api/:schema/tabelas/:tabela/by-pk` | Registro único por PK (`?pk=COL&value=VAL`) |
| GET | `/api/:schema/tabelas/:tabela` | Listagem paginada com busca textual e filtro de status |
| POST | `/api/:schema/tabelas/:tabela` | Upsert — body `{ pk, registro }`; suporta PK composta (array); incrementa `seq_atualizacao_matriz` automaticamente; captura estado anterior (`dados_antes`) para audit log |
| DELETE | `/api/:schema/tabelas/:tabela` | Deleção por PK — body `{ pk, pkValores }`; captura snapshot do registro antes de apagar para audit log |

**Audit log:**

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| GET | `/api/:schema/audit-log` | Log de auditoria paginado (`pageSize` máx. 100, padrão 50); filtros: `tabela`, `operacao` (INSERT/UPDATE/DELETE), `dataInicio`, `dataFim`; requer role `gerente` ou `dono`; gerentes veem apenas registros cuja `ID_LOJA` corresponde à sua loja; retorna `registros` + `total` |

Cada entrada do audit log inclui:
- `dados` — conteúdo enviado pelo formulário (campos alterados; `null` em DELETE)
- `dados_antes` — snapshot completo do registro **antes** da operação (capturado via `SELECT *` antes do upsert/delete; `null` em INSERT e em registros criados antes da migração `dados_antes`)
- `email` do usuário, `tabela`, `operacao`, `pk_valor`, `ip_cliente`, `criado_em`

O frontend SiriusWebFrontend exibe no modal "Ver dados":
- **INSERT** — tabela campo → valor inserido
- **DELETE** — tabela campo → valor excluído (em vermelho)
- **UPDATE** — comparação antes × depois, realçando em azul apenas os campos realmente alterados (falsos positivos eliminados: só campos presentes em `dados` são comparados, evitando campos fora do formulário aparecerem como alterados)

**Gestão de usuários:**

| Método | Endpoint | Role mínimo | Descrição |
|--------|----------|-------------|-----------|
| GET | `/api/:schema/usuarios` | gerente | Lista usuários; dono vê todos os schemas, gerente vê apenas sua loja |
| POST | `/api/:schema/usuarios` | gerente | Cria usuário e vincula ao schema (`nome`, `email`, `senha`, `role`, `id_loja`, `id_vendedor`) |
| PATCH | `/api/:schema/usuarios/:id/ativo` | gerente | Ativa/desativa usuário |
| PATCH | `/api/:schema/usuarios/:id/perfil` | gerente | Edita nome, email ou senha |
| PATCH | `/api/:schema/usuarios/:id/role` | dono | Altera role e loja do usuário |
| GET | `/api/:schema/vendedores-disponiveis` | gerente | Lista vendedores da tabela VENDEDORES do tenant para popular selects |

**Endpoints de pedidos:**

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| GET | `/api/:schema/pedidos-lista` | Lista simplificada com `VALOR_TOTAL` calculado; suporta `?q=`, `?status=`, `?dataInicio=`, `?dataFim=`, filtro por vendedor e faixa de valor |
| GET | `/api/:schema/pedidos-completo` | JOIN flat PEDIDOS + PEDIDOS_ITENS + PRODUTOS + PEDIDOS_PARCELAS_PAGAMENTOS; colunas ausentes ignoradas silenciosamente |
| GET | `/api/:schema/pedidos/:id/itens` | Itens com JOIN em PRODUTOS (resolve descrição, unidade, valor total do item) |
| GET | `/api/:schema/pedidos/:id/pagamentos` | Parcelas de pagamento (`PEDIDOS_PARCELAS_PAGAMENTOS`) |

**Endpoints de dashboard:**

| Método | Endpoint | Role mínimo | Descrição |
|--------|----------|-------------|-----------|
| GET | `/api/:schema/dashboard` | vendedor | Totais do dia: clientes ativos, pedidos hoje, faturamento hoje, produtos ativos |
| GET | `/api/:schema/dashboard/faturamento-por-loja` | gerente | Faturamento e contagem de pedidos por loja; filtros de data e período |
| GET | `/api/:schema/dashboard/evolucao-mensal` | gerente | Faturamento e contagem mensal; suporta filtro por mês exato ou intervalo |
| GET | `/api/:schema/dashboard/evolucao-mensal-por-loja` | dono | Evolução mensal por loja (série histórica multi-loja) |
| GET | `/api/:schema/dashboard/top-produtos` | gerente | Top 10 produtos por faturamento e quantidade vendida |
| GET | `/api/:schema/dashboard/pedidos-por-status` | gerente | Contagem de pedidos agrupada por status |
| GET | `/api/:schema/dashboard/faturamento-por-vendedor` | gerente | Top 10 vendedores por faturamento |

**Outros:**

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| GET | `/api/:schema/filiais` | Lista filiais registradas em `sync_filiais` (`id`, `nome`) |
| GET | `/api/:schema/admin/sync-config` | Lê configurações de sync do schema (role: dono) |
| PUT | `/api/:schema/admin/sync-config` | Atualiza configuração de sync — chave `filtro_filial_clientes` (role: dono) |

---

## 6. Web UI da Filial (`http://localhost:3001`)

Interface Express + EJS acessível em tempo real durante a execução do cliente.

### 6.1 Páginas

| Rota | Descrição |
|------|-----------|
| `/` | Dashboard de conflitos pendentes |
| `/status` | Status do ciclo de sincronização atual |
| `/auditoria` | Comparação paginada de registros entre matriz e filial |
| `/configuracoes` | Ativar/desabilitar tabelas individualmente sem reiniciar |
| `/erros` | Log dos últimos 200 erros de sincronização |

### 6.2 API JSON

| Rota | Descrição |
|------|-----------|
| `/api/conflitos/count` | Número de conflitos não resolvidos |
| `/api/erros/count` | Número de erros registrados |
| `/eventos` | SSE — stream de eventos `novo-conflito` e `novo-erro` em tempo real |

### 6.3 Auditoria de Registros
- Compara registros paginados entre matriz (via servidor) e filial (local)
- Destaca colunas divergentes
- Normaliza timestamps via `toNaiveDateTime()` para evitar falsos positivos por fuso horário (UTC vs. UTC-3)
- Colunas de metadados são ocultadas via `COLUNAS_IGNORADAS_AUDITORIA`

### 6.4 Configuração de Tabelas em Runtime
- Página `/configuracoes` lista todas as tabelas agrupadas por `grupo`
- Toggle on/off persiste em `tabelas-config.json` (cwd)
- `tabelaAtiva()` relê o arquivo a cada ciclo de 30s — sem necessidade de reiniciar

---

## 7. Modo em Segundo Plano e Bandeja do Sistema (`client.exe`)

### 7.1 Modo Background
- Iniciado explicitamente com `client.exe --background` (mecanismo primário — funciona tanto em desenvolvimento quanto em produção empacotada)
- Quando empacotado (`client.exe`) e o usuário fecha a janela do CMD, o processo captura `SIGHUP` e se relança automaticamente com `SINCRONIZADOR_BG=1` e `windowsHide: true` (mecanismo secundário, apenas no executável)
- Em ambos os casos: todos os logs (`console.log` / `console.error`) passam a ser gravados em `client.log` (máx. 5 MB; truncado ao exceder)
- O processo continua rodando sem janela visível

### 7.2 Ícone na Bandeja do Sistema (`tray.js`)
- Disponível apenas quando empacotado como `client.exe` (usa `systray2`)
- Ícone visível no canto inferior direito do Windows o tempo todo
- Menu de contexto com quatro itens:

| Item | Comportamento |
|------|---------------|
| **Abrir Console** | Abre `cmd.exe` exibindo `client.log` em tempo real (`Get-Content -Wait -Tail 100`) |
| **Abrir Web UI** | Abre `http://localhost:3001` no navegador padrão |
| **Iniciar com o Windows** | Toggle com checkmark: grava/remove entrada no registro `HKCU\...\Run` com `client.exe --background` para inicialização automática no boot |
| **Parar cliente** | Encerra o processo Node.js completamente |

### 7.3 Inicialização Automática com o Windows
- Ativada via item **Iniciar com o Windows** no menu da bandeja
- Grava `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\SincronizadorCliente = "<caminho>\client.exe --background"`
- O checkmark no menu reflete o estado atual consultando o registro a cada abertura do tray
- Para desativar: clicar no mesmo item remove a chave do registro

---

## 8. Autenticação e Segurança

### 8.1 Token de Sincronização
- Todos os endpoints do servidor requerem `?token=<SYNC_TOKEN>`
- Token lido de `.env` via `dotenv`; deve ser idêntico no servidor e no cliente
- Falha retorna HTTP 400 com `{ erro: 'token inválido!' }`

### 8.2 Bloqueio de Filial
- Middleware `filialBloqueada.js` verifica `FILIAIS_BLOQUEADAS` antes de processar qualquer requisição
- `ID_FILIAL_BLOQUEADA` armazena o número da filial diretamente (sem coluna separada de ID_LOJA)
- Filial bloqueada retorna HTTP 401 (sem corpo)
- Cliente detecta 401 e lança erro descritivo, interrompendo o ciclo de sync para aquela filial

### 8.3 Validação de Nome de Tabela
- `TABELAS_PERMITIDAS` Set em `sincronizacao.js` — rejeita qualquer tabela não listada
- `filtroFilial` validado via regex `/^[A-Za-z_][A-Za-z0-9_]*$/` — previne SQL injection no nome de coluna

---

## 9. Rastreamento de Erros

### 9.1 Log Persistente (`erros.js` + `SYNC_ERROS`)
- `salvarErro({ tabela, operacao, mensagem })` — grava na tabela Firebird `SYNC_ERROS`
- Máximo de **200 registros**; ao atingir o limite, o mais antigo é deletado automaticamente
- Escrita assíncrona via `setImmediate` (não bloqueia o ciclo de sync)
- `EventEmitter` emite `'novo-erro'` para push imediato via SSE aos clientes Web UI conectados

### 9.2 Erros por Tabela vs. por Ciclo
- Erros por registro individual são capturados e logados sem interromper as demais tabelas
- Erros de conectividade (bloqueio de filial, timeout) interrompem o ciclo inteiro

---

## 10. Configuração Multi-PDV / Sync Seletivo

### 10.1 idPDV
- Lido de `PARAMETROS(50004)` a cada ciclo; `null` se ausente
- Repassado como `&idPDV=X` em todas as chamadas HTTP ao servidor
- Servidor recebe e parseia o parâmetro; lógica de negócio específica por PDV ainda não implementada (fase 2)

### 10.2 filtroFilial
- Campo por entrada em `tabelas.js` (padrão `null`)
- Quando definido (ex.: `'ID_LOJA'`), adiciona `AND <coluna> = idLoja` na query do servidor
- Restringe o pull a registros pertencentes à loja local — útil para tabelas com dados por filial

---

## 11. Gestão de Conexões

### 11.1 Servidor (PostgreSQL — `src/db.js`)
- Usa `pg.Pool`; API pública: `withConnection(fn)`, `query(client, sql, params)`, `execute(client, sql, params)`
- Parâmetros posicionais `$1, $2, ...` (estilo PostgreSQL)
- Resultados normalizados para **UPPERCASE** por `pg.Pool`
- Colunas computadas detectadas via `information_schema.columns WHERE is_generated = 'ALWAYS'` — nunca incluídas em UPSERT
- Upsert via `INSERT ... ON CONFLICT (pk) DO UPDATE SET col = EXCLUDED.col`

### 11.2 Cliente (Firebird — `src/client/db.js`)
- Usa `node-firebird`; **não expõe `withConnection`** — conexões gerenciadas manualmente com `try/finally → closeConnection(db)`
- Nomes de colunas retornados em **UPPERCASE** pelo node-firebird — manter todas as referências em maiúsculas
- Colunas computadas (`COMPUTED BY`) detectadas via `RDB$RELATION_FIELDS JOIN RDB$FIELDS` e cacheadas por tabela
- Upsert via `UPDATE OR INSERT ... MATCHING (pk_columns)` — sintaxe nativa Firebird
- Multi-statement via `EXECUTE BLOCK AS BEGIN ... END` (não usa `SET TERM`)
- FKs descobertas automaticamente via `RDB$RELATION_CONSTRAINTS / RDB$REF_CONSTRAINTS / RDB$INDEX_SEGMENTS`

---

## 12. Tabelas Sincronizadas (Grupos)

Tabelas em `tabelas.js`, organizadas na ordem abaixo (respeita dependências de FK). A **ordem importa**.

| Grupo | Tabelas |
|-------|---------|
| Auxiliares | `UNIDADES`, `AUX_CLASSIFICACOES_FISCAIS`, `AUX_CODIFICACAO_GRUPOS`, `AUX_ESPECIES_EMBALAGENS`, `AUX_GENERICA`, `AUX_PAISES_BACEN`, `AUX_PARCELAS_PAGAMENTOS`, `FORMAS_DE_PAGAMENTOS`, `AUX_SITUACOES_TRIBUTARIAS`, `AUX_SUB_GRUPOS`, `AUX_MOEDAS` |
| Cadastros | `CENTROS_DE_CUSTO`, `CLASSIFICACOES`, `CODIGOS_REGIMES_TRIBUTARIOS`, `CONTAS`, `DEPARTAMENTOS`, `LISTA_PRECOS`, `TIPOS_PRODUTOS` |
| Produtos | `PRODUTOS`, `PRODUTOS_GRADES`, `PRODUTOS_X_LISTA` |
| Clientes | `CLIENTES`, `CLIENTES_X_ENTREGA`, `ENDERECOS_DE_RETIRADA` |
| Fornecedores | `FORNECEDORES`, `FORN_CONTATOS_ADICIONAIS`, `FORMAS_DE_PAGAMENTOS_SISPAG` |
| Transportadores | `TRANSPORTADORES`, `TRANSP_CONTATOS_ADICIONAIS`, `TRANSPORTADORES_PLACAS` |
| Vendedores | `VENDEDORES`, `REPRESENTANTES`, `SUPERVISORES` |
| Pedidos | `PEDIDOS`, `PEDIDOS_ITENS`, `PEDIDOS_PARCELAS_PAGAMENTOS` |
| Kits | `KITS_PRODUTOS`, `KITS_ITENS_PROD`, `KITS_ITENS_SUB_PROD` |

PKs compostas suportadas: ex. `AUX_GENERICA` usa `['SUB_TABELA', 'ID_SUB_TABELA']` e `PEDIDOS_PARCELAS_PAGAMENTOS` usa `['ID_PEDIDO', 'PARCELA']` — armazenadas concatenadas com `|` nas tabelas de rastreamento (ex.: `CATEGORIA|42`).

Generators Firebird declarados no campo `generator` de cada entrada: tabelas onde a filial nunca cria registros localmente têm `generator: null`. Exemplos: `PRODUTOS → NOVO_PRODUTO`, `CLIENTES → NOVO_CLIENTE`, `PEDIDOS → NOVO_PEDIDO`.
