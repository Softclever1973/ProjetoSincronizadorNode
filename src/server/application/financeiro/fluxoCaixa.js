const { pool } = require('../../infrastructure/db');

// Agregação diária de entradas (CR recebidos) + saídas (CP pagos) + MOV_CAIXA, com saldo
// acumulado. MOV_CAIXA é opcional (só entra na UNION se a tabela já existir no schema).
async function gerarFluxoCaixa(s, mes, filtroLoja) {
  const lojaWhereCR = filtroLoja !== null && !isNaN(filtroLoja) ? `AND id_loja = ${filtroLoja}` : '';

  const temMovCaixa = await pool.query(`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = $1 AND table_name = 'mov_caixa'
  `, [s.toLowerCase()]);

  const movCaixaUnion = temMovCaixa.rows.length > 0 ? `
    UNION ALL
    SELECT
      COALESCE(DATA_MOV::DATE, DATE_TRUNC('month', '${mes}-01'::DATE)) AS data,
      SUM(CASE WHEN TIPO IN ('E','ENTRADA') THEN COALESCE(VALOR,0) ELSE 0 END) AS entradas,
      SUM(CASE WHEN TIPO IN ('S','SAIDA','SAÍDA') THEN COALESCE(VALOR,0) ELSE 0 END) AS saidas
    FROM ${s}.MOV_CAIXA
    WHERE DATA_MOV::DATE >= '${mes}-01'::DATE AND DATA_MOV::DATE < ('${mes}-01'::DATE + INTERVAL '1 month')
      ${filtroLoja !== null && !isNaN(filtroLoja) ? `AND ID_LOJA = ${filtroLoja}` : ''}
    GROUP BY DATA_MOV::DATE
  ` : '';

  const { rows } = await pool.query(`
    WITH base AS (
      SELECT
        data_realizado::DATE AS data,
        SUM(valor) AS entradas,
        0::NUMERIC AS saidas
      FROM ${s}.a_receber
      WHERE LOWER(COALESCE(status::text,'')) IN ('recebido','recebida','realizada','realizado')
        AND data_realizado::DATE >= '${mes}-01'::DATE
        AND data_realizado::DATE < ('${mes}-01'::DATE + INTERVAL '1 month')
        ${lojaWhereCR}
      GROUP BY data_realizado::DATE

      UNION ALL

      SELECT
        data_realizado::DATE AS data,
        0::NUMERIC AS entradas,
        SUM(valor) AS saidas
      FROM ${s}.a_pagar
      WHERE LOWER(COALESCE(status::text,'')) IN ('pago','paga','realizado','realizada')
        AND data_realizado::DATE >= '${mes}-01'::DATE
        AND data_realizado::DATE < ('${mes}-01'::DATE + INTERVAL '1 month')
        ${lojaWhereCR}
      GROUP BY data_realizado::DATE

      ${movCaixaUnion}
    ),
    agrupado AS (
      SELECT
        data,
        SUM(entradas) AS entradas,
        SUM(saidas)   AS saidas
      FROM base
      GROUP BY data
      ORDER BY data
    )
    SELECT
      data,
      entradas,
      saidas,
      SUM(entradas - saidas) OVER (ORDER BY data ROWS UNBOUNDED PRECEDING) AS saldo_acumulado
    FROM agrupado
    ORDER BY data
  `);

  return rows;
}

module.exports = { gerarFluxoCaixa };
