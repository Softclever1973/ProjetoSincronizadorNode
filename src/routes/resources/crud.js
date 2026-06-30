/**
 * Rotas CRUD genéricas para tabelas do tenant.
 * GET/POST/DELETE /api/:schema/tabelas/:tabela (+ /colunas, /next-pk, /by-pk, /distinct)
 */

const express = require('express');
const router  = express.Router();

const authJwt             = require('../../middleware/authJwt');
const { requireRole }     = require('../../middleware/checkRole');
const { checkSchema }     = require('../../middleware/checkSchema');
const { withTenantConnection, query, execute, isMissingTableError, isMissingColumnError } = require('../../db');
const { NOME_VALIDO, TABELAS_FILTRO_LOJA, validarRegistro } = require('./constants');
const { colunasTabela, resolveIdLoja, registrarAuditLog }   = require('./helpers');
const { getCurrentTime } = require('../../services/timeService');

/**
 * Loga o erro com um ID rastreável e responde 500 com JSON.
 * O ID aparece tanto no log do servidor quanto na resposta — use-o para grep.
 */
function erroServidor(res, e, rota) {
  const id = `CRUD-${Date.now().toString(36).slice(-6).toUpperCase()}`;
  console.error(`[${id}] ${rota}:`, e.stack || e.message);
  res.status(500).json({ erro: 'Erro interno do servidor.', id });
}

/* ── GET /api/:schema/tabelas/:tabela/colunas ── */
router.get('/:schema/tabelas/:tabela/colunas', authJwt, checkSchema, async (req, res) => {
  const { schema, tabela } = req.params;
  if (!NOME_VALIDO.test(tabela)) return res.status(400).json({ erro: 'nome de tabela inválido' });
  try {
    const cols = await withTenantConnection(schema, db => colunasTabela(db, schema, tabela));
    res.json(cols);
  } catch (e) {
    erroServidor(res, e, `GET ${tabela}/colunas`);
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
    erroServidor(res, e, `GET ${tabela}/next-pk`);
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
    erroServidor(res, e, `GET ${tabela}/by-pk`);
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
    if (isMissingTableError(e) || isMissingColumnError(e)) return res.json([]);
    erroServidor(res, e, `GET ${tabela}/distinct`);
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
  if (sortCol) {
    const sortCols = sortCol.split(',').map(c => c.trim()).filter(Boolean);
    if (sortCols.some(c => !NOME_VALIDO.test(c))) return res.status(400).json({ erro: 'sortCol inválido' });
  }
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
      // DESC padrão do PostgreSQL = NULLS FIRST (NULLs no topo), que distorce a ordenação
      // quando há colunas opcionais como HORA. Forçamos NULLS LAST para DESC.
      const nullsClause = sortDir === 'DESC' ? ' NULLS LAST' : '';
      const orderBy     = sortCol
        ? sortCol.split(',').map(c => `${c.trim()} ${sortDir}${nullsClause}`).join(', ')
        : '1';
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
    erroServidor(res, e, `GET ${tabela}`);
  }
});

