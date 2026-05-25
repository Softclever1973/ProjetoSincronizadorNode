/**
 * Helpers compartilhados pelas rotas de tabelas.
 * Extraídos de tabelas.js (monolítico) para facilitar reutilização e testes.
 */

const { pool, query } = require('../../db');
const { COLS_DATA_PEDIDO } = require('./constants');

/**
 * Retorna as colunas de uma tabela consultando o information_schema do PostgreSQL.
 * Chaves normalizadas para UPPERCASE (padrão do projeto).
 *
 * @param {import('pg').PoolClient} db
 * @param {string} schema
 * @param {string} tabela
 * @returns {Promise<Array<{ COLUMN_NAME: string, DATA_TYPE: string, IS_GENERATED: string, CHARACTER_MAXIMUM_LENGTH: number|null }>>}
 */
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

/**
 * Resolve o ID da loja efetivo para uma query, respeitando o role do usuário.
 *
 * - Não-donos: sempre forçados à sua própria loja (req.userLojas[schema]).
 * - Donos: sem restrição por padrão; quando `donoPodemFiltrar: true`, podem
 *   passar ?filtroLoja=N para filtrar por loja específica.
 *
 * Inclui guarda `Number.isInteger` para barrar NaN/Infinity vindos de parseInt.
 *
 * @param {import('express').Request} req
 * @param {string} schema
 * @param {{ donoPodemFiltrar?: boolean }} [opts]
 * @returns {number|null}
 */
function resolveIdLoja(req, schema, { donoPodemFiltrar = false } = {}) {
  const isDono = req.userRoles?.[schema] === 'dono';
  if (!isDono) return req.userLojas?.[schema] ?? null;
  if (donoPodemFiltrar && req.query.filtroLoja) {
    const parsed = parseInt(req.query.filtroLoja, 10);
    return Number.isInteger(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Insere uma linha no audit_log de forma assíncrona (fire-and-forget).
 * Nunca lança erro — falha silenciosa intencional para não bloquear a resposta.
 *
 * @param {import('express').Request} req
 * @param {string} schema
 * @param {string} tabela
 * @param {'INSERT'|'UPDATE'|'DELETE'} operacao
 * @param {string} pkStr       — valor(es) da PK concatenados com '|'
 * @param {object|null} dados  — payload enviado (null para DELETE)
 * @param {object|null} dadosAntes — snapshot antes da operação (null para INSERT)
 */
function registrarAuditLog(req, schema, tabela, operacao, pkStr, dados, dadosAntes) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || null;
  pool.query(
    `INSERT INTO public.audit_log
       (id_usuario, schema_name, tabela, operacao, pk_valor, dados, dados_antes, ip_cliente)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [req.userId, schema, tabela.toUpperCase(), operacao, pkStr, dados, dadosAntes, ip]
  ).catch(() => {});
}

/**
 * Gera a expressão SQL de nome de loja e os LEFT JOINs necessários para resolvê-la.
 * Prioridade: sync_filiais (preenchida automaticamente) >
 *             AUX_GENERICA (configurada manualmente) >
 *             'Loja N' (fallback literal)
 *
 * Assume aliases: p = PEDIDOS, sf = sync_filiais, ag = AUX_GENERICA.
 *
 * @param {{ hasSF: boolean, hasAuxGen: boolean }} flags
 * @returns {{ nomeLojaExpr: string, joinSF: string, joinAG: string }}
 */
function buildNomeLojaExpr({ hasSF, hasAuxGen }) {
  const nomeLojaExpr = [
    hasSF     && `MAX(sf.nome)`,
    hasAuxGen && `MAX(ag.DESCRICAO)`,
    `'Loja ' || COALESCE(p.ID_LOJA::TEXT, '?')`,
  ].filter(Boolean).reduce((acc, expr) => `COALESCE(${acc}, ${expr})`);

  const joinSF = hasSF
    ? `LEFT JOIN sync_filiais sf ON sf.id_loja = p.ID_LOJA`
    : '';
  const joinAG = hasAuxGen
    ? `LEFT JOIN AUX_GENERICA ag ON ag.SUB_TABELA = 'Lojas'
       AND CAST(ag.ID_SUB_TABELA AS TEXT) = CAST(p.ID_LOJA AS TEXT)`
    : '';

  return { nomeLojaExpr, joinSF, joinAG };
}

/**
 * Detecta a coluna de data de pedido disponível e retorna a expressão SQL
 * para usá-la como DATE (converte TEXT→DATE se necessário).
 * Retorna null se nenhuma coluna de data for encontrada.
 *
 * @param {object[]} colsP — resultado de colunasTabela() para PEDIDOS
 * @returns {string|null}
 */
function dateExprFromCols(colsP) {
  const colNamesP    = new Set(colsP.map(c => c.COLUMN_NAME));
  const dataCol      = COLS_DATA_PEDIDO.find(c => colNamesP.has(c)) ?? null;
  if (!dataCol) return null;
  const dataType     = colsP.find(c => c.COLUMN_NAME === dataCol)?.DATA_TYPE ?? 'text';
  const isNativeDate = dataType.startsWith('timestamp') || dataType === 'date';
  return isNativeDate ? `p.${dataCol}` : `NULLIF(p.${dataCol}, '')::DATE`;
}

/**
 * Constrói as partes do WHERE comuns a todos os gráficos de dashboard.
 *
 * Suporta dois modos de filtro de data:
 *   - Exato:    { ano, mes }                          — dono (selects únicos)
 *   - Intervalo: { anoInicio, mesInicio, anoFim, mesFim } — gerente
 * Se algum param de intervalo estiver presente, o filtro exato é ignorado.
 *
 * @param {object[]} colsP — resultado de colunasTabela() para PEDIDOS
 * @param {{ ano?, mes?, idLojaF, anoInicio?, mesInicio?, anoFim?, mesFim? }} filtros
 * @param {any[]} params — array de parâmetros mutável (push in-place)
 * @returns {{ whereParts: string[], dateExpr: string|null, colNamesP: Set<string> }}
 */
function buildWhere(colsP, { ano, mes, idLojaF, anoInicio, mesInicio, anoFim, mesFim }, params) {
  const colNamesP  = new Set(colsP.map(c => c.COLUMN_NAME));
  const dateExpr   = dateExprFromCols(colsP);
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

module.exports = {
  colunasTabela,
  resolveIdLoja,
  registrarAuditLog,
  buildNomeLojaExpr,
  dateExprFromCols,
  buildWhere,
};
