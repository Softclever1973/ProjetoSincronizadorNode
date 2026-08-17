const { query, execute, withTenantConnection } = require('../../infrastructure/db');
const { colunasTabela } = require('../../infrastructure/repositories/colunasRepository');

/**
 * Cria um VENDEDORES "DONO" e vincula o usuário a ele (usuarios_empresas.id_vendedor),
 * retornando o id_vendedor criado — para telas que exibem nome do vendedor (ex.:
 * movimentações de estoque) mostrarem um nome consistente em vez do fallback
 * "Web - <nome da conta>" quando quem lançou é o dono.
 *
 * Best-effort: só roda se a tabela VENDEDORES já existir no schema — um schema
 * recém-criado só ganha essa tabela no primeiro sync do Firebird; criar uma
 * versão mínima aqui faria pushes futuros do Firebird perderem colunas, já que
 * sincronizacao.js filtra o registro pelas colunas já existentes no servidor.
 * Nunca lança — retorna null se não for possível vincular agora.
 *
 * @param {string} schema
 * @param {number} idUsuario
 * @returns {Promise<number|null>}
 */
async function vincularVendedorDono(schema, idUsuario) {
  try {
    return await withTenantConnection(schema, async db => {
      const cols = await colunasTabela(db, schema, 'VENDEDORES').catch(() => []);
      if (cols.length === 0) return null; // tabela ainda não existe — nada a fazer

      const [ins] = await query(db, `
        INSERT INTO VENDEDORES (id_vendedor, nome, status, id_ultima_atualizacao_matriz)
        VALUES ((SELECT COALESCE(MAX(id_vendedor::numeric), 0) + 1 FROM VENDEDORES), 'DONO', 'A',
                nextval('${schema}.seq_atualizacao_matriz'))
        RETURNING id_vendedor
      `);
      if (ins?.ID_VENDEDOR == null) return null;

      await execute(db,
        `UPDATE public.usuarios_empresas SET id_vendedor = $1 WHERE id_usuario = $2 AND schema_name = $3`,
        [ins.ID_VENDEDOR, idUsuario, schema]
      );
      return Number(ins.ID_VENDEDOR);
    });
  } catch (e) {
    console.error(`[vincularVendedorDono] falhou para ${schema}:`, e.message);
    return null;
  }
}

module.exports = { vincularVendedorDono };
