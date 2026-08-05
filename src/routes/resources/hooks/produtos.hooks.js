/**
 * Hooks de handleSave (crud.js) específicos da tabela PRODUTOS.
 */
const { query } = require('../../../db');

// Unicidade de CODIGO quando parâmetro 122 = 'S' no Firebird da filial (sync_config.codigo_interno_unico)
async function validarUnicidade(db, { registro }) {
  const codigoKey = Object.keys(registro).find(k => k.toUpperCase() === 'CODIGO');
  const codigoVal = codigoKey ? String(registro[codigoKey] ?? '').trim() : '';
  if (!codigoVal) return;

  const [cfg] = await query(db,
    `SELECT valor FROM sync_config WHERE chave = 'codigo_interno_unico'`
  ).catch(() => [null]);
  if (cfg?.VALOR !== 'S') return;

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

module.exports = { validarUnicidade };
