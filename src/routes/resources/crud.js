/**
 * Rotas CRUD genéricas para tabelas do tenant.
 * GET/POST/DELETE /api/:schema/tabelas/:tabela (+ /colunas, /next-pk, /by-pk, /distinct)
 */

const express = require('express');
const router  = express.Router();

const authJwt             = require('../../middleware/authJwt');
const { requireRole }     = require('../../middleware/checkRole');
const { checkSchema }     = require('../../middleware/checkSchema');
const { withTenantConnection, query, execute, isMissingTableError } = require('../../db');
const { NOME_VALIDO, TABELAS_FILTRO_LOJA, validarRegistro } = require('./constants');
const { colunasTabela, resolveIdLoja, registrarAuditLog }   = require('./helpers');

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

/* ── GET /api/:schema/tabelas/:tabela/distinct/:col ── */
router.get('/:schema/tabelas/:tabela/distinct/:col', authJwt, checkSchema, async (req, res) => {
  const { schema, tabela, col } = req.params;
  if (!NOME_VALIDO.test(tabela)) return res.status(400).json({ erro: 'nome de tabela inválido' });
  if (!NOME_VALIDO.test(col))    return res.status(400).json({ erro: 'nome de coluna inválido' });
  try {
    const rows = await withTenantConnection(schema, db =>
      query(db, `SELECT DISTINCT ${col} FROM ${tabela} WHERE ${col} IS NOT NULL ORDER BY ${col} LIMIT 200`, [])
    );
    res.json(rows.map(r => r[col.toUpperCase()]));
  } catch (e) {
    if (isMissingTableError(e)) return res.json([]);
    res.status(500).json({ erro: e.message });
  }
});

