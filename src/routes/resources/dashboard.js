/**
 * Rotas de dashboard do tenant.
 * GET /api/:schema/dashboard
 * GET /api/:schema/dashboard/faturamento-por-loja
 * GET /api/:schema/dashboard/evolucao-mensal
 * GET /api/:schema/dashboard/evolucao-mensal-por-loja
 * GET /api/:schema/dashboard/top-produtos
 * GET /api/:schema/dashboard/pedidos-por-status
 * GET /api/:schema/dashboard/faturamento-por-vendedor
 */

const express = require('express');
const router  = express.Router();

const authJwt             = require('../../middleware/authJwt');
const { requireRole }     = require('../../middleware/checkRole');
const { checkSchema }     = require('../../middleware/checkSchema');
const { withTenantConnection, query, isMissingTableError } = require('../../db');
const { COLS_DATA_PEDIDO } = require('./constants');
const { colunasTabela, resolveIdLoja, buildNomeLojaExpr, buildWhere } = require('./helpers');

/* ── GET /api/:schema/dashboard ── */
router.get('/:schema/dashboard', authJwt, checkSchema, async (req, res) => {
  const { schema } = req.params;
  const lojaFiltro = resolveIdLoja(req, schema, { donoPodemFiltrar: true });

  try {
    const hoje = new Date().toISOString().slice(0, 10);

    // ── Parâmetros parametrizados para cada query (sem interpolação de lojaFiltro) ──
    const paramsClientes    = lojaFiltro !== null ? [lojaFiltro] : [];
    const lojaWhereClientes = lojaFiltro !== null ? 'AND ID_LOJA = $1' : '';

    // queries com hoje como $1 — lojaFiltro vira $2 se presente
    const paramsComHoje = lojaFiltro !== null ? [hoje, lojaFiltro] : [hoje];
    const lojaWhereHoje = lojaFiltro !== null ? 'AND p.ID_LOJA = $2' : '';

    const [clientes, pedidosHoje, faturamentoHoje, produtosAtivos] = await Promise.all([
      withTenantConnection(schema, db => query(db,
        `SELECT COUNT(*) AS cnt FROM CLIENTES WHERE TRIM(SITUACAO::TEXT) = 'A' ${lojaWhereClientes}`,
        paramsClientes
      )).catch(() => [{ CNT: 0 }]),
      withTenantConnection(schema, db => query(db,
        `SELECT COUNT(*) AS cnt FROM PEDIDOS p WHERE p.DATA_DO_PEDIDO = $1 ${lojaWhereHoje}`,
        paramsComHoje
      )).catch(() => [{ CNT: 0 }]),
      withTenantConnection(schema, db => query(db, `
        SELECT COALESCE(SUM(pi.VALOR_UNITARIO * pi.QUANTIDADE), 0) AS total
        FROM PEDIDOS p
        JOIN PEDIDOS_ITENS pi ON pi.ID_PEDIDO = p.ID_PEDIDO
        WHERE p.DATA_DO_PEDIDO = $1 ${lojaWhereHoje}`,
        paramsComHoje
      )).catch(() => [{ TOTAL: 0 }]),
      withTenantConnection(schema, db => query(db,
        `SELECT COUNT(*) AS cnt FROM PRODUTOS WHERE TRIM(SITUACAO::TEXT) = 'A'`,
        []
      )).catch(() => [{ CNT: 0 }]),
    ]);

    res.json({
      clientesAtivos:  parseInt(clientes[0]?.CNT     ?? 0),
      pedidosHoje:     parseInt(pedidosHoje[0]?.CNT  ?? 0),
      faturamentoHoje: parseFloat(faturamentoHoje[0]?.TOTAL ?? 0),
      produtosAtivos:  parseInt(produtosAtivos[0]?.CNT ?? 0),
    });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

/* ── GET /api/:schema/dashboard/faturamento-por-loja ── */
router.get('/:schema/dashboard/faturamento-por-loja', authJwt, checkSchema, requireRole('gerente', 'dono'), async (req, res) => {
  const { schema } = req.params;
  const { ano, mes, anoInicio, mesInicio, anoFim, mesFim } = req.query;

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
      const dataCol      = COLS_DATA_PEDIDO.find(c => colNamesP.has(c)) ?? null;
      const dataType     = dataCol ? colsP.find(c => c.COLUMN_NAME === dataCol)?.DATA_TYPE ?? 'text' : null;
      const isNativeDate = dataType && (dataType.startsWith('timestamp') || dataType === 'date');
      const dateExpr     = dataCol
        ? (isNativeDate ? `p.${dataCol}` : `NULLIF(p.${dataCol}, '')::DATE`)
        : null;

      const hasValor  = colsI.length && colNamesI.has('VALOR_UNITARIO') && colNamesI.has('QUANTIDADE');
      const hasSF     = colsSF.length > 0;
      const hasAuxGen = colsAG.length > 0;

      const idLojaF = resolveIdLoja(req, schema);

      /* reutiliza buildWhere para aplicar o mesmo filtro de data/loja dos demais gráficos */
      const params = [];
      const { whereParts } = buildWhere(colsP, { ano, mes, idLojaF, anoInicio, mesInicio, anoFim, mesFim }, params);
      const where = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

      // Prioridade do nome: sync_filiais (auto) > AUX_GENERICA (manual) > 'Loja N'
      const { nomeLojaExpr, joinSF, joinAG } = buildNomeLojaExpr({ hasSF, hasAuxGen });

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

/* ── GET /api/:schema/dashboard/evolucao-mensal ── */
router.get('/:schema/dashboard/evolucao-mensal', authJwt, checkSchema, requireRole('gerente', 'dono'), async (req, res) => {
  const { schema } = req.params;
  const { ano, mes, anoInicio, mesInicio, anoFim, mesFim } = req.query;
  const idLojaF = resolveIdLoja(req, schema, { donoPodemFiltrar: true });

  try {
    const result = await withTenantConnection(schema, async db => {
      const colsP = await colunasTabela(db, schema, 'PEDIDOS').catch(() => []);
      const colsI = await colunasTabela(db, schema, 'PEDIDOS_ITENS').catch(() => []);
      if (!colsP.length) return [];
      const params = [];
      const { whereParts, dateExpr } = buildWhere(colsP, { ano, mes, idLojaF, anoInicio, mesInicio, anoFim, mesFim }, params);
      if (!dateExpr) return [];
      const colsI_set = new Set(colsI.map(c => c.COLUMN_NAME));
      const hasValor  = colsI.length && colsI_set.has('VALOR_UNITARIO') && colsI_set.has('QUANTIDADE');
      const where     = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
      return query(db, `
        SELECT
          TO_CHAR(DATE_TRUNC('month', ${dateExpr}), 'YYYY-MM') AS MES,
          COUNT(DISTINCT p.ID_PEDIDO) AS QTD_PEDIDOS,
          ${hasValor ? 'COALESCE(SUM(pi.VALOR_UNITARIO * pi.QUANTIDADE), 0)' : '0'} AS FATURAMENTO
        FROM PEDIDOS p
        ${hasValor ? 'LEFT JOIN PEDIDOS_ITENS pi ON pi.ID_PEDIDO = p.ID_PEDIDO' : ''}
        ${where}
        GROUP BY DATE_TRUNC('month', ${dateExpr})
        ORDER BY DATE_TRUNC('month', ${dateExpr})
      `, params);
    });
    res.json(result);
  } catch (e) {
    if (isMissingTableError(e)) return res.json([]);
    res.status(500).json({ erro: e.message });
  }
});

/* ── GET /api/:schema/dashboard/evolucao-mensal-por-loja ── */
router.get('/:schema/dashboard/evolucao-mensal-por-loja', authJwt, checkSchema, requireRole('dono'), async (req, res) => {
  const { schema } = req.params;
  const { ano, mes, anoInicio, mesInicio, anoFim, mesFim } = req.query;
  const idLojaF = null; // dono only — want all stores

  try {
    const result = await withTenantConnection(schema, async db => {
      const colsP = await colunasTabela(db, schema, 'PEDIDOS').catch(() => []);
      const colsI = await colunasTabela(db, schema, 'PEDIDOS_ITENS').catch(() => []);
      if (!colsP.length) return [];
      const colsP_set = new Set(colsP.map(c => c.COLUMN_NAME));
      if (!colsP_set.has('ID_LOJA')) return [];
      const params = [];
      const { whereParts, dateExpr } = buildWhere(colsP, { ano, mes, idLojaF, anoInicio, mesInicio, anoFim, mesFim }, params);
      if (!dateExpr) return [];
      const colsI_set         = new Set(colsI.map(c => c.COLUMN_NAME));
      const hasValorTotalItem = colsI.length && colsI_set.has('VALOR_TOTAL_ITEM');
      const hasValorCalc      = colsI.length && colsI_set.has('VALOR_UNITARIO') && colsI_set.has('QUANTIDADE');
      const hasValor          = hasValorTotalItem || hasValorCalc;
      const valorExpr         = hasValorTotalItem ? 'pi.VALOR_TOTAL_ITEM' : 'pi.VALOR_UNITARIO * pi.QUANTIDADE';
      const where             = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

      const colsSF    = await colunasTabela(db, schema, 'sync_filiais').catch(() => []);
      const colsAG    = await colunasTabela(db, schema, 'AUX_GENERICA').catch(() => []);
      const hasSF     = colsSF.length > 0;
      const hasAuxGen = colsAG.length > 0;
      const { nomeLojaExpr, joinSF, joinAG } = buildNomeLojaExpr({ hasSF, hasAuxGen });

      return query(db, `
        SELECT
          p.ID_LOJA,
          ${nomeLojaExpr} AS NOME_LOJA,
          TO_CHAR(DATE_TRUNC('month', ${dateExpr}), 'YYYY-MM') AS MES,
          COUNT(DISTINCT p.ID_PEDIDO) AS QTD_PEDIDOS,
          ${hasValor ? `COALESCE(SUM(${valorExpr}), 0)` : '0'} AS FATURAMENTO
        FROM PEDIDOS p
        ${hasValor ? `LEFT JOIN PEDIDOS_ITENS pi ON pi.ID_PEDIDO = p.ID_PEDIDO` : ''}
        ${joinSF}
        ${joinAG}
        ${where}
        GROUP BY p.ID_LOJA, DATE_TRUNC('month', ${dateExpr})
        ORDER BY p.ID_LOJA, DATE_TRUNC('month', ${dateExpr})
      `, params);
    });
    res.json(result);
  } catch (e) {
    if (isMissingTableError(e)) return res.json([]);
    res.status(500).json({ erro: e.message });
  }
});

/* ── GET /api/:schema/dashboard/top-produtos ── */
router.get('/:schema/dashboard/top-produtos', authJwt, checkSchema, requireRole('gerente', 'dono'), async (req, res) => {
  const { schema } = req.params;
  const { ano, mes, anoInicio, mesInicio, anoFim, mesFim } = req.query;
  const idLojaF = resolveIdLoja(req, schema, { donoPodemFiltrar: true });

  try {
    const result = await withTenantConnection(schema, async db => {
      const colsP  = await colunasTabela(db, schema, 'PEDIDOS').catch(() => []);
      const colsI  = await colunasTabela(db, schema, 'PEDIDOS_ITENS').catch(() => []);
      const colsPR = await colunasTabela(db, schema, 'PRODUTOS').catch(() => []);
      if (!colsI.length) return [];
      const colNamesI  = new Set(colsI.map(c => c.COLUMN_NAME));
      const colNamesPR = new Set(colsPR.map(c => c.COLUMN_NAME));
      if (!colNamesI.has('VALOR_UNITARIO') || !colNamesI.has('QUANTIDADE') || !colNamesI.has('ID_PRODUTO')) return [];
      const params = [];
      const { whereParts } = buildWhere(colsP, { ano, mes, idLojaF, anoInicio, mesInicio, anoFim, mesFim }, params);
      const where   = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
      const descCol = colNamesPR.has('DESCRICAO') ? 'pr.DESCRICAO' : colNamesPR.has('NOME') ? 'pr.NOME' : null;
      const nomeExpr = descCol ? `COALESCE(${descCol}, pi.ID_PRODUTO::TEXT)` : `pi.ID_PRODUTO::TEXT`;
      const joinPR   = colsPR.length ? `LEFT JOIN PRODUTOS pr ON pr.ID_PRODUTO = pi.ID_PRODUTO` : '';
      return query(db, `
        SELECT
          pi.ID_PRODUTO,
          ${nomeExpr} AS NOME_PRODUTO,
          SUM(pi.QUANTIDADE) AS QTD_TOTAL,
          COALESCE(SUM(pi.VALOR_UNITARIO * pi.QUANTIDADE), 0) AS FATURAMENTO
        FROM PEDIDOS_ITENS pi
        ${joinPR}
        LEFT JOIN PEDIDOS p ON p.ID_PEDIDO = pi.ID_PEDIDO
        ${where}
        GROUP BY pi.ID_PRODUTO, ${nomeExpr}
        ORDER BY FATURAMENTO DESC
        LIMIT 10
      `, params);
    });
    res.json(result);
  } catch (e) {
    if (isMissingTableError(e)) return res.json([]);
    res.status(500).json({ erro: e.message });
  }
});

/* ── GET /api/:schema/dashboard/pedidos-por-status ── */
router.get('/:schema/dashboard/pedidos-por-status', authJwt, checkSchema, requireRole('gerente', 'dono'), async (req, res) => {
  const { schema } = req.params;
  const { ano, mes, anoInicio, mesInicio, anoFim, mesFim } = req.query;
  const idLojaF = resolveIdLoja(req, schema, { donoPodemFiltrar: true });

  try {
    const result = await withTenantConnection(schema, async db => {
      const colsP = await colunasTabela(db, schema, 'PEDIDOS').catch(() => []);
      if (!colsP.length || !new Set(colsP.map(c => c.COLUMN_NAME)).has('STATUS')) return [];
      const params = [];
      const { whereParts } = buildWhere(colsP, { ano, mes, idLojaF, anoInicio, mesInicio, anoFim, mesFim }, params);
      const where = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
      return query(db, `SELECT STATUS, COUNT(*) AS QTD FROM PEDIDOS p ${where} GROUP BY STATUS ORDER BY QTD DESC`, params);
    });
    res.json(result);
  } catch (e) {
    if (isMissingTableError(e)) return res.json([]);
    res.status(500).json({ erro: e.message });
  }
});

/* ── GET /api/:schema/dashboard/faturamento-por-vendedor ── */
router.get('/:schema/dashboard/faturamento-por-vendedor', authJwt, checkSchema, requireRole('gerente', 'dono'), async (req, res) => {
  const { schema } = req.params;
  const { ano, mes, anoInicio, mesInicio, anoFim, mesFim } = req.query;
  const idLojaF = resolveIdLoja(req, schema, { donoPodemFiltrar: true });

  try {
    const result = await withTenantConnection(schema, async db => {
      const colsP = await colunasTabela(db, schema, 'PEDIDOS').catch(() => []);
      const colsI = await colunasTabela(db, schema, 'PEDIDOS_ITENS').catch(() => []);
      const colsV = await colunasTabela(db, schema, 'VENDEDORES').catch(() => []);
      if (!colsP.length) return [];
      const colNamesP = new Set(colsP.map(c => c.COLUMN_NAME));
      const colNamesV = new Set(colsV.map(c => c.COLUMN_NAME));
      if (!colNamesP.has('ID_VENDEDOR')) return [];
      const colsI_set = new Set(colsI.map(c => c.COLUMN_NAME));
      const hasValor  = colsI.length && colsI_set.has('VALOR_UNITARIO') && colsI_set.has('QUANTIDADE');
      const params = [];
      const { whereParts } = buildWhere(colsP, { ano, mes, idLojaF, anoInicio, mesInicio, anoFim, mesFim }, params);
      whereParts.push('p.ID_VENDEDOR IS NOT NULL');
      const where    = `WHERE ${whereParts.join(' AND ')}`;
      const nomeCols = ['NOME', 'RAZAO_SOCIAL', 'FANTASIA', 'NOME_VENDEDOR'].filter(c => colNamesV.has(c)).map(c => `v.${c}`);
      const joinV    = colsV.length ? `LEFT JOIN VENDEDORES v ON v.ID_VENDEDOR = p.ID_VENDEDOR` : '';
      const nomePartes = [];
      if (nomeCols.length) nomePartes.push(...nomeCols);
      if (colNamesP.has('NOME_VENDEDOR')) nomePartes.push('p.NOME_VENDEDOR');
      nomePartes.push('p.ID_VENDEDOR::TEXT');
      const nomeExpr = `COALESCE(${nomePartes.join(', ')})`;
      return query(db, `
        SELECT
          p.ID_VENDEDOR,
          ${nomeExpr} AS NOME_VENDEDOR,
          COUNT(DISTINCT p.ID_PEDIDO) AS QTD_PEDIDOS,
          ${hasValor ? 'COALESCE(SUM(pi.VALOR_UNITARIO * pi.QUANTIDADE), 0)' : '0'} AS FATURAMENTO
        FROM PEDIDOS p
        ${hasValor ? 'LEFT JOIN PEDIDOS_ITENS pi ON pi.ID_PEDIDO = p.ID_PEDIDO' : ''}
        ${joinV}
        ${where}
        GROUP BY p.ID_VENDEDOR${colNamesP.has('NOME_VENDEDOR') ? ', p.NOME_VENDEDOR' : ''}${nomeCols.length ? ', ' + nomeCols.join(', ') : ''}
        ORDER BY FATURAMENTO DESC
        LIMIT 10
      `, params);
    });
    res.json(result);
  } catch (e) {
    if (isMissingTableError(e)) return res.json([]);
    res.status(500).json({ erro: e.message });
  }
});

module.exports = router;
