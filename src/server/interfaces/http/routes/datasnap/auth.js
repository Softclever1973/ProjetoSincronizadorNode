const express        = require('express');
const router         = express.Router();
const bcrypt         = require('bcryptjs');
const jwt            = require('jsonwebtoken');
const { pool }              = require('../../../../infrastructure/db');
const { vincularVendedorDono } = require('../../../../application/onboarding/vincularVendedorDono');
const authJwt        = require('../../middleware/authJwt');
const tokenBlacklist = require('../../../../infrastructure/cache/tokenBlacklist');

const JWT_EXPIRES_IN = '24h';

/**
 * Lê os vínculos do usuário com empresas e monta os claims schemas/roles/lojas/vendedores.
 * Para schemas em que o usuário é dono e ainda não tem vendedor vinculado, tenta vincular
 * a um VENDEDORES "DONO" agora — no momento da criação da empresa isso ainda não é possível
 * (VENDEDORES só existe depois do primeiro sync do Firebird), então login/refresh é o ponto
 * em que, mais cedo ou mais tarde, a tabela já vai existir e o vínculo é feito automaticamente.
 */
async function montarClaims(idUsuario) {
  const { rows } = await pool.query(
    `SELECT ue.schema_name, ue.role, ue.id_loja, ue.id_vendedor, st.plano
     FROM public.usuarios_empresas ue
     JOIN public.sync_tenants st ON st.schema_name = ue.schema_name
     WHERE ue.id_usuario = $1`,
    [idUsuario]
  );

  const vendedores = Object.fromEntries(rows.map(r => [r.schema_name, r.id_vendedor ?? null]));
  for (const r of rows) {
    if (r.role === 'dono' && vendedores[r.schema_name] == null) {
      const novoId = await vincularVendedorDono(r.schema_name, idUsuario);
      if (novoId != null) vendedores[r.schema_name] = novoId;
    }
  }

  return {
    schemas:    rows.map(r => r.schema_name),
    roles:      Object.fromEntries(rows.map(r => [r.schema_name, r.role])),
    lojas:      Object.fromEntries(rows.map(r => [r.schema_name, r.id_loja ?? null])),
    vendedores,
    planos:     Object.fromEntries(rows.map(r => [r.schema_name, r.plano])),
  };
}

/** Assina um JWT novo para o usuário com os claims fornecidos (schemas/roles/lojas/vendedores). */
function assinarToken(usuario, claims) {
  const nome         = usuario.nome || usuario.email;
  const isSuperAdmin = usuario.is_super_admin === true;
  const token = jwt.sign(
    { id: usuario.id, nome, isSuperAdmin, ...claims },
    process.env.JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
  return { token, nome, isSuperAdmin };
}

router.post('/login', async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha)
    return res.status(400).json({ erro: 'email e senha obrigatórios' });

  try {
    const result = await pool.query(
      'SELECT id, email, nome, senha_hash, is_super_admin FROM public.usuarios WHERE email = $1 AND ativo = TRUE',
      [email]
    );
    const usuario = result.rows[0];
    if (!usuario || !(await bcrypt.compare(senha, usuario.senha_hash)))
      return res.status(401).json({ erro: 'credenciais inválidas' });

    const claims = await montarClaims(usuario.id);
    const { token, nome, isSuperAdmin } = assinarToken(usuario, claims);

    res.json({ id: usuario.id, email: usuario.email, token, ...claims, nome, isSuperAdmin });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

/**
 * Reemite um JWT com os claims atuais do banco (role/loja/vendedor/schemas), sem pedir senha.
 * O frontend chama isso uma vez por aba para "atualizar" uma sessão antiga — sem isso, um
 * token de dias atrás continua valendo com role/loja/schemas do momento do login original
 * até um logout manual, mesmo que o cadastro do usuário tenha mudado nesse meio-tempo.
 */
router.post('/refresh', authJwt, async (req, res) => {
  try {
    const { rows: [usuario] } = await pool.query(
      'SELECT id, email, nome, is_super_admin, ativo FROM public.usuarios WHERE id = $1',
      [req.userId]
    );
    if (!usuario || !usuario.ativo)
      return res.status(401).json({ erro: 'usuário inativo' });

    const claims = await montarClaims(usuario.id);
    const { token, nome, isSuperAdmin } = assinarToken(usuario, claims);

    res.json({ id: usuario.id, email: usuario.email, token, ...claims, nome, isSuperAdmin });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

router.post('/logout', authJwt, (req, res) => {
  const token = req.headers.authorization.slice(7);
  tokenBlacklist.revogar(token);
  res.json({ ok: true });
});

router.get('/me', authJwt, async (req, res) => {
  try {
    const { rows: [u] } = await pool.query(
      'SELECT nome, is_super_admin FROM public.usuarios WHERE id = $1', [req.userId]
    );
    res.json({
      id:          req.userId,
      nome:        u?.nome || null,
      schemas:     req.userSchemas,
      roles:       req.userRoles,
      lojas:       req.userLojas,
      isSuperAdmin: u?.is_super_admin === true,
    });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

module.exports = router;
