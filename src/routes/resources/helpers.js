/**
 * Helpers compartilhados pelas rotas de tabelas.
 * Extraídos de tabelas.js (monolítico) para facilitar reutilização e testes.
 */

const { pool, query, execute, withTenantConnection } = require('../../db');
const { COLS_DATA_PEDIDO } = require('./constants');

// Colunas que o servidor gerencia internamente — não devem ser sobrescritas pela filial
// nem viram coluna numa tabela criada automaticamente (ver criarTabelaSeNecessario).
const COLUNAS_IGNORADAS_SERVIDOR = new Set([
  'ID_ULTIMA_ATUALIZACAO_MATRIZ',
  'ID_ULTIMA_ATUALIZACAO_WEB',
  'SRV_ID', // rastreado em srv_id_map; não existe como coluna nas tabelas do servidor
]);

// Números sempre viram NUMERIC: Firebird NUMERIC(10,2) com valor 100.00 chega como
// inteiro 100 via node-firebird, e NUMERIC comporta ambos sem perda.
function inferirTipoPg(valor) {
  if (Buffer.isBuffer(valor)) return 'BYTEA';
  if (valor instanceof Date) return 'TIMESTAMP';
  if (typeof valor === 'boolean') return 'BOOLEAN';
  if (typeof valor === 'number') return 'NUMERIC';
  return 'TEXT';
}

/**
 * Colunas que compõem a chave de negócio usada na constraint UNIQUE (uq_<tabela>_bk).
 * Inclui ID_LOJA quando a tabela tem essa coluna — o ID local do Firebird (generator)
 * só é único DENTRO de uma filial; cada filial tem seu próprio generator, então duas
 * filiais podem gerar o mesmo id_local para registros diferentes. Sem ID_LOJA na chave,
 * essa constraint rejeitaria como duplicata um push legítimo vindo de outra filial.
 */
function chaveNegocioTabela(pks, colunasDisponiveis) {
  const chave = [...(Array.isArray(pks) ? pks : [pks])];
  if (colunasDisponiveis.has('ID_LOJA') && !chave.includes('ID_LOJA')) chave.push('ID_LOJA');
  return chave;
}

/**
 * Deriva a lista de colunas tipadas de um registro real (recebido via push, ou enviado por
 * um formulário web), inferindo o tipo PostgreSQL de cada valor. Usado por
 * criarTabelaSeNecessario quando a criação parte de um registro de verdade (há um registro
 * pra inferir tipo por valor, ao contrário de GarantirTabela, que usa introspecção do Firebird).
 */
function colunasTipadasDeRegistro(registro) {
  return Object.keys(registro).map(nome => ({ nome, tipoPg: inferirTipoPg(registro[nome]) }));
}

/**
 * Cria a tabela no schema do tenant a partir de uma lista de colunas já tipadas.
 * Chamado quando ReceberRegistro ou o CRUD genérico da web (crud.js) encontram
 * colunasServidor vazio (tabela inexistente — tipos inferidos do primeiro registro via
 * colunasTipadasDeRegistro), e por GarantirTabela (tabela vazia na filial — sem registro
 * real, tipos vêm da introspecção do Firebird feita pelo cliente).
 * colunasTipadas: [{ nome, tipoPg }, ...].
 *
 * @param {import('pg').PoolClient} db
 * @param {string} nomeTabela
 * @param {string} schemaName
 * @param {Array<{ nome: string, tipoPg: string }>} colunasTipadas
 * @param {string[]} pks
 * @param {boolean} [useSrvId]
 */
