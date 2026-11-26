/**
 * Verificação de sincronização — lado do superadmin (montado em /superadmin, já com authJwt + requireSuperAdmin).
 * GET  /verificacoes/tabelas                → tabelas que sincronizam (para escolher)
 * POST /empresas/:schema/verificacoes       → { idLoja?: number, tabelas: string[] } — sem idLoja = todas as lojas
 * GET  /empresas/:schema/verificacoes       → últimas verificações (só o resumo)
 * GET  /verificacoes/:id                    → resultado completo + correções pedidas
 * POST /verificacoes/:id/correcoes          → { itens: [{ tabela, chave, lado: 'servidor'|'loja' }] }
 */
const express = require('express');
const router  = express.Router();

const { pool, withTenantConnection, query } = require('#server/infrastructure/db.js');
const TABELAS = require('#client/domain/tabelas.js');
const repo = require('#server/infrastructure/repositories/verificacoesRepository.js');
const { reenviarParaLoja } = require('#server/application/verificacao/registrosServidor.js');
const { erroServidor } = require('#server/interfaces/http/erroServidor.js');

const NOMES_TABELAS = new Set(TABELAS.map(t => t.nome));
// Lado que cada tipo de divergência aceita (excluir registro não é oferecido).
const LADOS_POR_GRUPO = { diferentes: ['servidor', 'loja'], soServidor: ['servidor'], soFirebird: ['loja'] };
const MAX_CORRECOES = 600;

function correcaoResumo(c) {
  return { id: c.id, tabela: c.tabela, chave: c.chave, lado: c.lado, status: c.status, erro: c.erro,
    solicitadoEm: c.solicitado_em, concluidoEm: c.concluido_em };
}

// Grupo da amostra em que a chave aparece (só se corrige o que a verificação mostrou).
function grupoDaChave(t, chave) {
  return Object.keys(LADOS_POR_GRUPO).find(g => (t.amostras?.[g] || []).some(a => a.chave === chave)) ?? null;
}

// Sem as amostras: a listagem só mostra contagens.
function resumo(v) {
  const tabelas = Object.fromEntries(Object.entries(v.resultado?.tabelas || {}).map(([nome, t]) => {
    const { amostras, _servidor, colunas, ...contagens } = t; // eslint-disable-line no-unused-vars
    return [nome, contagens];
  }));
  return { id: v.id, idLoja: v.id_loja, tabelas: v.tabelas, status: v.status, erro: v.erro,
    solicitadoEm: v.solicitado_em, iniciadoEm: v.iniciado_em, concluidoEm: v.concluido_em, resultado: tabelas };
}

async function empresaExiste(schema) {
  const { rows } = await pool.query('SELECT 1 FROM public.sync_tenants WHERE schema_name = $1', [schema]);
  return rows.length > 0;
}

router.get('/verificacoes/tabelas', (_req, res) => {
  res.json(TABELAS.map(t => ({ nome: t.nome, grupo: t.grupo })));
});

router.post('/empresas/:schema/verificacoes', async (req, res) => {
  const { schema } = req.params;
  const tabelas = Array.isArray(req.body?.tabelas) ? [...new Set(req.body.tabelas.map(String))] : [];
  if (!tabelas.length) return res.status(400).json({ erro: 'Escolha ao menos uma tabela.' });
  const invalidas = tabelas.filter(t => !NOMES_TABELAS.has(t));
  if (invalidas.length) return res.status(400).json({ erro: `Tabela(s) que não sincronizam: ${invalidas.join(', ')}` });
  // Mesma ordem do tabelas.js (pais antes dos filhos), não a ordem de clique.
  const ordenadas = TABELAS.map(t => t.nome).filter(n => tabelas.includes(n));
  try {
    if (!(await empresaExiste(schema))) return res.status(404).json({ erro: 'Empresa não encontrada' });
    let lojas;
    if (req.body?.idLoja != null) {
      const n = parseInt(req.body.idLoja, 10);
      if (!Number.isInteger(n) || n <= 0) return res.status(400).json({ erro: 'Loja inválida.' });
      lojas = [n];
    } else {
      lojas = (await withTenantConnection(schema, db => query(db, 'SELECT id_loja FROM sync_filiais ORDER BY id_loja')).catch(() => []))
        .map(r => Number(r.ID_LOJA)).filter(n => Number.isInteger(n) && n > 0);
      if (!lojas.length) return res.status(400).json({ erro: 'Nenhuma loja desta empresa sincronizou ainda.' });
    }
    const criadas = [];
    for (const idLoja of lojas) criadas.push(await repo.criar({ schema, idLoja, tabelas: ordenadas, solicitadoPor: req.userId }));
    res.status(201).json(criadas.map(c => ({ id: c.id, idLoja: c.id_loja, status: c.status, solicitadoEm: c.solicitado_em })));
  } catch (e) {
    erroServidor(res, e);
  }
});

