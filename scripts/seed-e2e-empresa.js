/**
 * Provisiona o schema `empresa_e2e` usado pelos testes Playwright do SiriusWebFrontend
 * (ver SiriusWebFrontend/e2e/). Roda no MESMO Postgres de desenvolvimento do .env — não é
 * um banco isolado. Separado de `empresa_teste` (usado pelos testes Jest de integração,
 * ver tests/helpers/testSchema.js) para os dois conjuntos de testes poderem rodar sem
 * interferir um no outro.
 *
 * As tabelas de negócio aqui NÃO são o schema sincronizado do Firebird de verdade — são só
 * o subconjunto mínimo de colunas que o fluxo "Novo Pedido" do frontend (js/pedidos.js) lê
 * e grava, levantado lendo o código real (rotas + handleSave + validarRegistro).
 *
 * Uso: node scripts/seed-e2e-empresa.js
 * Idempotente — pode rodar quantas vezes for preciso (upserts + truncate das tabelas
 * transacionais de pedido a cada execução, para os testes partirem de um estado limpo).
 */

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool, withTenantConnection, query, execute } = require('../src/server/infrastructure/db');
const { initializeTenantSchema } = require('../src/server/infrastructure/db-init');

const SCHEMA   = 'empresa_e2e';
const TOKEN    = 'TOKEN_E2E_EMPRESA_E2E';
const EMAIL    = 'e2e.gerente@teste.com';
const SENHA    = 'senha123456';
const ID_LOJA  = 1;

// SALDO_ATUAL baixo de propósito — usado pelo teste de bloqueio de saldo negativo
// (venda_saldo_negativo = 'N' é o default de sync_config, ver src/db-init.js).
const PRODUTO_SALDO_BAIXO = { ID_PRODUTO: 2, SRV_ID: 2, CODIGO: 'PROD002', DESCRICAO: 'Produto Saldo Baixo E2E', UNIDADE: 'UN', PRECO_VENDA: 5, SALDO_ATUAL: 2 };
const PRODUTO_PADRAO      = { ID_PRODUTO: 1, SRV_ID: 1, CODIGO: 'PROD001', DESCRICAO: 'Produto Teste E2E',      UNIDADE: 'UN', PRECO_VENDA: 25.5, SALDO_ATUAL: 1000 };

