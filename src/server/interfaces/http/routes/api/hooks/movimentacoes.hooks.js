/**
 * Hooks de handleSave (crud.js) específicos da tabela MOVIMENTACOES.
 */
const { query } = require('#server/infrastructure/db.js');
const { resolverNomeVendedor } = require('#server/interfaces/http/routes/api/helpers.js');

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

// DATA/HORA em texto misturam o site ('2026-10-14' / '11:42:06', hora local) e o client (ISO em UTC): ordena tudo como data e hora local.
const RE_HORA_ISO = `'^1970-01-0[12]T[0-9]{2}:[0-9]{2}:[0-9]{2}'`;
function expressaoOrdenacao(col, tipo) {
  if (tipo !== 'text' && tipo !== 'character varying') return null;
  if (col === 'DATA') return 'LEFT(DATA, 10)';
  if (col === 'HORA') return `(CASE WHEN HORA ~ ${RE_HORA_ISO} THEN to_char(HORA::timestamptz, 'HH24:MI:SS') ELSE HORA END)`;
  return null;
}

module.exports = { denormalizar, expressaoOrdenacao };