/* ── POST (criar) e PUT (editar) /api/:schema/tabelas/:tabela ── */
async function handleSave(req, res, forceUpdate) {
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
    /* SEC-03 (revisão): donos são excluídos intencionalmente desta validação.
     * O JWT de dono não carrega idLoja — eles têm acesso global a todas as lojas
     * do schema (design multi-PDV). A proteção para não-donos é completa:
     * idLojaJwt vem do JWT assinado, não do corpo da requisição. */
    if (userRole !== 'dono' && idLojaJwt !== null) {
      const idLojaRegistro = registro.ID_LOJA ?? registro.id_loja ?? null;
      if (idLojaRegistro !== null && Number(idLojaRegistro) !== idLojaJwt)
        return res.status(403).json({ erro: 'não é permitido salvar registros de outra loja' });
      // Garante que ID_LOJA esteja sempre preenchido com o valor do JWT
      registro.ID_LOJA = idLojaJwt;
    }
  }

  // Detecta UPDATE antecipadamente: se todas as PKs estão presentes no payload,
  // é edição de registro existente — campos obrigatórios não devem bloquear a operação.
  const pksUpper   = pks.map(p => p.toUpperCase());
  const pkValsHint = pksUpper.map(p => registro[Object.keys(registro).find(k => k.toUpperCase() === p)]);
  const likelyUpdate = forceUpdate || pkValsHint.every(v => v != null);

  // Validações de negócio por tabela
  const erroValidacao = validarRegistro(tabela, registro, { isUpdate: likelyUpdate });
  if (erroValidacao) return res.status(400).json({ erro: erroValidacao });

  // Campos automáticos para pedidos criados via web
  if (tabela.toUpperCase() === 'PEDIDOS') {
    const now        = new Date();
    const hojeIso    = now.toISOString().slice(0, 10);
    const horaUtcZ   = now.toISOString().slice(11, 19) + 'Z';
    const dataPedido = registro.DATA_DO_PEDIDO || hojeIso;
    const nomeUser   = req.userName || null;

    if (!registro.HORA_DO_PEDIDO)     registro.HORA_DO_PEDIDO    = horaUtcZ;
    if (!registro.TIPO_OPERACAO)      registro.TIPO_OPERACAO     = 'VD';
    if (!registro.DATA_DE_EMISSAO)    registro.DATA_DE_EMISSAO   = dataPedido;
    if (!registro.DATA_DE_EMISSAO_NF) registro.DATA_DE_EMISSAO_NF = dataPedido;
    if (!registro.USUARIO && nomeUser)      registro.USUARIO      = nomeUser;
    if (!registro.USUARIO_NOME && nomeUser) registro.USUARIO_NOME = nomeUser;
    if (!registro.AUTORIZADO_POR && nomeUser) registro.AUTORIZADO_POR = nomeUser;
    if (!registro.DATA_REALIZACAO && registro.STATUS === 'R')
      registro.DATA_REALIZACAO = dataPedido;
  }

  try {
    const { isUpdate, dadosAntes, srvId } = await withTenantConnection(schema, async db => {
      const serverCols = await query(db, `
        SELECT UPPER(column_name) AS col FROM information_schema.columns
        WHERE table_schema = $1 AND LOWER(table_name) = LOWER($2) AND is_generated <> 'ALWAYS'
      `, [schema, tabela]);
      const allowed  = new Set(serverCols.map(r => r.COL));
      const pksUpper = pks.map(p => p.toUpperCase());

      // Garante colunas da web que podem não existir no schema Firebird sincronizado
      if (tabela.toUpperCase() === 'PEDIDOS') {
        for (const [col, type] of [['OUTRAS_DESPESAS', 'NUMERIC(15,2)'], ['MODALIDADE_FRETE', 'VARCHAR(1)']]) {
          if (!allowed.has(col)) {
            await execute(db, `ALTER TABLE ${tabela} ADD COLUMN IF NOT EXISTS ${col} ${type}`).catch(() => {});
            allowed.add(col);
          }
        }
      } else if (tabela.toUpperCase() === 'PEDIDOS_PARCELAS_PAGAMENTOS') {
        if (!allowed.has('STATUS')) {
          await execute(db, `ALTER TABLE ${tabela} ADD COLUMN IF NOT EXISTS STATUS TEXT`).catch(() => {});
          allowed.add('STATUS');
        }
      }

      // Detecta se é INSERT ou UPDATE antes do upsert.
      // Se todos os PKs estão ausentes do payload (registro novo sem ID atribuído),
      // vai direto para INSERT — evita SELECT com NULL que nunca encontra linhas.
      const pkWhere = pksUpper.map((p, i) => `${p} = $${i + 1}`).join(' AND ');
      const pkVals  = pksUpper.map(p => registro[Object.keys(registro).find(k => k.toUpperCase() === p)]);
      let update;
      if (forceUpdate) {
        update = true;
      } else {
        const allPKsNull = pkVals.every(v => v == null);
        const existing   = allPKsNull ? [] : await query(db, `SELECT 1 FROM ${tabela} WHERE ${pkWhere} LIMIT 1`, pkVals);
        update = existing.length > 0;
      }

      // Captura estado anterior para o audit log de UPDATE
      let dadosAntes = null;
      let insertedSrvId = null;
      if (update) {
        const before = await query(db, `SELECT * FROM ${tabela} WHERE ${pkWhere} LIMIT 1`, pkVals);
        dadosAntes = before[0] ?? null;
      }

      // Unicidade de CODIGO em PRODUTOS quando parâmetro 122 = 'S' no Firebird da filial
      if (tabela.toUpperCase() === 'PRODUTOS') {
        const codigoKey = Object.keys(registro).find(k => k.toUpperCase() === 'CODIGO');
        const codigoVal = codigoKey ? String(registro[codigoKey] ?? '').trim() : '';
        if (codigoVal) {
          const [cfg] = await query(db,
            `SELECT valor FROM sync_config WHERE chave = 'codigo_interno_unico'`
          ).catch(() => [null]);
          if (cfg?.VALOR === 'S') {
            const srvIdKey = Object.keys(registro).find(k => k.toUpperCase() === 'SRV_ID');
            const srvIdAtual = srvIdKey !== undefined ? registro[srvIdKey] : null;
            const qParams = [codigoVal];
            const excludeClause = srvIdAtual != null ? ' AND SRV_ID != $2' : '';
            if (srvIdAtual != null) qParams.push(srvIdAtual);
            const [dup] = await query(db,
              `SELECT 1 FROM PRODUTOS WHERE UPPER(TRIM(CODIGO)) = UPPER(TRIM($1))${excludeClause} LIMIT 1`,
              qParams
            ).catch(() => [null]);
            if (dup) throw Object.assign(
              new Error(`Código "${codigoVal}" já está em uso por outro produto.`),
              { isValidation: true }
            );
          }
        }
      }

      // Unicidade de CPF/CNPJ em CLIENTES
      // O frontend declara pk: 'SRV_ID', então pkVals[0] é sempre o SRV_ID do servidor —
      // nunca nulo em edição, independente do ID_CLIENTE do ERP local.
      if (tabela.toUpperCase() === 'CLIENTES') {
        const srvIdAtual = pkVals[0] != null ? pkVals[0] : null;
        for (const campo of ['CPF', 'CNPJ']) {
          const key = Object.keys(registro).find(k => k.toUpperCase() === campo);
          const rawVal = key ? String(registro[key] ?? '').trim() : '';
          if (!rawVal) continue;
          const digits = rawVal.replace(/\D/g, '');
          if (!digits) continue;
          const excludeClause = srvIdAtual != null ? ' AND SRV_ID != $2' : '';
          const qParams = [digits];
          if (srvIdAtual != null) qParams.push(srvIdAtual);
          const [dup] = await query(db,
            `SELECT 1 FROM CLIENTES WHERE regexp_replace(${campo}::TEXT, '[^0-9]', '', 'g') = $1${excludeClause} LIMIT 1`,
            qParams
          ).catch(() => [null]);
          if (dup) throw Object.assign(
            new Error(`${campo} já está cadastrado para outro cliente.`),
            { isValidation: true }
          );
        }
      }

      // Injeta timestamps via API de tempo externa (America/Sao_Paulo)
      const agora = (await getCurrentTime()).toISOString();
      if (!update) {
        // Só preenche data de criação se ainda não veio do formulário
        if (allowed.has('DATA_FOI_CADASTRADO') && registro['DATA_FOI_CADASTRADO'] == null)
          registro['DATA_FOI_CADASTRADO'] = agora;
      }
      if (allowed.has('DATA_ULTIMA_ATUALIZACAO'))
        registro['DATA_ULTIMA_ATUALIZACAO'] = agora;

      const cols = Object.keys(registro).filter(c =>
        NOME_VALIDO.test(c) &&
        allowed.has(c.toUpperCase()) &&
        !(c.toUpperCase() === 'SRV_ID' && registro[c] == null)
      );
      if (!cols.length) throw new Error('nenhuma coluna válida para salvar');

      const vals = cols.map(c => registro[c]);

      // Usa INSERT/UPDATE explícitos em vez de ON CONFLICT para compatibilidade com
      // tabelas cujo PK no servidor é SRV_ID (não ID_PRODUTO, ID_PEDIDO, etc.).
      // ON CONFLICT exige constraint única na coluna alvo — que não existe nesses casos.
      if (update) {
        const setCols = cols.filter(c => !pksUpper.includes(c.toUpperCase()));
        if (setCols.length > 0) {
          const setVals  = setCols.map(c => registro[c]);
          const setPhase = setCols.map((c, i) => `${c} = $${i + 1}`).join(', ');
          const whrPhase = pksUpper.map((p, i) => `${p} = $${setCols.length + i + 1}`).join(' AND ');
          await execute(db,
            `UPDATE ${tabela} SET ${setPhase} WHERE ${whrPhase}`,
            [...setVals, ...pkVals]
          );
        }
      } else {
        let insertCols = cols;
        let insertVals = vals;
        // Tabela com SRV_ID como PK (NOT NULL sem DEFAULT): aloca da sequência
        // por-tabela (mesma usada pelo push de sincronização — evita colisão de PKs).
        if (allowed.has('SRV_ID') && !insertCols.some(c => c.toUpperCase() === 'SRV_ID')) {
          const seqNome = `seq_srv_id_${tabela.toLowerCase()}`;
          await execute(db, `CREATE SEQUENCE IF NOT EXISTS "${schema}"."${seqNome}"`).catch(() => {});
          // Avança a sequência além do maior SRV_ID existente na tabela.
          // Necessário quando o Firebird re-envia registros com SRV_IDs já atribuídos
          // (ramo srvIdFilial != null em sincronizacao.js), que não avança a sequência.
          // Sem isso, a sequência pode começar em 1 enquanto a tabela já tem SRV_ID=1.
          const [seqInfo] = await query(db, `
            SELECT
              COALESCE((SELECT MAX(SRV_ID) FROM ${tabela}), 0) AS max_srv,
              (SELECT last_value FROM "${schema}"."${seqNome}") AS seq_last
          `).catch(() => [null]);
          if (seqInfo && Number(seqInfo.MAX_SRV ?? 0) >= Number(seqInfo.SEQ_LAST ?? 0)) {
            await execute(db, `SELECT setval('${schema}.${seqNome}', $1)`, [Number(seqInfo.MAX_SRV)]).catch(() => {});
          }
          const [seq] = await query(db, `SELECT nextval('${schema}.${seqNome}') AS v`);
          if (seq?.V != null) {
            insertCols = ['SRV_ID', ...insertCols];
            insertVals = [seq.V, ...insertVals];
            insertedSrvId = seq.V;
          }
        }
        const insertPh = insertCols.map((_, i) => `$${i + 1}`);
        try {
          await execute(db,
            `INSERT INTO ${tabela} (${insertCols.join(', ')}) VALUES (${insertPh.join(', ')})`,
            insertVals
          );
        } catch (eInsert) {
          // Unique constraint violation (23505): outra requisição concorrente inseriu este
          // registro entre o SELECT e o INSERT. Retenta como UPDATE para evitar falha visível.
          if (eInsert.code !== '23505') throw eInsert;
          const setCols = cols.filter(c => !pksUpper.includes(c.toUpperCase()));
          if (setCols.length > 0) {
            const setVals  = setCols.map(c => registro[c]);
            const setPhase = setCols.map((c, i) => `${c} = $${i + 1}`).join(', ');
            const whrPhase = pksUpper.map((p, i) => `${p} = $${setCols.length + i + 1}`).join(' AND ');
            await execute(db,
              `UPDATE ${tabela} SET ${setPhase} WHERE ${whrPhase}`,
              [...setVals, ...pkVals]
            );
          }
        }
      }

      if (allowed.has('ID_ULTIMA_ATUALIZACAO_MATRIZ')) {
        const where = pksUpper.map((p, i) => `${p} = $${i + 1}`).join(' AND ');
        await execute(db,
          `UPDATE ${tabela} SET ID_ULTIMA_ATUALIZACAO_MATRIZ = nextval('${schema}.seq_atualizacao_matriz') WHERE ${where}`,
          pksUpper.map(p => registro[Object.keys(registro).find(k => k.toUpperCase() === p)])
        );
      }
      return { isUpdate: update, dadosAntes, srvId: insertedSrvId ?? null };
    });

    // Audit log universal (fire-and-forget)
    const pkStr = pks.map(p => registro[Object.keys(registro).find(k => k.toUpperCase() === p.toUpperCase())]).join('|');
    registrarAuditLog(req, schema, tabela, isUpdate ? 'UPDATE' : 'INSERT', pkStr, registro, dadosAntes);

    res.json({ ok: true, srvId: srvId ?? null });
  } catch (e) {
    if (e.isValidation) return res.status(400).json({ erro: e.message });
    erroServidor(res, e, `${req.method} ${tabela}`);
  }
}

const _saveMw = [authJwt, checkSchema, requireRole('gerente', 'dono')];
router.post('/:schema/tabelas/:tabela', ..._saveMw, (req, res) => handleSave(req, res, false));
router.put ('/:schema/tabelas/:tabela', ..._saveMw, (req, res) => handleSave(req, res, true));

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
    erroServidor(res, e, `DELETE ${tabela}`);
  }
});

module.exports = router;