const DDL_TABELAS_NEGOCIO = [
  `CREATE TABLE IF NOT EXISTS PEDIDOS (
    ID_PEDIDO INTEGER PRIMARY KEY,
    ID_CLIENTE INTEGER,
    NOME_CLIENTE TEXT,
    ID_VENDEDOR INTEGER,
    NOME_VENDEDOR TEXT,
    DATA_DO_PEDIDO DATE,
    HORA_DO_PEDIDO TEXT,
    TIPO_OPERACAO TEXT,
    DATA_DE_EMISSAO DATE,
    DATA_DE_EMISSAO_NF DATE,
    USUARIO TEXT,
    USUARIO_NOME TEXT,
    AUTORIZADO_POR TEXT,
    DATA_REALIZACAO DATE,
    STATUS TEXT,
    ID_LOJA INTEGER,
    ID_AUX_PARCELA_PAGAMENTO INTEGER,
    PERCENTUAL_DESCONTO NUMERIC(15,2),
    VALOR_FRETE NUMERIC(15,2),
    MODALIDADE_FRETE VARCHAR(1),
    FRETE_EMITENTE_DESTINATARIO VARCHAR(1),
    OUTRAS_DESPESAS NUMERIC(15,2),
    OBS TEXT,
    ENDERECO_ESCOLHIDO VARCHAR(16),
    ENDERECO_ENTREGA_JSON TEXT,
    DATA_FOI_CADASTRADO TIMESTAMP,
    DATA_ULTIMA_ATUALIZACAO TIMESTAMP,
    ID_ULTIMA_ATUALIZACAO_MATRIZ INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS PEDIDOS_ITENS (
    ID_PEDIDO_ITEM INTEGER PRIMARY KEY,
    ID_PEDIDO INTEGER,
    ID_PRODUTO INTEGER,
    DESCRICAO_PRODUTO TEXT,
    UNIDADE TEXT,
    QUANTIDADE NUMERIC(15,3),
    QUANTIDADE_DE_PECAS NUMERIC(15,3),
    VALOR_UNITARIO NUMERIC(15,2),
    VALOR_TOTAL_ITEM NUMERIC(15,2),
    DATA_FOI_CADASTRADO TIMESTAMP,
    DATA_ULTIMA_ATUALIZACAO TIMESTAMP,
    ID_ULTIMA_ATUALIZACAO_MATRIZ INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS PEDIDOS_PARCELAS_PAGAMENTOS (
    ID_PEDIDO INTEGER,
    PARCELA INTEGER,
    VALOR NUMERIC(15,2),
    DATA_PARA_PAGAMENTO DATE,
    ID_FORMA_DE_PAGAMENTO INTEGER,
    STATUS TEXT,
    DATA_FOI_CADASTRADO TIMESTAMP,
    DATA_ULTIMA_ATUALIZACAO TIMESTAMP,
    ID_ULTIMA_ATUALIZACAO_MATRIZ INTEGER,
    PRIMARY KEY (ID_PEDIDO, PARCELA)
  )`,
  `CREATE TABLE IF NOT EXISTS CLIENTES (
    SRV_ID INTEGER PRIMARY KEY,
    ID_CLIENTE INTEGER UNIQUE,
    RAZAO_SOCIAL TEXT,
    FANTASIA TEXT,
    PESSOA_P_CONTATO TEXT,
    CONSUMIDOR_FINAL VARCHAR(1),
    CPF TEXT,
    CNPJ TEXT,
    INSC_ESTADUAL TEXT,
    ID_LOJA INTEGER,
    DATA_FOI_CADASTRADO TIMESTAMP,
    DATA_ULTIMA_ATUALIZACAO TIMESTAMP,
    ID_ULTIMA_ATUALIZACAO_MATRIZ INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS PRODUTOS (
    ID_PRODUTO INTEGER PRIMARY KEY,
    SRV_ID INTEGER UNIQUE,
    CODIGO TEXT,
    DESCRICAO TEXT,
    UNIDADE TEXT,
    PRECO_VENDA NUMERIC(15,2),
    SALDO_ATUAL NUMERIC(15,3),
    DATA_FOI_CADASTRADO TIMESTAMP,
    DATA_ULTIMA_ATUALIZACAO TIMESTAMP,
    ID_ULTIMA_ATUALIZACAO_MATRIZ INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS AUX_PARCELAS_PAGAMENTOS (
    ID_AUX_PARCELA_PAGAMENTO INTEGER PRIMARY KEY,
    DESCRICAO TEXT,
    QUANTIDADE_DE_PARCELAS INTEGER,
    PRAZO_DE_ENTRADA INTEGER,
    INTERVALO_ENTRE_PARCELAS INTEGER,
    ID_FORMA_DE_PAGAMENTO INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS FORMAS_DE_PAGAMENTOS (
    ID_FORMA_DE_PAGAMENTO INTEGER PRIMARY KEY,
    DESCRICAO_FORMA_DE_PAGAMENTO TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS MOVIMENTACOES (
    ID_MOVIMENTACAO INTEGER PRIMARY KEY,
    ID_PRODUTO INTEGER,
    TIPO_MOVIMENTACAO TEXT,
    DATA DATE,
    HORA TEXT,
    QUANTIDADE NUMERIC(15,3),
    SALDO_ANTERIOR NUMERIC(15,3),
    SALDO_ATUAL NUMERIC(15,3),
    OBS TEXT,
    USUARIO TEXT,
    ORIGEM_LANCAMENTO TEXT,
    ID_LOJA INTEGER
  )`,
];

async function upsertProduto(db, p) {
  await execute(db, `
    INSERT INTO PRODUTOS (ID_PRODUTO, SRV_ID, CODIGO, DESCRICAO, UNIDADE, PRECO_VENDA, SALDO_ATUAL)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (ID_PRODUTO) DO UPDATE SET
      CODIGO = EXCLUDED.CODIGO, DESCRICAO = EXCLUDED.DESCRICAO, UNIDADE = EXCLUDED.UNIDADE,
      PRECO_VENDA = EXCLUDED.PRECO_VENDA, SALDO_ATUAL = EXCLUDED.SALDO_ATUAL
  `, [p.ID_PRODUTO, p.SRV_ID, p.CODIGO, p.DESCRICAO, p.UNIDADE, p.PRECO_VENDA, p.SALDO_ATUAL]);
}

