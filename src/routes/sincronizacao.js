const express = require('express');
const router = express.Router();
const auth = require('../server/interfaces/http/middleware/auth');
const { withTenantConnection, query, execute, isMissingTableError, pool } = require('../server/infrastructure/db');
const { isFilialBloqueada } = require('../server/interfaces/http/middleware/filialBloqueada');
const { planoValido } = require('../planos');
const {
  registrarAuditLog, gerarContasReceberDoPedido,
  COLUNAS_IGNORADAS_SERVIDOR, chaveNegocioTabela,
  colunasTipadasDeRegistro, criarTabelaSeNecessario,
} = require('./resources/helpers');

/**
 * Cache de metadados de tabela por tenant (chave `schema:tabela`), para as 3 introspecções
 * (colunas existentes, colunas computadas, colunas da PK) que sempre precisavam ser
 * invalidadas em conjunto quando a estrutura de uma tabela muda — antes eram 3 dicts
 * separados, repetindo o mesmo trio de `delete` em ~4 pontos espalhados do arquivo.
 */
function criarTenantCache(tipos) {
  const stores = Object.fromEntries(tipos.map(t => [t, {}]));
  const key = (schema, tabela) => `${schema}:${tabela}`;

  return {
    get(schema, tabela, tipo) {
      return stores[tipo][key(schema, tabela)];
    },
    set(schema, tabela, tipo, valor) {
      stores[tipo][key(schema, tabela)] = valor;
      return valor;
    },
    // tiposParaLimpar: por padrão invalida todos os tipos; passe um subconjunto pra
    // preservar algum (ex.: migração de coluna isolada que não muda colunas computadas).
    invalidate(schema, tabela, tiposParaLimpar = tipos) {
      const k = key(schema, tabela);
      for (const tipo of tiposParaLimpar) delete stores[tipo][k];
    },
  };
}

const colunasCache = criarTenantCache(['colunas', 'pk', 'computadas']);

// Cache de sequences por-tabela já criadas nesta execução do servidor.
// Evita DDL (CREATE SEQUENCE IF NOT EXISTS) em toda requisição de push.
const seqsSrvIdInicializadas = new Set();

// Cache de tabelas que já receberam a UNIQUE constraint nas chaves de negócio.
// Evita DDL repetido em cada push após a constraint já existir.
const constraintsUqAdicionadas = new Set();

async function getColunasServidor(db, nomeTabela, schemaName) {
  const cached = colunasCache.get(schemaName, nomeTabela, 'colunas');
  if (cached) return cached;
  const rows = await query(db,
    `SELECT column_name AS "COLUNA"
     FROM information_schema.columns
     WHERE table_name = lower($1) AND table_schema = lower($2)`,
    [nomeTabela, schemaName]
  );
  return colunasCache.set(schemaName, nomeTabela, 'colunas', new Set(rows.map(r => (r.COLUNA || '').trim().toUpperCase())));
}

/**
 * Retorna as colunas que compõem a PRIMARY KEY real da tabela no PostgreSQL.
 * Para tabelas srvId criadas pelo servidor, isso retorna ['SRV_ID'].
 * Para tabelas legadas (PK original), retorna as colunas da PK Firebird.
 * Resultado cacheado por schema:tabela — invalidado junto com o cache de colunas (mesma
 * TenantCache, tipo 'pk').
 */
async function getPkServidor(db, nomeTabela, schemaName) {
  const cached = colunasCache.get(schemaName, nomeTabela, 'pk');
  if (cached) return cached;
  const rows = await query(db,
    `SELECT kcu.column_name AS "COLUNA"
     FROM information_schema.key_column_usage kcu
     JOIN information_schema.table_constraints tc
       ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema    = kcu.table_schema
      AND tc.table_name      = kcu.table_name
     WHERE kcu.table_schema  = lower($1)
       AND kcu.table_name    = lower($2)
       AND tc.constraint_type = 'PRIMARY KEY'
     ORDER BY kcu.ordinal_position`,
    [schemaName, nomeTabela]
  );
  const pkCols = rows.map(r => (r.COLUNA || '').trim().toUpperCase());
  return colunasCache.set(schemaName, nomeTabela, 'pk', pkCols.length > 0 ? pkCols : null);
}

