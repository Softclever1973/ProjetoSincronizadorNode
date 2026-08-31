const { query, execute, isMissingTableError } = require('#server/infrastructure/db.js');
const { colunasCache, getColunasServidor, getColunasComputadas, seqsSrvIdInicializadas, constraintsUqAdicionadas } = require('#server/infrastructure/cache/tenantCache.js');
const { criarTabelaSeNecessario } = require('#server/infrastructure/repositories/colunasRepository.js');
const { chaveNegocioTabela, colunasTipadasDeRegistro } = require('#server/domain/schema.js');
const { gerarContasReceberDoPedido } = require('#server/application/financeiro/gerarContasReceberDoPedido.js');

/**
 * Aloca (ou reusa) o SRV_ID de um registro, para tabelas que usam SRV_ID como PK real no
 * servidor. Sequence por-tabela (seq_srv_id_<tabela>) evita contador global compartilhado.
 */
async function alocarSrvId(db, { schemaName, idLoja, nomeTabela, pks, registro }) {
  const pkValorStr = pks.map(p => String(registro[p])).join('|');
  const seqNome = `seq_srv_id_${nomeTabela.toLowerCase()}`;
  const seqKey  = `${schemaName}:${seqNome}`;

  // SRV_ID já no payload = registro criado via web (PK null) e ecoado no pull —
  // reusa o ID existente em vez de alocar um novo, evitando duplicatas.
  const srvIdFilial = registro.SRV_ID != null ? Number(registro.SRV_ID) : null;

  if (srvIdFilial != null) {
    // Registra id_local → srv_id existente (sem alocar novo valor). Cada filial tem
    // seu próprio generator Firebird, então (filial_id, tabela, id_local) é a chave
    // real — o mesmo id_local em filiais diferentes são registros distintos.
    await execute(db,
      `INSERT INTO srv_id_map (filial_id, tabela, id_local, srv_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (filial_id, tabela, id_local) WHERE filial_id IS NOT NULL
       DO UPDATE SET srv_id = EXCLUDED.srv_id`,
      [idLoja, nomeTabela, pkValorStr, srvIdFilial]
    ).catch(() => {});
    return srvIdFilial;
  }

  const criarSequence = async () => {
    // Começa a sequence após o maior SRV_ID já atribuído à tabela,
    // para não colidir com valores de instalações existentes.
    const [maxRow] = await query(db,
      `SELECT COALESCE(MAX(srv_id), 0) + 1 AS inicio FROM srv_id_map WHERE tabela = $1`,
      [nomeTabela]
    ).catch(() => [{ INICIO: 1 }]);
    const inicio = maxRow?.INICIO ?? 1;
    await execute(db, `CREATE SEQUENCE IF NOT EXISTS ${seqNome} START WITH ${inicio}`).catch(() => {});
    seqsSrvIdInicializadas.add(seqKey);
  };

  if (!seqsSrvIdInicializadas.has(seqKey)) await criarSequence();

  const inserirMapa = () => query(db,
    `INSERT INTO srv_id_map (filial_id, tabela, id_local, srv_id)
     VALUES ($1, $2, $3, nextval('${seqNome}'))
     ON CONFLICT (filial_id, tabela, id_local) WHERE filial_id IS NOT NULL
     DO UPDATE SET srv_id = srv_id_map.srv_id
     RETURNING srv_id`,
    [idLoja, nomeTabela, pkValorStr]
  );

  // Retry único: reset-empresa.js pode ter apagado esta sequence com o servidor
  // no ar, deixando o cache em memória desatualizado (42P01). Recria e tenta de novo.
  let mapa;
  try {
    [mapa] = await inserirMapa();
  } catch (eSeq) {
    if (!isMissingTableError(eSeq)) throw eSeq;
    seqsSrvIdInicializadas.delete(seqKey);
    await criarSequence();
    [mapa] = await inserirMapa();
  }

  return mapa?.SRV_ID ?? null;
}

/**
 * Aplica uma deleção vinda da filial: remove a linha (por SRV_ID via srv_id_map, ou pela
 * PK original conforme a tabela use ou não SRV_ID) e registra o rastro em registros_deletados.
 */
async function processarDelecao(db, { nomeTabela, temSrvId, pks, registro, idLoja }) {
  if (temSrvId) {
    const pkValorStr = pks.map(p => registro[p]).join('|');
    const [mapa] = await query(db,
      `SELECT srv_id FROM srv_id_map WHERE tabela = $1 AND id_local = $2 AND filial_id = $3`,
      [nomeTabela, pkValorStr, idLoja]
    ).catch(() => [null]);
    const srvIdDel = mapa?.SRV_ID;
    try {
      if (srvIdDel) {
        await execute(db, `DELETE FROM ${nomeTabela} WHERE SRV_ID = $1`, [srvIdDel]);
        await execute(db,
          `DELETE FROM srv_id_map WHERE tabela = $1 AND id_local = $2 AND filial_id = $3`,
          [nomeTabela, pkValorStr, idLoja]
        );
      }
      await execute(db,
        `INSERT INTO registros_deletados (nome_da_tabela, id_registros, criado_em) VALUES ($1, $2, NOW())`,
        [nomeTabela, pkValorStr]
      );
    } catch (e) {
      if (!isMissingTableError(e)) throw e;
    }
  } else {
    const whereValores = pks.map(p => registro[p]);
    const whereParts   = pks.map((p, i) => `${p} = $${i + 1}`).join(' AND ');
    try {
      await execute(db, `DELETE FROM ${nomeTabela} WHERE ${whereParts}`, whereValores);
      await execute(db,
        `INSERT INTO registros_deletados (nome_da_tabela, id_registros, criado_em) VALUES ($1, $2, NOW())`,
        [nomeTabela, whereValores.join('|')]
      );
    } catch (e) {
      if (!isMissingTableError(e)) throw e;
    }
  }
}