async function criarTabelaSeNecessario(db, nomeTabela, schemaName, colunasTipadas, pks, useSrvId = false) {
  const pkSet = new Set(Array.isArray(pks) ? pks : [pks]);
  const colunasTipadasFiltradas = colunasTipadas.filter(({ nome }) => !COLUNAS_IGNORADAS_SERVIDOR.has(nome));
  const colunas = colunasTipadasFiltradas
    .map(({ nome, tipoPg }) => `${nome} ${tipoPg}${pkSet.has(nome) && !useSrvId ? ' NOT NULL' : ''}`);
  if (!colunasTipadas.some(c => c.nome === 'ID_ULTIMA_ATUALIZACAO_MATRIZ')) {
    colunas.push('ID_ULTIMA_ATUALIZACAO_MATRIZ INTEGER');
  }
  if (useSrvId) {
    colunas.unshift('SRV_ID INTEGER NOT NULL');
    await execute(db,
      `CREATE TABLE IF NOT EXISTS ${nomeTabela} (${colunas.join(', ')}, PRIMARY KEY (SRV_ID))`
    );
    // Garante que as chaves de negócio do Firebird sejam únicas no servidor,
    // impedindo duplicatas caso o srv_id_map perca a entrada e o registro seja re-inserido.
    const chaveNegocio = chaveNegocioTabela(pks, new Set(colunasTipadas.map(c => c.nome)));
    if (chaveNegocio.length > 0) {
      await execute(db,
        `ALTER TABLE ${nomeTabela} ADD CONSTRAINT uq_${nomeTabela.toLowerCase()}_bk UNIQUE (${chaveNegocio.join(', ')})`
      ).catch(e => { if (e.code !== '42710' && e.code !== '42P07') throw e; }); // 42710 = duplicate_object, 42P07 = índice de mesmo nome já existe
    }
  } else {
    await execute(db,
      `CREATE TABLE IF NOT EXISTS ${nomeTabela} (${colunas.join(', ')}, PRIMARY KEY (${[...pkSet].join(', ')}))`
    );
  }
  const triggerName = `tg_${nomeTabela.toLowerCase()}_seq`;
  await execute(db, `DROP TRIGGER IF EXISTS ${triggerName} ON ${nomeTabela}`);
  await execute(db, `
    CREATE TRIGGER ${triggerName}
    BEFORE INSERT OR UPDATE ON ${nomeTabela}
    FOR EACH ROW EXECUTE FUNCTION ${schemaName}.fn_seq_atualizacao()
  `);
  const delTriggerName = `tg_${nomeTabela.toLowerCase()}_del`;
  await execute(db, `DROP TRIGGER IF EXISTS ${delTriggerName} ON ${nomeTabela}`);
  await execute(db, `
    CREATE TRIGGER ${delTriggerName}
    AFTER DELETE ON ${nomeTabela}
    FOR EACH ROW EXECUTE FUNCTION ${schemaName}.fn_registrar_delecao()
  `);
  console.log(`[${schemaName}] Tabela '${nomeTabela}' criada automaticamente via carga inicial.`);
}

/**
 * Loga o erro com um ID rastreável e responde 500 com JSON — nunca expõe e.message
 * (pode conter SQL/detalhe interno) na resposta ao cliente. O ID aparece tanto no log
 * do servidor quanto na resposta, use-o para grep. Compartilhado entre todas as rotas
 * de resources/ (antes só existia dentro de crud.js; pedidos.js e dashboard.js
 * devolviam e.message cru).
 */
function erroServidor(res, e, rota) {
  const id = `CRUD-${Date.now().toString(36).slice(-6).toUpperCase()}`;
  console.error(`[${id}] ${rota}:`, e.stack || e.message);
  res.status(500).json({ erro: 'Erro interno do servidor.', id });
}

/**
 * Retorna as colunas de uma tabela consultando o information_schema do PostgreSQL.
 * Chaves normalizadas para UPPERCASE (padrão do projeto).
 *
 * @param {import('pg').PoolClient} db
 * @param {string} schema
 * @param {string} tabela
 * @returns {Promise<Array<{ COLUMN_NAME: string, DATA_TYPE: string, IS_GENERATED: string, CHARACTER_MAXIMUM_LENGTH: number|null }>>}
 */
async function colunasTabela(db, schema, tabela) {
  return query(db, `
    SELECT
      UPPER(column_name) AS column_name,
      data_type,
      CASE WHEN is_generated = 'ALWAYS' THEN 'ALWAYS' ELSE '' END AS is_generated,
      character_maximum_length
    FROM information_schema.columns
    WHERE table_schema = $1 AND LOWER(table_name) = LOWER($2)
    ORDER BY ordinal_position
  `, [schema, tabela]);
}

