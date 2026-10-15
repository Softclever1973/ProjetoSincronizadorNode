/**
 * Verificação de sincronização pedida no admin: a cada ciclo o client pergunta se há pedido para
 * esta loja; se houver, lê cada tabela no Firebird com as mesmas traduções do push (FK → SRV_ID,
 * ID_LOJA vazio = loja) e manda o hash de cada registro; depois os valores dos que divergem.
 */
const { query } = require('#client/infrastructure/firebird/db.js');
const http = require('#client/http.js');
const TABELAS = require('#client/domain/tabelas.js');
const { tabelaAtiva } = require('#client/infrastructure/config/tabelasConfig.js');
const { COLUNAS_SEMPRE_IGNORADAS } = require('#client/application/syncEngine/sync.js');
const { tipoComparacao, valorCanonico, hashLinha, chaveRegistro, LIMITE_TEXTO_LONGO } = require('#client/domain/verificacao.js');

const LOTE_LEITURA = 5000;
const NAO_COMPARAR = new Set(['SRV_ID', 'ID_ULTIMA_ATUALIZACAO_MATRIZ']);
let servidorSemRota = false; // servidor antigo (sem TSMVerificacao): não pergunta de novo neste processo

async function colunasFirebird(db, tabela) {
  const rows = await query(db, `
    SELECT TRIM(rf.RDB$FIELD_NAME) AS COLUNA, f.RDB$FIELD_TYPE AS TIPO, f.RDB$FIELD_SUB_TYPE AS SUBTIPO
    FROM RDB$RELATION_FIELDS rf
    JOIN RDB$FIELDS f ON f.RDB$FIELD_NAME = rf.RDB$FIELD_SOURCE
    WHERE TRIM(rf.RDB$RELATION_NAME) = ? AND f.RDB$COMPUTED_SOURCE IS NULL`, [tabela]);
  return new Map(rows.map(r => [String(r.COLUNA).trim(), tipoComparacao(r.TIPO, r.SUBTIPO)]));
}

// Mapa ID local → SRV_ID do pai, para as FKs que o push traduz.
async function mapasFk(db, config) {
  const mapas = {};
  for (const fk of config.fks || []) {
    if (!fk.traduzirSrvId || !fk.pkRef) continue;
    const rows = await query(db, `SELECT ${fk.pkRef} AS ID, SRV_ID FROM ${fk.tabela}`).catch(() => []);
    mapas[fk.coluna] = new Map(rows.map(r => [String(Number(r.ID)), r.SRV_ID]));
  }
  return mapas;
}

/** Lê a tabela inteira e devolve chave → { hash, valores } (valores canônicos, para os detalhes). */
async function coletarTabela(db, config, colunasServidor, idLoja) {
  const pks = Array.isArray(config.pk) ? config.pk : [config.pk];
  const tiposFb = await colunasFirebird(db, config.nome);
  const doServidor = new Set(colunasServidor);
  const colunas = [...tiposFb]
    .filter(([nome, cat]) => cat && doServidor.has(nome) && !COLUNAS_SEMPRE_IGNORADAS.has(nome) && !NAO_COMPARAR.has(nome))
    .map(([nome, categoria]) => ({ nome, categoria }))
    .sort((a, b) => a.nome.localeCompare(b.nome));
  const fks = await mapasFk(db, config);

  // Mesma retenção do pull: o servidor só manda os últimos 2 anos.
  const where = config.colunaData && tiposFb.has(config.colunaData)
    ? `WHERE ${config.colunaData} IS NULL OR ${config.colunaData} >= DATEADD(YEAR, -2, CURRENT_DATE)` : '';
  // BLOB de texto via CAST: o node-firebird devolveria uma função de leitura, inválida depois que a consulta termina.
  const expr = c => (c.categoria === 'textoLongo'
    ? `CAST(SUBSTRING(${c.nome} FROM 1 FOR ${LIMITE_TEXTO_LONGO}) AS VARCHAR(${LIMITE_TEXTO_LONGO})) AS ${c.nome}`
    : c.nome);
  // Chave: SRV_ID (único no servidor) quando a tabela tem; o ID local pode se repetir entre lojas.
  const porSrvId = Boolean(config.srvId) && tiposFb.has('SRV_ID');
  const selecionar = [...new Set([...pks, ...(porSrvId ? ['SRV_ID'] : []), ...colunas.filter(c => !pks.includes(c.nome)).map(expr)])].join(', ');
  const registros = new Map();
  const chavePorPk = new Map(); // PK local → chave usada (para a fila de envio)
  for (let pular = 0; ; pular += LOTE_LEITURA) {
    const lote = await query(db,
      `SELECT FIRST ${LOTE_LEITURA} SKIP ${pular} ${selecionar} FROM ${config.nome} ${where} ORDER BY ${pks.join(', ')}`);
    for (const linha of lote) {
      const pk = chaveRegistro(linha, pks);
      if (pk === null) continue;
      // Sem SRV_ID ainda (nunca enviado): chave própria, nunca casa com o servidor.
      const chave = porSrvId ? (linha.SRV_ID != null ? String(Number(linha.SRV_ID)) : `local:${pk}`) : pk;
      chavePorPk.set(pk, chave);
      if ((linha.ID_LOJA == null || linha.ID_LOJA === '') && 'ID_LOJA' in linha) linha.ID_LOJA = idLoja;
      for (const [coluna, mapa] of Object.entries(fks)) {
        if (linha[coluna] != null) linha[coluna] = mapa.get(String(Number(linha[coluna]))) ?? null;
      }
      const valores = {};
      for (const c of colunas) valores[c.nome] = valorCanonico(linha[c.nome], c.categoria);
      registros.set(chave, { hash: hashLinha(colunas.map(c => valores[c.nome])), valores });
    }
    if (lote.length < LOTE_LEITURA) break;
  }
  const pendentes = (await query(db, 'SELECT PK_VALOR FROM SYNC_ALTERACOES_PENDENTES WHERE NOME_TABELA = ?', [config.nome]))
    .map(r => chavePorPk.get(String(r.PK_VALOR).trim())).filter(Boolean);
  return { colunas, registros, pendentes, chave: porSrvId ? 'SRV_ID' : 'PK' };
}

