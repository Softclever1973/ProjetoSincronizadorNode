const { query, execute } = require('#client/infrastructure/firebird/db.js');
const { enviarRegistro, enviarRegistros } = require('#client/http.js');
const { atualizarOuSalvarConflito } = require('#client/infrastructure/persistence/conflitos.js');
const { registrarEcho } = require('./echos');
const { salvarErro } = require('#client/infrastructure/persistence/erros.js');
const { envioEstaPausado, cargaEstaPausada, geracaoEnvio } = require('./controle');
const { SQL_NAO_EH_CARGA, ehDaCarga } = require('#client/domain/filaCarga.js');

// Máximo de pendentes por tabela num ciclo — evita carregar milhões na memória de uma vez.
const LOTE_PUSH = 2000;
// Registros por chamada ao servidor (ReceberRegistros) e teto de tamanho do corpo.
const LOTE_ENVIO = 100;
const LOTE_ENVIO_BYTES = 2 * 1024 * 1024;
// Servidor antigo (sem ReceberRegistros) → envio unitário; tenta o lote de novo depois disso.
const RECHECAR_LOTE_MS = 30 * 60 * 1000;
let loteIndisponivelAte = 0;

/**
 * Lê o registro local e monta o que vai pro servidor (FKs traduzidas, sinal normalizado,
 * versão conhecida). Retorna null quando o registro deve ficar pendente pro próximo ciclo.
 */
