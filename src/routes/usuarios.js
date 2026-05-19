const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');
const { pool } = require('../db');
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
  const callerRole = req.userRoles[schema];

  try {
    let rows;
    if (callerRole === 'dono') {
      // Dono vê usuários de todos os schemas que possui
      const placeholders = req.userSchemas.map((_, i) => `$${i + 1}`).join(', ');
      const result = await pool.query(
        `SELECT u.id, u.email, u.ativo, ue.schema_name, ue.role, ue.id_loja
         FROM public.usuarios_empresas ue
         JOIN public.usuarios u ON u.id = ue.id_usuario
         WHERE ue.schema_name IN (${placeholders})
         ORDER BY ue.schema_name, u.email`,
        req.userSchemas
      );
      rows = result.rows;
    } else {
      // Gerente vê apenas usuários do seu schema
      const result = await pool.query(
        `SELECT u.id, u.email, u.ativo, ue.schema_name, ue.role, ue.id_loja
         FROM public.usuarios_empresas ue
         JOIN public.usuarios u ON u.id = ue.id_usuario
         WHERE ue.schema_name = $1
         ORDER BY u.email`,
        [schema]
      );
      rows = result.rows;
    }
    res.json(rows);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

/* ── POST /api/:schema/usuarios — criar usuário ── */
router.post('/:schema/usuarios', authJwt, checkSchema, requireRole('gerente', 'dono'), async (req, res) => {
  const { schema } = req.params;
  const callerRole = req.userRoles[schema];
  const { email, senha, role, id_loja } = req.body;

  if (!email || !senha || !role)
    return res.status(400).json({ erro: 'email, senha e role são obrigatórios' });

  if (!ROLES_VALIDOS.includes(role))
    return res.status(400).json({ erro: `role inválido. Use: ${ROLES_VALIDOS.join(' | ')}` });

  if (!PODE_CRIAR[callerRole]?.includes(role))
    return res.status(403).json({ erro: `você não pode criar usuário com role '${role}'` });

  if (role !== 'dono' && !id_loja)
    return res.status(400).json({ erro: 'id_loja é obrigatório para gerente e vendedor' });

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
        'INSERT INTO public.usuarios_empresas (id_usuario, schema_name, role, id_loja) VALUES ($1,$2,$3,$4)',
        [id, schema, role, id_loja ?? null]
      );
      return res.status(201).json({ ok: true, id, vinculo: 'existente' });
    }

    // Novo usuário
    const senhaHash = await bcrypt.hash(senha, 12);
    const novo = await client.query(
      'INSERT INTO public.usuarios (email, senha_hash) VALUES ($1,$2) RETURNING id',
      [email, senhaHash]
    );
    const id = novo.rows[0].id;

    await client.query(
      'INSERT INTO public.usuarios_empresas (id_usuario, schema_name, role, id_loja) VALUES ($1,$2,$3,$4)',
      [id, schema, role, id_loja ?? null]
    );

    res.status(201).json({ ok: true, id, vinculo: 'novo' });
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

  try {
    // Verificar se o usuário existe e está vinculado ao schema
    const vinculo = await pool.query(
      'SELECT 1 FROM public.usuarios_empresas WHERE id_usuario = $1 AND schema_name = $2',
      [id, schema]
    );
    if (!vinculo.rows.length)
      return res.status(404).json({ erro: 'usuário não encontrado neste schema' });

    await pool.query('UPDATE public.usuarios SET ativo = $1 WHERE id = $2', [ativo, id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

/* ── PATCH /api/:schema/usuarios/:id/role ── */
router.patch('/:schema/usuarios/:id/role', authJwt, checkSchema, requireRole('dono'), async (req, res) => {
  const { schema, id } = req.params;
  const { role, id_loja } = req.body;

  if (!ROLES_VALIDOS.includes(role))
    return res.status(400).json({ erro: `role inválido. Use: ${ROLES_VALIDOS.join(' | ')}` });

  // Dono não pode ser atribuído via API
  if (role === 'dono')
    return res.status(403).json({ erro: 'o role dono só pode ser atribuído via script CLI' });

  if (role !== 'dono' && !id_loja)
    return res.status(400).json({ erro: 'id_loja é obrigatório para gerente e vendedor' });

  try {
    const result = await pool.query(
      'UPDATE public.usuarios_empresas SET role = $1, id_loja = $2 WHERE id_usuario = $3 AND schema_name = $4',
      [role, id_loja ?? null, id, schema]
    );
    if (result.rowCount === 0)
      return res.status(404).json({ erro: 'usuário não encontrado neste schema' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

module.exports = router;