function normalizarBlobs(row) {
  if (!row || typeof row !== 'object') return row;
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k,
      Buffer.isBuffer(v) ? v.toString('utf8') : (typeof v === 'function' ? null : v),
    ])
  );
}

async function getColunasComputadas(db, nomeTabela, schemaName) {
  const cached = colunasCache.get(schemaName, nomeTabela, 'computadas');
  if (cached) return cached;
  const rows = await query(db,
    `SELECT column_name AS "COLUNA"
     FROM information_schema.columns
     WHERE table_name = lower($1)
       AND table_schema = lower($2)
       AND is_generated = 'ALWAYS'`,
    [nomeTabela, schemaName]
  );
  return colunasCache.set(schemaName, nomeTabela, 'computadas', new Set(rows.map(r => (r.COLUNA || '').trim().toUpperCase())));
}

async function registrarFilial(db, idLoja, nomeFilial) {
  if (!idLoja) return;
  await execute(db,
    `INSERT INTO sync_filiais (id_loja, nome, ultimo_sync)
     VALUES ($1, $2, NOW())
     ON CONFLICT (id_loja) DO UPDATE
       SET ultimo_sync = NOW(),
           nome = COALESCE(EXCLUDED.nome, sync_filiais.nome)`,
    [idLoja, nomeFilial || null]
  );
}

// Tabelas internas do servidor que nunca devem ser lidas ou escritas pela filial
const TABELAS_INTERNAS = new Set([
  'REGISTROS_DELETADOS',
  'FILIAIS_BLOQUEADAS',
  'SYNC_FILIAIS',
]);

// Valida nome de tabela: sem SQL injection e não é tabela interna do servidor
function validarNomeTabela(nomeTabela) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(nomeTabela)) return false;
  if (TABELAS_INTERNAS.has(nomeTabela)) return false;
  return true;
}

/**
 * GET /datasnap/rest/TSMSincronizacao/RegistrosParaAtualizar
 * Query params: token, nomeTabela, idUltimaAtualizacaoMatriz
 *
 * Equivalente a TSMSincronizacao.RegistrosParaAtualizar() do Delphi.
 */
