/**
 * Rotas de comandas (pré-venda por comanda/mesa — mesmo conceito, um único número) do tenant.
 * GET /api/:schema/comandas-abertas
 */

const express = require('express');
const router  = express.Router();

const authJwt         = require('#server/interfaces/http/middleware/authJwt.js');
const { checkSchema } = require('#server/interfaces/http/middleware/checkSchema.js');
const { requireModulo } = require('#server/interfaces/http/middleware/requireModulo.js');
const { withTenantConnection, query, execute } = require('#server/infrastructure/db.js');
const { colunasTabela } = require('#server/infrastructure/repositories/colunasRepository.js');
const { erroServidor } = require('#server/interfaces/http/erroServidor.js');
const { resolveIdLoja } = require('./helpers');

// PEDIDOS é sincronizada genericamente — essas colunas só existem no Postgres se algum
// registro do Firebird já tiver chegado com valor nelas (sincronizacao.js descarta campos
// que não existem ainda na tabela do servidor). Garante aqui, uma vez por schema por
// processo, igual ao padrão de garantirColunasParidade em datasnap/financeiro.js.
const _schemasGarantidos = new Set();
async function garantirColunasComandas(db, schema) {
  if (_schemasGarantidos.has(schema)) return;
  await execute(db, `
    ALTER TABLE PEDIDOS
      ADD COLUMN IF NOT EXISTS NUMERO_COMANDA INTEGER,
      ADD COLUMN IF NOT EXISTS QUANTIDADE_DE_PESSOAS INTEGER,
      ADD COLUMN IF NOT EXISTS LINHA_RODAPE_NF1 VARCHAR(255),
      ADD COLUMN IF NOT EXISTS NUMERO_CUPOM_FISCAL INTEGER,
      ADD COLUMN IF NOT EXISTS ID_VENDEDOR INTEGER,
      ADD COLUMN IF NOT EXISTS NOME_VENDEDOR VARCHAR(255),
      ADD COLUMN IF NOT EXISTS NOME_CLIENTE VARCHAR(255),
      ADD COLUMN IF NOT EXISTS HORA_DO_PEDIDO TIME,
      ADD COLUMN IF NOT EXISTS DATA_REALIZACAO TIMESTAMP,
      ADD COLUMN IF NOT EXISTS MOTIVO_CANCELAMENTO VARCHAR(255),
      ADD COLUMN IF NOT EXISTS USUARIO_CANCELAMENTO VARCHAR(255),
      ADD COLUMN IF NOT EXISTS DATA_CANCELAMENTO TIMESTAMP
  `);
  _schemasGarantidos.add(schema);
}

// status (query) -> STATUS de PEDIDOS. 'aberta' (padrão) é a única que também filtra por
// NUMERO_CUPOM_FISCAL vazio (regra original da ferramenta Delphi "Sirius Pré-Venda
// Comandas" — comanda em uso, ainda não passou pelo caixa físico); 'fechada'/'cancelada'
// já saíram do fluxo de edição então esse filtro não se aplica mais a elas. 'todas' (null)
// não filtra por STATUS nenhum.
const STATUS_POR_FILTRO = { todas: null, aberta: 'P', fechada: 'R', cancelada: 'C' };

/* ── GET /api/:schema/comandas-abertas ──
   Apesar do nome (mantido por compatibilidade), essa rota lista comandas em qualquer um
   dos três estados — aberta/fechada/cancelada — conforme o parâmetro ?status=. Comanda
   "aberta" não é um status novo — é um PEDIDOS normal (STATUS='P') com NUMERO_COMANDA
   preenchido. No negócio deste tenant "mesa" e "comanda" são o mesmo conceito (confirmado
   com o usuário) — não existe uma NUMERO_DA_MESA separada em uso real, então um único número
   cobre os dois casos. "fechada" (STATUS='R', Realizado) e "cancelada" (STATUS='C') são
   estados finais, sem edição possível pela tela de Comandas. VALOR_TOTAL_PRODUTOS não é
   usado — como em pedidosPage.js, o total é recalculado a partir de PEDIDOS_ITENS por não
   confiar no valor persistido. */