/**
 * Garante que a tabela existe no servidor antes de qualquer query nela, criando-a (tipos
 * inferidos do registro, na carga inicial) ou migrando a coluna SRV_ID quando necessário.
 * Invalida os caches de módulo (colunas/computadas/pk) sempre que a estrutura muda.
 */
async function garantirColunasServidor(db, nomeTabela, schemaName, registro, pks, temSrvId) {
  const computadas = await getColunasComputadas(db, nomeTabela, schemaName);
  let colunasServidor = await getColunasServidor(db, nomeTabela, schemaName);
  const tabelaJaExistia = colunasServidor.size > 0;

  if (!tabelaJaExistia) {
    await criarTabelaSeNecessario(db, nomeTabela, schemaName, colunasTipadasDeRegistro(registro), pks, temSrvId);
    colunasCache.invalidate(schemaName, nomeTabela);
    colunasServidor = await getColunasServidor(db, nomeTabela, schemaName);
  } else if (temSrvId && !colunasServidor.has('SRV_ID')) {
    // Migração: tabela existe (criada antes do srvId ser ativado) sem coluna SRV_ID.
    // Adiciona como coluna comum nullable — não destrói a PK original da tabela.
    await execute(db, `ALTER TABLE ${nomeTabela} ADD COLUMN IF NOT EXISTS srv_id INTEGER`);
    // Só colunas e pk — computadas não muda numa migração de coluna comum (mesmo
    // comportamento de antes da TenantCache, preservado de propósito).
    colunasCache.invalidate(schemaName, nomeTabela, ['colunas', 'pk']);
    colunasServidor = await getColunasServidor(db, nomeTabela, schemaName);
  }

  return { colunasServidor, computadas, tabelaJaExistia };
}

/**
 * Migração one-time: tabelas criadas antes do multi-filial têm a UNIQUE só em (pks), sem
 * ID_LOJA — rejeita como duplicata pushes legítimos de outra filial com o mesmo id_local.
 * Detecta e recria; constraintsUqAdicionadas evita repetir a checagem a cada push.
 */
async function garantirConstraintUnica(db, { schemaName, nomeTabela, tabelaJaExistia, temSrvId, pks, colunasServidor }) {
  if (!(tabelaJaExistia && temSrvId && pks.length > 0)) return;

  const cqKey = `${schemaName}:${nomeTabela}`;
  if (constraintsUqAdicionadas.has(cqKey)) return;
  constraintsUqAdicionadas.add(cqKey);

  const constraintName = `uq_${nomeTabela.toLowerCase()}_bk`;
  const chaveNegocio = chaveNegocioTabela(pks, colunasServidor);

  const colunasAtuais = await query(db, `
    SELECT kcu.column_name AS "COLUNA"
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.table_schema    = kcu.table_schema
     AND tc.table_name      = kcu.table_name
    WHERE tc.table_schema = lower($1) AND tc.table_name = lower($2) AND tc.constraint_name = $3
  `, [schemaName, nomeTabela, constraintName]).catch(() => []);

  const setAtual = new Set(colunasAtuais.map(r => (r.COLUNA || '').toUpperCase()));
  const setEsperado = new Set(chaveNegocio.map(c => c.toUpperCase()));
  const constraintDesatualizada = setAtual.size > 0 &&
    (setAtual.size !== setEsperado.size || [...setEsperado].some(c => !setAtual.has(c)));

  if (constraintDesatualizada) {
    console.log(`[${schemaName}] ${nomeTabela}: atualizando ${constraintName} de (${[...setAtual].join(', ')}) para (${chaveNegocio.join(', ')})`);
    await execute(db, `ALTER TABLE ${nomeTabela} DROP CONSTRAINT ${constraintName}`).catch(e => {
      // 42704 = constraint não existe (corrida com outra instância) — inofensivo.
      // Qualquer outro erro impede a correção e precisa aparecer no log.
      if (e.code !== '42704') {
        console.warn(`[${schemaName}] ${nomeTabela}: falha ao remover ${constraintName} antigo: ${e.message}`);
      }
    });
  }

  if (setAtual.size === 0 || constraintDesatualizada) {
    await execute(db,
      `ALTER TABLE ${nomeTabela} ADD CONSTRAINT ${constraintName} UNIQUE (${chaveNegocio.join(', ')})`
    ).catch(e => {
      if (e.code === '42710' || e.code === '42P07') return; // constraint ou índice de backing já existe — normal
      // Falso positivo: tabelaJaExistia veio de cache desatualizado (reset-empresa.js
      // apagou a tabela com o servidor no ar). selecionarRegistroAtual detecta e recria depois.
      if (isMissingTableError(e)) return;
      if (e.code === '23505') {        // existem duplicatas — limpeza manual necessária
        console.warn(`[${schemaName}] ${nomeTabela}: duplicatas em (${chaveNegocio.join(', ')}) impedem UNIQUE constraint. Execute a limpeza de duplicatas antes de reaplicar.`);
        return;
      }
      throw e;
    });
  }
}

