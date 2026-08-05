/**
 * Hooks de handleSave (crud.js) específicos da tabela MOVIMENTACOES.
 */
const { resolverNomeVendedor } = require('../helpers');

async function denormalizar(db, schema, registro, allowed, req) {
  // Frontend manda "Web - <conta>" em USUARIO; se a conta tem vendedor vinculado, usa
  // o nome do vendedor (mesma convenção do desktop, sem prefixo "Web -"). Contas sem
  // vendedor (ex.: dono) mantêm o valor já enviado.
  const idVendedor = req.userVendedores?.[schema] ?? null;
  if (idVendedor != null && allowed.has('USUARIO')) {
    const nomeVendedor = await resolverNomeVendedor(db, schema, idVendedor);
    if (nomeVendedor) registro.USUARIO = nomeVendedor;
  }
}

module.exports = { denormalizar };