async function prepararPendente(db, configTabela, pendente, idLoja, log) {
  const { nome, pk } = configTabela;
  const pks = Array.isArray(pk) ? pk : [pk];
  const pkValor = pendente.PK_VALOR;
  const pkValores = pkValor.split('|');

  let registros;
  try {
    registros = await query(db, `SELECT * FROM ${nome} WHERE ${pks.map(p => `${p} = ?`).join(' AND ')}`, pkValores);
  } catch (e) {
    log(`[${nome}] Erro ao buscar registro local (${pkValor}): ${e.message}`);
    return null;
  }

  if (registros.length === 0) {
    const registroDelete = {};
    pks.forEach((coluna, i) => { registroDelete[coluna] = pkValores[i]; });
    return { pkValor, pkValores, deletar: true, registro: registroDelete, registroParaEnviar: registroDelete, ultimaVersaoConhecida: 0 };
  }

  const registro = registros[0];

  // ID_LOJA nulo é preenchido com o ID da filial — garante que registros criados
  // localmente pelo Delphi (sem ID_LOJA explícito) sejam identificados corretamente
  // no servidor.
  if ((registro.ID_LOJA == null || registro.ID_LOJA === '') && idLoja) {
    registro.ID_LOJA = idLoja;
  }

  // Traduz FKs de PK local pra SRV_ID antes de enviar — o servidor usa SRV_ID como
  // referência global entre tenants, enquanto o Firebird local guarda o ID nativo
  // (ex: MOVIMENTACOES.ID_PRODUTO = ID local de PRODUTOS).
  let registroParaEnviar = registro;
  for (const fkRef of (configTabela.fks || [])) {
    if (!fkRef.traduzirSrvId || !fkRef.pkRef) continue;
    const localId = registroParaEnviar[fkRef.coluna];
    if (localId == null) continue;
    let srvRows;
    try {
      srvRows = await query(db, `SELECT FIRST 1 SRV_ID FROM ${fkRef.tabela} WHERE ${fkRef.pkRef} = ?`, [localId]);
    } catch (err) {
      log(`[${nome}] ERRO ao traduzir FK ${fkRef.coluna} (${fkRef.pkRef}=${localId}): ${err.message}`);
      return null;
    }
    if (srvRows.length === 0) {
      // Pai não existe mais localmente (foi deletado) — nunca vai ganhar SRV_ID, então
      // reenfileirá-lo (como no caso abaixo) causaria loop infinito: o pai é reenviado
      // como deleção, some da fila, e este filho volta a reenfileirá-lo no próximo
      // ciclo, para sempre. Em vez de travar o registro esperando revisão manual, envia
      // mesmo assim sem o vínculo (campo null) — a FK não é tratada como obrigatória.
      log(`[${nome}] WARN FK ${fkRef.coluna}: ${fkRef.pkRef}=${localId} não existe mais em ${fkRef.tabela} — enviando ${pk}=${pkValor} sem vínculo (${fkRef.coluna}=null)`);
      registroParaEnviar = { ...registroParaEnviar, [fkRef.coluna]: null };
      continue;
    }
    if (srvRows[0].SRV_ID == null) {
      log(`[${nome}] WARN FK ${fkRef.coluna}: ${fkRef.pkRef}=${localId} sem SRV_ID — enfileirando ${fkRef.tabela} para sync`);
      // Auto-enfileira o registro pai para que o próximo ciclo resolva o SRV_ID.
      // Sem isso, o filho fica bloqueado indefinidamente até intervenção manual.
      await execute(db,
        `UPDATE OR INSERT INTO SYNC_ALTERACOES_PENDENTES (NOME_TABELA, PK_VALOR, TIMESTAMP_ALTERACAO)
         VALUES (?, ?, CURRENT_TIMESTAMP) MATCHING (NOME_TABELA, PK_VALOR)`,
        [fkRef.tabela, String(localId)]
      ).catch(e2 => log(`[${nome}] WARN: não foi possível enfileirar ${fkRef.tabela}/${localId}: ${e2.message}`));
      return null;
    }
    log(`[${nome}] FK ${fkRef.coluna}: ${fkRef.pkRef}=${localId} → SRV_ID=${srvRows[0].SRV_ID}`);
    registroParaEnviar = { ...registroParaEnviar, [fkRef.coluna]: srvRows[0].SRV_ID };
  }

  // colunasAbsolutas: Firebird filial pode guardar quantidade negativa (ex: Saídas
  // em MOVIMENTACOES.QTDE = -5), mas o servidor só aceita positivo — direção vem de TP.MOV.
  for (const col of (configTabela.colunasAbsolutas || [])) {
    const val = registroParaEnviar[col];
    if (typeof val === 'number' && Number.isFinite(val) && val < 0) {
      registroParaEnviar = { ...registroParaEnviar, [col]: Math.abs(val) };
      log(`[${nome}] coluna ${col}: ${val} → ${Math.abs(val)} (normalização absoluta)`);
    }
  }

  // Última versão conhecida do servidor para este registro (para detecção de conflito)
  let ultimaVersaoConhecida = 0;
  try {
    const versoes = await query(db,
      `SELECT ID_ULTIMA_ATUALIZACAO_MATRIZ FROM SYNC_VERSOES_SERVIDOR WHERE NOME_TABELA = ? AND PK_VALOR = ?`,
      [nome, pkValor]
    );
    if (versoes.length > 0) ultimaVersaoConhecida = versoes[0].ID_ULTIMA_ATUALIZACAO_MATRIZ || 0;
  } catch { }

  return { pkValor, pkValores, deletar: false, registro, registroParaEnviar, ultimaVersaoConhecida };
}

