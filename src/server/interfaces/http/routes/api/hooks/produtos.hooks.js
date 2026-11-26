/**
 * Hooks de handleSave (crud.js) específicos da tabela PRODUTOS.
 */
const { query, execute } = require('#server/infrastructure/db.js');
const { proximoSrvIdDaTabela } = require('#server/infrastructure/repositories/srvIdSequencia.js');
const { denormalizar: usuarioDaMovimentacao } = require('./movimentacoes.hooks');

// Unicidade de CODIGO quando parâmetro 122 = 'S' no Firebird da filial (parametros.codigo_interno_unico)
async function validarUnicidade(db, { registro }) {
  const codigoKey = Object.keys(registro).find(k => k.toUpperCase() === 'CODIGO');
  const codigoVal = codigoKey ? String(registro[codigoKey] ?? '').trim() : '';
  if (!codigoVal) return;

  const [cfg] = await query(db,
    `SELECT parametro FROM parametros WHERE chave = 'codigo_interno_unico'`
  ).catch(() => [null]);
  if (cfg?.PARAMETRO !== 'S') return;

  const srvIdKey = Object.keys(registro).find(k => k.toUpperCase() === 'SRV_ID');
  const srvIdAtual = srvIdKey !== undefined ? registro[srvIdKey] : null;
  const qParams = [codigoVal];
  const excludeClause = srvIdAtual != null ? ' AND SRV_ID != $2' : '';
  if (srvIdAtual != null) qParams.push(srvIdAtual);
  const [dup] = await query(db,
    `SELECT 1 FROM PRODUTOS WHERE UPPER(TRIM(CODIGO)) = UPPER(TRIM($1))${excludeClause} LIMIT 1`,
    qParams
  ).catch(() => [null]);
  if (dup) throw Object.assign(
    new Error(`Código "${codigoVal}" já está em uso por outro produto.`),
    { isValidation: true }
  );
}

// Data e hora de agora no fuso das lojas ('YYYY-MM-DD', 'HH:MM:SS'), como o site gravava.
function agoraNasLojas() {
  const [data, hora] = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date()).split(' ');
  return { data, hora };
}

// Produto novo pelo site: saldo 0 e movimentação de "Implantação" com a permissão de Produtos (não exige a de movimentação).
async function depoisDeGravar(db, { update, schema, srvId, req }) {
  if (update || srvId == null) return;
  await execute(db, 'UPDATE PRODUTOS SET SALDO_ATUAL = 0 WHERE SRV_ID = $1 AND SALDO_ATUAL IS NULL', [srvId])
    .catch(e => console.error(`[produtos] saldo inicial não gravado (schema=${schema}, SRV_ID=${srvId}):`, e.message));
  // Falha aqui só vai para o log: o produto já está gravado e um erro faria o usuário salvar de novo (duplicando).
  try {
    const colunas = new Map((await query(db, `
      SELECT UPPER(column_name) AS col, data_type FROM information_schema.columns
      WHERE table_schema = $1 AND LOWER(table_name) = 'movimentacoes'`, [schema])).map(r => [r.COL, r.DATA_TYPE]));
    if (colunas.size === 0) return; // tabela ainda não sincronizada neste servidor

    const [{ PROXIMO } = {}] = await query(db, 'SELECT COALESCE(MAX(ID_MOVIMENTACAO), 0) + 1 AS proximo FROM MOVIMENTACOES');
    const { data, hora } = agoraNasLojas();
    const mov = {
      ID_MOVIMENTACAO: Number(PROXIMO),
      ID_PRODUTO: srvId,
      TIPO_MOVIMENTACAO: 'Implantação',
      DATA: data,
      // Coluna timestamp guarda hora "solta" em 1970-01-01, como o CRUD faz.
      HORA: colunas.get('HORA')?.startsWith('timestamp') ? `1970-01-01T${hora}` : hora,
      QUANTIDADE: 0,
      SALDO_ANTERIOR: 0,
      SALDO_ATUAL: 0,
      USUARIO: 'Web',
      ORIGEM_LANCAMENTO: 'Web',
      ID_LOJA: req?.userLojas?.[schema] ?? null,
    };
    await usuarioDaMovimentacao(db, schema, mov, new Set(colunas.keys()), req);
    if (colunas.has('SRV_ID')) mov.SRV_ID = await proximoSrvIdDaTabela(db, schema, 'MOVIMENTACOES');

    const cols = Object.keys(mov).filter(c => colunas.has(c));
    await execute(db,
      `INSERT INTO MOVIMENTACOES (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
      cols.map(c => mov[c]));
    if (colunas.has('ID_ULTIMA_ATUALIZACAO_MATRIZ')) {
      await execute(db,
        `UPDATE MOVIMENTACOES SET ID_ULTIMA_ATUALIZACAO_MATRIZ = nextval('${schema}.seq_atualizacao_matriz') WHERE ID_MOVIMENTACAO = $1`,
        [mov.ID_MOVIMENTACAO]);
    }
  } catch (e) {
    console.error(`[produtos] movimentação de Implantação não gravada (schema=${schema}, SRV_ID=${srvId}):`, e.message);
  }
}

module.exports = { validarUnicidade, depoisDeGravar };
