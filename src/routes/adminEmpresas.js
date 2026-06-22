const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');
const { pool } = require('../db');
const { initializeTenantSchema } = require('../db-init');

// ── GET /superadmin/empresas ──────────────────────────────────────────────────
// Lista todas as empresas com contagem de usuários vinculados.

router.get('/empresas', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT t.schema_name, t.nome, t.ativo, t.regime_tributario,
             COUNT(ue.id_usuario)::INTEGER AS total_usuarios
      FROM public.sync_tenants t
      LEFT JOIN public.usuarios_empresas ue ON ue.schema_name = t.schema_name
      GROUP BY t.schema_name, t.nome, t.ativo, t.regime_tributario
      ORDER BY t.nome
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ── POST /superadmin/empresas ─────────────────────────────────────────────────
// Cria empresa + conta do dono em uma única transação.

router.post('/empresas', async (req, res) => {
  const { empresa, dono } = req.body;

  if (!empresa?.schema || !empresa?.token || !empresa?.nome || !empresa?.regime_tributario)
    return res.status(400).json({ erro: 'empresa.schema, token, nome e regime_tributario são obrigatórios' });

  if (!dono?.nome || !dono?.email || !dono?.senha)
    return res.status(400).json({ erro: 'dono.nome, email e senha são obrigatórios' });

  if (!/^[a-z_][a-z0-9_]*$/.test(empresa.schema))
    return res.status(400).json({ erro: 'schema inválido: use apenas letras minúsculas, números e underscore' });

  if (dono.senha.length < 6)
    return res.status(400).json({ erro: 'Senha do dono deve ter no mínimo 6 caracteres' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const [tokenCheck, schemaCheck, emailCheck] = await Promise.all([
      client.query('SELECT 1 FROM public.sync_tenants WHERE token = $1',       [empresa.token]),
      client.query('SELECT 1 FROM public.sync_tenants WHERE schema_name = $1', [empresa.schema]),
      client.query('SELECT 1 FROM public.usuarios WHERE email = $1',           [dono.email]),
    ]);

    if (tokenCheck.rows.length  > 0) return res.status(409).json({ erro: 'Token já cadastrado' });
    if (schemaCheck.rows.length > 0) return res.status(409).json({ erro: 'Schema já em uso' });
    if (emailCheck.rows.length  > 0) return res.status(409).json({ erro: 'E-mail já cadastrado' });

    await initializeTenantSchema(empresa.schema);

    await client.query(
      'INSERT INTO public.sync_tenants (token, schema_name, nome, regime_tributario) VALUES ($1, $2, $3, $4)',
      [empresa.token, empresa.schema, empresa.nome, empresa.regime_tributario]
    );

    const senhaHash = await bcrypt.hash(dono.senha, 12);
    const { rows: [novoUsuario] } = await client.query(
      'INSERT INTO public.usuarios (email, nome, senha_hash, ativo) VALUES ($1, $2, $3, TRUE) RETURNING id',
      [dono.email, dono.nome, senhaHash]
    );

    await client.query(
      'INSERT INTO public.usuarios_empresas (id_usuario, schema_name, role) VALUES ($1, $2, $3)',
      [novoUsuario.id, empresa.schema, 'dono']
    );

    await client.query('COMMIT');
    res.status(201).json({ ok: true, schema: empresa.schema, idUsuario: novoUsuario.id });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ erro: e.message });
  } finally {
    client.release();
  }
});

// ── PATCH /superadmin/empresas/:schema/ativo ──────────────────────────────────
// Ativa ou desativa uma empresa.