router.get('/RegistrosParaAtualizar', auth, async (req, res) => {
  const nomeTabela = (req.query.nomeTabela || '').toUpperCase().trim();
  const idUltimaAtualizacaoMatriz = parseInt(req.query.idUltimaAtualizacaoMatriz, 10) || 0;
  const idPDV = req.query.idPDV ? parseInt(req.query.idPDV, 10) : null; // eslint-disable-line no-unused-vars
  const idLoja = req.query.idLoja ? parseInt(req.query.idLoja, 10) : null;
  const nomeFilial = req.query.nomeFilial ? String(req.query.nomeFilial).trim() : null;
  const filtroFilial = req.query.filtroFilial
    ? String(req.query.filtroFilial).trim().toUpperCase()
    : null;
  const filtroFilialViaFK = req.query.filtroFilialViaFK
    ? String(req.query.filtroFilialViaFK).trim().toUpperCase()
    : null;
  const colunaData = req.query.colunaData
    ? String(req.query.colunaData).trim().toUpperCase()
    : null;
  if (!nomeTabela) {
    return res.status(400).json({
      message: 'Ocorreu um erro ao tentar listar os registros para atualizar pois o campo nomeTabela não foi informado',
    });
  }

  if (!validarNomeTabela(nomeTabela)) {
    return res.status(400).json({ message: `Tabela '${nomeTabela}' não é permitida para sincronização` });
  }

  if (filtroFilial && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(filtroFilial)) {
    return res.status(400).json({ message: `Nome de coluna inválido: '${filtroFilial}'` });
  }
  if (filtroFilialViaFK && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(filtroFilialViaFK)) {
    return res.status(400).json({ message: `Nome de coluna inválido: '${filtroFilialViaFK}'` });
  }
  if (colunaData && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(colunaData)) {
    return res.status(400).json({ message: `Nome de coluna inválido: '${colunaData}'` });
  }

  try {
    const rows = await withTenantConnection(req.schemaName, async (db) => {
      try { await registrarFilial(db, idLoja, nomeFilial); } catch { /* não bloqueia a resposta */ }

      const params = [idUltimaAtualizacaoMatriz];
      let whereExtra = '';

      // CLIENTES: usa config do servidor (admin-configurável) em vez do parâmetro do cliente
      // Outros: usa o filtroFilial enviado pelo cliente
      let filtroFilialEfetivo = filtroFilial;
      if (nomeTabela === 'CLIENTES') {
        try {
          const [cfg] = await query(db, `SELECT valor FROM sync_config WHERE chave = $1`, ['filtro_filial_clientes']);
          filtroFilialEfetivo = cfg?.VALOR ?? null;
          if (filtroFilialEfetivo && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(filtroFilialEfetivo)) {
            filtroFilialEfetivo = null;
          }
        } catch {
          filtroFilialEfetivo = null;
        }
      }

      if (filtroFilialEfetivo && idLoja) {
        params.push(idLoja);
        whereExtra += ` AND ${filtroFilialEfetivo} = $${params.length}`;
      }

      // Tabelas filhas sem ID_LOJA próprio: filtra via FK para PEDIDOS
      // filtroFilialViaFK é a coluna FK local (ex: ID_PEDIDO), sempre apontando para PEDIDOS.ID_PEDIDO
      if (filtroFilialViaFK && idLoja) {
        params.push(idLoja);
        whereExtra += ` AND ${filtroFilialViaFK} IN (SELECT ID_PEDIDO FROM PEDIDOS WHERE ID_LOJA = $${params.length})`;
      }

      // Política de retenção: aplica o filtro de 2 anos apenas se a coluna realmente existe.
      // Usa o cache de colunas para evitar quebrar quando o nome da coluna difere no banco.
      if (colunaData) {
        const colunas = await getColunasServidor(db, nomeTabela, req.schemaName);
        if (colunas.has(colunaData)) {
          whereExtra += ` AND (${colunaData} IS NULL OR ${colunaData}::text::timestamptz >= NOW() - INTERVAL '2 years')`;
        }
      }

      const sql = `SELECT * FROM ${nomeTabela}
                   WHERE ID_ULTIMA_ATUALIZACAO_MATRIZ IS NOT NULL
                     AND ID_ULTIMA_ATUALIZACAO_MATRIZ > $1
                     ${whereExtra}
                   ORDER BY ID_ULTIMA_ATUALIZACAO_MATRIZ
                   LIMIT 50`;

      const registros = await query(db, sql, params);

      // A_RECEBER: o Sirius/Firebird espera STATUS com a primeira letra maiúscula
      // (ex.: "Pendente"), mas é gravado em minúsculo no Postgres (ver helpers.js).
      if (nomeTabela === 'A_RECEBER') {
        for (const r of registros) {
          if (typeof r.STATUS === 'string' && r.STATUS.length > 0) {
            r.STATUS = r.STATUS.charAt(0).toUpperCase() + r.STATUS.slice(1);
          }
        }
      }

      return registros;
    });

    res.json(rows);
  } catch (e) {
    // Tabela ainda não existe no servidor — retorna vazio para não bloquear o pull.
    // Será criada automaticamente no primeiro push via criarTabelaSeNecessario.
    if (isMissingTableError(e)) return res.json([]);
    res.status(400).json({
      message: `Ocorreu um erro ao tentar listar os registros para atualizar. Erro: ${e.message}`,
    });
  }
});

/**
 * GET /datasnap/rest/TSMSincronizacao/RegistrosParaDeletar
 * Query params: token, nomeTabela, idUltimoRegistroDeletado
 *
 * Equivalente a TSMSincronizacao.RegistrosParaDeletar() do Delphi.
 */