/** Aplica localmente a resposta do servidor para um registro. Retorna 'enviado' | 'conflito'. */
async function processarResultado(db, configTabela, item, resultado, log) {
  const { nome, pk } = configTabela;
  const pks = Array.isArray(pk) ? pk : [pk];
  const { pkValor, pkValores } = item;
  const tirarDaFila = () => execute(db,
    `DELETE FROM SYNC_ALTERACOES_PENDENTES WHERE NOME_TABELA = ? AND PK_VALOR = ?`, [nome, pkValor]);

  for (const aviso of (resultado?.avisos || [])) log(`[${nome}] AVISO do servidor (${pkValor}): ${aviso}`);

  if (item.deletar) {
    await tirarDaFila().catch(() => { });
    return 'enviado';
  }

  if (resultado.conflito) {
    // Remove dos pendentes para não re-enviar indefinidamente no próximo ciclo
    await tirarDaFila().catch(() => { });
    // Atualiza conflito existente para (tabela + pkValor) em vez de duplicar
    const id = atualizarOuSalvarConflito({ tabela: nome, pk, pkValor, versaoLocal: item.registro, versaoServidor: resultado.versaoServidor });
    log(`[${nome}] Conflito (${pk}=${pkValor}) — id: ${id}`);
    return 'conflito';
  }

  await tirarDaFila();
  if (resultado.novoId) registrarEcho(nome, pkValor, resultado.novoId);
  // Atualiza SYNC_VERSOES_SERVIDOR logo após o push — sem isso, uma carga parcial
  // que re-enfileira o registro antes do próximo pull causaria falso conflito
  // (versaoConhecida < novoId).
  if (resultado.novoId) {
    await execute(db,
      `UPDATE OR INSERT INTO SYNC_VERSOES_SERVIDOR (NOME_TABELA, PK_VALOR, ID_ULTIMA_ATUALIZACAO_MATRIZ)
       VALUES (?, ?, ?) MATCHING (NOME_TABELA, PK_VALOR)`,
      [nome, pkValor, resultado.novoId]
    ).catch(() => {});
  }
  if (resultado.srvId && configTabela.srvId) {
    const whereParts = pks.map(p => `${p} = ?`).join(' AND ');
    await execute(db, `EXECUTE BLOCK AS BEGIN RDB$SET_CONTEXT('USER_SESSION', 'SYNC_SKIP', '1'); END`).catch(() => {});
    let srvIdGravado = false;
    try {
      await execute(db, `UPDATE ${nome} SET SRV_ID = ? WHERE ${whereParts}`, [resultado.srvId, ...pkValores]);
      srvIdGravado = true;
    } catch (e) {
      log(`[${nome}] ERRO ao gravar SRV_ID local (${pkValor}): ${e.message} — re-enfileirando para retry`);
      // Re-enfileira para o próximo ciclo tentar de novo — sem isso o registro sai
      // de SYNC_ALTERACOES_PENDENTES com SRV_ID=NULL no Firebird, travando qualquer
      // FK dependente indefinidamente.
      await execute(db,
        `UPDATE OR INSERT INTO SYNC_ALTERACOES_PENDENTES (NOME_TABELA, PK_VALOR, TIMESTAMP_ALTERACAO)
         VALUES (?, ?, CURRENT_TIMESTAMP) MATCHING (NOME_TABELA, PK_VALOR)`,
        [nome, pkValor]
      ).catch(e2 => log(`[${nome}] ERRO ao re-enfileirar (${pkValor}): ${e2.message}`));
    }
    await execute(db, `EXECUTE BLOCK AS BEGIN RDB$SET_CONTEXT('USER_SESSION', 'SYNC_SKIP', NULL); END`).catch(() => {});
    if (srvIdGravado) log(`[${nome}] SRV_ID=${resultado.srvId} gravado localmente (${pkValor})`);
  }
  return 'enviado';
}

function _logEnvio(configTabela, item, log) {
  const { nome, pk } = configTabela;
  if (item.deletar) { log(`[${nome}] Enviando deleção (${item.pkValor}) ao servidor`); return; }
  const r = item.registroParaEnviar;
  log(`[${nome}] Enviando (${Array.isArray(pk) ? pk.map(p => `${p}=${r[p]}`).join(', ') : `${pk}=${r[pk]}`}) ao servidor`);
}

function _registrarErroEnvio(configTabela, item, mensagem, log) {
  const { nome, pk } = configTabela;
  log(item.deletar
    ? `[${nome}] Erro ao enviar deleção (${item.pkValor}): ${mensagem}`
    : `[${nome}] Erro ao enviar (${pk}=${item.pkValor}): ${mensagem}`);
  if (!item.deletar) salvarErro({ tabela: nome, operacao: 'push', mensagem });
}

