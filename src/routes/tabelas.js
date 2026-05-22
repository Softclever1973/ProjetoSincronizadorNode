const express = require('express');
const router  = express.Router();
const authJwt = require('../middleware/authJwt');
const { requireRole } = require('../middleware/checkRole');
const { pool, withTenantConnection, query, execute, isMissingTableError } = require('../db');

const NOME_VALIDO = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Só essas tabelas recebem filtro obrigatório de ID_LOJA para gerente/vendedor
const TABELAS_FILTRO_LOJA = new Set(['PEDIDOS', 'PEDIDOS_ITENS', 'PEDIDOS_PARCELAS_PAGAMENTOS', 'CLIENTES']);

// ── Regras de negócio por tabela (aplicadas no upsert do backend) ────────────
// Campo lookup é case-insensitive para tolerar frontends que enviam lowercase.
function _campo(registro, nome) {
  const chave = Object.keys(registro).find(k => k.toUpperCase() === nome);
  const val   = chave !== undefined ? registro[chave] : undefined;
  if (val === null || val === undefined || String(val).trim() === '') return undefined;
  return val;
}

const REGRAS_TABELA = {
  CLIENTES: {
    obrigatorios: ['RAZAO_SOCIAL', 'FANTASIA'],
    validacoes: [
      r => (!_campo(r, 'CPF') && !_campo(r, 'CNPJ'))
        ? 'Informe o CPF ou o CNPJ do cliente'
        : null,
    ],
  },
  PEDIDOS: {
    obrigatorios: ['ID_CLIENTE', 'STATUS'],
  },
  PEDIDOS_ITENS: {
    obrigatorios: ['ID_PEDIDO', 'ID_PRODUTO', 'QUANTIDADE', 'VALOR_UNITARIO'],
    validacoes: [
      r => (Number(_campo(r, 'QUANTIDADE'))    <= 0) ? 'Quantidade deve ser maior que zero'          : null,
      r => (Number(_campo(r, 'VALOR_UNITARIO')) < 0) ? 'Valor unitário não pode ser negativo'        : null,
    ],
  },
  PEDIDOS_PARCELAS_PAGAMENTOS: {
    obrigatorios: ['ID_PEDIDO', 'PARCELA', 'VALOR'],
    validacoes: [
      r => (Number(_campo(r, 'VALOR')) <= 0) ? 'Valor do pagamento deve ser maior que zero' : null,
    ],
  },
};

function validarRegistro(tabela, registro) {
  const regras = REGRAS_TABELA[tabela.toUpperCase()];
  if (!regras) return null;
  for (const campo of (regras.obrigatorios || [])) {
    if (_campo(registro, campo) === undefined)
      return `O campo "${campo}" é obrigatório`;
  }
  for (const fn of (regras.validacoes || [])) {
    const erro = fn(registro);
    if (erro) return erro;
  }
  return null;
}

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
  const userRole          = req.userRoles?.[schema];
  // Vendedor sempre vê apenas registros ativos — ignora qualquer statusVal enviado
  const statusVal = userRole === 'vendedor' && statusCol
    ? 'A'
    : (req.query.statusVal?.trim() || '');
  const sortCol   = req.query.sortCol?.trim() || '';
  const sortDir   = (req.query.sortDir?.trim() || 'ASC').toUpperCase();
  // Loja obrigatória: gerente/vendedor só veem sua loja nas tabelas transacionais; dono sem restrição
  const usaFiltroLoja     = TABELAS_FILTRO_LOJA.has(tabela.toUpperCase());
  const idLojaObrigatorio = (usaFiltroLoja && userRole !== 'dono') ? (req.userLojas?.[schema] ?? null) : null;
  // Filtro opcional: qualquer tabela aceita ?filtroLoja=N (ex: dono filtrando clientes por filial)
  const filtroLojaParam   = req.query.filtroLoja ? parseInt(req.query.filtroLoja) : null;
  const idLojaFiltro      = idLojaObrigatorio ?? filtroLojaParam;

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
    const userRole = req.userRoles?.[schema];
    const idLojaJwt = req.userLojas?.[schema] ?? null;
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
      const allowed = new Set(serverCols.map(r => r.COL));
      const pksUpper = pks.map(p => p.toUpperCase());

      // Detecta se é INSERT ou UPDATE antes do upsert
      const pkWhere = pksUpper.map((p, i) => `${p} = $${i + 1}`).join(' AND ');
      const pkVals  = pksUpper.map(p => registro[Object.keys(registro).find(k => k.toUpperCase() === p)]);
      const existing = await query(db, `SELECT 1 FROM ${tabela} WHERE ${pkWhere} LIMIT 1`, pkVals);
      const update = existing.length > 0;

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
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || null;
    pool.query(
      `INSERT INTO public.audit_log (id_usuario, schema_name, tabela, operacao, pk_valor, dados, dados_antes, ip_cliente)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [req.userId, schema, tabela.toUpperCase(), isUpdate ? 'UPDATE' : 'INSERT', pkStr, registro, dadosAntes, ip]
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
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || null;
    pool.query(
      `INSERT INTO public.audit_log (id_usuario, schema_name, tabela, operacao, pk_valor, dados, dados_antes, ip_cliente)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [req.userId, schema, tabela.toUpperCase(), 'DELETE', pkStr, null, dadosAntes, ip]
    ).catch(() => {});

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

