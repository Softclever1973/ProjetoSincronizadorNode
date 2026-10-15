/**
 * Verificação de sincronização — lado do client.exe (token de sync), montado em /datasnap/rest/TSMVerificacao.
 * GET  /Pendente   → pedido da loja + colunas do servidor por tabela
 * POST /Tabela     → hashes do Firebird de uma tabela; responde as chaves cujo detalhe deve vir
 * POST /Detalhes   → valores canônicos do Firebird das chaves pedidas
 * POST /Concluir   → fecha o pedido
 */
const express = require('express');
const router  = express.Router();

const auth = require('#server/interfaces/http/middleware/auth.js');
const { withTenantConnection, isMissingTableError } = require('#server/infrastructure/db.js');
const repo = require('#server/infrastructure/repositories/verificacoesRepository.js');
const { registrosServidor, colunasComparaveis } = require('#server/application/verificacao/registrosServidor.js');
const { compararHashes, camposDiferentes, MAX_DETALHES } = require('#client/domain/verificacao.js');
const { NOME_VALIDO } = require('#server/domain/validacao.js');
const { erroServidor } = require('#server/interfaces/http/erroServidor.js');

const CATEGORIAS = new Set(['data', 'hora', 'datahora', 'numero', 'booleano', 'texto', 'textoLongo']);

