/**
 * Rotas de pedidos do tenant.
 * GET /api/:schema/pedidos-completo
 * GET /api/:schema/pedidos-lista
 * GET /api/:schema/pedidos/:id/itens
 * GET /api/:schema/pedidos/:id/pagamentos
 */

const express = require('express');
const router  = express.Router();

const authJwt             = require('../../middleware/authJwt');
const { checkSchema }     = require('../../middleware/checkSchema');
const { withTenantConnection, query, isMissingTableError } = require('../../db');
const { NOME_VALIDO, COLS_OCULTAS, COLS_FLAT, NAME_CANDIDATES, SORT_COLS_DIRETOS } = require('./constants');
const { colunasTabela, resolveIdLoja } = require('./helpers');

/* ── GET /api/:schema/pedidos-completo — JOIN das 3 tabelas de pedido ── */
router.get('/:schema/pedidos-completo', authJwt, checkSchema, async (req, res) => {
  const { schema } = req.params;
  const page     = Math.max(1, parseInt(req.query.page)     || 1);
  const pageSize = Math.min(500, Math.max(1, parseInt(req.query.pageSize) || 50));
  const q        = req.query.q?.trim() || '';
  const idLojaPC = resolveIdLoja(req, schema);

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
        colsI.length    ? 'LEFT JOIN PEDIDOS_ITENS pi ON pi.ID_PEDIDO = p.ID_PEDIDO'                : '',
        srcAtivo.pr     ? 'LEFT JOIN PRODUTOS pr ON pr.ID_PRODUTO = pi.ID_PRODUTO'                  : '',
        colsPP.length   ? 'LEFT JOIN PEDIDOS_PARCELAS_PAGAMENTOS pp ON pp.ID_PEDIDO = p.ID_PEDIDO'  : '',
      ].filter(Boolean).join(' ');

      const params     = [];
      const whereParts = [];
      if (q) {
        params.push(`%${q}%`);
        whereParts.push(`p.ID_PEDIDO::TEXT ILIKE $${params.length}`);
      }
      // Não-donos veem apenas pedidos da sua loja
      if (idLojaPC !== null && existe.p.has('ID_LOJA')) {
        params.push(idLojaPC);
        whereParts.push(`p.ID_LOJA = $${params.length}`);
      }
      const where = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

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
  const q          = req.query.q?.trim() || '';
  const status     = req.query.status?.trim() || '';
  const dataInicio = req.query.dataInicio?.trim() || '';
  const dataFim    = req.query.dataFim?.trim()    || '';
  const sortCol    = req.query.sortCol?.trim() || '';
  const sortDir    = (req.query.sortDir?.trim() || 'DESC').toUpperCase();
  const valorMin   = req.query.valorMin?.trim() ? parseFloat(req.query.valorMin) : null;
  const valorMax   = req.query.valorMax?.trim() ? parseFloat(req.query.valorMax) : null;
  const idVendedor = req.query.idVendedor?.trim() || '';
  if (sortCol && !NOME_VALIDO.test(sortCol)) return res.status(400).json({ erro: 'sortCol inválido' });
  if (!['ASC', 'DESC'].includes(sortDir))   return res.status(400).json({ erro: 'sortDir inválido' });
  const idLojaFiltro = resolveIdLoja(req, schema, { donoPodemFiltrar: true });

  try {
    const result = await withTenantConnection(schema, async db => {
      const colsP = await colunasTabela(db, schema, 'PEDIDOS').catch(() => []);
      const colsI = await colunasTabela(db, schema, 'PEDIDOS_ITENS').catch(() => []);
      if (!colsP.length) return { total: 0, registros: [], statusOptions: [] };

      const colNamesP = new Set(colsP.map(c => c.COLUMN_NAME));
      const colNamesI = new Set(colsI.map(c => c.COLUMN_NAME));

      // Detecta coluna de vendedor (ID_VENDEDOR ou NOME_VENDEDOR)
      let vendedorCol = null;
      if (colNamesP.has('ID_VENDEDOR'))       vendedorCol = 'ID_VENDEDOR';
      else if (colNamesP.has('NOME_VENDEDOR')) vendedorCol = 'NOME_VENDEDOR';

      const temVtItem    = colsI.length > 0 && colNamesI.has('VALOR_TOTAL_ITEM');
      const temCalcTotal = colsI.length > 0 && colNamesI.has('VALOR_UNITARIO') && colNamesI.has('QUANTIDADE');
      const temValorTotal = temVtItem || temCalcTotal;
      // Prefere a coluna armazenada VALOR_TOTAL_ITEM (preenchida pelo Delphi/trigger)
      // para evitar 0,00 quando VALOR_UNITARIO está zerado no servidor
      const exprValorItem = temVtItem ? 'pi.VALOR_TOTAL_ITEM' : 'pi.VALOR_UNITARIO * pi.QUANTIDADE';

      const select = ['p.ID_PEDIDO'];
      if (colNamesP.has('ID_CLIENTE'))     select.push('p.ID_CLIENTE');
      if (colNamesP.has('NOME_CLIENTE'))   select.push('p.NOME_CLIENTE');
      if (colNamesP.has('DATA_DO_PEDIDO')) select.push('p.DATA_DO_PEDIDO');
      if (colNamesP.has('STATUS'))         select.push('p.STATUS');
      if (vendedorCol)                     select.push(`p.${vendedorCol}`);
      if (temValorTotal) {
        select.push(`(SELECT COALESCE(SUM(${exprValorItem}), 0) FROM PEDIDOS_ITENS pi WHERE pi.ID_PEDIDO = p.ID_PEDIDO) AS VALOR_TOTAL`);
      }

      const statusOptions = colNamesP.has('STATUS')
        ? (await query(db, `SELECT DISTINCT STATUS FROM PEDIDOS WHERE STATUS IS NOT NULL ORDER BY STATUS`, [])).map(r => r.STATUS)
        : [];

      // Opções de vendedor: se a coluna for ID_VENDEDOR, tenta resolver o nome via JOIN com VENDEDORES
      // Retorna [{ value, label }] — value é o que vai no filtro, label é o que aparece no select
      let vendedorOptions = [];
      if (vendedorCol === 'ID_VENDEDOR') {
        try {
          // Descobre dinamicamente qual coluna de nome existe em VENDEDORES.
          // Usa colunasTabela() que já normaliza para UPPERCASE e faz LOWER(table_name),
          // evitando falhas de case-sensitivity no information_schema do PostgreSQL.
          const colsV = await colunasTabela(db, schema, 'VENDEDORES').catch(() => []);
          const colNamesV = new Set(colsV.map(c => c.COLUMN_NAME));
          const nomeColVend = NAME_CANDIDATES.find(c => colNamesV.has(c)) || null;
          const hasLojaVend = colNamesV.has('ID_LOJA');

          // Mesmo filtro de loja aplicado na listagem principal
          const vParams = [];
          const vWhere  = ['p.ID_VENDEDOR IS NOT NULL'];
          if (idLojaFiltro !== null && colNamesP.has('ID_LOJA')) {
            vParams.push(idLojaFiltro);
            vWhere.push(`p.ID_LOJA = $${vParams.length}`);
          }

          if (nomeColVend) {
            // Quando dono vê todas as lojas e VENDEDORES tem ID_LOJA:
            // acrescenta "(Loja X)" ao label para diferenciar vendedores de lojas distintas.
            const lblExpr = (idLojaFiltro === null && hasLojaVend)
              ? `COALESCE(NULLIF(TRIM(v.${nomeColVend}::TEXT), ''), p.ID_VENDEDOR::TEXT)
                 || CASE WHEN v.ID_LOJA IS NOT NULL THEN ' (Loja ' || v.ID_LOJA::TEXT || ')' ELSE '' END`
              : `COALESCE(NULLIF(TRIM(v.${nomeColVend}::TEXT), ''), p.ID_VENDEDOR::TEXT)`;

            const rows = await query(db, `
              SELECT DISTINCT p.ID_VENDEDOR AS val, ${lblExpr} AS lbl
              FROM PEDIDOS p
              LEFT JOIN VENDEDORES v ON v.ID_VENDEDOR = p.ID_VENDEDOR
              WHERE ${vWhere.join(' AND ')}
              ORDER BY lbl
              LIMIT 200
            `, vParams);
            vendedorOptions = rows.map(r => ({ value: String(r.VAL), label: String(r.LBL) }));
          } else {
            // VENDEDORES não existe ou não tem coluna de nome reconhecível — usa só o ID
            const fbWhere = ['ID_VENDEDOR IS NOT NULL'];
            const fbParams = [];
            if (idLojaFiltro !== null && colNamesP.has('ID_LOJA')) {
              fbParams.push(idLojaFiltro);
              fbWhere.push(`ID_LOJA = $${fbParams.length}`);
            }
            const rows = await query(db,
              `SELECT DISTINCT ID_VENDEDOR AS val FROM PEDIDOS WHERE ${fbWhere.join(' AND ')} ORDER BY val LIMIT 200`,
              fbParams
            ).catch(() => []);
            vendedorOptions = rows.map(r => ({ value: String(r.VAL), label: String(r.VAL) }));
          }
        } catch {
          // Erro inesperado — fallback seguro (sem filtro de loja)
          const rows = await query(db,
            `SELECT DISTINCT ID_VENDEDOR AS val FROM PEDIDOS WHERE ID_VENDEDOR IS NOT NULL ORDER BY val LIMIT 200`,
            []
          ).catch(() => []);
          vendedorOptions = rows.map(r => ({ value: String(r.VAL), label: String(r.VAL) }));
        }
      } else if (vendedorCol) {
        const fbWhere = [`${vendedorCol} IS NOT NULL`];
        const fbParams = [];
        if (idLojaFiltro !== null && colNamesP.has('ID_LOJA')) {
          fbParams.push(idLojaFiltro);
          fbWhere.push(`ID_LOJA = $${fbParams.length}`);
        }
        const rows = await query(db,
          `SELECT DISTINCT ${vendedorCol} AS val FROM PEDIDOS WHERE ${fbWhere.join(' AND ')} ORDER BY val LIMIT 200`,
          fbParams
        ).catch(() => []);
        vendedorOptions = rows.map(r => ({ value: String(r.VAL), label: String(r.VAL) }));
      }

      const params     = [];
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
      if (dataInicio && colNamesP.has('DATA_DO_PEDIDO')) {
        params.push(dataInicio);
        whereParts.push(`p.DATA_DO_PEDIDO >= $${params.length}`);
      }
      if (dataFim && colNamesP.has('DATA_DO_PEDIDO')) {
        params.push(dataFim);
        whereParts.push(`p.DATA_DO_PEDIDO <= $${params.length}`);
      }
      if (idLojaFiltro !== null && colNamesP.has('ID_LOJA')) {
        params.push(idLojaFiltro);
        whereParts.push(`p.ID_LOJA = $${params.length}`);
      }
      if (idVendedor && vendedorCol) {
        params.push(idVendedor);
        whereParts.push(`p.${vendedorCol}::TEXT = $${params.length}`);
      }
      // Filtro de faixa de valor total (subquery inline no WHERE) — usa a mesma expressão do SELECT
      if (temValorTotal) {
        const subqValor = `(SELECT COALESCE(SUM(${exprValorItem}), 0) FROM PEDIDOS_ITENS pi WHERE pi.ID_PEDIDO = p.ID_PEDIDO)`;
        if (valorMin !== null && !isNaN(valorMin)) { params.push(valorMin); whereParts.push(`${subqValor} >= $${params.length}`); }
        if (valorMax !== null && !isNaN(valorMax)) { params.push(valorMax); whereParts.push(`${subqValor} <= $${params.length}`); }
      }
      const where = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

      const sortUpper       = sortCol.toUpperCase();
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
      return { total, registros, statusOptions, vendedorOptions, vendedorCol };
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
  const idLojaJwt = resolveIdLoja(req, schema);
  try {
    const rows = await withTenantConnection(schema, async db => {
      // Não-donos só podem ver itens de pedidos da sua loja
      if (idLojaJwt !== null) {
        const pedido = await query(db, `SELECT ID_LOJA FROM PEDIDOS WHERE ID_PEDIDO = $1 LIMIT 1`, [id]);
        if (!pedido.length || Number(pedido[0].ID_LOJA) !== idLojaJwt)
          return null; // acesso negado
      }
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
      // Prefere a coluna armazenada; calcula como fallback se VALOR_TOTAL_ITEM não existir
      if (colNamesI.has('VALOR_TOTAL_ITEM')) {
        select.push('pi.VALOR_TOTAL_ITEM');
      } else if (colNamesI.has('VALOR_UNITARIO') && colNamesI.has('QUANTIDADE')) {
        select.push('(pi.VALOR_UNITARIO * pi.QUANTIDADE) AS VALOR_TOTAL_ITEM');
      }

      return query(db,
        `SELECT ${select.join(', ')} FROM PEDIDOS_ITENS pi ${joinPR} WHERE pi.ID_PEDIDO = $1 ORDER BY pi.ID_PEDIDO_ITEM`,
        [id]
      );
    });
    if (rows === null) return res.status(403).json({ erro: 'pedido não pertence à sua loja' });
    res.json(rows);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

/* ── GET /api/:schema/pedidos/:id/pagamentos ── */
router.get('/:schema/pedidos/:id/pagamentos', authJwt, checkSchema, async (req, res) => {
  const { schema, id } = req.params;
  if (!/^\d+$/.test(id)) return res.status(400).json({ erro: 'id inválido' });
  const idLojaJwt = resolveIdLoja(req, schema);
  try {
    const result = await withTenantConnection(schema, async db => {
      // Não-donos só podem ver pagamentos de pedidos da sua loja
      if (idLojaJwt !== null) {
        const pedido = await query(db, `SELECT ID_LOJA FROM PEDIDOS WHERE ID_PEDIDO = $1 LIMIT 1`, [id]);
        if (!pedido.length || Number(pedido[0].ID_LOJA) !== idLojaJwt)
          return null; // acesso negado
      }
      const cols = await colunasTabela(db, schema, 'PEDIDOS_PARCELAS_PAGAMENTOS').catch(() => []);
      if (!cols.length) return { colunas: [], registros: [] };
      const colsVisiveis = cols.filter(c => !COLS_OCULTAS.has(c.COLUMN_NAME) && c.COLUMN_NAME !== 'ID_PEDIDO');
      if (!colsVisiveis.length) return { colunas: [], registros: [] };
      const select   = colsVisiveis.map(c => `pp.${c.COLUMN_NAME}`);
      const registros = await query(db,
        `SELECT ${select.join(', ')} FROM PEDIDOS_PARCELAS_PAGAMENTOS pp WHERE pp.ID_PEDIDO = $1 ORDER BY pp.PARCELA`,
        [id]
      );
      return {
        colunas: colsVisiveis.map(c => ({ COLUMN_NAME: c.COLUMN_NAME, DATA_TYPE: c.DATA_TYPE })),
        registros,
      };
    });
    if (result === null) return res.status(403).json({ erro: 'pedido não pertence à sua loja' });
    res.json(result);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

module.exports = router;