async function seed() {
  // 1) Schema + infraestrutura padrão (sync_config, sync_filiais, srv_id_map, seq_atualizacao_matriz...)
  await initializeTenantSchema(SCHEMA);

  // 2) Registra o schema em public.sync_tenants — usuarios_empresas.schema_name tem FK pra cá.
  await pool.query(`
    INSERT INTO public.sync_tenants (token, schema_name, nome, ativo)
    VALUES ($1, $2, 'Empresa de Teste E2E (Playwright)', TRUE)
    ON CONFLICT (token) DO UPDATE SET schema_name = EXCLUDED.schema_name, ativo = TRUE
  `, [TOKEN, SCHEMA]);

  await withTenantConnection(SCHEMA, async db => {
    // 3) Tabelas de negócio (subconjunto mínimo do schema Firebird real — ver cabeçalho do arquivo)
    for (const ddl of DDL_TABELAS_NEGOCIO) await query(db, ddl);

    // 4) Reset das tabelas transacionais de pedido — cada rodada de teste parte de PEDIDOS vazia
    await execute(db, `TRUNCATE TABLE PEDIDOS, PEDIDOS_ITENS, PEDIDOS_PARCELAS_PAGAMENTOS, MOVIMENTACOES RESTART IDENTITY CASCADE`);

    // 5) Dados de referência (upsert — idempotente entre rodadas)
    await execute(db, `
      INSERT INTO CLIENTES (SRV_ID, ID_CLIENTE, RAZAO_SOCIAL, FANTASIA, PESSOA_P_CONTATO, CONSUMIDOR_FINAL, CPF, ID_LOJA)
      VALUES (1, 1, 'Cliente Teste E2E', 'Cliente E2E', 'Fulano de Tal', 'S', '12345678909', $1)
      ON CONFLICT (SRV_ID) DO UPDATE SET RAZAO_SOCIAL = EXCLUDED.RAZAO_SOCIAL, ID_LOJA = EXCLUDED.ID_LOJA
    `, [ID_LOJA]);

    await upsertProduto(db, PRODUTO_PADRAO);
    await upsertProduto(db, PRODUTO_SALDO_BAIXO);

    await execute(db, `
      INSERT INTO FORMAS_DE_PAGAMENTOS (ID_FORMA_DE_PAGAMENTO, DESCRICAO_FORMA_DE_PAGAMENTO)
      VALUES (1, 'Dinheiro')
      ON CONFLICT (ID_FORMA_DE_PAGAMENTO) DO UPDATE SET DESCRICAO_FORMA_DE_PAGAMENTO = EXCLUDED.DESCRICAO_FORMA_DE_PAGAMENTO
    `);

    // Condição "À vista" — 1 parcela, sem prazo, pra o wizard gerar o pagamento sozinho no
    // valor cheio do pedido (ver auto-geração de parcelas em abrirWizardPagamento).
    await execute(db, `
      INSERT INTO AUX_PARCELAS_PAGAMENTOS (ID_AUX_PARCELA_PAGAMENTO, DESCRICAO, QUANTIDADE_DE_PARCELAS, PRAZO_DE_ENTRADA, INTERVALO_ENTRE_PARCELAS, ID_FORMA_DE_PAGAMENTO)
      VALUES (1, 'A vista', 1, 0, 0, 1)
      ON CONFLICT (ID_AUX_PARCELA_PAGAMENTO) DO UPDATE SET
        DESCRICAO = EXCLUDED.DESCRICAO, QUANTIDADE_DE_PARCELAS = EXCLUDED.QUANTIDADE_DE_PARCELAS,
        PRAZO_DE_ENTRADA = EXCLUDED.PRAZO_DE_ENTRADA, INTERVALO_ENTRE_PARCELAS = EXCLUDED.INTERVALO_ENTRE_PARCELAS,
        ID_FORMA_DE_PAGAMENTO = EXCLUDED.ID_FORMA_DE_PAGAMENTO
    `);

    await execute(db, `
      INSERT INTO sync_filiais (id_loja, nome) VALUES ($1, 'Loja Teste E2E')
      ON CONFLICT (id_loja) DO UPDATE SET nome = EXCLUDED.nome
    `, [ID_LOJA]);

    // Garante que venda_saldo_negativo comece em 'N' (bloqueia saldo negativo) — pode ter
    // sido deixado em 'S' por uma rodada anterior do teste de bloqueio de saldo.
    await execute(db, `UPDATE sync_config SET valor = 'N' WHERE chave = 'venda_saldo_negativo'`);
  });

  // 6) Usuário de login (role gerente, loja 1 — sem select de loja no wizard, sem exigir vendedor)
  const { rows: existentes } = await pool.query('SELECT id FROM public.usuarios WHERE email = $1', [EMAIL]);
  let idUsuario;
  if (existentes.length > 0) {
    idUsuario = existentes[0].id;
    const senhaHash = await bcrypt.hash(SENHA, 12);
    await pool.query('UPDATE public.usuarios SET senha_hash = $1, ativo = TRUE WHERE id = $2', [senhaHash, idUsuario]);
  } else {
    const senhaHash = await bcrypt.hash(SENHA, 12);
    const { rows } = await pool.query(
      'INSERT INTO public.usuarios (email, senha_hash, nome, ativo) VALUES ($1, $2, $3, TRUE) RETURNING id',
      [EMAIL, senhaHash, 'Gerente E2E']
    );
    idUsuario = rows[0].id;
  }

  await pool.query(`
    INSERT INTO public.usuarios_empresas (id_usuario, schema_name, role, id_loja)
    VALUES ($1, $2, 'gerente', $3)
    ON CONFLICT (id_usuario, schema_name) DO UPDATE SET role = 'gerente', id_loja = $3
  `, [idUsuario, SCHEMA, ID_LOJA]);

  console.log(`Seed e2e OK — schema=${SCHEMA} email=${EMAIL} senha=${SENHA}`);
}

seed()
  .then(() => pool.end())
  .catch(e => { console.error('Falha no seed e2e:', e); pool.end(); process.exit(1); });
