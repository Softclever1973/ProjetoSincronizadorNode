const express  = require('express');
const router   = express.Router();
const { pool } = require('../server/infrastructure/db');
const { initializeTenantSchema } = require('../server/infrastructure/db-init');
const authJwt  = require('../server/interfaces/http/middleware/authJwt');
const { featuresDoPlano } = require('../planos');

// O vínculo do dono com um VENDEDORES "DONO" acontece em routes/auth.js (login/refresh),
// não aqui — a tabela VENDEDORES do schema recém-criado só existe depois do primeiro
// sync do Firebird, que nunca já aconteceu no momento em que uma empresa é criada.

router.get('/', authJwt, async (req, res) => {
  if (req.userSchemas.length === 0) return res.json([]);

  try {
    const placeholders = req.userSchemas.map((_, i) => `$${i + 1}`).join(', ');
    const result = await pool.query(
      `SELECT schema_name, nome, ativo, regime_tributario, plano FROM public.sync_tenants WHERE schema_name IN (${placeholders})`,
      req.userSchemas
    );
    res.json(result.rows.map(r => ({ ...r, features: featuresDoPlano(r.plano) })));
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

router.post('/', authJwt, async (req, res) => {
  const { schema, token, nome } = req.body;
  if (!schema || !token)
    return res.status(400).json({ erro: 'schema e token são obrigatórios' });

  if (!/^[a-z_][a-z0-9_]*$/.test(schema))
    return res.status(400).json({ erro: 'schema inválido: use apenas letras minúsculas, números e underscore' });

  const client = await pool.connect();
  try {
    const tokenExiste = await client.query(
      'SELECT 1 FROM public.sync_tenants WHERE token = $1', [token]
    );
    if (tokenExiste.rows.length > 0)
      return res.status(409).json({ erro: 'token já cadastrado' });

    const schemaExiste = await client.query(
      'SELECT 1 FROM public.sync_tenants WHERE schema_name = $1', [schema]
    );
    if (schemaExiste.rows.length > 0)
      return res.status(409).json({ erro: 'schema já em uso' });

    await initializeTenantSchema(schema);

    await client.query(
      'INSERT INTO public.sync_tenants (token, schema_name, nome) VALUES ($1, $2, $3)',
      [token, schema, nome ?? schema]
    );

    await client.query(
      'INSERT INTO public.usuarios_empresas (id_usuario, schema_name, role) VALUES ($1, $2, $3)',
      [req.userId, schema, 'dono']
    );

    res.status(201).json({ ok: true, schema });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  } finally {
    client.release();
  }
});

module.exports = router;
