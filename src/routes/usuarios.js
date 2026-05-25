const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');
const { pool, withTenantConnection, query, execute } = require('../db');
const authJwt  = require('../middleware/authJwt');
const { requireRole } = require('../middleware/checkRole');

const ROLES_VALIDOS = ['dono', 'gerente', 'vendedor'];
const PODE_CRIAR    = { dono: ['gerente', 'vendedor'], gerente: ['vendedor'] };

function checkSchema(req, res, next) {
  if (!req.userSchemas.includes(req.params.schema))
    return res.status(403).json({ erro: 'acesso negado' });
  next();
}

/* ── GET /api/:schema/usuarios ── */
router.get('/:schema/usuarios', authJwt, checkSchema, requireRole('gerente', 'dono'), async (req, res) => {
  const { schema } = req.params;
  const callerRole  = req.userRoles[schema];
  const filtroLoja  = req.query.filtroLoja !== undefined ? parseInt(req.query.filtroLoja) : null;

  try {
    let rows;
    if (callerRole === 'dono') {
      // Dono vê usuários de todos os schemas que possui, com filtro de loja opcional
      const placeholders = req.userSchemas.map((_, i) => `$${i + 1}`).join(', ');
      const params = [...req.userSchemas];
      let where = `ue.schema_name IN (${placeholders})`;
      if (filtroLoja !== null && !isNaN(filtroLoja)) {
        params.push(filtroLoja);
        where += ` AND ue.id_loja = $${params.length}`;
      }
      const result = await pool.query(
        `SELECT u.id, u.nome, u.email, u.ativo, ue.schema_name, ue.role, ue.id_loja, ue.id_vendedor
         FROM public.usuarios_empresas ue
         JOIN public.usuarios u ON u.id = ue.id_usuario
         WHERE ${where}
         ORDER BY ue.schema_name, u.email`,
        params
      );
      rows = result.rows;
    } else {
      // Gerente vê apenas usuários do seu schema, excluindo donos
      // Filtra pela loja do próprio gerente (ignora filtroLoja do query — gerente não escolhe)
      const lojaGerente = req.userLojas?.[schema] ?? null;
      const params = [schema];
      let where = `ue.schema_name = $1 AND ue.role <> 'dono'`;
      if (lojaGerente !== null) {
        params.push(lojaGerente);
        where += ` AND ue.id_loja = $${params.length}`;
      }
      const result = await pool.query(
        `SELECT u.id, u.nome, u.email, u.ativo, ue.schema_name, ue.role, ue.id_loja, ue.id_vendedor
         FROM public.usuarios_empresas ue
         JOIN public.usuarios u ON u.id = ue.id_usuario
         WHERE ${where}
         ORDER BY u.email`,
        params
      );
      rows = result.rows;
    }
    res.json(rows);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

/**
 * Tenta criar um registro na tabela VENDEDORES do tenant e retorna o novo ID.
 * Detecta colunas dinamicamente para tolerar schemas variados.
 * Retorna null silenciosamente se a tabela não existir ou falhar.
 *
 * @param {string} schema
 * @param {{ nome: string|null, id_loja: number|null }} dados
 * @returns {Promise<number|null>}
 */
async function _criarVendedorNoTenant(schema, { nome, id_loja }) {
  try {
    return await withTenantConnection(schema, async (db) => {
      // Detecta colunas disponíveis
      const { rows: colRows } = await db.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = current_schema() AND LOWER(table_name) = 'vendedores'
         ORDER BY ordinal_position`
      );
      if (!colRows.length) return null;

      const colsRaw = colRows.map(r => r.column_name);
      const colsUp  = colsRaw.map(c => c.toUpperCase());
      const has     = (c) => colsUp.includes(c);

      if (!has('ID_VENDEDOR')) return null;

      // Próximo ID via MAX+1
      const [{ max }] = (await db.query(`SELECT COALESCE(MAX(ID_VENDEDOR), 0) AS max FROM VENDEDORES`)).rows;
      const nextId = Number(max) + 1;

      // Monta INSERT dinamicamente com as colunas que existirem
      const insertCols = ['ID_VENDEDOR'];
      const insertVals = [nextId];

      const nomeCol = colsRaw[colsUp.findIndex(c => ['NOME_VENDEDOR','NOME','RAZAO_SOCIAL'].includes(c))] ?? null;
      if (nomeCol && nome) { insertCols.push(nomeCol); insertVals.push(nome.trim()); }

      if (has('ID_LOJA')  && id_loja != null) { insertCols.push(colsRaw[colsUp.indexOf('ID_LOJA')]);  insertVals.push(id_loja); }
      if (has('ATIVO'))                        { insertCols.push(colsRaw[colsUp.indexOf('ATIVO')]);    insertVals.push('S'); }
      if (has('SITUACAO'))                     { insertCols.push(colsRaw[colsUp.indexOf('SITUACAO')]); insertVals.push('A'); }

      const ph = insertVals.map((_, i) => `$${i + 1}`);
      await db.query(
        `INSERT INTO VENDEDORES (${insertCols.join(', ')}) VALUES (${ph.join(', ')})`,
        insertVals
      );
      return nextId;
    });
  } catch {
    return null; // falha silenciosa — não bloqueia criação do usuário
  }
}

/* ── POST /api/:schema/usuarios — criar usuário ── */
router.post('/:schema/usuarios', authJwt, checkSchema, requireRole('gerente', 'dono'), async (req, res) => {
  const { schema } = req.params;
  const callerRole = req.userRoles[schema];
  const { nome, email, senha, role, id_loja, id_vendedor, criarVendedor } = req.body;

  if (!email || !senha || !role)
    return res.status(400).json({ erro: 'email, senha e role são obrigatórios' });

  if (!ROLES_VALIDOS.includes(role))
    return res.status(400).json({ erro: `role inválido. Use: ${ROLES_VALIDOS.join(' | ')}` });

  if (!PODE_CRIAR[callerRole]?.includes(role))
    return res.status(403).json({ erro: `você não pode criar usuário com role '${role}'` });

  if (role !== 'dono' && !id_loja)
    return res.status(400).json({ erro: 'id_loja é obrigatório para gerente e vendedor' });

  // Auto-cria vendedor no tenant se solicitado e nenhum foi vinculado manualmente
  let idVendedorFinal = id_vendedor ?? null;
  if (criarVendedor && !idVendedorFinal && (role === 'vendedor' || role === 'gerente')) {
    idVendedorFinal = await _criarVendedorNoTenant(schema, { nome: nome || null, id_loja: id_loja ?? null });
  }

  const client = await pool.connect();
  try {
    // Verifica se email já existe
    const existe = await client.query('SELECT id FROM public.usuarios WHERE email = $1', [email]);
    if (existe.rows.length > 0) {
      // Usuário já existe — apenas vincular ao schema se ainda não vinculado
      const id = existe.rows[0].id;
      const jaVinculado = await client.query(
        'SELECT 1 FROM public.usuarios_empresas WHERE id_usuario = $1 AND schema_name = $2',
        [id, schema]
      );
      if (jaVinculado.rows.length > 0)
        return res.status(409).json({ erro: 'usuário já vinculado a este schema' });

      await client.query(
        'INSERT INTO public.usuarios_empresas (id_usuario, schema_name, role, id_loja, id_vendedor) VALUES ($1,$2,$3,$4,$5)',
        [id, schema, role, id_loja ?? null, idVendedorFinal]
      );
      return res.status(201).json({ ok: true, id, vinculo: 'existente', id_vendedor: idVendedorFinal });
    }

    // Novo usuário
    const senhaHash = await bcrypt.hash(senha, 12);
    const novo = await client.query(
      'INSERT INTO public.usuarios (nome, email, senha_hash) VALUES ($1,$2,$3) RETURNING id',
      [nome?.trim() || null, email, senhaHash]
    );
    const id = novo.rows[0].id;

    await client.query(
      'INSERT INTO public.usuarios_empresas (id_usuario, schema_name, role, id_loja, id_vendedor) VALUES ($1,$2,$3,$4,$5)',
      [id, schema, role, id_loja ?? null, idVendedorFinal]
    );

    res.status(201).json({ ok: true, id, vinculo: 'novo', id_vendedor: idVendedorFinal });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  } finally {
    client.release();
  }
});

/* ── PATCH /api/:schema/usuarios/:id/ativo ── */
router.patch('/:schema/usuarios/:id/ativo', authJwt, checkSchema, requireRole('gerente', 'dono'), async (req, res) => {
  const { schema, id } = req.params;
  const { ativo } = req.body;

  if (typeof ativo !== 'boolean')
    return res.status(400).json({ erro: 'ativo deve ser true ou false' });

  // Dono pode alternar gerente e vendedor; gerente só pode alternar vendedor
  const PODE_ALTERNAR = { dono: ['gerente', 'vendedor'], gerente: ['vendedor'] };

  try {
    // Busca o role do usuário alvo no schema
    const vinculo = await pool.query(
      'SELECT role FROM public.usuarios_empresas WHERE id_usuario = $1 AND schema_name = $2',
      [id, schema]
    );
    if (!vinculo.rows.length)
      return res.status(404).json({ erro: 'usuário não encontrado neste schema' });

    const callerRole = req.userRoles[schema];
    const targetRole = vinculo.rows[0].role;
    if (!PODE_ALTERNAR[callerRole]?.includes(targetRole))
      return res.status(403).json({ erro: `você não pode alterar o status de um ${targetRole}` });

    await pool.query('UPDATE public.usuarios SET ativo = $1 WHERE id = $2', [ativo, id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

/* ── PATCH /api/:schema/usuarios/:id/perfil — editar nome, email, senha ── */
router.patch('/:schema/usuarios/:id/perfil', authJwt, checkSchema, requireRole('gerente', 'dono'), async (req, res) => {
  const { schema, id } = req.params;
  const callerRole = req.userRoles[schema];
  const { nome, email, senha } = req.body;

  const PODE_EDITAR = { dono: ['gerente', 'vendedor'], gerente: ['vendedor'] };

  if (!email && !nome && !senha)
    return res.status(400).json({ erro: 'Informe ao menos um campo para alterar.' });

  if (email !== undefined && !email)
    return res.status(400).json({ erro: 'E-mail não pode ser vazio.' });

  try {
    // Verifica role do alvo
    const vinculo = await pool.query(
      'SELECT ue.role FROM public.usuarios_empresas ue WHERE ue.id_usuario = $1 AND ue.schema_name = $2',
      [id, schema]
    );
    if (!vinculo.rows.length)
      return res.status(404).json({ erro: 'Usuário não encontrado neste schema.' });

    const targetRole = vinculo.rows[0].role;
    if (!PODE_EDITAR[callerRole]?.includes(targetRole))
      return res.status(403).json({ erro: `Você não pode editar um usuário com papel "${targetRole}".` });

    // Monta SET dinâmico
    const sets = [];
    const vals = [];
    let i = 1;

    if (nome  !== undefined) { sets.push(`nome = $${i++}`);       vals.push(nome.trim() || null); }
    if (email !== undefined) { sets.push(`email = $${i++}`);      vals.push(email.trim()); }
    if (senha)               { sets.push(`senha_hash = $${i++}`); vals.push(await require('bcryptjs').hash(senha, 12)); }

    if (!sets.length) return res.status(400).json({ erro: 'Nenhum dado para salvar.' });

    vals.push(id);
    await pool.query(
      `UPDATE public.usuarios SET ${sets.join(', ')} WHERE id = $${i}`,
      vals
    );
    res.json({ ok: true });
  } catch (e) {
    if (e.constraint === 'usuarios_email_key' || e.code === '23505')
      return res.status(409).json({ erro: 'Este e-mail já está cadastrado.' });
    res.status(500).json({ erro: e.message });
  }
});

/* ── PATCH /api/:schema/usuarios/:id/role ── */
router.patch('/:schema/usuarios/:id/role', authJwt, checkSchema, requireRole('dono'), async (req, res) => {
  const { schema, id } = req.params;
  const { role, id_loja, id_vendedor } = req.body;

  if (!ROLES_VALIDOS.includes(role))
    return res.status(400).json({ erro: `role inválido. Use: ${ROLES_VALIDOS.join(' | ')}` });

  // Dono não pode ser atribuído via API
  if (role === 'dono')
    return res.status(403).json({ erro: 'o role dono só pode ser atribuído via script CLI' });

  if (role !== 'dono' && !id_loja)
    return res.status(400).json({ erro: 'id_loja é obrigatório para gerente e vendedor' });

  try {
    // Impede alterar o role de outro dono
    const alvo = await pool.query(
      'SELECT role FROM public.usuarios_empresas WHERE id_usuario = $1 AND schema_name = $2',
      [id, schema]
    );
    if (!alvo.rows.length)
      return res.status(404).json({ erro: 'usuário não encontrado neste schema' });
    if (alvo.rows[0].role === 'dono')
      return res.status(403).json({ erro: 'não é possível alterar o papel de um dono' });

    const result = await pool.query(
      'UPDATE public.usuarios_empresas SET role = $1, id_loja = $2, id_vendedor = $3 WHERE id_usuario = $4 AND schema_name = $5',
      [role, id_loja ?? null, id_vendedor ?? null, id, schema]
    );
    if (result.rowCount === 0)
      return res.status(404).json({ erro: 'usuário não encontrado neste schema' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

/* ── GET /api/:schema/vendedores-disponiveis ── */
// Retorna [{id_vendedor, nome, id_loja}] da tabela VENDEDORES do tenant.
// Usado pelos modais de criar/editar usuário para popular o select de vínculo.
router.get('/:schema/vendedores-disponiveis', authJwt, checkSchema, requireRole('gerente', 'dono'), async (req, res) => {
  const { schema } = req.params;
  try {
    // 1. Detecta colunas com o nome original (case) que o PostgreSQL armazenou.
    //    Colunas criadas sem aspas ficam em lowercase — não usar aspas duplas no SQL
    //    para evitar "column not found" por mismatch de case.
    const colsRes = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND LOWER(table_name) = 'vendedores'
       ORDER BY ordinal_position`,
      [schema]
    );
    if (!colsRes.rows.length) return res.json([]);

    // Mapeia nome-original → uppercase para buscas case-insensitive
    const colsRaw = colsRes.rows.map(r => r.column_name);
    const colsUp  = colsRaw.map(c => c.toUpperCase());

    const idxOf = (...candidates) => {
      for (const c of candidates) {
        const i = colsUp.findIndex(u => u === c);
        if (i >= 0) return i;
      }
      return -1;
    };

    const pkIdx    = idxOf('ID_VENDEDOR');
    const nomeIdx  = idxOf('NOME_VENDEDOR', 'NOME', 'RAZAO_SOCIAL', 'DESCRICAO');
    const lojaIdx  = idxOf('ID_LOJA');
    const ativoIdx = idxOf('ATIVO', 'SITUACAO');

    const pkCol    = pkIdx    >= 0 ? colsRaw[pkIdx]    : colsRaw[0];
    const nomeCol  = nomeIdx  >= 0 ? colsRaw[nomeIdx]  : pkCol;
    const lojaCol  = lojaIdx  >= 0 ? colsRaw[lojaIdx]  : null;
    const ativoCol = ativoIdx >= 0 ? colsRaw[ativoIdx] : null;

    // 2. Executa dentro do tenant (search_path correto).
    //    Sem aspas duplas: PostgreSQL resolve case-insensitivo para colunas lowercase.
    //    Filtro de ativo aceita 'S' (Sim/Não) e 'A' (Ativo/Inativo).
    const rows = await withTenantConnection(schema, async (db) => {
      let sql = `SELECT ${pkCol} AS id_vendedor, ${nomeCol} AS nome`;
      if (lojaCol)  sql += `, ${lojaCol} AS id_loja`;
      sql += ` FROM VENDEDORES`;
      if (ativoCol) sql += ` WHERE ${ativoCol} IN ('S', 'A')`;
      sql += ` ORDER BY ${nomeCol}`;
      const { rows: r } = await db.query(sql);
      return r;
    });

    res.json(rows.map(r => ({
      id_vendedor: r.id_vendedor,
      nome:        r.nome,
      id_loja:     r.id_loja ?? null,
    })));
  } catch (e) {
    // Tabela pode não existir ainda — retorna vazio sem derrubar o request
    res.json([]);
  }
});

module.exports = router;