/** Envio unitário (ReceberRegistro) — usado quando o servidor não tem a rota de lote. */
async function enviarUnitario(db, ctx, item) {
  const { baseURI, idLoja, configTabela, idPDV, nomeFilial, log } = ctx;
  const { nome, pk } = configTabela;
  _logEnvio(configTabela, item, log);
  try {
    const resultado = item.deletar
      ? await enviarRegistro(baseURI, idLoja, nome, pk, item.registroParaEnviar, 0, false, idPDV, nomeFilial, true)
      : await enviarRegistro(baseURI, idLoja, nome, pk, item.registroParaEnviar, item.ultimaVersaoConhecida, false, idPDV, nomeFilial, false, configTabela.srvId ?? false);
    return await processarResultado(db, configTabela, item, resultado, log);
  } catch (e) {
    _registrarErroEnvio(configTabela, item, e.message, log);
    // Deleção sai da fila mesmo com erro (comportamento de sempre — não fica em laço).
    if (item.deletar) await execute(db, `DELETE FROM SYNC_ALTERACOES_PENDENTES WHERE NOME_TABELA = ? AND PK_VALOR = ?`, [nome, item.pkValor]).catch(() => { });
    return 'erro';
  }
}

/** Envia um lote; servidor sem a rota (404) cai pro unitário. Retorna a contagem por status. */
async function enviarLote(db, ctx, itens) {
  const { baseURI, idLoja, configTabela, idPDV, nomeFilial, log } = ctx;
  const { nome, pk } = configTabela;
  const cont = { enviado: 0, conflito: 0, erro: 0 };
  const somar = s => { cont[s]++; };

  // Um por um (servidor antigo): pausa/parar continuam valendo entre registros.
  const unitarios = async () => {
    for (const item of itens) {
      if (ctx.parar()) { cont.interrompido = true; break; }
      somar(await enviarUnitario(db, ctx, item));
    }
    return cont;
  };
  if (Date.now() < loteIndisponivelAte) return unitarios();

  itens.forEach(item => _logEnvio(configTabela, item, log));
  let resposta;
  try {
    resposta = await enviarRegistros(baseURI, idLoja, nome, pk,
      itens.map(i => ({
        registro: i.registroParaEnviar, ultimaVersaoConhecida: i.ultimaVersaoConhecida, deletar: i.deletar,
        ...(i.deletar ? { temSrvId: false } : {}),
      })),
      idPDV, nomeFilial, configTabela.srvId ?? false);
  } catch (e) {
    if (e.status === 404) {
      log(`[${nome}] Servidor sem envio em lote (versão antiga) — enviando um por um`);
      loteIndisponivelAte = Date.now() + RECHECAR_LOTE_MS;
      return unitarios();
    }
    // Falha do lote inteiro (rede/timeout): todos ficam na fila pro próximo ciclo.
    log(`[${nome}] Erro ao enviar lote de ${itens.length} registro(s): ${e.message}`);
    salvarErro({ tabela: nome, operacao: 'push', mensagem: `Lote de ${itens.length}: ${e.message}` });
    cont.erro += itens.length;
    cont.falhaLote = true;
    return cont;
  }

  const resultados = Array.isArray(resposta?.resultados) ? resposta.resultados : [];
  for (let i = 0; i < itens.length; i++) {
    const item = itens[i];
    const r = resultados[i];
    if (!r || r.erro) {
      _registrarErroEnvio(configTabela, item, r?.erro || 'sem resposta do servidor para este registro', log);
      if (item.deletar) await execute(db, `DELETE FROM SYNC_ALTERACOES_PENDENTES WHERE NOME_TABELA = ? AND PK_VALOR = ?`, [nome, item.pkValor]).catch(() => { });
      somar('erro');
      continue;
    }
    try {
      somar(await processarResultado(db, configTabela, item, r, log));
    } catch (e) {
      _registrarErroEnvio(configTabela, item, e.message, log);
      somar('erro');
    }
  }
  return cont;
}

