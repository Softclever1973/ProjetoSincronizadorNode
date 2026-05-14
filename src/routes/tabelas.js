const express = require('express');
const router  = express.Router();
const authJwt = require('../middleware/authJwt');
const { withTenantConnection, query, execute, isMissingTableError } = require('../db');

const NOME_VALIDO = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

  if (cols) {
    const lista = cols.split(',').map(c => c.trim()).filter(Boolean);
    if (lista.some(c => !NOME_VALIDO.test(c))) return res.status(400).json({ erro: 'cols inválido' });
  }
  if (statusCol && !NOME_VALIDO.test(statusCol)) return res.status(400).json({ erro: 'statusCol inválido' });
  if (statusVal && !['A', 'I'].includes(statusVal)) return res.status(400).json({ erro: 'statusVal inválido' });

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

      const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

      const countRows = await query(db, `SELECT COUNT(*) AS cnt FROM ${tabela} ${where}`, params);
      const total     = parseInt(countRows[0].CNT);
      const offset    = (page - 1) * pageSize;
      params.push(pageSize, offset);
      const registros = await query(db,
        `SELECT * FROM ${tabela} ${where} ORDER BY 1 LIMIT $${params.length - 1} OFFSET $${params.length}`,
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
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

/* ── DELETE /api/:schema/tabelas/:tabela ── */
router.delete('/:schema/tabelas/:tabela', authJwt, checkSchema, async (req, res) => {
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
    res.json({ ok: true });
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
      const [colsP, colsI, colsPP, colsPR] = await Promise.all([
        colunasTabela(db, schema, 'PEDIDOS').catch(() => []),
        colunasTabela(db, schema, 'PEDIDOS_ITENS').catch(() => []),
        colunasTabela(db, schema, 'PEDIDOS_PARCELAS_PAGAMENTOS').catch(() => []),
        colunasTabela(db, schema, 'PRODUTOS').catch(() => []),
      ]);

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
  try {
    const result = await withTenantConnection(schema, async db => {
      const [colsP, colsI] = await Promise.all([
        colunasTabela(db, schema, 'PEDIDOS').catch(() => []),
        colunasTabela(db, schema, 'PEDIDOS_ITENS').catch(() => []),
      ]);
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
      const where = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

      const countRows = await query(db, `SELECT COUNT(*) AS cnt FROM PEDIDOS p ${where}`, params);
      const total  = parseInt(countRows[0].CNT);
      const offset = (page - 1) * pageSize;
      params.push(pageSize, offset);
      const registros = await query(db,
        `SELECT ${select.join(', ')} FROM PEDIDOS p ${where} ORDER BY p.ID_PEDIDO DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );
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
      const [colsI, colsPR] = await Promise.all([
        colunasTabela(db, schema, 'PEDIDOS_ITENS').catch(() => []),
        colunasTabela(db, schema, 'PRODUTOS').catch(() => []),
      ]);
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
