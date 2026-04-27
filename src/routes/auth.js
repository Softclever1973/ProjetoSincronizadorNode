const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcrypt');
const jwt      = require('jsonwebtoken');
const { pool } = require('../db');
const authJwt  = require('../middleware/authJwt');

router.post('/login', async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha)
    return res.status(400).json({ erro: 'email e senha obrigatórios' });

  try {
    const result = await pool.query(
      'SELECT id, senha_hash FROM public.usuarios WHERE email = $1 AND ativo = TRUE',
      [email]
    );
    const usuario = result.rows[0];
    if (!usuario || !(await bcrypt.compare(senha, usuario.senha_hash)))
      return res.status(401).json({ erro: 'credenciais inválidas' });

    const schemas = await pool.query(
      'SELECT schema_name FROM public.usuarios_empresas WHERE id_usuario = $1',
      [usuario.id]
    );
    const schemaList = schemas.rows.map(r => r.schema_name);

    const token = jwt.sign(
      { id: usuario.id, schemas: schemaList },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({ token, schemas: schemaList });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

router.get('/me', authJwt, (req, res) => {
  res.json({ id: req.userId, schemas: req.userSchemas });
});

module.exports = router;