/* ── GET /api/:schema/tabelas/:tabela — lista paginada ── */
router.get('/:schema/tabelas/:tabela', authJwt, checkSchema, async (req, res) => {
  const { schema, tabela } = req.params;
  if (!NOME_VALIDO.test(tabela)) return res.status(400).json({ erro: 'nome de tabela inválido' });
  const exportAll = req.query.all === 'true';
  const page      = exportAll ? 1 : Math.max(1, parseInt(req.query.page) || 1);
  const pageSize  = exportAll ? 10000 : Math.min(500, Math.max(1, parseInt(req.query.pageSize) || 50));
  const q         = req.query.q?.trim() || '';
  const cols      = req.query.cols?.trim() || '';
  const statusCol = req.query.statusCol?.trim() || '';
  const userRole  = req.userRoles?.[schema];
  // Vendedor sempre vê apenas registros ativos — ignora qualquer statusVal enviado
  const statusVal = userRole === 'vendedor' && statusCol
    ? 'A'
    : (req.query.statusVal?.trim() || '');
  const sortCol = req.query.sortCol?.trim() || '';
  const sortDir = (req.query.sortDir?.trim() || 'ASC').toUpperCase();
  // Tabelas transacionais: não-donos são forçados à sua loja; dono pode passar ?filtroLoja=N
  // Tabelas globais: qualquer role pode usar ?filtroLoja=N como filtro opcional
  const usaFiltroLoja = TABELAS_FILTRO_LOJA.has(tabela.toUpperCase());
  const idLojaFiltro  = usaFiltroLoja
    ? resolveIdLoja(req, schema, { donoPodemFiltrar: true })
    : (req.query.filtroLoja ? parseInt(req.query.filtroLoja, 10) : null);

  // Filtros extras por coluna: ?filtros={"GRUPO":"BEBIDAS"}
  let filtrosExtras = {};
  if (req.query.filtros) {
    try { filtrosExtras = JSON.parse(req.query.filtros); } catch { /* ignora JSON inválido */ }
    if (typeof filtrosExtras !== 'object' || Array.isArray(filtrosExtras)) filtrosExtras = {};
  }

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
      const params     = [];
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

      // Filtro especial PF/PJ (chave virtual _PF_PJ, não é coluna real)
      if (filtrosExtras._PF_PJ === 'PF') {
        conditions.push(`(CPF IS NOT NULL AND TRIM(CPF::TEXT) <> '')`);
      } else if (filtrosExtras._PF_PJ === 'PJ') {
        conditions.push(`(CNPJ IS NOT NULL AND TRIM(CNPJ::TEXT) <> '')`);
      }

      // Filtros extras por coluna — valida nome, ignora chaves especiais (iniciadas com _)
      // Suporta igualdade (string/número) e range ({ gte, lte })
      const colsExtrasValidas = Object.keys(filtrosExtras).filter(c => {
        if (!NOME_VALIDO.test(c) || c.startsWith('_')) return false;
        const v = filtrosExtras[c];
        if (v === '' || v === null || v === undefined) return false;
        if (typeof v === 'object') return (v.gte != null && v.gte !== '') || (v.lte != null && v.lte !== '');
        return true;
      });
      if (colsExtrasValidas.length) {
        const colsTabela = await query(db, `
          SELECT UPPER(column_name) AS column_name
          FROM information_schema.columns
          WHERE table_schema = $1 AND LOWER(table_name) = LOWER($2)
        `, [schema, tabela]);
        const colsExistentes = new Set(colsTabela.map(r => r.COLUMN_NAME));
        for (const col of colsExtrasValidas) {
          if (!colsExistentes.has(col.toUpperCase())) continue;
          const val = filtrosExtras[col];
          if (typeof val === 'object' && val !== null) {
            // Filtro de range: { gte: minimo, lte: maximo }
            if (val.gte != null && val.gte !== '') { params.push(val.gte); conditions.push(`${col} >= $${params.length}`); }
            if (val.lte != null && val.lte !== '') { params.push(val.lte); conditions.push(`${col} <= $${params.length}`); }
          } else {
            params.push(val);
            conditions.push(`${col} = $${params.length}`);
          }
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
router.post('/:schema/tabelas/:tabela', authJwt, checkSchema, requireRole('gerente', 'dono'), async (req, res) => {
  const { schema, tabela } = req.params;
  if (!NOME_VALIDO.test(tabela)) return res.status(400).json({ erro: 'nome de tabela inválido' });

  const { pk, registro } = req.body;
  if (!pk || !registro) return res.status(400).json({ erro: 'pk e registro são obrigatórios' });

  const pks = Array.isArray(pk) ? pk : [pk];
  if (pks.some(p => !NOME_VALIDO.test(p))) return res.status(400).json({ erro: 'pk inválido' });

  // Verificação e injeção de loja para gerente/vendedor — só em tabelas transacionais
  if (TABELAS_FILTRO_LOJA.has(tabela.toUpperCase())) {
    const userRole   = req.userRoles?.[schema];
    const idLojaJwt  = req.userLojas?.[schema] ?? null;
    if (userRole !== 'dono' && idLojaJwt !== null) {
      const idLojaRegistro = registro.ID_LOJA ?? registro.id_loja ?? null;
      if (idLojaRegistro !== null && Number(idLojaRegistro) !== idLojaJwt)
        return res.status(403).json({ erro: 'não é permitido salvar registros de outra loja' });
      // Garante que ID_LOJA esteja sempre preenchido com o valor do JWT
      registro.ID_LOJA = idLojaJwt;
    }
  }

  // Validações de negócio por tabela
  const erroValidacao = validarRegistro(tabela, registro);
  if (erroValidacao) return res.status(400).json({ erro: erroValidacao });

  try {
    const { isUpdate, dadosAntes } = await withTenantConnection(schema, async db => {
      const serverCols = await query(db, `
        SELECT UPPER(column_name) AS col FROM information_schema.columns
        WHERE table_schema = $1 AND LOWER(table_name) = LOWER($2) AND is_generated <> 'ALWAYS'
      `, [schema, tabela]);
      const allowed  = new Set(serverCols.map(r => r.COL));
      const pksUpper = pks.map(p => p.toUpperCase());

      // Detecta se é INSERT ou UPDATE antes do upsert
      const pkWhere = pksUpper.map((p, i) => `${p} = $${i + 1}`).join(' AND ');
      const pkVals  = pksUpper.map(p => registro[Object.keys(registro).find(k => k.toUpperCase() === p)]);
      const existing = await query(db, `SELECT 1 FROM ${tabela} WHERE ${pkWhere} LIMIT 1`, pkVals);
      const update   = existing.length > 0;

      // Captura estado anterior para o audit log de UPDATE
      let dadosAntes = null;
      if (update) {
        const before = await query(db, `SELECT * FROM ${tabela} WHERE ${pkWhere} LIMIT 1`, pkVals);
        dadosAntes = before[0] ?? null;
      }

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
      return { isUpdate: update, dadosAntes };
    });

    // Audit log universal (fire-and-forget)
    const pkStr = pks.map(p => registro[Object.keys(registro).find(k => k.toUpperCase() === p.toUpperCase())]).join('|');
    registrarAuditLog(req, schema, tabela, isUpdate ? 'UPDATE' : 'INSERT', pkStr, registro, dadosAntes);

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
    // Captura estado anterior e apaga na mesma conexão de tenant
    const dadosAntes = await withTenantConnection(schema, async db => {
      const whereStr = pks.map((p, i) => `${p.toUpperCase()} = $${i + 1}`).join(' AND ');
      const before   = await query(db, `SELECT * FROM ${tabela} WHERE ${whereStr} LIMIT 1`, pkValores);
      const snap     = before[0] ?? null;
      const where    = pks.map((p, i) => `${p} = $${i + 1}`).join(' AND ');
      await execute(db, `DELETE FROM ${tabela} WHERE ${where}`, pkValores);
      return snap;
    });

    // Audit log universal (fire-and-forget)
    const pkStr = (Array.isArray(pkValores) ? pkValores : [pkValores]).join('|');
    registrarAuditLog(req, schema, tabela, 'DELETE', pkStr, null, dadosAntes);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

module.exports = router;
