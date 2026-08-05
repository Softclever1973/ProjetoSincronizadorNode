/**
 * Hooks de handleSave (crud.js) específicos da tabela CLIENTES.
 */
const { query } = require('../../../db');

// Unicidade de CPF/CNPJ — pk é 'SRV_ID' no frontend, então pkVals[0] é sempre o SRV_ID
// do servidor (nunca nulo em edição), independente do ID_CLIENTE do ERP local.
async function validarUnicidade(db, { registro, pkVals }) {
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

module.exports = { validarUnicidade };
