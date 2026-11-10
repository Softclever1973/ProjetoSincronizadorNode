/**
 * Hooks de handleSave (crud.js) específicos da tabela CLIENTES.
 */
const { query } = require('#server/infrastructure/db.js');

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

// SITUACAO nunca fica vazia: cliente novo nasce 'A'; na edição, vazio não sobrescreve o valor gravado.
function aplicarCamposAutomaticos(req, registro) {
  const chave = Object.keys(registro).find(k => k.toUpperCase() === 'SITUACAO') ?? 'SITUACAO';
  const novo = Object.keys(registro).every(k => k.toUpperCase() !== 'SRV_ID' || registro[k] == null);
  if (String(registro[chave] ?? '').trim()) return;
  if (novo) registro[chave] = 'A';
  else delete registro[chave];
}

// Edição de cliente que ficou sem SITUACAO (cadastro antigo do site) já o grava como 'A'.
async function denormalizar(db, schema, registro, allowed) {
  if (!allowed.has('SITUACAO') || registro.SITUACAO) return;
  const srvId = registro[Object.keys(registro).find(k => k.toUpperCase() === 'SRV_ID')];
  if (srvId == null) return;
  const [atual] = await query(db, 'SELECT SITUACAO FROM CLIENTES WHERE SRV_ID = $1 LIMIT 1', [srvId]);
  if (atual && !String(atual.SITUACAO ?? '').trim()) registro.SITUACAO = 'A';
}

module.exports = { validarUnicidade, aplicarCamposAutomaticos, denormalizar };