router.get('/RegistrosParaDeletar', auth, async (req, res) => {
  const nomeTabela = (req.query.nomeTabela || '').toUpperCase().trim();
  const idUltimoRegistroDeletado = parseInt(req.query.idUltimoRegistroDeletado, 10) || 0;

  if (!nomeTabela) {
    return res.status(400).json({
      message: 'Ocorreu um erro ao tentar listar os registros para deletar pois o campo nomeTabela não foi informado',
    });
  }

  if (!validarNomeTabela(nomeTabela)) {
    return res.status(400).json({ message: `Tabela '${nomeTabela}' não é permitida para sincronização` });
  }

  try {
    const rows = await withTenantConnection(req.schemaName, (db) =>
      query(
        db,
        `SELECT * FROM REGISTROS_DELETADOS
         WHERE NOME_DA_TABELA = $1
           AND ID_REGISTRO_DELETADO > $2
         ORDER BY ID_REGISTRO_DELETADO
         LIMIT 10`,
        [nomeTabela, idUltimoRegistroDeletado]
      )
    );

    res.json(rows);
  } catch (e) {
    if (isMissingTableError(e)) return res.json([]);
    res.status(400).json({
      message: `Ocorreu um erro ao tentar listar os registros para deletar. Erro: ${e.message}`,
    });
  }
});

/**
 * GET /datasnap/rest/TSMSincronizacao/StatusTabelas
 * Query params: token
 *
 * Retorna para cada tabela: total de registros e o maior ID_ULTIMA_ATUALIZACAO_MATRIZ.
 * Usado pelo cliente para verificar se está tudo sincronizado.
 */