router.get('/:schema/comandas-abertas', authJwt, checkSchema, requireModulo('comandas', 'r'), async (req, res) => {
  const { schema } = req.params;
  const busca  = req.query.busca?.trim() || '';
  const idLoja = resolveIdLoja(req, schema, { donoPodemFiltrar: true });
  // 'todas' mapeia pra null (sem filtro de STATUS) — não dá pra usar `||` aqui, cairia no
  // fallback 'aberta' porque null é falsy.
  const statusFiltro   = Object.prototype.hasOwnProperty.call(STATUS_POR_FILTRO, req.query.status)
    ? STATUS_POR_FILTRO[req.query.status] : STATUS_POR_FILTRO.aberta;

  try {
    const registros = await withTenantConnection(schema, async db => {
      const colsP = await colunasTabela(db, schema, 'PEDIDOS').catch(() => []);
      if (!colsP.length) return [];

      await garantirColunasComandas(db, schema);
      // VALOR_TOTAL_ITEM nem sempre existe (depende do que já foi sincronizado desse
      // tenant) — QUANTIDADE/VALOR_UNITARIO são as colunas realmente garantidas em
      // PEDIDOS_ITENS, então o total soma por ali quando falta a coluna pronta.
      const colsItensSet = new Set((await colunasTabela(db, schema, 'PEDIDOS_ITENS').catch(() => [])).map(c => c.COLUMN_NAME));
      const somaItem = colsItensSet.has('VALOR_TOTAL_ITEM')
        ? 'pi.VALOR_TOTAL_ITEM'
        : colsItensSet.has('QUANTIDADE') && colsItensSet.has('VALOR_UNITARIO')
          ? 'pi.QUANTIDADE * pi.VALOR_UNITARIO'
          : null;

      // Cast pra text antes de comparar — essas colunas podem ter vindo do export inicial do
      // schema Firebird com um tipo que não é INTEGER (o ADD COLUMN IF NOT EXISTS acima só
      // cria a coluna quando ela não existe, não migra o tipo de uma já existente), e um
      // COALESCE(coluna, 0) quebra em "tipos ... não podem corresponder" nesse caso.
      const where = [
        `COALESCE(NULLIF(p.NUMERO_COMANDA::text, ''), '0')::numeric > 0`,
      ];
      if (statusFiltro !== null) where.push(`p.STATUS = '${statusFiltro}'`);
      if (statusFiltro === 'P') {
        where.push(`COALESCE(NULLIF(p.NUMERO_CUPOM_FISCAL::text, ''), '0') = '0'`);
      }
      const params = [];
      if (idLoja !== null) { params.push(idLoja); where.push(`p.ID_LOJA = $${params.length}`); }
      if (busca) {
        // Número da comanda casa por prefixo (busca incremental de digitação); garçom,
        // cliente e observação casam por substring — mais útil pra nome do que prefixo.
        params.push(`${busca}%`, `%${busca}%`);
        const pPrefixo = params.length - 1, pSubstr = params.length;
        where.push(`(
          p.NUMERO_COMANDA::text LIKE $${pPrefixo}
          OR p.NOME_VENDEDOR ILIKE $${pSubstr}
          OR p.NOME_CLIENTE ILIKE $${pSubstr}
          OR p.LINHA_RODAPE_NF1 ILIKE $${pSubstr}
        )`);
      }

      // Fechadas/canceladas são histórico — mais útil ordenado pelo momento do encerramento
      // (mais recente primeiro) do que pelo número da comanda. Abertas/todas continuam por
      // NUMERO_COMANDA (não faz sentido ordenar "todas" por um dos dois campos de encerramento,
      // já que comandas abertas não têm nenhum dos dois preenchido).
      const orderBy = statusFiltro === 'R' ? 'p.DATA_REALIZACAO DESC NULLS LAST'
        : statusFiltro === 'C' ? 'p.DATA_CANCELAMENTO DESC NULLS LAST'
        : 'p.NUMERO_COMANDA ASC';

      return query(db, `
        SELECT p.ID_PEDIDO, p.NUMERO_COMANDA, p.DATA_DO_PEDIDO, p.HORA_DO_PEDIDO, p.STATUS,
               p.QUANTIDADE_DE_PESSOAS, p.LINHA_RODAPE_NF1 AS OBSERVACAO,
               p.ID_VENDEDOR, p.NOME_VENDEDOR, p.NOME_CLIENTE,
               p.DATA_REALIZACAO, p.DATA_CANCELAMENTO,
               ${somaItem
                 ? `COALESCE((SELECT SUM(${somaItem}) FROM PEDIDOS_ITENS pi WHERE pi.ID_PEDIDO = p.ID_PEDIDO), 0)`
                 : '0'} AS VALOR_TOTAL
        FROM PEDIDOS p
        WHERE ${where.join(' AND ')}
        ORDER BY ${orderBy}
      `, params);
    });
    res.json({ registros });
  } catch (e) {
    erroServidor(res, e, 'GET comandas-abertas');
  }
});

module.exports = router;
