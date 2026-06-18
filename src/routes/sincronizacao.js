const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { withTenantConnection, query, execute, isMissingTableError, pool } = require('../db');
const { isFilialBloqueada } = require('../middleware/filialBloqueada');
const { registrarAuditLog } = require('./resources/helpers');

// Cache de colunas computadas do servidor
const cacheComputadas = {};

// Cache de colunas existentes no servidor por tabela
const cacheColunasServidor = {};

// Cache da PK real de cada tabela (schema:tabela → string[])
const cachePkServidor = {};

// Cache de sequences por-tabela já criadas nesta execução do servidor.
// Evita DDL (CREATE SEQUENCE IF NOT EXISTS) em toda requisição de push.
const seqsSrvIdInicializadas = new Set();

// Cache de tabelas que já receberam a UNIQUE constraint nas chaves de negócio.
// Evita DDL repetido em cada push após a constraint já existir.
const constraintsUqAdicionadas = new Set();

// Mapeia tipo JavaScript (inferido do valor) para tipo PostgreSQL.
// Números sempre viram NUMERIC: Firebird NUMERIC(10,2) com valor 100.00 chega como
// inteiro 100 via node-firebird, então Number.isInteger() não distingue se é ID ou preço.
// NUMERIC é superset seguro — comporta inteiros e decimais sem perda.
function inferirTipoPg(valor) {
  if (Buffer.isBuffer(valor)) return 'BYTEA';
  if (valor instanceof Date) return 'TIMESTAMP';
  if (typeof valor === 'boolean') return 'BOOLEAN';
  if (typeof valor === 'number') return 'NUMERIC';
  return 'TEXT';
}

/**
 * Cria a tabela no schema do tenant usando os tipos inferidos do primeiro registro recebido.
 * Chamado quando ReceberRegistro encontra colunasServidor vazio (tabela inexistente).
 */
async function criarTabelaSeNecessario(db, nomeTabela, schemaName, registro, pks, useSrvId = false) {
  const pkSet = new Set(Array.isArray(pks) ? pks : [pks]);
  const colunas = Object.keys(registro)
    .filter(nome => !COLUNAS_IGNORADAS_SERVIDOR.has(nome))
    .map(nome => {
      const tipo = inferirTipoPg(registro[nome]);
      return `${nome} ${tipo}${pkSet.has(nome) && !useSrvId ? ' NOT NULL' : ''}`;
    });
  if (!Object.prototype.hasOwnProperty.call(registro, 'ID_ULTIMA_ATUALIZACAO_MATRIZ')) {
    colunas.push('ID_ULTIMA_ATUALIZACAO_MATRIZ INTEGER');
  }
  if (useSrvId) {
    colunas.unshift('SRV_ID INTEGER NOT NULL');
    await execute(db,
      `CREATE TABLE IF NOT EXISTS ${nomeTabela} (${colunas.join(', ')}, PRIMARY KEY (SRV_ID))`
    );
    // Garante que as chaves de negócio do Firebird sejam únicas no servidor,
    // impedindo duplicatas caso o srv_id_map perca a entrada e o registro seja re-inserido.
    if (pkSet.size > 0) {
      await execute(db,
        `ALTER TABLE ${nomeTabela} ADD CONSTRAINT uq_${nomeTabela.toLowerCase()}_bk UNIQUE (${[...pkSet].join(', ')})`
      ).catch(e => { if (e.code !== '42710') throw e; }); // 42710 = duplicate_object
    }
  } else {
    await execute(db,
      `CREATE TABLE IF NOT EXISTS ${nomeTabela} (${colunas.join(', ')}, PRIMARY KEY (${[...pkSet].join(', ')}))`
    );
  }
  const triggerName = `tg_${nomeTabela.toLowerCase()}_seq`;
  await execute(db, `DROP TRIGGER IF EXISTS ${triggerName} ON ${nomeTabela}`);
  await execute(db, `
    CREATE TRIGGER ${triggerName}
    BEFORE INSERT OR UPDATE ON ${nomeTabela}
    FOR EACH ROW EXECUTE FUNCTION ${schemaName}.fn_seq_atualizacao()
  `);
  const delTriggerName = `tg_${nomeTabela.toLowerCase()}_del`;
  await execute(db, `DROP TRIGGER IF EXISTS ${delTriggerName} ON ${nomeTabela}`);
  await execute(db, `
    CREATE TRIGGER ${delTriggerName}
    AFTER DELETE ON ${nomeTabela}
    FOR EACH ROW EXECUTE FUNCTION ${schemaName}.fn_registrar_delecao()
  `);
  console.log(`[${schemaName}] Tabela '${nomeTabela}' criada automaticamente via carga inicial.`);
}

