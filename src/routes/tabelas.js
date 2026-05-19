const express = require('express');
const router  = express.Router();
const authJwt = require('../middleware/authJwt');
const { requireRole } = require('../middleware/checkRole');
const { pool, withTenantConnection, query, execute, isMissingTableError } = require('../db');

const NOME_VALIDO = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Só essas tabelas recebem filtro obrigatório de ID_LOJA para gerente/vendedor
const TABELAS_FILTRO_LOJA = new Set(['PEDIDOS', 'PEDIDOS_ITENS', 'PEDIDOS_PARCELAS_PAGAMENTOS']);

const COLS_OCULTAS = new Set([
  'ID_ULTIMA_ATUALIZACAO_MATRIZ', 'ID_ULTIMA_ATUALIZACAO_WEB',
  'ID_ULTIMA_ATT_IFOOD', 'DATA_INCLUSAO_SIRIUS', 'DATA_ALTERACAO_SIRIUS', 'ULTIMA_ALTERACAO',
]);

function checkSchema(req, res, next) {
  if (!req.userSchemas.includes(req.params.schema))
    return res.status(403).json({ erro: 'acesso negado' });
  next();
}

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

/* ── GET /api/:schema/tabelas/:tabela/colunas ── */
router.get('/:schema/tabelas/:tabela/colunas', authJwt, checkSchema, async (req, res) => {
  const { schema, tabela } = req.params;
  if (!NOME_VALIDO.test(tabela)) return res.status(400).json({ erro: 'nome de tabela inválido' });
  try {
    const cols = await withTenantConnection(schema, db => colunasTabela(db, schema, tabela));
    res.json(cols);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

/* ── GET /api/:schema/tabelas/:tabela/next-pk ── */
router.get('/:schema/tabelas/:tabela/next-pk', authJwt, checkSchema, async (req, res) => {
  const { schema, tabela } = req.params;
  const { pk } = req.query;
  if (!NOME_VALIDO.test(tabela)) return res.status(400).json({ erro: 'nome de tabela inválido' });
  if (!pk || !NOME_VALIDO.test(pk)) return res.status(400).json({ erro: 'pk inválido' });
  try {
    const rows = await withTenantConnection(schema, db =>
      query(db, `SELECT COALESCE(MAX(${pk}), 0) + 1 AS next FROM ${tabela}`, [])
    );
    res.json({ next: rows[0]?.NEXT ?? 1 });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

/* ── GET /api/:schema/tabelas/:tabela/by-pk — busca registro único por PK ── */
router.get('/:schema/tabelas/:tabela/by-pk', authJwt, checkSchema, async (req, res) => {
  const { schema, tabela } = req.params;
  if (!NOME_VALIDO.test(tabela)) return res.status(400).json({ erro: 'nome de tabela inválido' });
  const { pk, value } = req.query;
  if (!pk || !NOME_VALIDO.test(pk)) return res.status(400).json({ erro: 'pk inválido' });
  try {
    const rows = await withTenantConnection(schema, db =>
      query(db, `SELECT * FROM ${tabela} WHERE ${pk} = $1 LIMIT 1`, [value])
    );
    res.json(rows[0] || null);
  } catch (e) {
    if (isMissingTableError(e)) return res.json(null);
    res.status(500).json({ erro: e.message });
  }
});

/* ── GET /api/:schema/tabelas/:tabela — lista paginada ── */
router.get('/:schema/tabelas/:tabela', authJwt, checkSchema, async (req, res) => {
  const { schema, tabela } = req.params;
  if (!NOME_VALIDO.test(tabela)) return res.status(400).json({ erro: 'nome de tabela inválido' });
  const page      = Math.max(1, parseInt(req.query.page)     || 1);
  const pageSize  = Math.min(500, Math.max(1, parseInt(req.query.pageSize) || 50));
  const q         = req.query.q?.trim() || '';
  const cols      = req.query.cols?.trim() || '';
  const statusCol = req.query.statusCol?.trim() || '';
  const statusVal = req.query.statusVal?.trim() || '';
  const sortCol   = req.query.sortCol?.trim() || '';
  const sortDir   = (req.query.sortDir?.trim() || 'ASC').toUpperCase();
  // Filtro de loja: só para tabelas transacionais (PEDIDOS e afins)
  const usaFiltroLoja   = TABELAS_FILTRO_LOJA.has(tabela.toUpperCase());
  const idLojaObrigatorio = usaFiltroLoja ? (req.userLojas?.[schema] ?? null) : null;
  const filtroLojaParam   = usaFiltroLoja && req.query.filtroLoja ? parseInt(req.query.filtroLoja) : null;
  const idLojaFiltro      = idLojaObrigatorio ?? filtroLojaParam;

  if (cols) {
    const lista = cols.split(',').map(c => c.trim()).filter(Boolean);
    if (lista.some(c => !NOME_VALIDO.test(c))) return res.status(400).json({ erro: 'cols inválido' });
  }
  if (statusCol && !NOME_VALIDO.test(statusCol)) return res.status(400).json({ erro: 'statusCol inválido' });
  if (statusVal && !['A', 'I'].includes(statusVal)) return res.status(400).json({ erro: 'statusVal inválido' });
  if (sortCol && !NOME_VALIDO.test(sortCol)) return res.status(400).json({ erro: 'sortCol inválido' });
  if (!['ASC', 'DESC'].includes(sortDir)) return res.status(400).json({ erro: 'sortDir inválido' });

  try {
    const result = await withTenantConnection(schema, async db => {
      const params = [];
      const conditions = [];

      if (q) {
        let searchCols;
        if (cols) {
          searchCols = cols.split(',').map(c => c.trim().toUpperCase()).filter(Boolean);
        } else {
          const textCols = await query(db, `
            SELECT column_name FROM information_schema.columns
            WHERE table_schema = $1 AND LOWER(table_name) = LOWER($2)
            AND data_type IN ('character varying', 'text', 'character')
            ORDER BY ordinal_position LIMIT 8
          `, [schema, tabela]);
          searchCols = textCols.map(c => c.COLUMN_NAME);
        }

        if (searchCols.length) {
          params.push(`%${q}%`);
          conditions.push('(' + searchCols.map(c => `CAST(${c} AS TEXT) ILIKE $1`).join(' OR ') + ')');
        }
      }

      if (statusCol && statusVal) {
        params.push(statusVal);
        conditions.push(`TRIM(${statusCol}::TEXT) = $${params.length}`);
      }

      // Filtro de loja: aplica somente se a tabela tiver coluna ID_LOJA
      if (idLojaFiltro !== null) {
        const temIdLoja = await query(db, `
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = $1 AND LOWER(table_name) = LOWER($2)
            AND UPPER(column_name) = 'ID_LOJA'
          LIMIT 1
        `, [schema, tabela]);
        if (temIdLoja.length) {
          params.push(idLojaFiltro);
          conditions.push(`ID_LOJA = $${params.length}`);
        }
      }

      const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

      const countRows = await query(db, `SELECT COUNT(*) AS cnt FROM ${tabela} ${where}`, params);
      const total     = parseInt(countRows[0].CNT);
      const offset    = (page - 1) * pageSize;
      const orderBy   = sortCol ? `${sortCol} ${sortDir}` : '1';
      params.push(pageSize, offset);
      const registros = await query(db,
        `SELECT * FROM ${tabela} ${where} ORDER BY ${orderBy} LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );
      return { total, registros };
    });
    res.json(result);
  } catch (e) {
    if (isMissingTableError(e)) return res.json({ total: 0, registros: [] });
    res.status(500).json({ erro: e.message });
  }
});

/* ── POST /api/:schema/tabelas/:tabela — upsert ── */
router.post('/:schema/tabelas/:tabela', authJwt, checkSchema, async (req, res) => {
  const { schema, tabela } = req.params;
  if (!NOME_VALIDO.test(tabela)) return res.status(400).json({ erro: 'nome de tabela inválido' });

  const { pk, registro } = req.body;
  if (!pk || !registro) return res.status(400).json({ erro: 'pk e registro são obrigatórios' });

  const pks = Array.isArray(pk) ? pk : [pk];
  if (pks.some(p => !NOME_VALIDO.test(p))) return res.status(400).json({ erro: 'pk inválido' });

  // Verificação de loja para gerente/vendedor — só em tabelas transacionais
  if (TABELAS_FILTRO_LOJA.has(tabela.toUpperCase())) {
    const idLojaObrigatorio = req.userLojas?.[schema] ?? null;
    if (idLojaObrigatorio !== null) {
      const idLojaRegistro = registro.ID_LOJA ?? registro.id_loja ?? null;
      if (idLojaRegistro !== null && Number(idLojaRegistro) !== idLojaObrigatorio)
        return res.status(403).json({ erro: 'não é permitido salvar registros de outra loja' });
    }
  }

  try {
    await withTenantConnection(schema, async db => {
      const serverCols = await query(db, `
        SELECT UPPER(column_name) AS col FROM information_schema.columns
        WHERE table_schema = $1 AND LOWER(table_name) = LOWER($2) AND is_generated <> 'ALWAYS'
      `, [schema, tabela]);
      const allowed = new Set(serverCols.map(r => r.COL));
      const pksUpper = pks.map(p => p.toUpperCase());

      const cols = Object.keys(registro).filter(c => NOME_VALIDO.test(c) && allowed.has(c.toUpperCase()));
      if (!cols.length) throw new Error('nenhuma coluna válida para salvar');

      const vals    = cols.map(c => registro[c]);
      const ph      = cols.map((_, i) => `$${i + 1}`);
      const updates = cols
        .filter(c => !pksUpper.includes(c.toUpperCase()))
        .map(c => `${c} = EXCLUDED.${c}`);

      await execute(db, `
        INSERT INTO ${tabela} (${cols.join(', ')})
        VALUES (${ph.join(', ')})
        ON CONFLICT (${pks.join(', ')}) DO UPDATE SET ${updates.join(', ')}
      `, vals);

      if (allowed.has('ID_ULTIMA_ATUALIZACAO_MATRIZ')) {
        const where = pksUpper.map((p, i) => `${p} = $${i + 1}`).join(' AND ');
        await execute(db,
          `UPDATE ${tabela} SET ID_ULTIMA_ATUALIZACAO_MATRIZ = nextval('${schema}.seq_atualizacao_matriz') WHERE ${where}`,
          pksUpper.map(p => registro[Object.keys(registro).find(k => k.toUpperCase() === p)])
        );
      }
    });

    // Audit log universal (fire-and-forget)
    const pkStr = pks.map(p => registro[Object.keys(registro).find(k => k.toUpperCase() === p.toUpperCase())]).join('|');
    pool.query(
      `INSERT INTO public.audit_log (id_usuario, schema_name, tabela, operacao, pk_valor, dados, ip_cliente)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [req.userId, schema, tabela.toUpperCase(), 'INSERT', pkStr, registro, req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || null]
    ).catch(() => {});

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

/* ── DELETE /api/:schema/tabelas/:tabela ── */
router.delete('/:schema/tabelas/:tabela', authJwt, checkSchema, requireRole('gerente', 'dono'), async (req, res) => {
  const { schema, tabela } = req.params;
  if (!NOME_VALIDO.test(tabela)) return res.status(400).json({ erro: 'nome de tabela inválido' });

  const { pk, pkValores } = req.body;
  if (!pk || !pkValores) return res.status(400).json({ erro: 'pk e pkValores são obrigatórios' });

  const pks = Array.isArray(pk) ? pk : [pk];
  if (pks.some(p => !NOME_VALIDO.test(p))) return res.status(400).json({ erro: 'pk inválido' });

  try {
    await withTenantConnection(schema, db => {
      const where = pks.map((p, i) => `${p} = $${i + 1}`).join(' AND ');
      return execute(db, `DELETE FROM ${tabela} WHERE ${where}`, pkValores);
    });

    // Audit log universal (fire-and-forget)
    const pkStr = (Array.isArray(pkValores) ? pkValores : [pkValores]).join('|');
    pool.query(
      `INSERT INTO public.audit_log (id_usuario, schema_name, tabela, operacao, pk_valor, dados, ip_cliente)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [req.userId, schema, tabela.toUpperCase(), 'DELETE', pkStr, { pk: pks, pkValores }, req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || null]
    ).catch(() => {});

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

/* ── GET /api/:schema/audit-log ── */
router.get('/:schema/audit-log', authJwt, checkSchema, requireRole('gerente', 'dono'), async (req, res) => {
  const { schema } = req.params;
  const limit  = Math.min(500, Math.max(1, parseInt(req.query.limit)  || 200));
  const offset = Math.max(0, parseInt(req.query.offset) || 0);
  const idLojaUsuario = req.userLojas?.[schema] ?? null;

  try {
    const rows = await pool.query(
      `SELECT al.id, al.id_usuario, u.email, al.tabela, al.operacao, al.pk_valor, al.dados, al.ip_cliente, al.criado_em
       FROM public.audit_log al
       LEFT JOIN public.usuarios u ON u.id = al.id_usuario
       WHERE al.schema_name = $1
       ORDER BY al.criado_em DESC
       LIMIT $2 OFFSET $3`,
      [schema, limit, offset]
    );

    let result = rows.rows;
    // Gerente vê apenas registros da sua loja (filtra pelo campo ID_LOJA dentro de dados)
    if (idLojaUsuario !== null) {
      result = result.filter(r => {
        const idLoja = r.dados?.ID_LOJA ?? r.dados?.id_loja ?? null;
        return idLoja === null || Number(idLoja) === idLojaUsuario;
      });
    }

    res.json(result);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// Definição plana — ordem exata de exibição no join.
// src: alias da tabela ('p'=PEDIDOS, 'pi'=PEDIDOS_ITENS, 'pr'=PRODUTOS, 'pp'=PEDIDOS_PARCELAS_PAGAMENTOS)
// Colunas ausentes no banco são silenciosamente ignoradas.
const COLS_FLAT = [
  // IDs — agrupados no início, coluna compacta
  { col: 'ID_PEDIDO',          src: 'p',  grupo: 'IDs' },
  { col: 'ID_PEDIDO_ITEM',     src: 'pi', grupo: 'IDs' },
  { col: 'ID_PRODUTO',         src: 'pi', grupo: 'IDs' },
  { col: 'PARCELA',            src: 'pp', grupo: 'IDs' },
  { col: 'ID_CLIENTE',         src: 'p',  grupo: 'IDs' },
  { col: 'ID_VENDEDOR',        src: 'p',  grupo: 'IDs' },
  { col: 'ID_LOJA',            src: 'p',  grupo: 'IDs' },
  // Dados — ordem pedida pelo usuário
  { col: 'NOME_PRODUTO',       src: 'pr', grupo: 'Dados' },
  { col: 'NOME',               src: 'pr', grupo: 'Dados' },
  { col: 'DESCRICAO',          src: 'pr', grupo: 'Dados' },
  { col: 'DESCRICAO_PRODUTO',  src: 'pr', grupo: 'Dados' },
  { col: 'QUANTIDADE',         src: 'pi', grupo: 'Dados' },
  { col: 'VALOR_UNITARIO',     src: 'pi', grupo: 'Dados' },
  { col: 'PRECO_UNITARIO',     src: 'pi', grupo: 'Dados' },
  { col: 'VALOR',              src: 'pp', grupo: 'Dados' },
  { col: 'TIPO_OPERACAO',      src: 'p',  grupo: 'Dados' },
  { col: 'NOME_CLIENTE',       src: 'p',  grupo: 'Dados' },
  { col: 'NOME_VENDEDOR',      src: 'p',  grupo: 'Dados' },
  { col: 'DATA_DO_PEDIDO',     src: 'p',  grupo: 'Dados' },
  { col: 'HORA_DO_PEDIDO',     src: 'p',  grupo: 'Dados' },
  { col: 'STATUS',             src: 'p',  grupo: 'Dados' },
];

/* ── GET /api/:schema/pedidos-completo — JOIN das 3 tabelas de pedido ── */
router.get('/:schema/pedidos-completo', authJwt, checkSchema, async (req, res) => {
  const { schema } = req.params;
  const page     = Math.max(1, parseInt(req.query.page)     || 1);
  const pageSize = Math.min(500, Math.max(1, parseInt(req.query.pageSize) || 50));
  const q        = req.query.q?.trim() || '';

  try {
    const result = await withTenantConnection(schema, async db => {
      const colsP  = await colunasTabela(db, schema, 'PEDIDOS').catch(() => []);
      const colsI  = await colunasTabela(db, schema, 'PEDIDOS_ITENS').catch(() => []);
      const colsPP = await colunasTabela(db, schema, 'PEDIDOS_PARCELAS_PAGAMENTOS').catch(() => []);
      const colsPR = await colunasTabela(db, schema, 'PRODUTOS').catch(() => []);

      if (!colsP.length) return { total: 0, registros: [], colunas: [] };

      // Lookup: src → colunas existentes no banco
      const srcAtivo = {
        p:  colsP.length  > 0,
        pi: colsI.length  > 0,
        pp: colsPP.length > 0,
        pr: colsPR.length > 0 && colsI.length > 0, // PRODUTOS exige PEDIDOS_ITENS no JOIN
      };
      const existe = {
        p:  new Set(colsP .map(c => c.COLUMN_NAME)),
        pi: new Set(colsI .map(c => c.COLUMN_NAME)),
        pp: new Set(colsPP.map(c => c.COLUMN_NAME)),
        pr: new Set(colsPR.map(c => c.COLUMN_NAME)),
      };
      const tipoOf = {
        p:  new Map(colsP .map(c => [c.COLUMN_NAME, c.DATA_TYPE])),
        pi: new Map(colsI .map(c => [c.COLUMN_NAME, c.DATA_TYPE])),
        pp: new Map(colsPP.map(c => [c.COLUMN_NAME, c.DATA_TYPE])),
        pr: new Map(colsPR.map(c => [c.COLUMN_NAME, c.DATA_TYPE])),
      };

      const resolvidas = COLS_FLAT.filter(def => srcAtivo[def.src] && existe[def.src].has(def.col));

      const sel   = resolvidas.map(def => `${def.src}.${def.col} AS "${def.src}_${def.col}"`);
      const joins = [
        colsI.length    ? 'LEFT JOIN PEDIDOS_ITENS pi ON pi.ID_PEDIDO = p.ID_PEDIDO'                 : '',
        srcAtivo.pr     ? 'LEFT JOIN PRODUTOS pr ON pr.ID_PRODUTO = pi.ID_PRODUTO'                   : '',
        colsPP.length   ? 'LEFT JOIN PEDIDOS_PARCELAS_PAGAMENTOS pp ON pp.ID_PEDIDO = p.ID_PEDIDO'   : '',
      ].filter(Boolean).join(' ');

      const params = [];
      let where = '';
      if (q) {
        params.push(`%${q}%`);
        where = `WHERE p.ID_PEDIDO::TEXT ILIKE $1`;
      }

      const countRows = await query(db,
        `SELECT COUNT(*) AS cnt FROM PEDIDOS p ${joins} ${where}`, params);
      const total  = parseInt(countRows[0].CNT);
      const offset = (page - 1) * pageSize;
      params.push(pageSize, offset);

      const registros = await query(db, `
        SELECT ${sel.length ? sel.join(', ') : 'p.*'}
        FROM PEDIDOS p ${joins} ${where}
        ORDER BY p.ID_PEDIDO${colsI.length ? ', pi.ID_PEDIDO_ITEM' : ''}
        LIMIT $${params.length - 1} OFFSET $${params.length}
      `, params);

      // COLUMN_NAME em maiúsculas para bater com as chaves normalizadas pelo query()
      const colunas = resolvidas.map(def => ({
        COLUMN_NAME: `${def.src.toUpperCase()}_${def.col}`,
        DATA_TYPE:   tipoOf[def.src]?.get(def.col) || 'text',
        GRUPO:       def.grupo,
      }));

      return { total, registros, colunas };
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

/* ── GET /api/:schema/pedidos-lista — lista simplificada com valor total ── */
router.get('/:schema/pedidos-lista', authJwt, checkSchema, async (req, res) => {
  const { schema } = req.params;
  const page     = Math.max(1, parseInt(req.query.page)     || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 50));
  const q        = req.query.q?.trim() || '';
  const status   = req.query.status?.trim() || '';
  const sortCol  = req.query.sortCol?.trim() || '';
  const sortDir  = (req.query.sortDir?.trim() || 'DESC').toUpperCase();
  if (sortCol && !NOME_VALIDO.test(sortCol)) return res.status(400).json({ erro: 'sortCol inválido' });
  if (!['ASC', 'DESC'].includes(sortDir))   return res.status(400).json({ erro: 'sortDir inválido' });
  const idLojaObrigatorio = req.userLojas?.[schema] ?? null;
  const filtroLojaParam   = req.query.filtroLoja ? parseInt(req.query.filtroLoja) : null;
  const idLojaFiltro      = idLojaObrigatorio ?? filtroLojaParam;
  try {
    const result = await withTenantConnection(schema, async db => {
      const colsP = await colunasTabela(db, schema, 'PEDIDOS').catch(() => []);
      const colsI = await colunasTabela(db, schema, 'PEDIDOS_ITENS').catch(() => []);
      if (!colsP.length) return { total: 0, registros: [], statusOptions: [] };

      const colNamesP = new Set(colsP.map(c => c.COLUMN_NAME));
      const colNamesI = new Set(colsI.map(c => c.COLUMN_NAME));

      const select = ['p.ID_PEDIDO'];
      if (colNamesP.has('ID_CLIENTE'))     select.push('p.ID_CLIENTE');
      if (colNamesP.has('NOME_CLIENTE'))   select.push('p.NOME_CLIENTE');
      if (colNamesP.has('DATA_DO_PEDIDO')) select.push('p.DATA_DO_PEDIDO');
      if (colNamesP.has('STATUS'))         select.push('p.STATUS');
      if (colsI.length && colNamesI.has('VALOR_UNITARIO') && colNamesI.has('QUANTIDADE')) {
        select.push(`(SELECT COALESCE(SUM(pi.VALOR_UNITARIO * pi.QUANTIDADE), 0) FROM PEDIDOS_ITENS pi WHERE pi.ID_PEDIDO = p.ID_PEDIDO) AS VALOR_TOTAL`);
      }

      const statusOptions = colNamesP.has('STATUS')
        ? (await query(db, `SELECT DISTINCT STATUS FROM PEDIDOS WHERE STATUS IS NOT NULL ORDER BY STATUS`, [])).map(r => r.STATUS)
        : [];

      const params = [];
      const whereParts = [];
      if (q) {
        params.push(`%${q}%`);
        const qConds = [`p.ID_PEDIDO::TEXT ILIKE $${params.length}`];
        if (colNamesP.has('NOME_CLIENTE')) qConds.push(`p.NOME_CLIENTE ILIKE $${params.length}`);
        whereParts.push(`(${qConds.join(' OR ')})`);
      }
      if (status && colNamesP.has('STATUS')) {
        params.push(status);
        whereParts.push(`p.STATUS = $${params.length}`);
      }
      if (idLojaFiltro !== null && colNamesP.has('ID_LOJA')) {
        params.push(idLojaFiltro);
        whereParts.push(`p.ID_LOJA = $${params.length}`);
      }
      const where = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

      const SORT_COLS_DIRETOS = new Set(['ID_PEDIDO', 'ID_CLIENTE', 'NOME_CLIENTE', 'DATA_DO_PEDIDO', 'STATUS', 'ID_LOJA']);
      const sortUpper = sortCol.toUpperCase();
      const sortByValorTotal = sortUpper === 'VALOR_TOTAL' && select.some(s => s.includes('VALOR_TOTAL'));

      const countRows = await query(db, `SELECT COUNT(*) AS cnt FROM PEDIDOS p ${where}`, params);
      const total  = parseInt(countRows[0].CNT);
      const offset = (page - 1) * pageSize;
      params.push(pageSize, offset);

      let registros;
      if (sortByValorTotal) {
        // VALOR_TOTAL é alias de subquery — envolver num derived table para ordenar
        registros = await query(db,
          `SELECT * FROM (SELECT ${select.join(', ')} FROM PEDIDOS p ${where}) _sub ORDER BY VALOR_TOTAL ${sortDir} LIMIT $${params.length - 1} OFFSET $${params.length}`,
          params
        );
      } else {
        const orderBy = (sortCol && SORT_COLS_DIRETOS.has(sortUpper) && colNamesP.has(sortUpper))
          ? `p.${sortCol} ${sortDir}`
          : 'p.ID_PEDIDO DESC';
        registros = await query(db,
          `SELECT ${select.join(', ')} FROM PEDIDOS p ${where} ORDER BY ${orderBy} LIMIT $${params.length - 1} OFFSET $${params.length}`,
          params
        );
      }
      return { total, registros, statusOptions };
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

/* ── GET /api/:schema/pedidos/:id/itens ── */
router.get('/:schema/pedidos/:id/itens', authJwt, checkSchema, async (req, res) => {
  const { schema, id } = req.params;
  if (!/^\d+$/.test(id)) return res.status(400).json({ erro: 'id inválido' });
  try {
    const rows = await withTenantConnection(schema, async db => {
      const colsI  = await colunasTabela(db, schema, 'PEDIDOS_ITENS').catch(() => []);
      const colsPR = await colunasTabela(db, schema, 'PRODUTOS').catch(() => []);
      if (!colsI.length) return [];

      const colNamesI  = new Set(colsI .map(c => c.COLUMN_NAME));
      const colNamesPR = new Set(colsPR.map(c => c.COLUMN_NAME));

      const select = ['pi.ID_PEDIDO_ITEM', 'pi.ID_PRODUTO'];
      let joinPR = '';
      if (colsPR.length && colNamesI.has('ID_PRODUTO')) {
        joinPR = 'LEFT JOIN PRODUTOS pr ON pr.ID_PRODUTO = pi.ID_PRODUTO';
        const descCol = colNamesPR.has('DESCRICAO_PRODUTO') ? 'pr.DESCRICAO_PRODUTO'
                      : colNamesPR.has('DESCRICAO')         ? 'pr.DESCRICAO'
                      : colNamesPR.has('NOME')              ? 'pr.NOME'
                      : null;
        if (descCol) select.push(`${descCol} AS DESCRICAO`);
        if (colNamesPR.has('UNIDADE')) select.push('pr.UNIDADE');
      }
      if (colNamesI.has('QUANTIDADE'))     select.push('pi.QUANTIDADE');
      if (colNamesI.has('VALOR_UNITARIO')) select.push('pi.VALOR_UNITARIO');
      if (colNamesI.has('VALOR_UNITARIO') && colNamesI.has('QUANTIDADE'))
        select.push('(pi.VALOR_UNITARIO * pi.QUANTIDADE) AS VALOR_TOTAL_ITEM');

      return query(db,
        `SELECT ${select.join(', ')} FROM PEDIDOS_ITENS pi ${joinPR} WHERE pi.ID_PEDIDO = $1 ORDER BY pi.ID_PEDIDO_ITEM`,
        [id]
      );
    });
    res.json(rows);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

/* ── GET /api/:schema/dashboard/faturamento-por-loja ── */
router.get('/:schema/dashboard/faturamento-por-loja', authJwt, checkSchema, async (req, res) => {
  const { schema } = req.params;
  const { ano, mes } = req.query;

  try {
    const result = await withTenantConnection(schema, async db => {
      const colsP  = await colunasTabela(db, schema, 'PEDIDOS').catch(() => []);
      const colsI  = await colunasTabela(db, schema, 'PEDIDOS_ITENS').catch(() => []);
      const colsAG = await colunasTabela(db, schema, 'AUX_GENERICA').catch(() => []);
      const colsSF = await colunasTabela(db, schema, 'sync_filiais').catch(() => []);
      if (!colsP.length) return [];

      const colNamesP = new Set(colsP.map(c => c.COLUMN_NAME));
      const colNamesI = new Set(colsI.map(c => c.COLUMN_NAME));
      if (!colNamesP.has('ID_LOJA')) return [];

      // Detectar coluna de data e seu tipo real (pode ter sido migrado como text)
      const DATA_COLS = ['DATA_DO_PEDIDO', 'DATA_HORA', 'DATA_EMISSAO'];
      const dataCol   = DATA_COLS.find(c => colNamesP.has(c)) ?? null;
      const dataType  = dataCol ? colsP.find(c => c.COLUMN_NAME === dataCol)?.DATA_TYPE ?? 'text' : null;
      const isNativeDate = dataType && (dataType.startsWith('timestamp') || dataType === 'date');
      const dateExpr  = dataCol
        ? (isNativeDate ? `p.${dataCol}` : `NULLIF(p.${dataCol}, '')::DATE`)
        : null;

      const hasValor  = colsI.length && colNamesI.has('VALOR_UNITARIO') && colNamesI.has('QUANTIDADE');
      const hasSF     = colsSF.length > 0;  // sync_filiais — preenchida automaticamente pelo cliente
      const hasAuxGen = colsAG.length > 0;  // AUX_GENERICA — fallback configurado manualmente

      const params = [];
      const whereParts = [];
      if (dateExpr && ano && /^\d{4}$/.test(ano)) {
        params.push(parseInt(ano));
        whereParts.push(`EXTRACT(YEAR FROM ${dateExpr}) = $${params.length}`);
      }
      const mesInt = parseInt(mes);
      if (dateExpr && mes && /^\d{1,2}$/.test(mes) && mesInt >= 1 && mesInt <= 12) {
        params.push(mesInt);
        whereParts.push(`EXTRACT(MONTH FROM ${dateExpr}) = $${params.length}`);
      }
      const where = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

      // Prioridade do nome: sync_filiais (auto) > AUX_GENERICA (manual) > 'Loja N'
      const nomeLojaExpr = [
        hasSF     && `MAX(sf.nome)`,
        hasAuxGen && `MAX(ag.DESCRICAO)`,
        `'Loja ' || COALESCE(p.ID_LOJA::TEXT, '?')`,
      ].filter(Boolean).reduce((acc, expr) => `COALESCE(${acc}, ${expr})`);

      const joinSF = hasSF
        ? `LEFT JOIN sync_filiais sf ON sf.id_loja = p.ID_LOJA`
        : '';
      const joinAG = hasAuxGen
        ? `LEFT JOIN AUX_GENERICA ag ON ag.SUB_TABELA = 'Lojas' AND CAST(ag.ID_SUB_TABELA AS TEXT) = CAST(p.ID_LOJA AS TEXT)`
        : '';

      return query(db, `
        SELECT
          p.ID_LOJA,
          ${nomeLojaExpr} AS NOME_LOJA,
          COUNT(DISTINCT p.ID_PEDIDO) AS QTD_PEDIDOS,
          ${hasValor
            ? 'COALESCE(SUM(pi.VALOR_UNITARIO * pi.QUANTIDADE), 0) AS FATURAMENTO'
            : '0 AS FATURAMENTO'}
        FROM PEDIDOS p
        ${hasValor ? 'LEFT JOIN PEDIDOS_ITENS pi ON pi.ID_PEDIDO = p.ID_PEDIDO' : ''}
        ${joinSF}
        ${joinAG}
        ${where}
        GROUP BY p.ID_LOJA
        ORDER BY p.ID_LOJA
      `, params);
    });
    res.json(result);
  } catch (e) {
    if (isMissingTableError(e)) return res.json([]);
    res.status(500).json({ erro: e.message });
  }
});

/* ── GET /api/:schema/pedidos/:id/pagamentos ── */
router.get('/:schema/pedidos/:id/pagamentos', authJwt, checkSchema, async (req, res) => {
  const { schema, id } = req.params;
  if (!/^\d+$/.test(id)) return res.status(400).json({ erro: 'id inválido' });
  try {
    const result = await withTenantConnection(schema, async db => {
      const cols = await colunasTabela(db, schema, 'PEDIDOS_PARCELAS_PAGAMENTOS').catch(() => []);
      if (!cols.length) return { colunas: [], registros: [] };
      const colsVisiveis = cols.filter(c => !COLS_OCULTAS.has(c.COLUMN_NAME) && c.COLUMN_NAME !== 'ID_PEDIDO');
      if (!colsVisiveis.length) return { colunas: [], registros: [] };
      const select = colsVisiveis.map(c => `pp.${c.COLUMN_NAME}`);
      const registros = await query(db,
        `SELECT ${select.join(', ')} FROM PEDIDOS_PARCELAS_PAGAMENTOS pp WHERE pp.ID_PEDIDO = $1 ORDER BY pp.PARCELA`,
        [id]
      );
      return {
        colunas: colsVisiveis.map(c => ({ COLUMN_NAME: c.COLUMN_NAME, DATA_TYPE: c.DATA_TYPE })),
        registros,
      };
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

module.exports = router;
