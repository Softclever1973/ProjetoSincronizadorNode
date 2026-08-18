/**
 * Hooks de handleSave (crud.js) específicos da tabela MOVIMENTACOES.
 */
const { query } = require('../../../../../infrastructure/db');
const { resolverNomeVendedor } = require('../helpers');

async function denormalizar(db, schema, registro, allowed, req) {
  if (!allowed.has('USUARIO')) return;

  // Se a conta tem vendedor vinculado, usa o nome do vendedor (mesma convenção do
  // desktop, sem prefixo "Web -").
  const idVendedor = req.userVendedores?.[schema] ?? null;
  if (idVendedor != null) {
    const nomeVendedor = await resolverNomeVendedor(db, schema, idVendedor);
    if (nomeVendedor) { registro.USUARIO = nomeVendedor; return; }
  }

  // Sem vendedor vinculado: resolve o nome real do usuário logado a partir do JWT
  // (req.userId, verificado por assinatura) em vez de confiar no "Web - <conta>" que o
  // frontend manda — esse valor vem de jwt_nome no localStorage, que é compartilhado
  // entre todas as abas do navegador e pode estar desatualizado/de outra conta.
  const [u] = await query(db, 'SELECT nome FROM public.usuarios WHERE id = $1', [req.userId]).catch(() => []);
  if (u?.NOME) registro.USUARIO = `Web - ${u.NOME}`;
}

module.exports = { denormalizar };
