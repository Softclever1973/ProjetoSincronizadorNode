/**
 * Rotas de lista de preços do tenant (vincular/remover usa o CRUD genérico em PRODUTOS_X_LISTA).
 * GET /api/:schema/listas-precos
 * GET /api/:schema/listas-precos/:id/produtos
 */

const express = require('express');
const router  = express.Router();

const authJwt           = require('#server/interfaces/http/middleware/authJwt.js');
const { checkSchema }   = require('#server/interfaces/http/middleware/checkSchema.js');
const { requireModulo } = require('#server/interfaces/http/middleware/requireModulo.js');
const { withTenantConnection, query, isMissingTableError } = require('#server/infrastructure/db.js');
const { colunasTabela } = require('#server/infrastructure/repositories/colunasRepository.js');
const { erroServidor }  = require('#server/interfaces/http/erroServidor.js');

/* ── GET /api/:schema/listas-precos — listas com a quantidade de produtos vinculados ── */
router.get('/:schema/listas-precos', authJwt, checkSchema, requireModulo('lista_precos', 'r'), async (req, res) => {
  const { schema } = req.params;
  try {
    const rows = await withTenantConnection(schema, async db => {
      const temVinculos = (await colunasTabela(db, schema, 'PRODUTOS_X_LISTA').catch(() => [])).length > 0;
      return query(db, `
        SELECT l.*, ${temVinculos ? '(SELECT COUNT(*) FROM PRODUTOS_X_LISTA px WHERE px.ID_LISTA = l.ID_LISTA)' : '0'}::INT AS QTD_PRODUTOS
        FROM LISTA_PRECOS l ORDER BY l.DESCRICAO, l.ID_LISTA`);
    });
    res.json(rows);
  } catch (e) {
    if (isMissingTableError(e)) return res.json([]);
    erroServidor(res, e);
  }
});

/* ── GET /api/:schema/listas-precos/:id/produtos — produtos da lista (JOIN com PRODUTOS), busca e paginação ── */
router.get('/:schema/listas-precos/:id/produtos', authJwt, checkSchema, requireModulo('lista_precos', 'r'), async (req, res) => {
  const { schema, id } = req.params;
  if (!/^\d+$/.test(id)) return res.status(400).json({ erro: 'id inválido' });
  const page     = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 20));
  const q        = req.query.q?.trim() || '';
  try {
    const result = await withTenantConnection(schema, async db => {
      const colsPR = new Set((await colunasTabela(db, schema, 'PRODUTOS').catch(() => [])).map(c => c.COLUMN_NAME));
      const colPR  = c => (colsPR.has(c) ? `pr.${c}` : 'NULL');

      const params = [Number(id)];
      const where  = ['px.ID_LISTA = $1'];
      if (q) {
        params.push(`%${q}%`);
        const busca = ['px.ID_PRODUTO::TEXT', ...['CODIGO', 'DESCRICAO'].filter(c => colsPR.has(c)).map(c => `pr.${c}::TEXT`)];
        where.push(`(${busca.map(b => `${b} ILIKE $${params.length}`).join(' OR ')})`);
      }
      const from = `FROM PRODUTOS_X_LISTA px LEFT JOIN PRODUTOS pr ON pr.ID_PRODUTO = px.ID_PRODUTO WHERE ${where.join(' AND ')}`;

      const [{ CNT }] = await query(db, `SELECT COUNT(*) AS cnt ${from}`, params);
      params.push(pageSize, (page - 1) * pageSize);
      const registros = await query(db, `
        SELECT px.ID_PRODUTO_X_LISTA, px.ID_PRODUTO, px.PRECO,
               ${colPR('CODIGO')} AS CODIGO, ${colPR('DESCRICAO')} AS DESCRICAO,
               ${colPR('UNIDADE')} AS UNIDADE, ${colPR('PRECO_VENDA')} AS PRECO_VENDA
        ${from}
        ORDER BY ${colsPR.has('DESCRICAO') ? 'pr.DESCRICAO, ' : ''}px.ID_PRODUTO
        LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
      return { total: parseInt(CNT), registros };
    });
    res.json(result);
  } catch (e) {
    if (isMissingTableError(e)) return res.json({ total: 0, registros: [] });
    erroServidor(res, e);
  }
});

module.exports = router;
