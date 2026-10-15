/**
 * Verificação de sincronização: lê no Postgres o que o pull entregaria à loja (mesmo filtro de
 * loja, retenção de 2 anos e traduções do pull) e devolve cada registro em valores canônicos.
 */
const { types } = require('pg');
const TABELAS = require('#client/domain/tabelas.js');
const { valorCanonico, hashLinha, chaveRegistro } = require('#client/domain/verificacao.js');
const { colunasTabela, COLUNAS_IGNORADAS_SERVIDOR } = require('#server/infrastructure/repositories/colunasRepository.js');
const { NOME_VALIDO } = require('#server/domain/validacao.js');

// Datas e horas como texto cru: o driver converteria pelo fuso do processo do servidor.
const OIDS_DATA_HORA = new Set([1082, 1083, 1114, 1184, 1266]);
const TIPOS_CRUS = { getTypeParser: (oid, fmt) => (OIDS_DATA_HORA.has(oid) ? v => v : types.getTypeParser(oid, fmt)) };

async function consultar(db, text, values) {
  const { rows } = await db.query({ text, values, types: TIPOS_CRUS });
  return rows.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toUpperCase(), v])));
}

/** Colunas comparáveis do servidor para uma tabela (sem as de controle). */
async function colunasComparaveis(db, schema, tabela) {
  const cols = await colunasTabela(db, schema, tabela);
  return cols.map(c => c.COLUMN_NAME).filter(c => !COLUNAS_IGNORADAS_SERVIDOR.has(c));
}

// Mesma escolha de filtro de loja do RegistrosParaAtualizar (CLIENTES segue o parâmetro do servidor).
async function filtroDeLoja(db, config) {
  if (config.nome !== 'CLIENTES') return config.filtroFilial;
  const [cfg] = await consultar(db, `SELECT parametro FROM parametros WHERE chave = 'filtro_filial_clientes'`).catch(() => []);
  return cfg?.PARAMETRO && NOME_VALIDO.test(cfg.PARAMETRO) ? cfg.PARAMETRO : null;
}

/**
 * @param {{ tabela: string, colunas: { nome: string, categoria: string }[], idLoja: number, schema: string, chave?: 'SRV_ID'|'PK' }} opts
 *   chave: a mesma que o client usou — SRV_ID (único no servidor) ou a PK local do Firebird.
 * @returns {Promise<{ registros: Map<string, { hash: string, valores: object }>, semChave: number, repetidas: string[] }>}
 */
async function registrosServidor(db, { tabela, colunas, idLoja, schema, chave = 'PK' }) {
  const config = TABELAS.find(t => t.nome === tabela);
  if (!config) throw Object.assign(new Error(`Tabela ${tabela} não sincroniza`), { isValidation: true });
  const pks = Array.isArray(config.pk) ? config.pk : [config.pk];
  const existentes = new Set((await colunasTabela(db, schema, tabela)).map(c => c.COLUMN_NAME));
  const usadas = colunas.filter(c => existentes.has(c.nome) && NOME_VALIDO.test(c.nome));
  const sinal = config.normalizarSinal;
  const porSrvId = chave === 'SRV_ID' && existentes.has('SRV_ID');

  const selecionar = new Set([...pks, ...(porSrvId ? ['SRV_ID'] : []), ...usadas.map(c => c.nome)]);
  if (sinal && existentes.has(sinal.colunaRef)) selecionar.add(sinal.colunaRef);
  const params = [];
  const where = ['ID_ULTIMA_ATUALIZACAO_MATRIZ IS NOT NULL'];
  const colLoja = await filtroDeLoja(db, config);
  if (colLoja && existentes.has(colLoja)) { params.push(idLoja); where.push(`${colLoja} = $${params.length}`); }
  if (config.filtroFilialViaFK && config.filtroFilialViaTabela) {
    params.push(idLoja);
    where.push(`${config.filtroFilialViaFK} IN (SELECT ${config.filtroFilialViaFK} FROM ${config.filtroFilialViaTabela} WHERE ID_LOJA = $${params.length})`);
  }
  if (config.colunaData && existentes.has(config.colunaData)) {
    where.push(`(${config.colunaData} IS NULL OR ${config.colunaData}::text::timestamptz >= NOW() - INTERVAL '2 years')`);
  }
  const linhas = await consultar(db,
    `SELECT ${[...selecionar].join(', ')} FROM ${tabela} WHERE ${where.join(' AND ')}`, params);

  // PRODUTOS: o pull troca o preço pelo da loja (PRODUTOS_PRECOS_LOJAS) quando existe.
  let precoLoja = null;
  if (tabela === 'PRODUTOS') {
    precoLoja = new Map((await consultar(db, 'SELECT ID_PRODUTO, PRECO FROM PRODUTOS_PRECOS_LOJAS WHERE ID_LOJA = $1', [idLoja])
      .catch(() => [])).map(r => [String(Number(r.ID_PRODUTO)), r.PRECO]));
  }

  const registros = new Map();
  const repetidas = new Set(); // mesma chave em mais de uma linha (ID local repetido entre lojas)
  let semChave = 0;
  for (const linha of linhas) {
    const chaveLinha = porSrvId
      ? (linha.SRV_ID != null ? String(Number(linha.SRV_ID)) : null)
      : chaveRegistro(linha, pks);
    if (chaveLinha === null) { semChave++; continue; } // criado no site, ainda sem ID do Firebird
    if (registros.has(chaveLinha)) repetidas.add(chaveLinha);
    if (sinal && linha[sinal.coluna] != null) {
      const tipo = String(linha[sinal.colunaRef] ?? '').toLowerCase().trim();
      const n = Number(linha[sinal.coluna]);
      if (n > 0 && sinal.negativoQuando.some(p => tipo === p.toLowerCase())) linha[sinal.coluna] = -n;
    }
    if (tabela === 'A_RECEBER' && typeof linha.STATUS === 'string' && linha.STATUS) {
      linha.STATUS = linha.STATUS.charAt(0).toUpperCase() + linha.STATUS.slice(1);
    }
    if (precoLoja?.has(String(Number(linha.ID_PRODUTO)))) linha.PRECO_VENDA = precoLoja.get(String(Number(linha.ID_PRODUTO)));

    const valores = {};
    for (const c of colunas) valores[c.nome] = existentes.has(c.nome) ? valorCanonico(linha[c.nome], c.categoria) : null;
    registros.set(chaveLinha, { hash: hashLinha(colunas.map(c => valores[c.nome])), valores });
  }
  return { registros, semChave, repetidas: [...repetidas] };
}

module.exports = { registrosServidor, colunasComparaveis };
