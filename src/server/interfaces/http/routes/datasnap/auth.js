const express        = require('express');
const router         = express.Router();
const crypto         = require('crypto');
const bcrypt         = require('bcryptjs');
const jwt            = require('jsonwebtoken');
const { pool }              = require('#server/infrastructure/db.js');
const { vincularVendedorDono } = require('#server/application/onboarding/vincularVendedorDono.js');
const authJwt        = require('#server/interfaces/http/middleware/authJwt.js');
const tokenBlacklist = require('#server/infrastructure/cache/tokenBlacklist.js');
const { enviarEmail } = require('#server/infrastructure/email/emailApiClient.js');

const JWT_EXPIRES_IN = '24h';
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1h
const RESET_THROTTLE_MS  = 60 * 1000;      // evita reenvio em disparada pelo mesmo e-mail

// Em memória, por processo — mesma limitação de tokenBlacklist.js (não sobrevive a
// restart nem é compartilhado entre instâncias; suficiente para um único processo).
const _ultimoPedidoReset = new Map(); // email → timestamp do último pedido aceito

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
 * Pede o envio de um e-mail de recuperação de senha. Responde sempre com sucesso
 * genérico — nunca revela se o e-mail existe ou não na base (evita enumeração de contas).
 */
router.post('/esqueci-senha', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ erro: 'email obrigatório' });

  const RESPOSTA_GENERICA = { ok: true, message: 'Se o e-mail existir, enviaremos um link de redefinição.' };

  const ultimoPedido = _ultimoPedidoReset.get(email);
  if (ultimoPedido && Date.now() - ultimoPedido < RESET_THROTTLE_MS) {
    return res.json(RESPOSTA_GENERICA);
  }

  try {
    const { rows: [usuario] } = await pool.query(
      'SELECT id, email, nome FROM public.usuarios WHERE email = $1 AND ativo = TRUE',
      [email]
    );

    if (usuario) {
      const token     = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const expira    = new Date(Date.now() + RESET_TOKEN_TTL_MS);

      await pool.query(
        'UPDATE public.usuarios SET reset_token_hash = $1, reset_token_expira = $2 WHERE id = $3',
        [tokenHash, expira, usuario.id]
      );

      const link = `${process.env.FRONTEND_URL}/redefinir-senha.html?token=${token}`;
      await enviarEmail({
        to: usuario.email,
        subject: 'Redefinição de senha — Sirius Web',
        html: `<p>Olá${usuario.nome ? ', ' + usuario.nome : ''}!</p>
               <p>Recebemos um pedido para redefinir sua senha. Clique no link abaixo (válido por 1 hora):</p>
               <p><a href="${link}">${link}</a></p>
               <p>Se você não pediu isso, ignore este e-mail.</p>`,
        text: `Redefinição de senha. Acesse: ${link} (válido por 1 hora). Se você não pediu isso, ignore este e-mail.`,
      });

      _ultimoPedidoReset.set(email, Date.now());
    }

    res.json(RESPOSTA_GENERICA);
  } catch (e) {
    // Falha no envio (Email API fora do ar, etc.) não deve vazar se o e-mail existe —
    // loga no servidor e responde com a mesma mensagem genérica.
    console.error('Erro ao processar /auth/esqueci-senha:', e.message);
    res.json(RESPOSTA_GENERICA);
  }
});

/** Confirma a redefinição de senha a partir do token recebido por e-mail. */
router.post('/redefinir-senha', async (req, res) => {
  const { token, novaSenha } = req.body;
  if (!token || !novaSenha)
    return res.status(400).json({ erro: 'token e novaSenha obrigatórios' });
  if (novaSenha.length < 6)
    return res.status(400).json({ erro: 'Senha deve ter no mínimo 6 caracteres' });

  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const { rows: [usuario] } = await pool.query(
      `SELECT id FROM public.usuarios
       WHERE reset_token_hash = $1 AND reset_token_expira > NOW() AND ativo = TRUE`,
      [tokenHash]
    );
    if (!usuario)
      return res.status(400).json({ erro: 'Link inválido ou expirado. Solicite uma nova redefinição.' });

    const senhaHash = await bcrypt.hash(novaSenha, 12);
    await pool.query(
      'UPDATE public.usuarios SET senha_hash = $1, reset_token_hash = NULL, reset_token_expira = NULL WHERE id = $2',
      [senhaHash, usuario.id]
    );

    res.json({ ok: true });
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