/**
 * Resolve o ID da loja efetivo para uma query, respeitando o role do usuário.
 *
 * - Não-donos: sempre forçados à sua própria loja (req.userLojas[schema]).
 * - Donos: sem restrição por padrão; quando `donoPodemFiltrar: true`, podem
 *   passar ?filtroLoja=N para filtrar por loja específica.
 *
 * Inclui guarda `Number.isInteger` para barrar NaN/Infinity vindos de parseInt.
 *
 * @param {import('express').Request} req
 * @param {string} schema
 * @param {{ donoPodemFiltrar?: boolean }} [opts]
 * @returns {number|null}
 */
function resolveIdLoja(req, schema, { donoPodemFiltrar = false } = {}) {
  const isDono = req.userRoles?.[schema] === 'dono';
  if (!isDono) return req.userLojas?.[schema] ?? null;
  if (donoPodemFiltrar && req.query.filtroLoja) {
    const parsed = parseInt(req.query.filtroLoja, 10);
    return Number.isInteger(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Resolve o nome de um vendedor (tabela VENDEDORES, sincronizada do Firebird) a partir
 * do ID — tenta as colunas de nome mais comuns entre os schemas dos clientes, na ordem
 * de preferência abaixo (nem todo schema tem exatamente as mesmas colunas).
 *
 * @param {import('pg').PoolClient} db
 * @param {string} schema
 * @param {number|string} idVendedor
 * @returns {Promise<string|null>}
 */
async function resolverNomeVendedor(db, schema, idVendedor) {
  if (idVendedor == null) return null;
  const colsVend = await colunasTabela(db, schema, 'VENDEDORES').catch(() => []);
  const nomeCol = ['NOME_VENDEDOR', 'NOME', 'RAZAO_SOCIAL', 'DESCRICAO']
    .find(c => colsVend.some(cc => cc.COLUMN_NAME === c));
  if (!nomeCol) return null;
  const [vend] = await query(db,
    `SELECT ${nomeCol} AS NOME FROM VENDEDORES WHERE ID_VENDEDOR = $1 LIMIT 1`,
    [idVendedor]
  ).catch(() => []);
  return vend?.NOME ?? null;
}

/**
 * Retorna true se o pedido informado está com STATUS = 'C' (Cancelado).
 * Usado para bloquear qualquer edição de PEDIDOS_ITENS/PEDIDOS_PARCELAS_PAGAMENTOS
 * depois do cancelamento — não só a transição de status do próprio PEDIDOS.
 *
 * @param {import('pg').PoolClient} db
 * @param {number|string|null|undefined} idPedido
 * @returns {Promise<boolean>}
 */
async function pedidoEstaCancelado(db, idPedido) {
  if (idPedido == null) return false;
  const [row] = await query(db, `SELECT STATUS FROM PEDIDOS WHERE ID_PEDIDO = $1 LIMIT 1`, [idPedido]).catch(() => []);
  return row?.STATUS === 'C';
}

/**
 * Insere uma linha no audit_log de forma assíncrona (fire-and-forget).
 * Nunca lança erro — falha silenciosa intencional para não bloquear a resposta.
 *
 * @param {import('express').Request} req
 * @param {string} schema
 * @param {string} tabela
 * @param {'INSERT'|'UPDATE'|'DELETE'} operacao
 * @param {string} pkStr       — valor(es) da PK concatenados com '|'
 * @param {object|null} dados  — payload enviado (null para DELETE)
 * @param {object|null} dadosAntes — snapshot antes da operação (null para INSERT)
 */
function registrarAuditLog(req, schema, tabela, operacao, pkStr, dados, dadosAntes) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || null;
  pool.query(
    `INSERT INTO public.audit_log
       (id_usuario, schema_name, tabela, operacao, pk_valor, dados, dados_antes, ip_cliente)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [req.userId, schema, tabela.toUpperCase(), operacao, pkStr, dados, dadosAntes, ip]
  ).catch(() => {});
}

/**
 * Gera a expressão SQL de nome de loja e os LEFT JOINs necessários para resolvê-la.
 * Prioridade: sync_filiais (preenchida automaticamente) >
 *             AUX_GENERICA (configurada manualmente) >
 *             'Loja N' (fallback literal)
 *
 * Assume aliases: p = PEDIDOS, sf = sync_filiais, ag = AUX_GENERICA.
 *
 * @param {{ hasSF: boolean, hasAuxGen: boolean }} flags
 * @returns {{ nomeLojaExpr: string, joinSF: string, joinAG: string }}
 */
function buildNomeLojaExpr({ hasSF, hasAuxGen }) {
  const nomeLojaExpr = [
    hasSF     && `MAX(sf.nome)`,
    hasAuxGen && `MAX(ag.DESCRICAO)`,
    `'Loja ' || COALESCE(p.ID_LOJA::TEXT, '?')`,
  ].filter(Boolean).reduce((acc, expr) => `COALESCE(${acc}, ${expr})`);

  const joinSF = hasSF
    ? `LEFT JOIN sync_filiais sf ON sf.id_loja = p.ID_LOJA`
    : '';
  const joinAG = hasAuxGen
    ? `LEFT JOIN AUX_GENERICA ag ON ag.SUB_TABELA = 'Lojas'
       AND CAST(ag.ID_SUB_TABELA AS TEXT) = CAST(p.ID_LOJA AS TEXT)`
    : '';

  return { nomeLojaExpr, joinSF, joinAG };
}

/**
 * Detecta a coluna de data de pedido disponível e retorna a expressão SQL
 * para usá-la como DATE (converte TEXT→DATE se necessário).
 * Retorna null se nenhuma coluna de data for encontrada.
 *
 * @param {object[]} colsP — resultado de colunasTabela() para PEDIDOS
 * @returns {string|null}
 */
function dateExprFromCols(colsP) {
  const colNamesP    = new Set(colsP.map(c => c.COLUMN_NAME));
  const dataCol      = COLS_DATA_PEDIDO.find(c => colNamesP.has(c)) ?? null;
  if (!dataCol) return null;
  const dataType     = colsP.find(c => c.COLUMN_NAME === dataCol)?.DATA_TYPE ?? 'text';
  const isNativeDate = dataType.startsWith('timestamp') || dataType === 'date';
  return isNativeDate ? `p.${dataCol}` : `NULLIF(p.${dataCol}, '')::DATE`;
}

/**
 * Constrói as partes do WHERE comuns a todos os gráficos de dashboard.
 *
 * Suporta dois modos de filtro de data:
 *   - Exato:    { ano, mes }                          — dono (selects únicos)
 *   - Intervalo: { anoInicio, mesInicio, anoFim, mesFim } — gerente
 * Se algum param de intervalo estiver presente, o filtro exato é ignorado.
 *
 * @param {object[]} colsP — resultado de colunasTabela() para PEDIDOS
 * @param {{ ano?, mes?, idLojaF, anoInicio?, mesInicio?, anoFim?, mesFim? }} filtros
 * @param {any[]} params — array de parâmetros mutável (push in-place)
 * @returns {{ whereParts: string[], dateExpr: string|null, colNamesP: Set<string> }}
 */
function buildWhere(colsP, { ano, mes, idLojaF, anoInicio, mesInicio, anoFim, mesFim }, params) {
  const colNamesP  = new Set(colsP.map(c => c.COLUMN_NAME));
  const dateExpr   = dateExprFromCols(colsP);
  const whereParts = [];

  if (dateExpr) {
    const hasRange = (anoInicio && mesInicio) || (anoFim && mesFim);
    if (hasRange) {
      /* ── filtro por intervalo ── */
      if (anoInicio && mesInicio) {
        const aI = parseInt(anoInicio), mI = parseInt(mesInicio);
        if (/^\d{4}$/.test(anoInicio) && mI >= 1 && mI <= 12) {
          params.push(aI); params.push(mI);
          whereParts.push(
            `DATE_TRUNC('month', ${dateExpr}) >= make_date($${params.length - 1}, $${params.length}, 1)`
          );
        }
      }
      if (anoFim && mesFim) {
        const aF = parseInt(anoFim), mF = parseInt(mesFim);
        if (/^\d{4}$/.test(anoFim) && mF >= 1 && mF <= 12) {
          params.push(aF); params.push(mF);
          whereParts.push(
            `DATE_TRUNC('month', ${dateExpr}) <= make_date($${params.length - 1}, $${params.length}, 1)`
          );
        }
      }
    } else {
      /* ── filtro exato por ano/mês (comportamento original) ── */
      if (ano && /^\d{4}$/.test(ano)) {
        params.push(parseInt(ano));
        whereParts.push(`EXTRACT(YEAR FROM ${dateExpr}) = $${params.length}`);
      }
      const mesInt = parseInt(mes);
      if (mes && /^\d{1,2}$/.test(mes) && mesInt >= 1 && mesInt <= 12) {
        params.push(mesInt);
        whereParts.push(`EXTRACT(MONTH FROM ${dateExpr}) = $${params.length}`);
      }
    }
  }

  if (idLojaF !== null && colNamesP.has('ID_LOJA')) {
    params.push(idLojaF);
    whereParts.push(`p.ID_LOJA = $${params.length}`);
  }
  return { whereParts, dateExpr, colNamesP };
}

/**
 * Garante que existam registros em A_RECEBER para as parcelas de pagamento de um
 * pedido — mas só quando o pedido já está com STATUS = 'R' (Realizado). Pagamento
 * não é pré-requisito para "Realizado": este é o único gate.
 *
 * Idempotente: pula parcelas que já têm um A_RECEBER correspondente (dedup via
 * observacao = 'pedido:<id_pedido>:<parcela>'). Seguro de chamar repetidamente —
 * ex.: quando o pedido já era 'R' e novas parcelas são geradas depois.
 *
 * @param {string} schema
 * @param {number|string} idPedido
 * @returns {Promise<{ criados: object[] }>}
 */
async function gerarContasReceberDoPedido(schema, idPedido) {
  const { rows: pedRows } = await pool.query(
    `SELECT status, id_cliente, id_loja, id_vendedor FROM ${schema}.pedidos WHERE id_pedido = $1 LIMIT 1`,
    [idPedido]
  );
  const ped = pedRows[0];
  if (!ped || ped.status !== 'R') return { criados: [] };

  let id_cliente_srv = null;
  if (ped.id_cliente) {
    const { rows: c } = await pool.query(
      `SELECT srv_id FROM ${schema}.clientes WHERE id_cliente = $1 LIMIT 1`,
      [ped.id_cliente]
    );
    id_cliente_srv = c[0]?.srv_id ?? null;
  }

  const { rows: parcelas } = await pool.query(
    `SELECT parcela, valor, data_para_pagamento, id_forma_de_pagamento
     FROM ${schema}.pedidos_parcelas_pagamentos WHERE id_pedido = $1 ORDER BY parcela`,
    [idPedido]
  ).catch(() => ({ rows: [] }));
  if (!parcelas.length) return { criados: [] };

  await pool.query(`CREATE SEQUENCE IF NOT EXISTS ${schema}.seq_srv_id_a_receber START WITH 1`);
  await pool.query(`
    SELECT setval(
      '${schema}.seq_srv_id_a_receber',
      GREATEST(
        (SELECT last_value FROM ${schema}.seq_srv_id_a_receber),
        (SELECT COALESCE(MAX(srv_id), 0) FROM ${schema}.a_receber)
      )
    )
  `);

  const criados = [];
  for (const p of parcelas) {
    const obs = `pedido:${idPedido}:${p.parcela}`;
    const existing = await pool.query(
      `SELECT srv_id FROM ${schema}.a_receber WHERE observacao = $1 LIMIT 1`, [obs]
    );
    if (existing.rows.length > 0) continue;

    const { rows: [{ next_id }] } = await pool.query(
      `SELECT nextval('${schema}.seq_srv_id_a_receber') AS next_id`
    );
    await pool.query(
      `INSERT INTO ${schema}.srv_id_map (tabela, id_local, srv_id)
       VALUES ('A_RECEBER', $1, $2) ON CONFLICT (tabela, id_local) WHERE filial_id IS NULL DO NOTHING`,
      [`web:${next_id}`, next_id]
    );
    const desc = `Pedido #${idPedido} - Parcela ${p.parcela}`;
    const { rows: [r] } = await pool.query(
      `INSERT INTO ${schema}.a_receber
         (srv_id, descricao, id_cliente, id_pedido, valor, vencimento, status,
          id_forma_de_pagamento, parcela, observacao, id_loja, id_vendedor)
       VALUES ($1,$2,$3,$4,$5,$6,'Pendente',$7,$8,$9,$10,$11)
       RETURNING srv_id AS id, descricao, valor, vencimento AS data_vencimento, status, parcela`,
      [next_id, desc, id_cliente_srv, idPedido, p.valor, p.data_para_pagamento,
       p.id_forma_de_pagamento ? Number(p.id_forma_de_pagamento) : null,
       p.parcela, obs, ped.id_loja || null, ped.id_vendedor || null]
    );
    if (r) criados.push(r);
  }
  return { criados };
}

/**
 * Cria um VENDEDORES "DONO" e vincula o usuário a ele (usuarios_empresas.id_vendedor),
 * retornando o id_vendedor criado — para telas que exibem nome do vendedor (ex.:
 * movimentações de estoque) mostrarem um nome consistente em vez do fallback
 * "Web - <nome da conta>" quando quem lançou é o dono.
 *
 * Best-effort: só roda se a tabela VENDEDORES já existir no schema — um schema
 * recém-criado só ganha essa tabela no primeiro sync do Firebird; criar uma
 * versão mínima aqui faria pushes futuros do Firebird perderem colunas, já que
 * sincronizacao.js filtra o registro pelas colunas já existentes no servidor.
 * Nunca lança — retorna null se não for possível vincular agora.
 *
 * @param {string} schema
 * @param {number} idUsuario
 * @returns {Promise<number|null>}
 */
async function vincularVendedorDono(schema, idUsuario) {
  try {
    return await withTenantConnection(schema, async db => {
      const cols = await colunasTabela(db, schema, 'VENDEDORES').catch(() => []);
      if (cols.length === 0) return null; // tabela ainda não existe — nada a fazer

      const [ins] = await query(db, `
        INSERT INTO VENDEDORES (id_vendedor, nome, status, id_ultima_atualizacao_matriz)
        VALUES ((SELECT COALESCE(MAX(id_vendedor::numeric), 0) + 1 FROM VENDEDORES), 'DONO', 'A',
                nextval('${schema}.seq_atualizacao_matriz'))
        RETURNING id_vendedor
      `);
      if (ins?.ID_VENDEDOR == null) return null;

      await execute(db,
        `UPDATE public.usuarios_empresas SET id_vendedor = $1 WHERE id_usuario = $2 AND schema_name = $3`,
        [ins.ID_VENDEDOR, idUsuario, schema]
      );
      return Number(ins.ID_VENDEDOR);
    });
  } catch (e) {
    console.error(`[vincularVendedorDono] falhou para ${schema}:`, e.message);
    return null;
  }
}

module.exports = {
  erroServidor,
  colunasTabela,
  resolveIdLoja,
  resolverNomeVendedor,
  vincularVendedorDono,
  pedidoEstaCancelado,
  registrarAuditLog,
  buildNomeLojaExpr,
  dateExprFromCols,
  buildWhere,
  gerarContasReceberDoPedido,
  COLUNAS_IGNORADAS_SERVIDOR,
  inferirTipoPg,
  chaveNegocioTabela,
  colunasTipadasDeRegistro,
  criarTabelaSeNecessario,
};