router.get('/empresas/:schema/verificacoes', async (req, res) => {
  try {
    res.json((await repo.listar(req.params.schema)).map(resumo));
  } catch (e) {
    erroServidor(res, e);
  }
});

router.get('/verificacoes/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ erro: 'id inválido' });
  try {
    const v = await repo.buscar(id);
    if (!v) return res.status(404).json({ erro: 'Verificação não encontrada' });
    const tabelas = v.resultado?.tabelas || {};
    for (const t of Object.values(tabelas)) delete t._servidor;
    const correcoes = (await repo.listarCorrecoes(id)).map(correcaoResumo);
    res.json({ ...resumo(v), schema: v.schema_name, detalhes: tabelas, correcoes });
  } catch (e) {
    erroServidor(res, e);
  }
});

router.post('/verificacoes/:id/correcoes', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const itens = Array.isArray(req.body?.itens) ? req.body.itens : [];
  if (!Number.isInteger(id)) return res.status(400).json({ erro: 'id inválido' });
  if (!itens.length) return res.status(400).json({ erro: 'Nenhum registro para corrigir.' });
  if (itens.length > MAX_CORRECOES) return res.status(400).json({ erro: `No máximo ${MAX_CORRECOES} registros por vez.` });
  try {
    const v = await repo.buscar(id);
    if (!v) return res.status(404).json({ erro: 'Verificação não encontrada' });
    if (!['concluida', 'erro'].includes(v.status)) return res.status(400).json({ erro: 'Espere a verificação terminar para corrigir.' });
    const tabelas = v.resultado?.tabelas || {};
    const atuais = new Map((await repo.listarCorrecoes(id)).map(c => [`${c.tabela}\n${c.chave}`, c]));
    const resultados = [];
    for (const item of itens) {
      const tabela = String(item?.tabela ?? '');
      const chave = String(item?.chave ?? '');
      const lado = item?.lado;
      const t = tabelas[tabela];
      const grupo = t?.status === 'ok' ? grupoDaChave(t, chave) : null;
      if (!grupo || !LADOS_POR_GRUPO[grupo].includes(lado)) {
        resultados.push({ tabela, chave, lado, status: 'erro', erro: 'Correção não permitida para este registro.' });
        continue;
      }
      if (atuais.get(`${tabela}\n${chave}`)?.status === 'executando') {
        resultados.push({ tabela, chave, lado, status: 'erro', erro: 'A loja ainda está aplicando a correção anterior deste registro.' });
        continue;
      }
      const tipoChave = t.chave === 'SRV_ID' ? 'SRV_ID' : 'PK';
      let status = 'pendente';
      let erro = null;
      if (lado === 'servidor') {
        try {
          const achados = await withTenantConnection(v.schema_name, db =>
            reenviarParaLoja(db, { tabela, chave, tipoChave, idLoja: v.id_loja, schema: v.schema_name }));
          if (achados === 1) status = 'feita';
          else {
            status = 'erro';
            erro = achados === 0 ? 'O registro não existe mais no servidor.' : `${achados} registros no servidor com esta chave — não dá para escolher um.`;
          }
        } catch (e) {
          console.error(`[Verificação] correção #${id} ${tabela}/${chave}:`, e.message);
          status = 'erro';
          erro = 'Falha ao marcar o registro no servidor.';
        }
      }
      const gravada = await repo.gravarCorrecao({ verificacaoId: id, schema: v.schema_name, idLoja: v.id_loja,
        tabela, chave, tipoChave, lado, status, erro, solicitadoPor: req.userId });
      resultados.push(correcaoResumo(gravada));
    }
    res.json({ resultados, correcoes: (await repo.listarCorrecoes(id)).map(correcaoResumo) });
  } catch (e) {
    erroServidor(res, e);
  }
});

module.exports = router;
