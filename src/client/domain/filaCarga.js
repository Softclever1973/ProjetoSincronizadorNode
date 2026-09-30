/**
 * Marca dos pendentes da carga inicial/parcial em SYNC_ALTERACOES_PENDENTES: TIMESTAMP_ALTERACAO
 * com uma data fixa antiga. Separa a carga das alterações do dia a dia sem mudar a tabela.
 * Registro da carga alterado no Sirius ganha a data real pelo trigger e vira alteração normal.
 */
const SQL_DATA_CARGA = "TIMESTAMP '1900-01-01 00:00:00'";
const SQL_EH_CARGA = "TIMESTAMP_ALTERACAO < TIMESTAMP '1901-01-01 00:00:00'";
const SQL_NAO_EH_CARGA = "TIMESTAMP_ALTERACAO >= TIMESTAMP '1901-01-01 00:00:00'";

function ehDaCarga(timestamp) {
  const d = timestamp instanceof Date ? timestamp : new Date(timestamp);
  return !Number.isNaN(d.getTime()) && d.getFullYear() < 1901;
}

module.exports = { SQL_DATA_CARGA, SQL_EH_CARGA, SQL_NAO_EH_CARGA, ehDaCarga };
