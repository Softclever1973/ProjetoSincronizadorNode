/**
 * Verificação de sincronização — lado do superadmin (montado em /superadmin, já com authJwt + requireSuperAdmin).
 * GET  /verificacoes/tabelas                → tabelas que sincronizam (para escolher)
 * POST /empresas/:schema/verificacoes       → { idLoja?: number, tabelas: string[] } — sem idLoja = todas as lojas
 * GET  /empresas/:schema/verificacoes       → últimas verificações (só o resumo)
 * GET  /verificacoes/:id                    → resultado completo
 */
const express = require('express');
const router  = express.Router();

const { pool, withTenantConnection, query } = require('#server/infrastructure/db.js');
const TABELAS = require('#client/domain/tabelas.js');
const repo = require('#server/infrastructure/repositories/verificacoesRepository.js');
const { erroServidor } = require('#server/interfaces/http/erroServidor.js');

const NOMES_TABELAS = new Set(TABELAS.map(t => t.nome));

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
    res.json({ ...resumo(v), schema: v.schema_name, detalhes: tabelas });
  } catch (e) {
    erroServidor(res, e);
  }
});

module.exports = router;