router.get('/StatusTabelas', auth, async (req, res) => {
  try {
    const resultado = await withTenantConnection(req.schemaName, async (db) => {
      const tabelasRows = await query(db,
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = lower($1) AND table_type = 'BASE TABLE'
         ORDER BY table_name`,
        [req.schemaName]
      );
      const tabelas = tabelasRows
        .map(r => r.TABLE_NAME.trim().toUpperCase())
        .filter(t => !TABELAS_INTERNAS.has(t));

      const status = [];
      for (const tabela of tabelas) {
        try {
          const rows = await query(db,
            `SELECT COUNT(*) AS TOTAL, MAX(ID_ULTIMA_ATUALIZACAO_MATRIZ) AS MAX_ID
             FROM ${tabela}`
          );
          status.push({
            tabela,
            total: rows[0].TOTAL || 0,
            maxId: rows[0].MAX_ID || 0,
          });
        } catch {
          // Tabela pode não ter a coluna ID_ULTIMA_ATUALIZACAO_MATRIZ ou outro erro
          status.push({ tabela, total: null, maxId: null, erro: true });
        }
      }

      return status;
    });

    res.json(resultado);
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
});

/**
 * GET /datasnap/rest/TSMSincronizacao/RegistrosPaginados
 * Query params: token, nomeTabela, pk, offset (padrão 0), limit (padrão 200)
 *
 * Retorna registros de uma tabela em páginas, ordenados pela PK.
 * Usado para auditoria de dados entre servidor e filial.
 */
router.get('/RegistrosPaginados', auth, async (req, res) => {
  const nomeTabela = (req.query.nomeTabela || '').toUpperCase().trim();
  const pk = req.query.pk; // Pode ser string ou array
  const offset = parseInt(req.query.offset, 10) || 0;
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);

  if (!nomeTabela || !pk) {
    return res.status(400).json({ message: 'nomeTabela e pk são obrigatórios' });
  }
  if (!validarNomeTabela(nomeTabela)) {
    return res.status(400).json({ message: `Tabela '${nomeTabela}' não permitida` });
  }

  // Valida que cada coluna PK contém apenas letras, números e underscore
  const pks = (Array.isArray(pk) ? pk : [pk]).map(p => String(p).trim());
  const colunaInvalida = pks.find(p => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(p));
  if (colunaInvalida) {
    return res.status(400).json({ message: `Nome de coluna inválido: '${colunaInvalida}'` });
  }

  try {
    const rows = await withTenantConnection(req.schemaName, (db) =>
      query(db,
        `SELECT * FROM ${nomeTabela} ORDER BY ${pks.join(', ')} LIMIT $1 OFFSET $2`,
        [limit, offset]
      )
    );
    res.json(rows.map(normalizarBlobs));
  } catch (e) {
    if (isMissingTableError(e)) return res.json([]);
    res.status(400).json({ message: e.message });
  }
});

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

/**
 * POST /datasnap/rest/TSMSincronizacao/ReceberRegistro
 * Query params: token, idLoja
 * Body JSON: { tabela, pk, registro, ultimaVersaoConhecida, forcar }
 *
 * Recebe um registro alterado na filial e aplica no servidor.
 * Se o registro foi modificado no servidor após ultimaVersaoConhecida,
 * retorna { conflito: true, versaoServidor: {...} } para resolução manual.
 * Se forcar=true, aplica sem verificar conflito.
 */
router.post('/ReceberRegistro', auth, async (req, res) => {
  const idLoja = parseInt(req.query.idLoja, 10);
  const idPDV = req.query.idPDV ? parseInt(req.query.idPDV, 10) : null; // eslint-disable-line no-unused-vars
  const nomeFilial = req.query.nomeFilial ? String(req.query.nomeFilial).trim() : null;
  const { tabela, pk, registro, ultimaVersaoConhecida = 0, forcar = false, deletar = false, temSrvId = false } = req.body || {};

  if (!idLoja) {
    return res.status(400).json({ message: 'idLoja não informado' });
  }
  if (!tabela || !pk || !registro) {
    return res.status(400).json({ message: 'tabela, pk e registro são obrigatórios' });
  }

  const nomeTabela = tabela.toUpperCase().trim();
  if (!validarNomeTabela(nomeTabela)) {
    return res.status(400).json({ message: `Tabela '${nomeTabela}' não permitida` });
  }

  try {
    await withTenantConnection(req.schemaName, async (db) => {
      try { await registrarFilial(db, idLoja, nomeFilial); } catch { /* não bloqueia a resposta */ }

      if (await isFilialBloqueada(idLoja, db)) {
        res.status(401).send();
        return;
      }

      const pks = Array.isArray(pk) ? pk : [pk];

      // SRV_ID é a PK real no PostgreSQL p/ tabelas srvId — obtido antes de qualquer operação.
      let srvId = null;
      if (temSrvId && !deletar) {
        srvId = await alocarSrvId(db, { schemaName: req.schemaName, idLoja, nomeTabela, pks, registro });
      }

      if (deletar) {
        await processarDelecao(db, { nomeTabela, temSrvId, pks, registro, idLoja });
        res.json({ ok: true });
        return;
      }

      // Garante que a tabela existe antes de qualquer query nela.
      // Na carga inicial, a tabela é criada com tipos inferidos do primeiro registro.
      let { colunasServidor, computadas, tabelaJaExistia } =
        await garantirColunasServidor(db, nomeTabela, req.schemaName, registro, pks, temSrvId);

      await garantirConstraintUnica(db, { schemaName: req.schemaName, nomeTabela, tabelaJaExistia, temSrvId, pks, colunasServidor });

      // srvIdEhPk: SRV_ID é a PK real, detectado via information_schema (cacheado) — não
      // via tabelaJaExistia, que dava falso no 1º push e causava ON CONFLICT inválido em
      // ID_PRODUTO nas chamadas seguintes.
      const pkReal = await getPkServidor(db, nomeTabela, req.schemaName);
      const srvIdEhPk = temSrvId && srvId != null && pkReal != null && pkReal.length === 1 && pkReal[0] === 'SRV_ID';

      // Detecção de conflito: SRV_ID como chave só quando é a PK real da tabela.
      // Se a tabela não existir (cache obsoleto), limpa, recria e continua com atual=[].
      let atual;
      ({ atual, colunasServidor } = await selecionarRegistroAtual(db,
        { schemaName: req.schemaName, nomeTabela, srvIdEhPk, srvId, pks, registro, temSrvId, colunasServidor }));

      // Recuperação de mapeamento perdido: SRV_ID recém-alocado sem linha (srv_id_map foi
      // limpo/resetado), mas já existe registro com a mesma chave de negócio — reusa o
      // SRV_ID existente em vez de duplicar.
      ({ srvId, atual } = await recuperarSrvIdPerdido(db,
        { schemaName: req.schemaName, nomeTabela, srvIdEhPk, atual, tabelaJaExistia, pks, registro, idLoja, srvId }));

      if (!forcar && atual.length > 0) {
        const versaoServidor = atual[0].ID_ULTIMA_ATUALIZACAO_MATRIZ;
        if (versaoServidor && ultimaVersaoConhecida > 0 && versaoServidor > ultimaVersaoConhecida) {
          res.json({ conflito: true, versaoServidor: atual[0] });
          return;
        }
      }

      const colunas = Object.keys(registro).filter(k =>
        registro[k] !== undefined &&
        !COLUNAS_IGNORADAS_SERVIDOR.has(k) &&
        !computadas.has(k) &&
        colunasServidor.has(k)
      );

      // Tabelas migradas (SRV_ID como coluna comum): inclui srv_id no UPSERT em vez de
      // UPDATE separado — evita disparar fn_seq_atualizacao duas vezes, o que geraria
      // falsos conflitos no próximo pull.
      const temSrvIdMigrado = temSrvId && srvId != null && !srvIdEhPk && colunasServidor.has('SRV_ID');

      let novoId = null;
      if (colunas.length > 0 || srvIdEhPk || temSrvIdMigrado) {
        // SRV_ID: primeiro se PK real, último se coluna migrada; senão só as colunas do registro.
        const colunasFinais = srvIdEhPk
          ? ['SRV_ID', ...colunas]
          : temSrvIdMigrado
            ? [...colunas, 'srv_id']
            : colunas;
        // PostgreSQL TEXT rejeita \x00 (Firebird CHAR/VARCHAR pode ter null bytes). Firebird
        // TIME vem como Date epoch 1970-01-01 — sem normalizar viraria string ISO inútil;
        // convertemos para 'HH:MM:SS'.
        const valoresFinais = colunasFinais.map(c => {
          if (c === 'SRV_ID' || c === 'srv_id') return srvId;
          const v = registro[c] === undefined ? null : registro[c];
          if (typeof v === 'string') return v.replace(/\x00/g, '');
          if (v instanceof Date) {
            const ms = v.getTime();
            if (ms >= 0 && ms < 86_400_000) {
              // É um valor TIME do Firebird (epoch + HH:MM:SS sem parte de data)
              const hh = String(Math.floor(ms / 3_600_000)).padStart(2, '0');
              const mm = String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, '0');
              const ss = String(Math.floor((ms % 60_000) / 1_000)).padStart(2, '0');
              return `${hh}:${mm}:${ss}`;
            }
          }
          return v;
        });
        const placeholders = colunasFinais.map((_, i) => `$${i + 1}`).join(', ');
        const conflictTarget = srvIdEhPk ? 'SRV_ID' : pks.join(', ');
        // srvIdEhPk resolve conflito por SRV_ID, não pelos pks da filial (ID_CLIENTE) — por
        // isso eles precisam entrar no UPDATE SET, senão o servidor nunca grava o PK local e
        // reenviaria ID_CLIENTE=null em loop infinito.
        const nonConflictCols = colunasFinais.filter(c =>
          c !== 'SRV_ID' && (srvIdEhPk || !pks.includes(c))
        );
        const updateSet = nonConflictCols.length > 0
          ? nonConflictCols.map(c => `${c} = EXCLUDED.${c}`).join(', ')
          : `${conflictTarget} = EXCLUDED.${conflictTarget}`;
        await execute(db,
          `INSERT INTO ${nomeTabela} (${colunasFinais.join(', ')}) VALUES (${placeholders})
           ON CONFLICT (${conflictTarget}) DO UPDATE SET ${updateSet}`,
          valoresFinais
        );

        dispararEfeitosPosUpsert(req.schemaName, { nomeTabela, atual, registro });

        // Lê o ID atribuído pelo trigger para que o cliente possa detectar o eco no próximo pull
        if (srvIdEhPk) {
          const [linha] = await query(db,
            `SELECT ID_ULTIMA_ATUALIZACAO_MATRIZ FROM ${nomeTabela} WHERE SRV_ID = $1`, [srvId]
          ).catch(() => [null]);
          novoId = linha?.ID_ULTIMA_ATUALIZACAO_MATRIZ ?? null;
        } else {
          const whereValores2 = pks.map(p => registro[p]);
          const whereParts2   = pks.map((p, i) => `${p} = $${i + 1}`).join(' AND ');
          const [linha] = await query(db,
            `SELECT ID_ULTIMA_ATUALIZACAO_MATRIZ FROM ${nomeTabela} WHERE ${whereParts2}`,
            whereValores2
          ).catch(() => [null]);
          novoId = linha?.ID_ULTIMA_ATUALIZACAO_MATRIZ ?? null;
        }
      }

      res.json({ ok: true, novoId, srvId });
    });
  } catch (e) {
    if (isMissingTableError(e)) {
      // Garante que o próximo push vai recriar a tabela (limpa cache obsoleto).
      const nomeTabela = ((req.body?.tabela) || '').toUpperCase().trim();
      if (nomeTabela && req.schemaName) {
        colunasCache.invalidate(req.schemaName, nomeTabela);
      }
    }
    res.status(400).json({ message: `Erro ao aplicar registro: ${e.message}` });
  }
});

// Tags de tipo que o cliente manda (derivadas da introspecção do Firebird), mapeadas pros
// mesmos buckets grosseiros que inferirTipoPg já usa a partir de valor real.
const TIPO_PG_POR_TAG = {
  texto: 'TEXT',
  numero: 'NUMERIC',
  data: 'TIMESTAMP',
  booleano: 'BOOLEAN',
  binario: 'BYTEA',
};

/**
 * POST /datasnap/rest/TSMSincronizacao/GarantirTabela
 * Body: { tabela, colunas: [{ nome, tipo }], pks, temSrvId }
 *
 * Cria a tabela no servidor com a estrutura correta mesmo sem nenhum registro pra inferir
 * tipo por valor — necessário pra tabelas que existem na filial mas estão vazias (instalação
 * nova, sem dados ainda): sem isso, criarTabelaSeNecessario só roda dentro de ReceberRegistro,
 * que nunca é chamado se não há nada pra empurrar, e a tabela nunca nasce no servidor. No-op
 * se a tabela já existe (idempotente, mesma checagem de colunasServidor usada em ReceberRegistro).
 */
router.post('/GarantirTabela', auth, async (req, res) => {
  const { tabela, colunas, pks, temSrvId = false } = req.body || {};

  if (!tabela || !Array.isArray(colunas) || colunas.length === 0 || !pks) {
    return res.status(400).json({ message: 'tabela, colunas e pks são obrigatórios' });
  }

  const nomeTabela = tabela.toUpperCase().trim();
  if (!validarNomeTabela(nomeTabela)) {
    return res.status(400).json({ message: `Tabela '${nomeTabela}' não permitida` });
  }

  const pksArr = (Array.isArray(pks) ? pks : [pks]).map(p => String(p).toUpperCase().trim());
  const colunasTipadas = colunas
    .map(c => ({ nome: String(c?.nome || '').toUpperCase().trim(), tipoPg: TIPO_PG_POR_TAG[c?.tipo] || 'TEXT' }))
    .filter(c => /^[A-Za-z_][A-Za-z0-9_]*$/.test(c.nome));

  if (colunasTipadas.length === 0) {
    return res.status(400).json({ message: 'Nenhuma coluna válida informada' });
  }

  try {
    await withTenantConnection(req.schemaName, async (db) => {
      const colunasServidor = await getColunasServidor(db, nomeTabela, req.schemaName);
      if (colunasServidor.size === 0) {
        await criarTabelaSeNecessario(db, nomeTabela, req.schemaName, colunasTipadas, pksArr, temSrvId);
        colunasCache.invalidate(req.schemaName, nomeTabela);
      }
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: `Erro ao garantir tabela: ${e.message}` });
  }
});

/**
 * GET /datasnap/rest/TSMSincronizacao/FiliaisRegistradas
 * Retorna filiais que já se conectaram ao servidor (usada pelo wizard do cliente).
 */
router.get('/FiliaisRegistradas', auth, async (req, res) => {
  try {
    const rows = await withTenantConnection(req.schemaName, db =>
      query(db, 'SELECT id_loja, nome FROM sync_filiais ORDER BY id_loja')
    );
    res.json(rows);
  } catch {
    res.json([]);
  }
});

router.post('/AtualizarRegime', auth, async (req, res) => {
  const { regime } = req.body || {};
  if (!regime) return res.status(400).json({ erro: 'regime obrigatório' });
  try {
    await pool.query(
      'UPDATE public.sync_tenants SET regime_tributario = $1 WHERE schema_name = $2',
      [regime, req.schemaName]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// Plano contratado (PARAMETROS(45004) no Firebird) → sync_tenants.plano, com validação própria (controla acesso pago).
router.post('/AtualizarPlano', auth, async (req, res) => {
  const { plano } = req.body || {};
  const planoNorm = typeof plano === 'string' ? plano.trim().toUpperCase() : '';
  if (!planoNorm) return res.status(400).json({ erro: 'plano obrigatório' });
  if (!planoValido(planoNorm)) {
    console.warn(`[AtualizarPlano] plano desconhecido recebido de ${req.schemaName}: "${plano}" — ignorado`);
    return res.status(400).json({ erro: `plano inválido: ${plano}` });
  }
  try {
    await pool.query(
      'UPDATE public.sync_tenants SET plano = $1 WHERE schema_name = $2',
      [planoNorm, req.schemaName]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// GET /StatusReset — client usa pra detectar reset do tenant (ver src/client/resetLocal.js).
router.get('/StatusReset', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT resetado_em FROM public.sync_tenants WHERE schema_name = $1',
      [req.schemaName]
    );
    res.json(rows[0] ?? {});
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// Chaves aceitas em POST /AtualizarParametros (push client -> servidor).
// Mantenha em sincronia manual com src/client/paramsSyncMap.js (deploys separados).
const CHAVES_ACEITAS = new Set([
  'codigo_interno_unico', 'utilizar_codigo_interno', 'venda_saldo_negativo',
  'modalidade_frete', 'forma_preenchimento_pedido',
]);

// Subconjunto de CHAVES_ACEITAS que reconcilia pro mesmo valor em todos os PDVs de um
// schema — GET /BuscarParametros devolve isso pro Firebird de cada PDV via setParam.
// 'modalidade_frete' fica de fora de propósito (cada PDV mantém o seu). Mantenha em
// sincronia manual com `global: true` em paramsSyncMap.js.
const CHAVES_GLOBAIS = new Set([
  'forma_preenchimento_pedido', 'venda_saldo_negativo',
  'codigo_interno_unico', 'utilizar_codigo_interno',
]);

router.get('/BuscarParametros', auth, async (req, res) => {
  try {
    const chaves = [...CHAVES_GLOBAIS];
    const placeholders = chaves.map((_, i) => `$${i + 1}`).join(', ');
    const parametros = await withTenantConnection(req.schemaName, async (db) => {
      const rows = await query(db, `SELECT chave, valor FROM sync_config WHERE chave IN (${placeholders})`, chaves);
      // valor IS NULL vira chave ausente no JSON (não `null`) — o cliente usa
      // "servidor === undefined" pra saber que o servidor ainda não tem valor.
      return Object.fromEntries(rows.filter(r => r.VALOR !== null).map(r => [r.CHAVE, r.VALOR]));
    });
    res.json({ parametros });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

router.post('/AtualizarParametros', auth, async (req, res) => {
  const { parametros } = req.body || {};
  if (!parametros || typeof parametros !== 'object') return res.json({ ok: true });
  const schema = req.schemaName;
  try {
    await withTenantConnection(schema, async (db) => {
      for (const [chave, valor] of Object.entries(parametros)) {
        if (!CHAVES_ACEITAS.has(chave)) continue;
        const valorStr = String(valor);
        const rows = await query(db, 'SELECT valor FROM sync_config WHERE chave = $1', [chave]);
        const dadosAntes = rows.length > 0 ? { chave, valor: rows[0].VALOR } : null;
        if (dadosAntes?.valor === valorStr) continue;
        await execute(db,
          `INSERT INTO sync_config (chave, valor) VALUES ($1, $2)
           ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor`,
          [chave, valorStr]
        );
        registrarAuditLog(req, schema, 'SYNC_CONFIG', dadosAntes ? 'UPDATE' : 'INSERT', chave,
          { chave, valor: valorStr, _fonte: 'sync_client' }, dadosAntes);
      }
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

module.exports = router;