async function atenderVerificacao(db, baseURI, idLoja, tabelasExistentes, log) {
  if (servidorSemRota || !idLoja) return;
  let pedido;
  try {
    pedido = await http.buscarVerificacaoPendente(baseURI, idLoja);
  } catch (e) {
    if (/ 404/.test(e.message)) { servidorSemRota = true; return; }
    throw e;
  }
  if (!pedido?.id) return;
  log(`[Verificação] pedido #${pedido.id}: ${pedido.tabelas.length} tabela(s)`);
  let erroGeral = null;
  try {
    for (const nome of pedido.tabelas) {
      const config = TABELAS.find(t => t.nome === nome);
      const base = { id: pedido.id, tabela: nome };
      if (!config) { await http.enviarVerificacaoTabela(baseURI, idLoja, { ...base, motivo: 'Tabela desconhecida por esta versão do client' }); continue; }
      if (!tabelasExistentes.has(nome)) { await http.enviarVerificacaoTabela(baseURI, idLoja, { ...base, motivo: 'Tabela não existe no Firebird desta loja' }); continue; }
      if (!tabelaAtiva(nome)) { await http.enviarVerificacaoTabela(baseURI, idLoja, { ...base, motivo: 'Sincronização desta tabela está desativada nesta loja' }); continue; }
      try {
        const inicio = Date.now();
        const { colunas, registros, pendentes, chave } = await coletarTabela(db, config, pedido.colunasServidor?.[nome] || [], idLoja);
        const { detalhes = [] } = await http.enviarVerificacaoTabela(baseURI, idLoja, {
          ...base, chave, colunas, pendentes, hashes: [...registros].map(([k, r]) => [k, r.hash]),
        });
        if (detalhes.length) {
          await http.enviarVerificacaoDetalhes(baseURI, idLoja, {
            ...base, registros: Object.fromEntries(detalhes.map(k => [k, registros.get(k)?.valores ?? null])),
          });
        }
        log(`[Verificação] ${nome}: ${registros.size} registro(s) em ${Math.round((Date.now() - inicio) / 1000)}s`);
      } catch (e) {
        log(`[Verificação] ${nome}: erro ${e.message}`);
        await http.enviarVerificacaoTabela(baseURI, idLoja, { ...base, erro: e.message.slice(0, 300) }).catch(() => {});
      }
    }
  } catch (e) {
    erroGeral = e.message;
    log(`[Verificação] pedido #${pedido.id} interrompido: ${e.message}`);
  }
  await http.concluirVerificacao(baseURI, idLoja, { id: pedido.id, erro: erroGeral }).catch(e => log(`[Verificação] falha ao concluir: ${e.message}`));
}

module.exports = { atenderVerificacao, coletarTabela };