function idLojaDe(req) {
  const n = parseInt(req.query.idLoja, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Pedido em execução desta empresa/loja e tabela pertencente a ele; senão responde o erro.
async function pedidoValido(req, res) {
  const idLoja = idLojaDe(req);
  const id = parseInt(req.body?.id, 10);
  if (!idLoja || !id) { res.status(400).json({ erro: 'id e idLoja são obrigatórios' }); return null; }
  const pedido = await repo.emExecucao(id, req.schemaName, idLoja);
  if (!pedido) { res.status(404).json({ erro: 'verificação não encontrada ou já encerrada' }); return null; }
  return { pedido, idLoja, id };
}

router.get('/Pendente', auth, async (req, res) => {
  const idLoja = idLojaDe(req);
  if (!idLoja) return res.status(400).json({ erro: 'idLoja é obrigatório' });
  try {
    const pedido = await repo.proximoPendente(req.schemaName, idLoja);
    if (!pedido) return res.json({});
    const colunasServidor = {};
    await withTenantConnection(req.schemaName, async db => {
      for (const t of pedido.tabelas) colunasServidor[t] = await colunasComparaveis(db, req.schemaName, t).catch(() => []);
    });
    res.json({ id: pedido.id, tabelas: pedido.tabelas, colunasServidor });
  } catch (e) {
    erroServidor(res, e);
  }
});

router.post('/Tabela', auth, async (req, res) => {
  try {
    const ok = await pedidoValido(req, res);
    if (!ok) return;
    const { pedido, idLoja, id } = ok;
    const { tabela, colunas = [], hashes = [], pendentes = [], erro, motivo } = req.body;
    // Client antigo não manda: compara pela PK local, como antes.
    const chave = req.body.chave === 'SRV_ID' ? 'SRV_ID' : 'PK';
    if (!NOME_VALIDO.test(tabela || '') || !pedido.tabelas.includes(tabela)) return res.status(400).json({ erro: 'tabela fora desta verificação' });
    if (erro || motivo) {
      await repo.gravarTabela(id, tabela, { status: erro ? 'erro' : 'ignorada', erro: erro || null, motivo: motivo || null });
      return res.json({ detalhes: [] });
    }
    const cols = colunas.filter(c => NOME_VALIDO.test(c?.nome || '') && CATEGORIAS.has(c?.categoria));
    // Coluna descartada mudaria o hash só de um lado: toda linha viraria "diferente" sem campo diferente.
    const recusadas = colunas.filter(c => !cols.includes(c));
    if (recusadas.length) {
      const nomes = recusadas.map(c => `${String(c?.nome ?? '?').slice(0, 40)} (${String(c?.categoria ?? '?').slice(0, 20)})`).join(', ');
      await repo.gravarTabela(id, tabela, { status: 'erro', erro: `O servidor não reconhece estas colunas enviadas pelo client: ${nomes}. Client e servidor precisam estar na mesma versão.` });
      return res.json({ detalhes: [] });
    }

    let servidor;
    try {
      servidor = await withTenantConnection(req.schemaName, db =>
        registrosServidor(db, { tabela, colunas: cols, idLoja, schema: req.schemaName, chave }));
    } catch (e) {
      if (!isMissingTableError(e)) throw e;
      servidor = { registros: new Map(), semChave: 0, repetidas: [] };
    }

    const hashServidor = new Map([...servidor.registros].map(([k, r]) => [k, r.hash]));
    const hashFirebird = new Map(hashes.filter(h => Array.isArray(h) && h.length === 2).map(([k, h]) => [String(k), String(h)]));
    const pend = new Set(pendentes.map(String));
    const cmp = compararHashes(hashServidor, hashFirebird);
    // Alterado na loja e ainda na fila de envio: não é divergência, só "aguardando envio".
    const aguardando = [...cmp.diferentes, ...cmp.soFirebird].filter(k => pend.has(k));
    const diferentes = cmp.diferentes.filter(k => !pend.has(k));
    const soFirebird = cmp.soFirebird.filter(k => !pend.has(k));

    const amostraDif = diferentes.slice(0, MAX_DETALHES);
    const amostraSoFb = soFirebird.slice(0, MAX_DETALHES);
    await repo.gravarTabela(id, tabela, {
      status: 'ok',
      chave,
      colunas: cols.map(c => c.nome),
      // Mais de um registro do servidor com a mesma chave: só o último foi comparado.
      repetidasServidor: servidor.repetidas.length,
      amostraRepetidas: servidor.repetidas.slice(0, MAX_DETALHES),
      totalServidor: servidor.registros.size,
      totalFirebird: hashFirebird.size,
      semIdServidor: servidor.semChave,
      iguais: cmp.iguais.length,
      diferentes: diferentes.length,
      soServidor: cmp.soServidor.length,
      soFirebird: soFirebird.length,
      aguardandoEnvio: aguardando.length,
      amostras: {
        diferentes: amostraDif.map(chave => ({ chave, campos: null })),
        soServidor: cmp.soServidor.slice(0, MAX_DETALHES).map(chave => ({ chave, valores: servidor.registros.get(chave).valores })),
        soFirebird: amostraSoFb.map(chave => ({ chave, valores: null })),
      },
      // Valores do servidor guardados até os detalhes do Firebird chegarem.
      _servidor: Object.fromEntries(amostraDif.map(k => [k, servidor.registros.get(k).valores])),
    });
    res.json({ detalhes: [...amostraDif, ...amostraSoFb] });
  } catch (e) {
    erroServidor(res, e);
  }
});

router.post('/Detalhes', auth, async (req, res) => {
  try {
    const ok = await pedidoValido(req, res);
    if (!ok) return;
    const { pedido, id } = ok;
    const { tabela, registros = {} } = req.body;
    const atual = pedido.resultado?.tabelas?.[tabela];
    if (!atual || atual.status !== 'ok') return res.status(400).json({ erro: 'tabela sem resumo nesta verificação' });

    const colunas = atual.colunas || [];
    const servidor = atual._servidor || {};
    atual.amostras.diferentes = atual.amostras.diferentes.map(({ chave }) => ({
      chave, campos: camposDiferentes(servidor[chave], registros[chave], colunas),
    }));
    atual.amostras.soFirebird = atual.amostras.soFirebird.map(({ chave }) => ({ chave, valores: registros[chave] ?? null }));
    delete atual._servidor;
    await repo.gravarTabela(id, tabela, atual);
    res.json({ ok: true });
  } catch (e) {
    erroServidor(res, e);
  }
});

router.post('/Concluir', auth, async (req, res) => {
  try {
    const ok = await pedidoValido(req, res);
    if (!ok) return;
    await repo.concluir(ok.id, req.body?.erro ? String(req.body.erro).slice(0, 500) : null);
    res.json({ ok: true });
  } catch (e) {
    erroServidor(res, e);
  }
});

module.exports = router;
