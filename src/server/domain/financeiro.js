// Convenção do Firebird legado: "pago"/"recebido" gravam como "Realizado", não "Pago"/"Recebido" — leitura já normaliza via LOWER().
function capitalizarStatus(status) {
  const s = String(status).trim().toLowerCase();
  if (s === 'pago' || s === 'recebido') return 'Realizado';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Próximo dia útil (sem feriados); ::timestamp explícito pra bind resolver o mesmo tipo na query toda.
function exprProximoDiaUtil(expr) {
  const v = `((${expr})::timestamp)`;
  return `(CASE EXTRACT(DOW FROM ${v})
    WHEN 0 THEN ${v} + INTERVAL '1 day'
    WHEN 6 THEN ${v} + INTERVAL '2 days'
    ELSE ${v}
  END)`;
}

// Mesma regra do Sirius desktop: data de pagamento não pode ser futura (só contas a pagar por enquanto).
function dataFutura(data) {
  if (!data) return false;
  const hoje = new Date();
  const hojeStr = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-${String(hoje.getDate()).padStart(2, '0')}`;
  return String(data).slice(0, 10) > hojeStr;
}

module.exports = { capitalizarStatus, exprProximoDiaUtil, dataFutura };
