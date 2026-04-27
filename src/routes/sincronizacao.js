const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { withTenantConnection, query, execute } = require('../db');
const { isFilialBloqueada } = require('../middleware/filialBloqueada');

// Cache de colunas computadas do servidor
const cacheComputadas = {};

// Cache de colunas existentes no servidor por tabela
const cacheColunasServidor = {};

// Mapeia tipo JavaScript (inferido do valor) para tipo PostgreSQL
function inferirTipoPg(valor) {
  if (Buffer.isBuffer(valor))      return 'BYTEA';
  if (valor instanceof Date)       return 'TIMESTAMP';
  if (typeof valor === 'boolean')  return 'BOOLEAN';
  if (typeof valor === 'number')   return Number.isInteger(valor) ? 'INTEGER' : 'NUMERIC';
  return 'TEXT';
}

/**
 * Cria a tabela no schema do tenant usando os tipos inferidos do primeiro registro recebido.
 * Chamado quando ReceberRegistro encontra colunasServidor vazio (tabela inexistente).
 */
async function criarTabelaSeNecessario(db, nomeTabela, schemaName, registro, pks) {
  const pkSet = new Set(Array.isArray(pks) ? pks : [pks]);
  const colunas = Object.keys(registro).map(nome => {
    const tipo = inferirTipoPg(registro[nome]);
    return `${nome} ${tipo}${pkSet.has(nome) ? ' NOT NULL' : ''}`;
  });
  if (!Object.prototype.hasOwnProperty.call(registro, 'ID_ULTIMA_ATUALIZACAO_MATRIZ')) {
    colunas.push('ID_ULTIMA_ATUALIZACAO_MATRIZ INTEGER');
  }
  await execute(db,
    `CREATE TABLE IF NOT EXISTS ${nomeTabela} (${colunas.join(', ')}, PRIMARY KEY (${[...pkSet].join(', ')}))`
  );
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

// Colunas que o servidor gerencia internamente — não devem ser sobrescritas pela filial
const COLUNAS_IGNORADAS_SERVIDOR = new Set([
  'ID_ULTIMA_ATUALIZACAO_MATRIZ',
  'ID_ULTIMA_ATUALIZACAO_WEB',
]);

// Tabelas permitidas para sincronização — equivalente ao case/AnsiIndexStr do Delphi
const TABELAS_PERMITIDAS = new Set([
  'AUX_CLASSIFICACOES_FISCAIS',
  'AUX_CODIFICACAO_GRUPOS',
  'AUX_ESPECIES_EMBALAGENS',
  'AUX_GENERICA',
  'AUX_PAISES_BACEN',
  'AUX_PARCELAS_PAGAMENTOS',
  'AUX_SITUACOES_TRIBUTARIAS',
  'AUX_SUB_GRUPOS',
  'CENTROS_DE_CUSTO',
  'CLASSIFICACOES',
  'CLIENTES',
  'CLIENTES_X_ENTREGA',
  'CODIGOS_REGIMES_TRIBUTARIOS',
  'CONTAS',
  'DEPARTAMENTOS',
  'ENDERECOS_DE_RETIRADA',
  'FORMAS_DE_PAGAMENTOS_SISPAG',
  'FORN_CONTATOS_ADICIONAIS',
  'FORNECEDORES',
  'LISTA_PRECOS',
  'PRODUTOS',
  'PRODUTOS_GRADES',
  'PRODUTOS_X_LISTA',
  'REPRESENTANTES',
  'SUPERVISORES',
  'TIPOS_PRODUTOS',
  'TRANSP_CONTATOS_ADICIONAIS',
  'TRANSPORTADORES',
  'TRANSPORTADORES_PLACAS',
  'UNIDADES',
  'VENDEDORES',
  'SYNC_4M_PRODUTOS',
  'SYNC_4M_PROD_CANAIS',
  'SYNC_4M_PROD_IMGS',
  'SYNC_4M_PROMOCOES',
  'AUX_MOEDAS',
  'KITS_PRODUTOS',
  'KITS_ITENS_PROD',
  'KITS_ITENS_SUB_PROD',
  'PEDIDOS',
  'PEDIDOS_ITENS',
  'PEDIDOS_PARCELAS_PAGAMENTOS',
]);

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
  const filtroFilial = req.query.filtroFilial
    ? String(req.query.filtroFilial).trim().toUpperCase()
    : null;

  if (!nomeTabela) {
    return res.status(400).json({
      message: 'Ocorreu um erro ao tentar listar os registros para atualizar pois o campo nomeTabela não foi informado',
    });
  }

  if (!TABELAS_PERMITIDAS.has(nomeTabela)) {
    return res.status(400).json({ message: `Tabela '${nomeTabela}' não é permitida para sincronização` });
  }

  // Valida nome de coluna para evitar SQL injection
  if (filtroFilial && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(filtroFilial)) {
    return res.status(400).json({ message: `Nome de coluna inválido: '${filtroFilial}'` });
  }

  try {
    const params = [idUltimaAtualizacaoMatriz];
    let whereExtra = '';

    if (filtroFilial && idLoja) {
      params.push(idLoja);
      whereExtra = ` AND ${filtroFilial} = $${params.length}`;
    }

    const sql = `SELECT * FROM ${nomeTabela}
                 WHERE ID_ULTIMA_ATUALIZACAO_MATRIZ IS NOT NULL
                   AND ID_ULTIMA_ATUALIZACAO_MATRIZ > $1
                   ${whereExtra}
                 ORDER BY ID_ULTIMA_ATUALIZACAO_MATRIZ
                 LIMIT 50`;

    const rows = await withTenantConnection(req.schemaName, (db) => query(db, sql, params));

    res.json(rows);
  } catch (e) {
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
      const tabelas = [...TABELAS_PERMITIDAS];
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
          // Tabela pode não existir no banco do servidor
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
  const pk         = req.query.pk; // Pode ser string ou array
  const offset     = parseInt(req.query.offset, 10) || 0;
  const limit      = Math.min(parseInt(req.query.limit, 10) || 200, 500);

  if (!nomeTabela || !pk) {
    return res.status(400).json({ message: 'nomeTabela e pk são obrigatórios' });
  }
  if (!TABELAS_PERMITIDAS.has(nomeTabela)) {
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
  const idPDV  = req.query.idPDV ? parseInt(req.query.idPDV, 10) : null; // eslint-disable-line no-unused-vars
  const { tabela, pk, registro, ultimaVersaoConhecida = 0, forcar = false } = req.body || {};

  if (!idLoja) {
    return res.status(400).json({ message: 'idLoja não informado' });
  }
  if (!tabela || !pk || !registro) {
    return res.status(400).json({ message: 'tabela, pk e registro são obrigatórios' });
  }

  restaurarBuffers(registro);

  const nomeTabela = tabela.toUpperCase().trim();
  if (!TABELAS_PERMITIDAS.has(nomeTabela)) {
    return res.status(400).json({ message: `Tabela '${nomeTabela}' não permitida` });
  }

  try {
    await withTenantConnection(req.schemaName, async (db) => {
      if (await isFilialBloqueada(idLoja, db)) {
        res.status(401).send();
        return;
      }

      const pks = Array.isArray(pk) ? pk : [pk];

      // Garante que a tabela existe antes de qualquer query nela.
      // Na carga inicial, a tabela é criada com tipos inferidos do primeiro registro.
      const computadas = await getColunasComputadas(db, nomeTabela, req.schemaName);
      let colunasServidor = await getColunasServidor(db, nomeTabela, req.schemaName);
      if (colunasServidor.size === 0) {
        await criarTabelaSeNecessario(db, nomeTabela, req.schemaName, registro, pks);
        const cacheKey = `${req.schemaName}:${nomeTabela}`;
        delete cacheColunasServidor[cacheKey];
        delete cacheComputadas[cacheKey];
        colunasServidor = await getColunasServidor(db, nomeTabela, req.schemaName);
      }

      // Busca o registro atual no servidor para detecção de conflito
      const whereValores = pks.map(p => registro[p]);
      const whereParts = pks.map((p, i) => `${p} = $${i + 1}`).join(' AND ');

      const atual = await query(db, `SELECT * FROM ${nomeTabela} WHERE ${whereParts}`, whereValores);

      if (!forcar && atual.length > 0) {
        const versaoServidor = atual[0].ID_ULTIMA_ATUALIZACAO_MATRIZ;
        if (versaoServidor && versaoServidor > ultimaVersaoConhecida) {
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

      if (colunas.length > 0) {
        const placeholders = colunas.map((_, i) => `$${i + 1}`).join(', ');
        const valores = colunas.map(c => (registro[c] === undefined ? null : registro[c]));
        const nonPkCols = colunas.filter(c => !pks.includes(c));
        const updateSet = nonPkCols.length > 0
          ? nonPkCols.map(c => `${c} = EXCLUDED.${c}`).join(', ')
          : `${pks[0]} = EXCLUDED.${pks[0]}`; // sem colunas não-PK: no-op seguro
        await execute(db,
          `INSERT INTO ${nomeTabela} (${colunas.join(', ')}) VALUES (${placeholders})
           ON CONFLICT (${pks.join(', ')}) DO UPDATE SET ${updateSet}`,
          valores
        );
      }

      res.json({ ok: true });
    });
  } catch (e) {
    res.status(400).json({ message: `Erro ao aplicar registro: ${e.message}` });
  }
});

module.exports = router;
 colunas não-PK: no-op seguro
        await execute(db,
          `INSERT INTO ${nomeTabela} (${colunas.join(', ')}) VALUES (${placeholders})
           ON CONFLICT (${pks.join(', ')}) DO UPDATE SET ${updateSet}`,
          valores
        );
      }

      res.json({ ok: true });
    });
  } catch (e) {
    res.status(400).json({ message: `Erro ao aplicar registro: ${e.message}` });
  }
});

module.exports = router;