/**
 * Busca o registro atual no servidor (por SRV_ID quando é a PK real, senão pela PK original
 * da filial) para detecção de conflito. Se a tabela foi dropada depois de cacheada (cache
 * obsoleto), recria e retorna atual=[] em vez de propagar o erro.
 */
async function selecionarRegistroAtual(db, { schemaName, nomeTabela, srvIdEhPk, srvId, pks, registro, temSrvId, colunasServidor }) {
  const _selecionarAtual = () => {
    if (srvIdEhPk) {
      return query(db, `SELECT * FROM ${nomeTabela} WHERE SRV_ID = $1`, [srvId]);
    }
    const whereValores = pks.map(p => registro[p]);
    const whereParts   = pks.map((p, i) => `${p} = $${i + 1}`).join(' AND ');
    return query(db, `SELECT * FROM ${nomeTabela} WHERE ${whereParts}`, whereValores);
  };

  try {
    return { atual: await _selecionarAtual(), colunasServidor };
  } catch (eSel) {
    if (!isMissingTableError(eSel)) throw eSel;
    // Cache obsoleto: tabela foi dropada após ser cacheada — recria agora mesmo.
    colunasCache.invalidate(schemaName, nomeTabela);
    await criarTabelaSeNecessario(db, nomeTabela, schemaName, colunasTipadasDeRegistro(registro), pks, temSrvId);
    return { atual: [], colunasServidor: await getColunasServidor(db, nomeTabela, schemaName) };
  }
}

/**
 * Recuperação de mapeamento perdido: SRV_ID recém-alocado sem linha correspondente
 * (srv_id_map foi limpo/resetado), mas já existe registro com a mesma chave de negócio —
 * reusa o SRV_ID existente em vez de duplicar.
 */
async function recuperarSrvIdPerdido(db, { schemaName, nomeTabela, srvIdEhPk, atual, tabelaJaExistia, pks, registro, idLoja, srvId }) {
  if (!(srvIdEhPk && atual.length === 0 && tabelaJaExistia)) return { srvId, atual };

  const pkWhere = pks.map((p, i) => `${p} = $${i + 1}`).join(' AND ');
  const pkVals  = pks.map(p => registro[p]);
  const [existente] = await query(db,
    `SELECT SRV_ID FROM ${nomeTabela} WHERE ${pkWhere} LIMIT 1`,
    pkVals
  ).catch(() => [null]);

  if (existente?.SRV_ID == null) return { srvId, atual };

  const pkValorStrLocal = pks.map(p => String(registro[p])).join('|');
  await execute(db,
    `UPDATE srv_id_map SET srv_id = $1 WHERE tabela = $2 AND id_local = $3 AND filial_id = $4`,
    [existente.SRV_ID, nomeTabela, pkValorStrLocal, idLoja]
  ).catch(() => {});
  const novoAtual = await query(db,
    `SELECT * FROM ${nomeTabela} WHERE SRV_ID = $1`, [existente.SRV_ID]
  ).catch(() => []);
  return { srvId: existente.SRV_ID, atual: novoAtual };
}

/**
 * Efeito colateral de negócio pós-upsert: pedido virou Realizado no push da filial — gera
 * as A_RECEBER das parcelas já cadastradas (fire-and-forget). Pagamento não é pré-requisito
 * para "Realizado": ver gerarContasReceberDoPedido().
 */
function dispararEfeitosPosUpsert(schemaName, { nomeTabela, atual, registro }) {
  if (nomeTabela !== 'PEDIDOS') return;
  const statusAntes = atual[0]?.STATUS ?? null;
  const statusNovo  = registro['STATUS'] ?? null;
  const idPedido    = registro['ID_PEDIDO'];
  if (statusNovo === 'R' && statusAntes !== 'R' && idPedido != null) {
    gerarContasReceberDoPedido(schemaName, idPedido).catch(e =>
      console.warn(`[PEDIDOS] WARN geração de A_RECEBER ao realizar: ${e.message}`)
    );
  }
}

module.exports = {
  alocarSrvId,
  processarDelecao,
  garantirColunasServidor,
  garantirConstraintUnica,
  selecionarRegistroAtual,
  recuperarSrvIdPerdido,
  dispararEfeitosPosUpsert,
};