/* ── GET /api/:schema/audit-log ── */
router.get('/:schema/audit-log', authJwt, checkSchema, requireRole('gerente', 'dono'), async (req, res) => {
  const { schema } = req.params;
  const pageSize   = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 50));
  const page       = Math.max(1, parseInt(req.query.page) || 1);
  const offset     = (page - 1) * pageSize;
  const tabela     = req.query.tabela?.trim().toUpperCase() || '';
  const operacao   = req.query.operacao?.trim().toUpperCase() || '';
  const dataInicio = req.query.dataInicio?.trim() || '';
  const dataFim    = req.query.dataFim?.trim()    || '';
  const idLojaUsuario = req.userLojas?.[schema] ?? null;

  const conds  = ['al.schema_name = $1'];
  const params = [schema];

  if (tabela)     { params.push(tabela);     conds.push(`al.tabela = $${params.length}`); }
  if (operacao && ['INSERT','UPDATE','DELETE'].includes(operacao)) {
    params.push(operacao); conds.push(`al.operacao = $${params.length}`);
  }
  if (dataInicio) { params.push(dataInicio); conds.push(`al.criado_em >= $${params.length}`); }
  if (dataFim)    { params.push(dataFim + ' 23:59:59'); conds.push(`al.criado_em <= $${params.length}`); }

  const where = conds.join(' AND ');

  try {
    const [rows, countRow] = await Promise.all([
      pool.query(
        `SELECT al.id, al.id_usuario, u.email, al.tabela, al.operacao, al.pk_valor, al.dados, al.dados_antes, al.ip_cliente, al.criado_em
         FROM public.audit_log al
         LEFT JOIN public.usuarios u ON u.id = al.id_usuario
         WHERE ${where}
         ORDER BY al.criado_em DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, pageSize, offset]
      ),
      pool.query(`SELECT COUNT(*) FROM public.audit_log al WHERE ${where}`, params),
    ]);

    let result = rows.rows;
    if (idLojaUsuario !== null) {
      result = result.filter(r => {
        const idLoja = r.dados?.ID_LOJA ?? r.dados?.id_loja ?? null;
        return idLoja === null || Number(idLoja) === idLojaUsuario;
      });
    }

    res.json({ registros: result, total: parseInt(countRow.rows[0].count) });
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
  const rolePC   = req.userRoles?.[schema];
  const idLojaPC = rolePC !== 'dono' ? (req.userLojas?.[schema] ?? null) : null;

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
  const _roleP            = req.userRoles?.[schema];
  const idLojaObrigatorio = _roleP !== 'dono' ? (req.userLojas?.[schema] ?? null) : null;
  const filtroLojaParam   = req.query.filtroLoja ? parseInt(req.query.filtroLoja) : null;
  const idLojaFiltro      = idLojaObrigatorio ?? filtroLojaParam;
  try {
    const result = await withTenantConnection(schema, async db => {
      const colsP = await colunasTabela(db, schema, 'PEDIDOS').catch(() => []);
      const colsI = await colunasTabela(db, schema, 'PEDIDOS_ITENS').catch(() => []);
      if (!colsP.length) return { total: 0, registros: [], statusOptions: [] };

      const colNamesP = new Set(colsP.map(c => c.COLUMN_NAME));
      const colNamesI = new Set(colsI.map(c => c.COLUMN_NAME));

      // Detecta coluna de vendedor (ID_VENDEDOR ou NOME_VENDEDOR)
      let vendedorCol = null;
      if (colNamesP.has('ID_VENDEDOR'))     vendedorCol = 'ID_VENDEDOR';
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
          const rows = await query(db, `
            SELECT DISTINCT p.ID_VENDEDOR AS val,
              COALESCE(NULLIF(TRIM(v.NOME_VENDEDOR::TEXT), ''), p.ID_VENDEDOR::TEXT) AS lbl
            FROM PEDIDOS p
            LEFT JOIN VENDEDORES v ON v.ID_VENDEDOR = p.ID_VENDEDOR
            WHERE p.ID_VENDEDOR IS NOT NULL
            ORDER BY lbl
            LIMIT 200
          `, []);
          vendedorOptions = rows.map(r => ({ value: String(r.VAL), label: String(r.LBL) }));
        } catch {
          // Tabela VENDEDORES não existe ou não tem NOME_VENDEDOR — usa só o ID
          const rows = await query(db, `SELECT DISTINCT ID_VENDEDOR AS val FROM PEDIDOS WHERE ID_VENDEDOR IS NOT NULL ORDER BY val LIMIT 200`, []).catch(() => []);
          vendedorOptions = rows.map(r => ({ value: String(r.VAL), label: String(r.VAL) }));
        }
      } else if (vendedorCol) {
        const rows = await query(db, `SELECT DISTINCT ${vendedorCol} AS val FROM PEDIDOS WHERE ${vendedorCol} IS NOT NULL ORDER BY val LIMIT 200`, []).catch(() => []);
        vendedorOptions = rows.map(r => ({ value: String(r.VAL), label: String(r.VAL) }));
      }

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
  const roleI     = req.userRoles?.[schema];
  const idLojaJwt = roleI !== 'dono' ? (req.userLojas?.[schema] ?? null) : null;
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

      const roleF   = req.userRoles?.[schema];
      const idLojaF = roleF !== 'dono' ? (req.userLojas?.[schema] ?? null) : null;

      /* reutiliza _buildWhere para aplicar o mesmo filtro de data/loja dos demais gráficos */
      const params = [];
      const { whereParts } = _buildWhere(colsP, { ano, mes, idLojaF, anoInicio, mesInicio, anoFim, mesFim }, params);
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
  const roleP     = req.userRoles?.[schema];
  const idLojaJwt = roleP !== 'dono' ? (req.userLojas?.[schema] ?? null) : null;
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
    if (result === null) return res.status(403).json({ erro: 'pedido não pertence à sua loja' });
    res.json(result);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

/* ── GET /api/:schema/admin/sync-config ── */
router.get('/:schema/admin/sync-config', authJwt, checkSchema, requireRole('dono'), async (req, res) => {
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
router.put('/:schema/admin/sync-config', authJwt, checkSchema, requireRole('dono'), async (req, res) => {
  const { schema } = req.params;
  const { chave, valor } = req.body;

  const CHAVES_PERMITIDAS = new Set(['filtro_filial_clientes']);
  if (!chave || !CHAVES_PERMITIDAS.has(chave)) {
    return res.status(400).json({ erro: 'chave inválida' });
  }
  if (valor !== null && valor !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(valor)) {
    return res.status(400).json({ erro: 'valor deve ser null ou nome de coluna válido (ex: ID_LOJA)' });
  }

  try {
    await withTenantConnection(schema, db =>
      execute(db,
        `INSERT INTO sync_config (chave, valor) VALUES ($1, $2)
         ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor`,
        [chave, valor || null]
      )
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

/* ── GET /api/:schema/filiais ── */
router.get('/:schema/filiais', authJwt, checkSchema, async (req, res) => {
  const { schema } = req.params;
  try {
    const rows = await withTenantConnection(schema, db =>
      query(db, 'SELECT id_loja, nome FROM sync_filiais ORDER BY id_loja')
    );
    res.json(rows.map(r => ({ id: r.ID_LOJA, nome: r.NOME || `Loja ${r.ID_LOJA}` })));
  } catch {
    res.json([]);
  }
});

/* helper: extrai dateExpr igual ao faturamento-por-loja */
function _dateExprFromCols(colsP) {
  const colNamesP = new Set(colsP.map(c => c.COLUMN_NAME));
  const DATA_COLS = ['DATA_DO_PEDIDO', 'DATA_HORA', 'DATA_EMISSAO'];
  const dataCol   = DATA_COLS.find(c => colNamesP.has(c)) ?? null;
  if (!dataCol) return null;
  const dataType     = colsP.find(c => c.COLUMN_NAME === dataCol)?.DATA_TYPE ?? 'text';
  const isNativeDate = dataType.startsWith('timestamp') || dataType === 'date';
  return isNativeDate ? `p.${dataCol}` : `NULLIF(p.${dataCol}, '')::DATE`;
}

/* helper: WHERE parts comuns a todos os gráficos
 * Suporta dois modos de filtro de data:
 *   - Exato:   { ano, mes }  — usado pelo dono (selects únicos)
 *   - Intervalo: { anoInicio, mesInicio, anoFim, mesFim } — usado pelo gerente
 * Se algum param de intervalo estiver presente, o filtro exato é ignorado.
 */
function _buildWhere(colsP, { ano, mes, idLojaF, anoInicio, mesInicio, anoFim, mesFim }, params) {
  const colNamesP  = new Set(colsP.map(c => c.COLUMN_NAME));
  const dateExpr   = _dateExprFromCols(colsP);
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

/* ── GET /api/:schema/dashboard/evolucao-mensal ── */
router.get('/:schema/dashboard/evolucao-mensal', authJwt, checkSchema, requireRole('gerente', 'dono'), async (req, res) => {
  const { schema } = req.params;
  const { ano, mes, anoInicio, mesInicio, anoFim, mesFim } = req.query;
  const roleF   = req.userRoles?.[schema];
  const idLojaF = roleF !== 'dono' ? (req.userLojas?.[schema] ?? null) : (req.query.filtroLoja ? parseInt(req.query.filtroLoja) : null);
  try {
    const result = await withTenantConnection(schema, async db => {
      const colsP = await colunasTabela(db, schema, 'PEDIDOS').catch(() => []);
      const colsI = await colunasTabela(db, schema, 'PEDIDOS_ITENS').catch(() => []);
      if (!colsP.length) return [];
      const params = [];
      const { whereParts, dateExpr } = _buildWhere(colsP, { ano, mes, idLojaF, anoInicio, mesInicio, anoFim, mesFim }, params);
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
      const { whereParts, dateExpr } = _buildWhere(colsP, { ano, mes, idLojaF, anoInicio, mesInicio, anoFim, mesFim }, params);
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
      const nomeLojaExpr = [
        hasSF     && `MAX(sf.nome)`,
        hasAuxGen && `MAX(ag.DESCRICAO)`,
        `'Loja ' || COALESCE(p.ID_LOJA::TEXT, '?')`,
      ].filter(Boolean).reduce((acc, expr) => `COALESCE(${acc}, ${expr})`);
      const joinSF = hasSF     ? `LEFT JOIN sync_filiais sf ON sf.id_loja = p.ID_LOJA` : '';
      const joinAG = hasAuxGen ? `LEFT JOIN AUX_GENERICA ag ON ag.SUB_TABELA = 'Lojas' AND CAST(ag.ID_SUB_TABELA AS TEXT) = CAST(p.ID_LOJA AS TEXT)` : '';

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
  const roleF   = req.userRoles?.[schema];
  const idLojaF = roleF !== 'dono' ? (req.userLojas?.[schema] ?? null) : (req.query.filtroLoja ? parseInt(req.query.filtroLoja) : null);
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
      const { whereParts } = _buildWhere(colsP, { ano, mes, idLojaF, anoInicio, mesInicio, anoFim, mesFim }, params);
      const where    = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
      const descCol  = colNamesPR.has('DESCRICAO') ? 'pr.DESCRICAO' : colNamesPR.has('NOME') ? 'pr.NOME' : null;
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
  const roleF   = req.userRoles?.[schema];
  const idLojaF = roleF !== 'dono' ? (req.userLojas?.[schema] ?? null) : (req.query.filtroLoja ? parseInt(req.query.filtroLoja) : null);
  try {
    const result = await withTenantConnection(schema, async db => {
      const colsP = await colunasTabela(db, schema, 'PEDIDOS').catch(() => []);
      if (!colsP.length || !new Set(colsP.map(c => c.COLUMN_NAME)).has('STATUS')) return [];
      const params = [];
      const { whereParts } = _buildWhere(colsP, { ano, mes, idLojaF, anoInicio, mesInicio, anoFim, mesFim }, params);
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
  const roleF   = req.userRoles?.[schema];
  const idLojaF = roleF !== 'dono' ? (req.userLojas?.[schema] ?? null) : (req.query.filtroLoja ? parseInt(req.query.filtroLoja) : null);
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
      const { whereParts } = _buildWhere(colsP, { ano, mes, idLojaF, anoInicio, mesInicio, anoFim, mesFim }, params);
      whereParts.push('p.ID_VENDEDOR IS NOT NULL');
      const where     = `WHERE ${whereParts.join(' AND ')}`;
      const nomeCols  = ['NOME', 'RAZAO_SOCIAL', 'FANTASIA', 'NOME_VENDEDOR'].filter(c => colNamesV.has(c)).map(c => `v.${c}`);
      const joinV     = colsV.length ? `LEFT JOIN VENDEDORES v ON v.ID_VENDEDOR = p.ID_VENDEDOR` : '';
      const nomePartes = [];
      if (nomeCols.length) nomePartes.push(...nomeCols);
      if (colNamesP.has('NOME_VENDEDOR')) nomePartes.push('p.NOME_VENDEDOR');
      nomePartes.push('p.ID_VENDEDOR::TEXT');
      const nomeExpr  = `COALESCE(${nomePartes.join(', ')})`;
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

/* ── GET /api/:schema/dashboard ── */
router.get('/:schema/dashboard', authJwt, checkSchema, async (req, res) => {
  const { schema } = req.params;
  const role        = req.userRoles?.[schema];
  const idLoja      = role !== 'dono' ? (req.userLojas?.[schema] ?? null) : null;
  const filtroLoja  = req.query.filtroLoja ? parseInt(req.query.filtroLoja) : null;
  const lojaFiltro  = idLoja ?? filtroLoja;

  try {
    const hoje = new Date().toISOString().slice(0, 10);
    const lojaWhere  = lojaFiltro !== null ? `AND ID_LOJA = ${lojaFiltro}` : '';
    const lojaWhereP = lojaFiltro !== null ? `AND p.ID_LOJA = ${lojaFiltro}` : '';

    const [clientes, pedidosHoje, faturamentoHoje, produtosAtivos] = await Promise.all([
      withTenantConnection(schema, db => query(db, `SELECT COUNT(*) AS cnt FROM CLIENTES WHERE TRIM(SITUACAO::TEXT) = 'A' ${lojaWhere}`, [])).catch(() => [{ CNT: 0 }]),
      withTenantConnection(schema, db => query(db, `SELECT COUNT(*) AS cnt FROM PEDIDOS p WHERE p.DATA_DO_PEDIDO = $1 ${lojaWhereP}`, [hoje])).catch(() => [{ CNT: 0 }]),
      withTenantConnection(schema, db => query(db, `
        SELECT COALESCE(SUM(pi.VALOR_UNITARIO * pi.QUANTIDADE), 0) AS total
        FROM PEDIDOS p
        JOIN PEDIDOS_ITENS pi ON pi.ID_PEDIDO = p.ID_PEDIDO
        WHERE p.DATA_DO_PEDIDO = $1 ${lojaWhereP}`, [hoje])).catch(() => [{ TOTAL: 0 }]),
      withTenantConnection(schema, db => query(db, `SELECT COUNT(*) AS cnt FROM PRODUTOS WHERE TRIM(SITUACAO::TEXT) = 'A'`, [])).catch(() => [{ CNT: 0 }]),
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

module.exports = router;
