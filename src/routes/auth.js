const express        = require('express');
const router         = express.Router();
const bcrypt         = require('bcryptjs');
const jwt            = require('jsonwebtoken');
const { pool }       = require('../db');
const authJwt        = require('../middleware/authJwt');
const tokenBlacklist = require('../tokenBlacklist');

router.post('/login', async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha)
    return res.status(400).json({ erro: 'email e senha obrigatórios' });

  try {
    const result = await pool.query(
      'SELECT id, email, nome, senha_hash FROM public.usuarios WHERE email = $1 AND ativo = TRUE',
      [email]
    );
    const usuario = result.rows[0];
    if (!usuario || !(await bcrypt.compare(senha, usuario.senha_hash)))
      return res.status(401).json({ erro: 'credenciais inválidas' });

    const schemas = await pool.query(
      'SELECT schema_name, role, id_loja, id_vendedor FROM public.usuarios_empresas WHERE id_usuario = $1',
      [usuario.id]
    );
    const schemaList  = schemas.rows.map(r => r.schema_name);
    const roles       = Object.fromEntries(schemas.rows.map(r => [r.schema_name, r.role]));
    const lojas       = Object.fromEntries(schemas.rows.map(r => [r.schema_name, r.id_loja      ?? null]));
    const vendedores  = Object.fromEntries(schemas.rows.map(r => [r.schema_name, r.id_vendedor  ?? null]));

    const nomeParaJwt = usuario.nome || usuario.email;
    const token = jwt.sign(
      { id: usuario.id, nome: nomeParaJwt, schemas: schemaList, roles, lojas, vendedores },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    const nomeUsuario = nomeParaJwt;
    res.json({ id: usuario.id, token, schemas: schemaList, roles, lojas, vendedores, nome: nomeUsuario });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

router.post('/logout', authJwt, (req, res) => {
  const token = req.headers.authorization.slice(7);
  tokenBlacklist.revogar(token);
  res.json({ ok: true });
});

router.get('/me', authJwt, (req, res) => {
  res.json({ id: req.userId, schemas: req.userSchemas, roles: req.userRoles, lojas: req.userLojas });
});

module.exports = router;
