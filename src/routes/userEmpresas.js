const express  = require('express');
const router   = express.Router();
const { pool } = require('../db');
const { initializeTenantSchema } = require('../db-init');
const authJwt  = require('../middleware/authJwt');

router.get('/', authJwt, async (req, res) => {
  if (req.userSchemas.length === 0) return res.json([]);

  try {
    const placeholders = req.userSchemas.map((_, i) => `$${i + 1}`).join(', ');
    const result = await pool.query(
      `SELECT schema_name, nome, ativo, regime_tributario FROM public.sync_tenants WHERE schema_name IN (${placeholders})`,
      req.userSchemas
    );
    res.json(result.rows);
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
