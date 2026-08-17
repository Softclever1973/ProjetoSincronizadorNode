// Colunas excluídas da comparação de auditoria e das escritas locais — controle de
// sincronização ou metadados de triggers locais com generator próprio (sobrescrever
// causaria divergência de GEN).
const COLUNAS_IGNORADAS_AUDITORIA = new Set([
  'ID_ULTIMA_ATUALIZACAO_MATRIZ',
  'ID_ULTIMA_ATUALIZACAO_WEB',
  'ID_ULTIMA_ATT_IFOOD',
  'DATA_HORA',
  'DATA_HORA_ATUALIZACAO',
  'DATA_ALTERACAO',
  'DATA_ULTIMA_ALTERACAO',
  'DATA_ULTIMA_ATUALIZACAO',
  'TIMESTAMP_ALTERACAO',
  'ID_ULTIMA_ATUALIZACAO',
  'DATA_ULTIMA_MOVIMENTACAO',
  'DATA_ULTIMA_ENTRADA',
  'DATA_ULTIMA_SAIDA',
  'DATA_INCLUSAO_SIRIUS',
  'DATA_ALTERACAO_SIRIUS',
  'ULTIMA_ALTERACAO',
  'DATA_PRECO_VENDA',
  'DATA_ULTIMA_ATUAL_IMP_ENTRADA',
  'DATA_PRECO_CUSTO',
]);

function isColunaIgnorada(coluna) {
  return COLUNAS_IGNORADAS_AUDITORIA.has((coluna ?? '').toUpperCase());
}

/**
 * Extrai a representação "ingênua" de uma data/timestamp — sem timezone.
 * Firebird armazena timestamps sem timezone; node-firebird retorna Date objects
 * no cliente (usando horário local da máquina) e ISO strings UTC no servidor.
 * Comparar getTime() causa falsos positivos de 3h (UTC-3). Comparar apenas
 * os dígitos de data/hora ignora o fuso e reflete o valor real armazenado.
 */
function toNaiveDateTime(v) {
  const pad = n => String(n).padStart(2, '0');
  if (v instanceof Date) {
    // Usa horário LOCAL da máquina — é o que o Firebird armazenou
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}` +
           `T${pad(v.getHours())}:${pad(v.getMinutes())}:${pad(v.getSeconds())}`;
  }
  if (typeof v === 'string') {
    // Remove frações de segundo e sufixo de timezone ("Z", "+00:00", "-03:00" …)
    return v.replace(/\.\d+/, '').replace(/([+-]\d{2}:\d{2}|Z)$/, '').replace(' ', 'T');
  }
  return String(v);
}

module.exports = { COLUNAS_IGNORADAS_AUDITORIA, isColunaIgnorada, toNaiveDateTime };