async function getColunasServidor(db, nomeTabela, schemaName) {
  const key = `${schemaName}:${nomeTabela}`;
  if (cacheColunasServidor[key]) return cacheColunasServidor[key];
  const rows = await query(db,
    `SELECT column_name AS "COLUNA"
     FROM information_schema.columns
     WHERE table_name = lower($1) AND table_schema = lower($2)`,
    [nomeTabela, schemaName]
  );
  cacheColunasServidor[key] = new Set(rows.map(r => (r.COLUNA || '').trim().toUpperCase()));
  return cacheColunasServidor[key];
}

/**
 * Retorna as colunas que compõem a PRIMARY KEY real da tabela no PostgreSQL.
 * Para tabelas srvId criadas pelo servidor, isso retorna ['SRV_ID'].
 * Para tabelas legadas (PK original), retorna as colunas da PK Firebird.
 * Resultado cacheado por schema:tabela — invalidar junto com cacheColunasServidor.
 */
async function getPkServidor(db, nomeTabela, schemaName) {
  const key = `${schemaName}:${nomeTabela}`;
  if (cachePkServidor[key]) return cachePkServidor[key];
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
  cachePkServidor[key] = pkCols.length > 0 ? pkCols : null;
  return cachePkServidor[key];
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
  const key = `${schemaName}:${nomeTabela}`;
  if (cacheComputadas[key]) return cacheComputadas[key];
  const rows = await query(db,
    `SELECT column_name AS "COLUNA"
     FROM information_schema.columns
     WHERE table_name = lower($1)
       AND table_schema = lower($2)
       AND is_generated = 'ALWAYS'`,
    [nomeTabela, schemaName]
  );
  cacheComputadas[key] = new Set(rows.map(r => (r.COLUNA || '').trim().toUpperCase()));
  return cacheComputadas[key];
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

// Colunas que o servidor gerencia internamente — não devem ser sobrescritas pela filial
const COLUNAS_IGNORADAS_SERVIDOR = new Set([
  'ID_ULTIMA_ATUALIZACAO_MATRIZ',
  'ID_ULTIMA_ATUALIZACAO_WEB',
  'SRV_ID', // rastreado em srv_id_map; não existe como coluna nas tabelas do servidor
]);

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
      try { await registrarFilial(db, idLoja, null); } catch { /* não bloqueia a resposta */ }

      if (await isFilialBloqueada(idLoja, db)) {
        res.status(401).send();
        return;
      }

      const pks = Array.isArray(pk) ? pk : [pk];

      // Para tabelas srvId, SRV_ID é a PK real no PostgreSQL — obtém antes de qualquer operação.
      // Cada tabela tem sua própria sequence (seq_srv_id_<tabela>) criada na primeira vez,
      // garantindo que o contador recomece do 1 por tabela em vez de usar um global.
      let srvId = null;
      if (temSrvId && !deletar) {
        const pkValorStr = pks.map(p => String(registro[p])).join('|');
        const seqNome = `seq_srv_id_${nomeTabela.toLowerCase()}`;
        const seqKey  = `${req.schemaName}:${seqNome}`;

        // Se a filial enviou um SRV_ID no payload, significa que este registro já existe
        // no servidor com esse ID (ex: foi criado via web UI com PK null e recebido no
        // pull). Reutiliza o ID existente em vez de alocar um novo — evita duplicatas.
        const srvIdFilial = registro.SRV_ID != null ? Number(registro.SRV_ID) : null;

        if (srvIdFilial != null) {
          // Registra o mapeamento id_local → srv_id existente (sem alocar novo valor)
          await execute(db,
            `INSERT INTO srv_id_map (filial_id, tabela, id_local, srv_id)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (tabela, id_local) DO UPDATE SET filial_id = EXCLUDED.filial_id, srv_id = EXCLUDED.srv_id`,
            [idLoja, nomeTabela, pkValorStr, srvIdFilial]
          ).catch(() => {});
          srvId = srvIdFilial;
        } else {
          if (!seqsSrvIdInicializadas.has(seqKey)) {
            // Começa a sequence após o maior SRV_ID já atribuído à tabela,
            // para não colidir com valores de instalações existentes.
            const [maxRow] = await query(db,
              `SELECT COALESCE(MAX(srv_id), 0) + 1 AS inicio FROM srv_id_map WHERE tabela = $1`,
              [nomeTabela]
            ).catch(() => [{ INICIO: 1 }]);
            const inicio = maxRow?.INICIO ?? 1;
            await execute(db, `CREATE SEQUENCE IF NOT EXISTS ${seqNome} START WITH ${inicio}`).catch(() => {});
            seqsSrvIdInicializadas.add(seqKey);
          }

          const [mapa] = await query(db,
            `INSERT INTO srv_id_map (filial_id, tabela, id_local, srv_id)
             VALUES ($1, $2, $3, nextval('${seqNome}'))
             ON CONFLICT (tabela, id_local) DO UPDATE SET filial_id = srv_id_map.filial_id
             RETURNING srv_id, filial_id`,
            [idLoja, nomeTabela, pkValorStr]
          );

          // Se o mapeamento existente pertence a uma FILIAL DIFERENTE, o ID local colidiu
          // com um registro de outra loja. Bloqueia o push para evitar sobrescrever o
          // produto errado silenciosamente. O operador deve corrigir o generator do Firebird.
          if (mapa?.FILIAL_ID != null && mapa.FILIAL_ID !== idLoja) {
            throw Object.assign(
              new Error(
                `COLISÃO DE ID: ${nomeTabela} id_local=${pkValorStr} já pertence à filial ${mapa.FILIAL_ID} ` +
                `(SRV_ID=${mapa.SRV_ID}). Avance o generator do Firebird da filial ${idLoja} ` +
                `para um valor acima de ${mapa.SRV_ID} e recrie o registro com um novo ID.`
              ),
              { isValidation: true }
            );
          }

          srvId = mapa?.SRV_ID ?? null;
        }
      }

      if (deletar) {
        if (temSrvId) {
          const pkValorStr = pks.map(p => registro[p]).join('|');
          const [mapa] = await query(db,
            `SELECT srv_id FROM srv_id_map WHERE tabela = $1 AND id_local = $2`,
            [nomeTabela, pkValorStr]
          ).catch(() => [null]);
          const srvIdDel = mapa?.SRV_ID;
          try {
            if (srvIdDel) {
              await execute(db, `DELETE FROM ${nomeTabela} WHERE SRV_ID = $1`, [srvIdDel]);
              await execute(db,
                `DELETE FROM srv_id_map WHERE tabela = $1 AND id_local = $2`,
                [nomeTabela, pkValorStr]
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
        res.json({ ok: true });
        return;
      }

      // Garante que a tabela existe antes de qualquer query nela.
      // Na carga inicial, a tabela é criada com tipos inferidos do primeiro registro.
      const computadas = await getColunasComputadas(db, nomeTabela, req.schemaName);
      let colunasServidor = await getColunasServidor(db, nomeTabela, req.schemaName);
      const tabelaJaExistia = colunasServidor.size > 0;

      if (!tabelaJaExistia) {
        await criarTabelaSeNecessario(db, nomeTabela, req.schemaName, registro, pks, temSrvId);
        const cacheKey = `${req.schemaName}:${nomeTabela}`;
        delete cacheColunasServidor[cacheKey];
        delete cacheComputadas[cacheKey];
        delete cachePkServidor[cacheKey];
        colunasServidor = await getColunasServidor(db, nomeTabela, req.schemaName);
      } else if (temSrvId && !colunasServidor.has('SRV_ID')) {
        // Migração: tabela existe (criada antes do srvId ser ativado) sem coluna SRV_ID.
        // Adiciona como coluna comum nullable — não destrói a PK original da tabela.
        await execute(db, `ALTER TABLE ${nomeTabela} ADD COLUMN IF NOT EXISTS srv_id INTEGER`);
        const cacheKey = `${req.schemaName}:${nomeTabela}`;
        delete cacheColunasServidor[cacheKey];
        delete cachePkServidor[cacheKey];
        colunasServidor = await getColunasServidor(db, nomeTabela, req.schemaName);
      }

      // Migração one-time: adiciona UNIQUE nas chaves de negócio de tabelas já existentes
      // que foram criadas antes desta versão do código (sem a constraint).
      // Marcado em constraintsUqAdicionadas para não emitir DDL em cada push subsequente.
      if (tabelaJaExistia && temSrvId && pks.length > 0) {
        const cqKey = `${req.schemaName}:${nomeTabela}`;
        if (!constraintsUqAdicionadas.has(cqKey)) {
          constraintsUqAdicionadas.add(cqKey);
          await execute(db,
            `ALTER TABLE ${nomeTabela} ADD CONSTRAINT uq_${nomeTabela.toLowerCase()}_bk UNIQUE (${pks.join(', ')})`
          ).catch(e => {
            if (e.code === '42710') return; // constraint já existe — normal
            if (e.code === '23505') {        // existem duplicatas — limpeza manual necessária
              console.warn(`[${req.schemaName}] ${nomeTabela}: duplicatas em (${pks.join(', ')}) impedem UNIQUE constraint. Execute a limpeza de duplicatas antes de reaplicar.`);
              return;
            }
            throw e;
          });
        }
      }

      // srvIdEhPk: true quando SRV_ID é a PK real da tabela no PostgreSQL.
      // Detectado consultando information_schema (cacheado) em vez de depender de
      // tabelaJaExistia — que era falso apenas no primeiro push e causava ON CONFLICT
      // com ID_PRODUTO (sem constraint única) em todas as chamadas subsequentes.
      const pkReal = await getPkServidor(db, nomeTabela, req.schemaName);
      const srvIdEhPk = temSrvId && srvId != null && pkReal != null && pkReal.length === 1 && pkReal[0] === 'SRV_ID';

      // Detecção de conflito: SRV_ID como chave só quando é a PK real da tabela.
      // Se a tabela não existir (cache obsoleto), limpa, recria e continua com atual=[].
      const _selecionarAtual = async () => {
        if (srvIdEhPk) {
          return query(db, `SELECT * FROM ${nomeTabela} WHERE SRV_ID = $1`, [srvId]);
        }
        const whereValores = pks.map(p => registro[p]);
        const whereParts   = pks.map((p, i) => `${p} = $${i + 1}`).join(' AND ');
        return query(db, `SELECT * FROM ${nomeTabela} WHERE ${whereParts}`, whereValores);
      };

      let atual;
      try {
        atual = await _selecionarAtual();
      } catch (eSel) {
        if (!isMissingTableError(eSel)) throw eSel;
        // Cache obsoleto: tabela foi dropada após ser cacheada — recria agora mesmo.
        const cacheKey = `${req.schemaName}:${nomeTabela}`;
        delete cacheColunasServidor[cacheKey];
        delete cacheComputadas[cacheKey];
        delete cachePkServidor[cacheKey];
        await criarTabelaSeNecessario(db, nomeTabela, req.schemaName, registro, pks, temSrvId);
        colunasServidor = await getColunasServidor(db, nomeTabela, req.schemaName);
        atual = [];
      }

      // Recuperação de mapeamento perdido: quando um SRV_ID recém-alocado não encontra
      // linha na tabela (atual=[]), mas um registro com as mesmas chaves de negócio
      // já existe com SRV_ID diferente (srv_id_map foi limpo/resetado), reutiliza o
      // SRV_ID da linha existente e corrige o mapeamento — evita criar linha duplicada.
      if (srvIdEhPk && atual.length === 0 && tabelaJaExistia) {
        const pkWhere = pks.map((p, i) => `${p} = $${i + 1}`).join(' AND ');
        const pkVals  = pks.map(p => registro[p]);
        const [existente] = await query(db,
          `SELECT SRV_ID FROM ${nomeTabela} WHERE ${pkWhere} LIMIT 1`,
          pkVals
        ).catch(() => [null]);

        if (existente?.SRV_ID != null) {
          const pkValorStrLocal = pks.map(p => String(registro[p])).join('|');
          await execute(db,
            `UPDATE srv_id_map SET srv_id = $1 WHERE tabela = $2 AND id_local = $3`,
            [existente.SRV_ID, nomeTabela, pkValorStrLocal]
          ).catch(() => {});
          srvId = existente.SRV_ID;
          atual = await query(db,
            `SELECT * FROM ${nomeTabela} WHERE SRV_ID = $1`, [srvId]
          ).catch(() => []);
        }
      }

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

      // Para tabelas migradas (SRV_ID como coluna comum, não como PK real):
      // inclui srv_id no próprio UPSERT em vez de um UPDATE separado — evita que
      // fn_seq_atualizacao dispare duas vezes, o que geraria duas versões distintas
      // e causaria falsos conflitos no pull seguinte.
      // Condição: srvId disponível, SRV_ID existe na tabela, mas NÃO é a PK real.
      const temSrvIdMigrado = temSrvId && srvId != null && !srvIdEhPk && colunasServidor.has('SRV_ID');

      let novoId = null;
      if (colunas.length > 0 || srvIdEhPk || temSrvIdMigrado) {
        // Monta listas de colunas/valores:
        // - tabela nova: SRV_ID no início (é a PK real)
        // - tabela migrada: srv_id no final (coluna comum)
        // - demais: só as colunas do registro
        const colunasFinais = srvIdEhPk
          ? ['SRV_ID', ...colunas]
          : temSrvIdMigrado
            ? [...colunas, 'srv_id']
            : colunas;
        // PostgreSQL TEXT rejeita \x00 — Firebird CHAR/VARCHAR pode conter null bytes.
        // Firebird TIME columns são retornados pelo node-firebird como Date com epoch 1970-01-01.
        // Se passados direto ao pg, viram "1970-01-01T12:47:13.000Z" numa coluna TEXT — inútil
        // para display. Normaliza para 'HH:MM:SS' antes de persistir.
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
        // Quando srvIdEhPk, o conflito é resolvido por SRV_ID (não pelos pks da filial como
        // ID_CLIENTE). Portanto ID_CLIENTE e similares devem aparecer no UPDATE SET — sem isso
        // o servidor nunca grava o PK local recebido da filial e continua enviando o registro
        // com ID_CLIENTE=null a cada ciclo, gerando um loop infinito de inserções.
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
        const cacheKey = `${req.schemaName}:${nomeTabela}`;
        delete cacheColunasServidor[cacheKey];
        delete cacheComputadas[cacheKey];
        delete cachePkServidor[cacheKey];
      }
    }
    res.status(400).json({ message: `Erro ao aplicar registro: ${e.message}` });
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

router.get('/BuscarParametros', auth, async (req, res) => {
  try {
    const parametros = await withTenantConnection(req.schemaName, async (db) => {
      const rows = await query(db, `SELECT chave, valor FROM sync_config WHERE chave IN ('codigo_interno_unico', 'utilizar_codigo_interno')`);
      return Object.fromEntries(rows.map(r => [r.CHAVE, r.VALOR]));
    });
    res.json({ parametros });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

router.post('/AtualizarParametros', auth, async (req, res) => {
  const { parametros } = req.body || {};
  if (!parametros || typeof parametros !== 'object') return res.json({ ok: true });
  const CHAVES_ACEITAS = new Set(['codigo_interno_unico', 'utilizar_codigo_interno']);
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