router.patch('/empresas/:schema/ativo', async (req, res) => {
  const { schema } = req.params;
  const { ativo }  = req.body;

  if (typeof ativo !== 'boolean')
    return res.status(400).json({ erro: 'ativo deve ser true ou false' });

  try {
    const { rowCount } = await pool.query(
      'UPDATE public.sync_tenants SET ativo = $1 WHERE schema_name = $2',
      [ativo, schema]
    );
    if (rowCount === 0) return res.status(404).json({ erro: 'Empresa não encontrada' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ── POST /superadmin/empresas/:schema/reset ───────────────────────────────────
// Destrói todos os dados de um schema (mantém infraestrutura de sync).
// Requer: body.confirmar === schema E body.senhaReset === RESET_SECRET.

const TABELAS_INFRA = new Set([
  'filiais_bloqueadas', 'registros_deletados', 'sync_filiais', 'sync_config', 'srv_id_map',
]);

router.post('/empresas/:schema/reset', async (req, res) => {
  const { schema }     = req.params;
  const { confirmar, senhaReset } = req.body;

  if (!process.env.RESET_SECRET)
    return res.status(503).json({ erro: 'RESET_SECRET não configurado no servidor' });

  if (senhaReset !== process.env.RESET_SECRET)
    return res.status(403).json({ erro: 'Senha de reset inválida' });

  if (confirmar !== schema)
    return res.status(400).json({ erro: 'Confirmação do schema não confere' });

  const client = await pool.connect();
  try {
    const { rows: schemaCheck } = await client.query(
      `SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`, [schema]
    );
    if (schemaCheck.length === 0)
      return res.status(404).json({ erro: `Schema "${schema}" não encontrado` });

    const { rows: todasTabelas } = await client.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename`, [schema]
    );

    const tabelasDados = todasTabelas.map(r => r.tablename).filter(t => !TABELAS_INFRA.has(t));

    for (const tabela of tabelasDados) {
      await client.query(`DROP TABLE IF EXISTS "${schema}"."${tabela}" CASCADE`);
    }

    for (const tabela of TABELAS_INFRA) {
      const { rows: existe } = await client.query(
        `SELECT 1 FROM pg_tables WHERE schemaname = $1 AND tablename = $2`, [schema, tabela]
      );
      if (existe.length > 0)
        await client.query(`TRUNCATE TABLE "${schema}"."${tabela}" CASCADE`);
    }

    await client.query(`ALTER SEQUENCE IF EXISTS "${schema}".seq_atualizacao_matriz RESTART WITH 1`);
    await client.query(`ALTER SEQUENCE IF EXISTS "${schema}".seq_srv_id RESTART WITH 1`);

    const { rows: seqsPortabela } = await client.query(
      `SELECT sequencename FROM pg_sequences
       WHERE schemaname = $1 AND sequencename LIKE 'seq_srv_id_%' AND sequencename <> 'seq_srv_id'`,
      [schema]
    );
    for (const { sequencename } of seqsPortabela) {
      await client.query(`DROP SEQUENCE IF EXISTS "${schema}"."${sequencename}"`);
    }

    res.json({ ok: true, tabelasRemovidas: tabelasDados });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  } finally {
    client.release();
  }
});

// ── GET /superadmin/usuarios ──────────────────────────────────────────────────
// Lista todos os usuários com seus vínculos de empresa.

router.get('/usuarios', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT u.id, u.email, u.nome, u.ativo, u.is_super_admin,
             COALESCE(
               json_agg(
                 json_build_object('schema', ue.schema_name, 'role', ue.role, 'loja', ue.id_loja)
                 ORDER BY ue.schema_name
               ) FILTER (WHERE ue.schema_name IS NOT NULL),
               '[]'::json
             ) AS empresas
      FROM public.usuarios u
      LEFT JOIN public.usuarios_empresas ue ON ue.id_usuario = u.id
      GROUP BY u.id
      ORDER BY u.email
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ── POST /superadmin/usuarios ─────────────────────────────────────────────────
// Cria usuário e opcionalmente vincula a um schema existente.

router.post('/usuarios', async (req, res) => {
  const { nome, email, senha, schema, role, loja } = req.body;

  if (!email || !senha)
    return res.status(400).json({ erro: 'email e senha são obrigatórios' });

  if (senha.length < 6)
    return res.status(400).json({ erro: 'Senha deve ter no mínimo 6 caracteres' });

  const ROLES_VALIDOS = ['dono', 'gerente', 'vendedor'];
  if (schema && role && !ROLES_VALIDOS.includes(role))
    return res.status(400).json({ erro: `Role inválido: ${role}. Use: ${ROLES_VALIDOS.join(' | ')}` });

  if (schema && role && role !== 'dono' && !loja)
    return res.status(400).json({ erro: `id_loja é obrigatório para role "${role}"` });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const emailCheck = await client.query('SELECT 1 FROM public.usuarios WHERE email = $1', [email]);
    if (emailCheck.rows.length > 0) return res.status(409).json({ erro: 'E-mail já cadastrado' });

    if (schema) {
      const schemaCheck = await client.query('SELECT 1 FROM public.sync_tenants WHERE schema_name = $1', [schema]);
      if (schemaCheck.rows.length === 0)
        return res.status(404).json({ erro: `Schema "${schema}" não encontrado` });
    }

    const senhaHash = await bcrypt.hash(senha, 12);
    const { rows: [novoUsuario] } = await client.query(
      'INSERT INTO public.usuarios (email, nome, senha_hash, ativo) VALUES ($1, $2, $3, TRUE) RETURNING id',
      [email, nome || null, senhaHash]
    );

    if (schema && role) {
      await client.query(
        'INSERT INTO public.usuarios_empresas (id_usuario, schema_name, role, id_loja) VALUES ($1, $2, $3, $4)',
        [novoUsuario.id, schema, role, loja || null]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ ok: true, id: novoUsuario.id });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ erro: e.message });
  } finally {
    client.release();
  }
});

module.exports = router;
