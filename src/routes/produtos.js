const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { withTenantConnection, query, isMissingTableError } = require('../db');
const { isFilialBloqueada } = require('../middleware/filialBloqueada');

/**
 * GET /datasnap/rest/TSMProdutos/ProdutosParaAtualizar
 * Query params: token, idLoja, idUltimaAtualizacaoMatriz
 *
 * Equivalente a TSMProdutos.ProdutosParaAtualizar() do Delphi.
 * Busca até 10 produtos alterados e substitui o preço pelo preço específico da loja.
 */
router.get('/ProdutosParaAtualizar', auth, async (req, res) => {
  const idLoja = parseInt(req.query.idLoja, 10);
  const idUltimaAtualizacaoMatriz = parseInt(req.query.idUltimaAtualizacaoMatriz, 10) || 0;

  if (!idLoja) {
    return res.status(400).json({
      message: 'Ocorreu um erro ao tentar listar os registros para atualizar pois o campo idLoja não foi informado',
    });
  }

  try {
    await withTenantConnection(req.schemaName, async (db) => {
      if (await isFilialBloqueada(idLoja, db)) {
        res.status(401).send();
        return;
      }

      const produtos = await query(
        db,
        `SELECT * FROM PRODUTOS
         WHERE ID_ULTIMA_ATUALIZACAO_MATRIZ IS NOT NULL
           AND ID_ULTIMA_ATUALIZACAO_MATRIZ > $1
         ORDER BY ID_ULTIMA_ATUALIZACAO_MATRIZ
         LIMIT 10`,
        [idUltimaAtualizacaoMatriz]
      );

      // Substitui preço de venda pelo preço específico da loja (PRODUTOS_PRECOS_LOJAS)
      // Se a tabela não existir ou não tiver a coluna, segue com o preço padrão
      for (const produto of produtos) {
        try {
          const precoLoja = await query(
            db,
            `SELECT PRECO FROM PRODUTOS_PRECOS_LOJAS
             WHERE ID_PRODUTO = $1 AND ID_LOJA = $2`,
            [produto.ID_PRODUTO, idLoja]
          );

          if (precoLoja.length > 0) {
            produto.PRECO_VENDA = precoLoja[0].PRECO;
          }
        } catch {
          // Tabela ou coluna inexistente — usa preço padrão do produto
        }
      }

      res.json(produtos);
    });
  } catch (e) {
    if (isMissingTableError(e)) {
      return res.json([]);
    }
    res.status(400).json({
      message: `Ocorreu um erro ao tentar listar os registros para atualizar. Erro: ${e.message}`,
    });
  }
});

/**
 * GET /datasnap/rest/TSMProdutos/getCountProdutosParaSincronizar
 * Query params: token, idLoja, idUltAtt (opcional)
 *
 * Equivalente a TSMProdutos.getCountProdutosParaSincronizar() do Delphi.
 */
router.get('/getCountProdutosParaSincronizar', auth, async (req, res) => {
  const idLoja = parseInt(req.query.idLoja, 10);

  if (!idLoja) {
    return res.status(400).json({
      message: 'Ocorreu um erro ao tentar listar os registros pois o campo idLoja não foi informado',
    });
  }

  try {
    let sql = 'SELECT COUNT(*) AS TOTAL FROM PRODUTOS WHERE 1=1';
    const params = [];

    if (req.query.idUltAtt) {
      params.push(parseInt(req.query.idUltAtt, 10));
      sql += ` AND ID_ULTIMA_ATUALIZACAO_MATRIZ IS NOT NULL AND ID_ULTIMA_ATUALIZACAO_MATRIZ > $${params.length}`;
    }

    const rows = await withTenantConnection(req.schemaName, (db) => query(db, sql, params));
    res.json({ total: rows[0]?.TOTAL ?? 0 });
  } catch (e) {
    if (isMissingTableError(e)) {
      return res.json({ total: 0 });
    }
    res.status(400).json({
      message: `Ocorreu um erro ao tentar buscar os produtos. Erro: ${e.message}`,
    });
  }
});

/**
 * GET /datasnap/rest/TSMProdutos/getProdutosSincronizadosByFilial
 * Query params: token, idLoja, situacao (opcional)
 *
 * Equivalente a TSMProdutos.getProdutosSincronizadosByFilial() do Delphi.
 * Retorna apenas o campo CODIGO dos produtos.
 */
router.get('/getProdutosSincronizadosByFilial', auth, async (req, res) => {
  const idLoja = parseInt(req.query.idLoja, 10);

  if (!idLoja) {
    return res.status(400).json({
      message: 'Ocorreu um erro ao tentar listar os registros pois o campo idLoja não foi informado',
    });
  }

  try {
    let sql = `SELECT CODIGO FROM PRODUTOS WHERE CODIGO <> ''`;
    const params = [];

    if (req.query.situacao) {
      params.push(req.query.situacao);
      sql += ` AND SITUACAO = $${params.length}`;
    }

    sql += ' ORDER BY ID_PRODUTO DESC';

    const rows = await withTenantConnection(req.schemaName, (db) => query(db, sql, params));
    res.json(rows.map((r) => ({ codigo: r.CODIGO })));
  } catch (e) {
    if (isMissingTableError(e)) {
      return res.json([]);
    }
    res.status(400).json({
      message: `Ocorreu um erro ao tentar buscar os produtos. Erro: ${e.message}`,
    });
  }
});

module.exports = router;
