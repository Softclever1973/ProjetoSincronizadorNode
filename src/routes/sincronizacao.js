const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { withConnection, getConnection, query, execute, closeConnection } = require('../db');
const { isFilialBloqueada } = require('../middleware/filialBloqueada');

// Cache de colunas computadas do servidor
const cacheComputadas = {};

function normalizarBlobs(row) {
  if (!row || typeof row !== 'object') return row;
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k, typeof v === 'function' ? null : v])
  );
}

async function getColunasComputadas(db, nomeTabela) {
  if (cacheComputadas[nomeTabela]) return cacheComputadas[nomeTabela];
  const rows = await query(db,
    `SELECT TRIM(rf.RDB$FIELD_NAME) AS COLUNA
     FROM RDB$RELATION_FIELDS rf
     JOIN RDB$FIELDS f ON f.RDB$FIELD_NAME = rf.RDB$FIELD_SOURCE
     WHERE TRIM(rf.RDB$RELATION_NAME) = ?
       AND f.RDB$COMPUTED_SOURCE IS NOT NULL`,
    [nomeTabela]
  );
  cacheComputadas[nomeTabela] = new Set(rows.map(r => (r.COLUNA || '').trim()));
  return cacheComputadas[nomeTabela];
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
    let sql = `SELECT FIRST 50 * FROM ${nomeTabela}
               WHERE ID_ULTIMA_ATUALIZACAO_MATRIZ IS NOT NULL
                 AND ID_ULTIMA_ATUALIZACAO_MATRIZ > ?`;
    const params = [idUltimaAtualizacaoMatriz];

    if (filtroFilial && idLoja) {
      sql += ` AND ${filtroFilial} = ?`;
      params.push(idLoja);
    }

    sql += ` ORDER BY ID_ULTIMA_ATUALIZACAO_MATRIZ`;

    const rows = await withConnection((db) => query(db, sql, params));

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
    const rows = await withConnection((db) =>
      query(
        db,
        `SELECT FIRST 10 * FROM REGISTROS_DELETADOS
         WHERE NOME_DA_TABELA = ?
           AND ID_REGISTRO_DELETADO > ?
         ORDER BY ID_REGISTRO_DELETADO`,
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
    const resultado = await withConnection(async (db) => {
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
    const rows = await withConnection((db) =>
      query(db,
        `SELECT FIRST ${limit} SKIP ${offset} * FROM ${nomeTabela} ORDER BY ${pks.join(', ')}`,
        []
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

  const nomeTabela = tabela.toUpperCase().trim();
  if (!TABELAS_PERMITIDAS.has(nomeTabela)) {
    return res.status(400).json({ message: `Tabela '${nomeTabela}' não permitida` });
  }

  const db = await getConnection();
  try {
    if (await isFilialBloqueada(idLoja, db)) {
      return res.status(401).send();
    }

    // Busca o registro atual no servidor para detecção de conflito
    const pks = Array.isArray(pk) ? pk : [pk];
    const whereParts = pks.map(p => `${p} = ?`).join(' AND ');
    const whereValores = pks.map(p => registro[p]);

    const atual = await query(db, `SELECT * FROM ${nomeTabela} WHERE ${whereParts}`, whereValores);

    if (!forcar && atual.length > 0) {
      const versaoServidor = atual[0].ID_ULTIMA_ATUALIZACAO_MATRIZ;
      if (versaoServidor && versaoServidor > ultimaVersaoConhecida) {
        // Conflito detectado: servidor tem versão mais nova que o cliente conhecia
        return res.json({ conflito: true, versaoServidor: atual[0] });
      }
    }

    // Aplica o UPSERT filtrando colunas computadas e reservadas
    const computadas = await getColunasComputadas(db, nomeTabela);
    const colunas = Object.keys(registro).filter(k =>
      registro[k] !== undefined &&
      !COLUNAS_IGNORADAS_SERVIDOR.has(k) &&
      !computadas.has(k)
    );

    if (colunas.length > 0) {
      const placeholders = colunas.map(() => '?').join(', ');
      const valores = colunas.map(c => (registro[c] === undefined ? null : registro[c]));
      await execute(db,
        `UPDATE OR INSERT INTO ${nomeTabela} (${colunas.join(', ')}) VALUES (${placeholders}) MATCHING (${pks.join(', ')})`,
        valores
      );
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ message: `Erro ao aplicar registro: ${e.message}` });
  } finally {
    await closeConnection(db);
  }
});

module.exports = router;
