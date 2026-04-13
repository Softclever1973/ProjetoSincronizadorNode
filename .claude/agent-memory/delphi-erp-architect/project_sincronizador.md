---
name: ProjetoSincronizador - Análise do Client Delphi
description: Mapeamento completo do SincronizadorDS Client: módulos, endpoints, lógica de negócio, parâmetros e funcionalidades especiais relevantes para comparação com a migração Node.js
type: project
---

# ProjetoSincronizador - Client SincronizadorDS

Projeto Delphi 10 Seattle localizado em `c:\Projetos\ProjetoSincronizador\Client\SincronizadorDS\`.
Sistema de sincronização filial → matriz via REST/DataSnap (Firebird).

**Why:** O projeto está sendo migrado para Node.js e precisamos identificar o que pode ter ficado para trás.

**How to apply:** Usar este mapeamento como checklist de cobertura ao revisar a implementação Node.js.

## Parâmetros de Configuração Críticos
- **50003** — Número da loja (filial). Obrigatório. Validado no startup.
- **60024** — URL base do servidor (matriz). Obrigatório. Validado no startup.

## Padrão de Sincronização Central
A tabela `ULTIMOS_REGISTROS_MATRIZ` controla o watermark incremental por tabela.
- `ULTIMO_REGISTRO_ATUALIZADO` — maior ID de atualização já processado (campo `idUltimaAtualizacaoMatriz`)
- `ULTIMO_REGISTRO_DELETADO` — maior ID de deleção já processado
- Usa `UPDATE OR INSERT ... MATCHING(NOME_TABELA)` (upsert Firebird nativo)
- Atualizado registro a registro dentro do loop de sincronização

## Módulos Mapeados

### classSincronizacao — Motor Genérico de Sincronização
3 variantes de insert/update + 1 delete, todos genéricos via Generics do Delphi:
- **AtualizarInserirRegistros<T>** — chave primária simples, busca por `TRIM(PK) LIKE valor`
- **AtualizarInserirRegistros2<T>** — duas chaves primárias (ex: AUX_GENERICA com SUB_TABELA+ID_SUB_TABELA)
- **AttInsRegistrosEspecial<T>** — busca por campo não-PK (ex: CODIGO do produto); suporta `canCheckIsOnlyKey` para detectar chave duplicada
- **DeletarRegistros<T>** — lê lista de IDs deletados do servidor, exclui em lote via IN (...)

Todos fazem `CorrigeGeneratorPeloMax` após insert quando `generator != ''`.
Todos tratam FK violations: consultam `RDB$` para identificar a tabela pai e produzem mensagem amigável.

### classRequisicoes — Orquestrador de Ciclo Completo
Singleton (`getInstance`). Método principal: `ExecutePackage`.
Flags de configuração controlam quais grupos são executados (salvas em JSON via TConfiguracoes):

**Grupo 1 — Pedidos** (`FRequisicaoPedidos`): envia fila PEDIDOS_SINCRONIZADOR_RDW → POST /TSMPedidos/Pedido
**Grupo 2 — Saldos + Distribuição** (`FRequisicaoProdutosSaldos`): envia PRODUTOS_SINCRONIZADOR_RDW em lotes de 50 + recebe distribuições confirmadas
**Grupo 3 — MovCaixa** (`FRequisicaoMovCaixa`): sincroniza AUX_MOEDAS (ambas direções) + envia MOVCAIXA_SINCRONIZADOR_RDW
**Grupo 4 — Produtos** (`FRequisicaoProdutos`): 10+ tabelas auxiliares + PRODUTOS + grades + listas
**Grupo 5 — Produtos 4Market** (`FRequisicaoProd4Market`): SYNC_4M_PRODUTOS, SYNC_4M_PROD_CANAIS, SYNC_4M_PROD_IMGS, SYNC_4M_PROMOCOES
**Grupo 6 — Clientes** (`FRequisicaoClientes`): CLIENTES + 10 tabelas auxiliares de cliente
**Grupo 7 — Fornecedores** (`FRequisicaoFornecedores`): FORNECEDORES + DEPARTAMENTOS + FORMAS_PAGTO + contatos
**Grupo 8 — Vendedores** (`FRequisicaoVendedores`): VENDEDORES + REPRESENTANTES + SUPERVISORES
**Grupo 9 — Transportadores** (`FRequisicaoTransportadores`): TRANSPORTADORES + contatos + placas
**Grupo 10 — Kits** (`FRequisicaoKitsProd`): KITS_PRODUTOS + KITS_ITENS_PROD + KITS_ITENS_SUB_PROD

**Web (URL/Token separados):**
- `FRequisicaoRecuperarPedidosWeb` — busca pedidos de plataforma web e insere no Sirius
- `FRequisicaoEnviarProdutosParaWeb` — envia produtos para plataforma web
- `FRequisicaoEnviarClientesParaWeb` — envia clientes para plataforma web
- `FRequisicaoEnviarVendedoresParaWeb` — envia vendedores para plataforma web
- `FRequisicaoEnviarListaPrecosParaWeb` — envia listas de preços + produtos × listas
- `FRequisicaoEnviarPedidosWeb` — envia pedidos para plataforma web
- `FRequisicaoEnviarTranspWeb` — envia transportadores para plataforma web
- `FRequisicaoNotificacoes` — notificações do Mercado Livre (`TNotificacoesMLSync.GetNotificacoes`)

**Particularidades (FConfiPartic):**
- `FProdutosPorCodigoInt` — produtos buscados por CODIGO interno, não por ID; ativa `AttInsRegistrosEspecial`; desabilita delete e sincronização de ProdutosGrades/ProdutosXLista
- `FProdIgnorarPrecoVenda`
- `FProdTrocarCSTCFOP`
- `FProdIgnorarEAN13`
- `FProdIgnorarPrecoCusto`

**Restrições de horário:** `FSincronizaNoIntervalo` + `FHorarioInicio`/`FHorarioFinal` — sincroniza somente dentro da janela configurada.

### classPedidos — Envio de Pedidos
- Processa um pedido por chamada (FIRST 1 da fila PEDIDOS_SINCRONIZADOR_RDW ORDER BY ID_PEDIDO ASC)
- Carrega: pedido + cliente + itens (PEDIDOS_ITENS) + parcelas (PEDIDOS_PARCELAS_PAGAMENTOS se `sincronizarPPP`)
- Se `sincronizarCodProd`: valida que todos os itens têm CODIGO preenchido
- POST `/datasnap/rest/TSMPedidos/Pedido?token=&sincronizarCliente=`
- Erro AND02042025A é tratado como não-crítico (pedido pulado, não exceção)
- Deleta o registro da fila após envio bem-sucedido
- `getPedidosNoServidor`: GET com filtro status='R', idLoja, dataInicio, dataFinal — retorna array de IDs

### classProdutos — Consultas de Produtos no Servidor
- `getProdutosNoServidor`: GET `/TSMProdutos/getProdutosSincronizadosByFilial?idLoja=&situacao=A` — retorna array de CODIGOs
- `getCountProdutosRestantes`: GET `/TSMProdutos/getCountProdutosParaSincronizar?idLoja=&idUltAtt=` — retorna total pendente para exibição no log

### classMovCaixas — Envio de Movimentação de Caixa
- Processa um registro por chamada (FIRST 1 de MOVCAIXA_SINCRONIZADOR_RDW)
- Carrega: movimentação + saldos (MOV_CAIXA_SALDOS) + moeda de cada saldo (AUX_MOEDAS por SIGLA_MOEDA)
- Injeta `idLoja` no objeto antes de enviar
- POST `/datasnap/rest/TSMMovimetacaoCaixas/MovimentacaoCaixa?token=`
- Deleta da fila após envio

### classSaldosProdutos — Envio de Saldos de Produtos
- Processa em lote: FIRST 50 de PRODUTOS_SINCRONIZADOR_RDW ORDER BY ID_PRODUTOS_SIN_RDW
- Se `hasToUseCodigoInterno`: enriquece cada registro com CODIGO do produto antes de enviar
- POST `/datasnap/rest/TSMProdutosSaldosWeb/ProdutoSaldoWeb?token=`
- Deleta os 50 registros dentro de transação após envio bem-sucedido
- Usa transação explícita (StartTransaction → Commit)

### classDistribuicao — Recebimento de Distribuição de Mercadorias
- GET `/TSMDistribuicaoDeMercadorias/ListarDistribuicaoDeMercadorias?idLoja=&status=Confirmado`
- Para cada item: localiza produto (por ID ou CODIGO conforme `hasToUseCodigoInterno`)
- Chama `TMovimentacoes.GerarMovimentacao(idProduto, quantidade, connection, True)` — gera movimentação local
- PUT `/TSMDistribuicaoDeMercadorias/AlterarStatus` com status='Recebida'
- Produto não encontrado → exceção crítica (interrompe)

### classForeignKey — Diagnóstico de FK Violations
- Consulta `RDB$RELATION_CONSTRAINTS` + `RDB$REF_CONSTRAINTS` + `RDB$INDEX_SEGMENTS`
- Retorna lista de (FIELD_NAME, REFERENCE_TABLE, FK_FIELD) para a tabela informada
- Usado pelos módulos de sincronização para produzir mensagem amigável em `ekFKViolated`

### ClassServicosBanco — Utilitários de Banco
- `getParam(id, conn)` — lê tabela PARAMETROS
- `CorrigeGeneratorPeloMax` — reajusta sequence Firebird após insert externo
- `GeneratorIncrementado` — `GEN_ID(nome, 1)` — obtém próximo valor
- `LerIni` — lê SIRIUS.INI (servidor:banco + versão FB); suporta FB2 (masterkey) e FB3 (Soft1973824650)
- `CriarConnection` — cria TFDConnection direta (usado em testes/correções manuais)
- DDL helpers: CriarTabelaSePrecisar, CriarCampoSePrecisar, CriarGeneratorSePrecisar, DropConstraint, DeletarChaveEstrangeiraSePrecisar, CriarTriggerSePrecisar, etc.

### ClassMigrations — Migrações de Schema
`RodarNovasTabelasECampos`: cria tabelas de controle do sincronizador (filas RDW, ULTIMOS_REGISTROS_MATRIZ, etc.)
`AjustarTabelas`: para cada tabela de negócio, cria a tabela se não existir OU adiciona campos faltantes campo a campo (idempotente).
- Tabelas cobertas incluem: AUX_CLASSIFICACOES_FISCAIS (40+ campos), AUX_CODIFICACAO_GRUPOS, AUX_ESPECIES_EMBALAGENS, AUX_GENERICA, AUX_MOEDAS, AUX_PAISES_BACEN, AUX_PARCELAS_PAGAMENTOS, e muitas outras
- `CriarTriggerDelecao` / `CriarTriggerAtualizacao` — cria triggers BEFORE DELETE/UPDATE que alimentam tabelas de log para rastreamento de deleções
- `CorrigePedidosVinculados` — correção pontual de pedidos com ID_PEDIDO_LOJA = 0
- `CriarIndexSePrecisar` — cria índice se não existir

### ClassUltimosRegistrosMatriz — Controle de Watermark
- `GetUltimaAtualizacaoMatriz(tabela)` → retorna ULTIMO_REGISTRO_ATUALIZADO (0 se não existe)
- `GetUltimaDelecaoMatriz(tabela)` → retorna ULTIMO_REGISTRO_DELETADO
- `CriarUltimoRegistroMatriz` → UPDATE OR INSERT MATCHING(NOME_TABELA); atualiza apenas o campo informado (delecao OU atualizacao, não ambos ao mesmo tempo)
- Faz commit imediato após cada atualização do watermark

### classParametros — Validação de Startup
- Valida apenas 50003 e 60024
- Lança exceção se vazio → `untPrincipal.FormCreate` chama `Application.Terminate`

### untPrincipal — View Principal (Windows Service-like)
- Roda como TrayIcon (minimizado na bandeja)
- Timer (`tmTempoProximaRequisicao`) dispara `ExecutePackage` em background via `TTask.Run`
- Intervalos: configurável (opções de radio group)
- Janela de horário: sincroniza apenas entre `FHorarioInicio` e `FHorarioFinal`
- `FormCreate` executa migrations + valida parâmetros antes de liberar timer
- Senha supervisor digitada no form: "IMPACT" (case-insensitive) desbloqueia aba Configurações/Parâmetros
- Log em TMemo (máx 1000 linhas) + TListView de processos (máx 25 grupos)
- Notificações: Windows Notification Center OU BalloonHint (configurável); acumula 3 antes de exibir
- **Correções manuais disponíveis no menu:**
  - Forçar re-sincronização de CLIENTES/PRODUTOS/PEDIDOS/LISTAS_PRECO (UPDATE SET campo = campo para ativar triggers)
  - Zerar watermark de CLIENTES (reset ULTIMO_REGISTRO_ATUALIZADO = 0)
  - Deletar PRODUTOS_X_LISTA com referências inválidas
  - Desvincular CLIENTES com TABELA_PRECO inválida
  - Recuperar pedidos do servidor por intervalo de datas
- Aba `tsProdutosCST` — edição manual de CST/CFOP por produto (grid DBGrid com DBNavigator)
- Configurações salvas em JSON via TConfiguracoes

## Endpoints Completos Identificados

### Recebimento da Matriz (GET/PUT via TSMSincronizacao genérico)
- `GET /datasnap/rest/TSMSincronizacao/RegistrosParaAtualizar?&idUltimaAtualizacaoMatriz=&nomeTabela=&token=`
- `GET /datasnap/rest/TSMSincronizacao/RegistrosParaDeletar?&idUltimoRegistroDeletado=&nomeTabela=&token=`

### Produtos
- `GET /datasnap/rest/TSMProdutos/ProdutosParaAtualizar?idLoja=&idUltimaAtualizacaoMatriz=&nomeTabela=&token=`
- `GET /datasnap/rest/TSMProdutos/getProdutosSincronizadosByFilial?idLoja=&situacao=A&token=`
- `GET /datasnap/rest/TSMProdutos/getCountProdutosParaSincronizar?idLoja=&idUltAtt=&token=`

### Pedidos
- `POST /datasnap/rest/TSMPedidos/Pedido?token=&sincronizarCliente=`
- `GET /datasnap/rest/TSMPedidos/getPedidosSincronizadosByFilial?idLoja=&status=R&minDataCriacao=&maxDataCriacao=&token=`

### Mov Caixa
- `POST /datasnap/rest/TSMMovimetacaoCaixas/MovimentacaoCaixa?token=`

### Saldos de Produtos
- `POST /datasnap/rest/TSMProdutosSaldosWeb/ProdutoSaldoWeb?token=`

### Distribuição
- `GET /datasnap/rest/TSMDistribuicaoDeMercadorias/ListarDistribuicaoDeMercadorias?idLoja=&status=Confirmado&token=`
- `PUT /datasnap/rest/TSMDistribuicaoDeMercadorias/AlterarStatus?token=`
