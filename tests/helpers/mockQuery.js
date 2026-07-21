/**
 * Configura um jest.fn() (tipicamente `query` mockado de ../src/client/db) para
 * responder de acordo com o texto do SQL, em vez de depender da ordem das chamadas —
 * mais robusto a refactors que reordenam queries logicamente independentes entre si.
 *
 * `respostas` é uma lista de pares [trechoDoSql, resposta]. `resposta` pode ser um
 * valor fixo ou uma função `(params) => valor`, usada quando o mesmo SQL roda mais de
 * uma vez no teste com parâmetros (e portanto resultados) diferentes.
 */
function mockQueryPorSql(queryMock, respostas) {
  queryMock.mockImplementation((db, sql, params) => {
    for (const [trecho, resposta] of respostas) {
      if (sql.includes(trecho)) {
        return Promise.resolve(typeof resposta === 'function' ? resposta(params) : resposta);
      }
    }
    return Promise.resolve([]);
  });
}

module.exports = { mockQueryPorSql };
