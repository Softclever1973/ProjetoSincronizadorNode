/**
 * Rotas administrativas do tenant.
 * GET  /api/:schema/admin/sync-config
 * PUT  /api/:schema/admin/sync-config
 * GET  /api/:schema/filiais
 * GET  /api/:schema/plano
 */

const express = require('express');
const router  = express.Router();

const authJwt                  = require('#server/interfaces/http/middleware/authJwt.js');
const { requireModulo }        = require('#server/interfaces/http/middleware/requireModulo.js');
const { checkSchema }          = require('#server/interfaces/http/middleware/checkSchema.js');
const { pool, withTenantConnection, query, execute, isMissingTableError } = require('#server/infrastructure/db.js');
const { NOME_VALIDO, CHAVES_PERMITIDAS } = require('#server/domain/validacao.js');
const { registrarAuditLog } = require('#server/infrastructure/repositories/auditLogRepository.js');
const { PLANOS, PLANO_PADRAO } = require('#server/domain/planos.js');
const { obterPermissoesEfetivas } = require('#server/infrastructure/cache/permissoesCache.js');
const { colunasTabela } = require('#server/infrastructure/repositories/colunasRepository.js');
const { buildNomeLojaExpr } = require('./helpers');

/* ── GET /api/:schema/admin/sync-config ── */
router.get('/:schema/admin/sync-config', authJwt, checkSchema, requireModulo('configuracoes', 'r'), async (req, res) => {
  const { schema } = req.params;
  try {
    const rows = await withTenantConnection(schema, db =>
      query(db, 'SELECT chave, valor FROM sync_config ORDER BY chave')
    );
    res.json(Object.fromEntries(rows.map(r => [r.CHAVE, r.VALOR])));
  } catch (e) {
    if (isMissingTableError(e)) return res.json({});
    res.status(500).json({ erro: e.message });
  }
});

/* ── PUT /api/:schema/admin/sync-config ── */
router.put('/:schema/admin/sync-config', authJwt, checkSchema, requireModulo('configuracoes', 'w'), async (req, res) => {
  const { schema } = req.params;
  const { chave, valor } = req.body;

  if (!chave || !CHAVES_PERMITIDAS.has(chave)) {
    return res.status(400).json({ erro: 'chave inválida' });
  }
  if (valor !== null && valor !== undefined && !NOME_VALIDO.test(valor)) {
    return res.status(400).json({ erro: 'valor deve ser null ou nome de coluna válido (ex: ID_LOJA)' });
  }

  try {
    let dadosAntes = null;
    await withTenantConnection(schema, async db => {
      const rows = await query(db, 'SELECT valor FROM sync_config WHERE chave = $1', [chave]);
      dadosAntes = rows.length > 0 ? { chave, valor: rows[0].VALOR } : null;
      await execute(db,
        `INSERT INTO sync_config (chave, valor) VALUES ($1, $2)
         ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor`,
        [chave, valor || null]
      );
    });
    registrarAuditLog(req, schema, 'SYNC_CONFIG', dadosAntes ? 'UPDATE' : 'INSERT', chave,
      { chave, valor: valor || null }, dadosAntes);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

/* ── GET /api/:schema/sync-flags — flags públicas sem restrição de role ── */
router.get('/:schema/sync-flags', authJwt, checkSchema, async (req, res) => {
  const { schema } = req.params;
  try {
    const rows = await withTenantConnection(schema, db =>
      query(db, `SELECT chave, valor FROM sync_config WHERE chave IN ('venda_saldo_negativo', 'modalidade_frete', 'forma_preenchimento_pedido')`)
    );
    res.json(Object.fromEntries(rows.map(r => [r.CHAVE, r.VALOR])));
  } catch (e) {
    if (isMissingTableError(e)) return res.json({});
    res.status(500).json({ erro: e.message });
  }
});

/* ── GET /api/:schema/filiais ── */
// sync_filiais só ganha uma linha quando o client daquela loja chega a rodar um ciclo de
// sync — uma loja com PEDIDOS reais (dado migrado, ou filial que nunca instalou o client)
// nunca aparece lá, mesmo aparecendo normalmente no gráfico de faturamento por loja (que
// lê ID_LOJA direto de PEDIDOS). Sem completar com essas lojas "órfãs" aqui, o filtro
// global de loja (sidebar.js) nunca oferece uma opção pra filtrar por elas.
router.get('/:schema/filiais', authJwt, checkSchema, async (req, res) => {
  const { schema } = req.params;
  try {
    const rows = await withTenantConnection(schema, async db => {
      const base = await query(db, 'SELECT id_loja, nome FROM sync_filiais ORDER BY id_loja').catch(() => []);
      const mapa = new Map(base.map(r => [r.ID_LOJA, r.NOME]));

      const colsP = await colunasTabela(db, schema, 'PEDIDOS').catch(() => []);
      if (colsP.some(c => c.COLUMN_NAME === 'ID_LOJA')) {
        const colsAG = await colunasTabela(db, schema, 'AUX_GENERICA').catch(() => []);
        const { nomeLojaExpr, joinAG } = buildNomeLojaExpr({ hasSF: false, hasAuxGen: colsAG.length > 0 });
        const extras = await query(db, `
          SELECT p.ID_LOJA AS id_loja, ${nomeLojaExpr} AS nome
          FROM PEDIDOS p
          ${joinAG}
          WHERE p.ID_LOJA IS NOT NULL
          GROUP BY p.ID_LOJA
        `, []).catch(() => []);
        for (const r of extras) if (!mapa.has(r.ID_LOJA)) mapa.set(r.ID_LOJA, r.NOME);
      }

      return [...mapa.entries()].sort((a, b) => a[0] - b[0]);
    });
    res.json(rows.map(([id, nome]) => ({ id, nome: nome || `Loja ${id}` })));
  } catch {
    res.json([]);
  }
});

// GET /api/:schema/plano — info do plano atual. Lê de sync_tenants, não do claim do JWT (evita staleness até o token renovar).
// `modulos` traz a permissão efetiva (plano ∩ role) de cada módulo — é o mesmo endpoint que
// sidebar.js#initSidebar() já chama em toda carga de página, então o frontend recebe
// permissões atualizadas sem precisar de um novo login.
router.get('/:schema/plano', authJwt, checkSchema, async (req, res) => {
  const { schema } = req.params;
  try {
    const { rows } = await pool.query(
      'SELECT plano FROM public.sync_tenants WHERE schema_name = $1', [schema]
    );
    const plano = rows[0]?.plano || PLANO_PADRAO;
    const role = req.userRoles?.[schema];
    const modulos = await obterPermissoesEfetivas(plano, role);
    res.json({ plano, nome: PLANOS[plano]?.nome ?? plano, modulos });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

module.exports = router;