/**
 * Envia ao servidor os registros locais que foram alterados desde o último sync, em lotes
 * de até LOTE_ENVIO por chamada (1 registro pendente = lote de 1). Detecta conflitos e os
 * salva para resolução manual via interface web.
 * Retorna { temMais } quando o lote encheu e ainda pode haver pendentes.
 */
async function empurrarTabela(db, baseURI, idLoja, configTabela, log = console.log, idPDV = null, nomeFilial = '') {
  const { nome } = configTabela;

  // Carga pausada: só as alterações do dia a dia sobem; os pendentes da carga esperam.
  const semCarga = cargaEstaPausada();
  let pendentes;
  try {
    pendentes = await query(
      db,
      `SELECT FIRST ${LOTE_PUSH} PK_VALOR, TIMESTAMP_ALTERACAO FROM SYNC_ALTERACOES_PENDENTES
       WHERE NOME_TABELA = ?${semCarga ? ` AND ${SQL_NAO_EH_CARGA}` : ''} ORDER BY TIMESTAMP_ALTERACAO`,
      [nome]
    );
  } catch {
    // Tabela ainda não existe (setup não rodou ou falhou)
    return { temMais: false };
  }

  if (pendentes.length === 0) return { temMais: false };

  log(`[${nome}] ${pendentes.length}${pendentes.length === LOTE_PUSH ? '+' : ''} registro(s) pendente(s) para enviar ao servidor`);

  const total = { enviado: 0, conflito: 0, erro: 0 };
  let interrompido = false;
  let falhaRede = false;
  const geracao = geracaoEnvio();
  // Pausar a carga no meio do envio só interrompe lote que tem pendente da carga.
  const temCarga = pendentes.some(p => ehDaCarga(p.TIMESTAMP_ALTERACAO));
  const parar = () => envioEstaPausado() || geracaoEnvio() !== geracao || (temCarga && cargaEstaPausada());
  const ctx = { baseURI, idLoja, configTabela, idPDV, nomeFilial, log, parar };

  let lote = [];
  let bytes = 0;
  const descarregar = async () => {
    if (lote.length === 0) return false;
    const r = await enviarLote(db, ctx, lote);
    total.enviado += r.enviado; total.conflito += r.conflito; total.erro += r.erro;
    if (r.interrompido) interrompido = true;
    lote = []; bytes = 0;
    return !!r.falhaLote;
  };

  for (const pendente of pendentes) {
    if (parar()) { interrompido = true; break; }
    const item = await prepararPendente(db, configTabela, pendente, idLoja, log);
    if (!item) continue;
    const tamanho = Buffer.byteLength(JSON.stringify(item.registroParaEnviar));
    if (lote.length > 0 && (lote.length >= LOTE_ENVIO || bytes + tamanho > LOTE_ENVIO_BYTES)) {
      // Rede/timeout no lote: para a tabela neste ciclo em vez de insistir com os próximos.
      if (await descarregar()) { falhaRede = true; break; }
      if (interrompido) break;
    }
    lote.push(item);
    bytes += tamanho;
  }
  if (!interrompido && !falhaRede) {
    if (parar()) interrompido = true;
    else falhaRede = await descarregar();
  }

  if (total.enviado > 0) log(`[${nome}] ${total.enviado} registro(s) enviado(s) ao servidor`);
  if (total.conflito > 0) log(`[${nome}] ${total.conflito} conflito(s) — acesse http://localhost:<porta_webui>/conflitos`);
  if (interrompido) log(`[${nome}] envio ${envioEstaPausado() ? 'pausado' : cargaEstaPausada() ? 'da carga pausado' : 'interrompido'} pelo operador`);
  // Sem nenhum envio no lote (tudo falhou) ou com falha de rede, não força ciclo imediato — evita laço.
  return { temMais: !interrompido && !falhaRede && pendentes.length === LOTE_PUSH && total.enviado + total.conflito > 0 };
}

// Uso exclusivo dos testes: volta a tentar o envio em lote.
function _resetLoteParaTeste() { loteIndisponivelAte = 0; }

module.exports = { empurrarTabela, _resetLoteParaTeste };
