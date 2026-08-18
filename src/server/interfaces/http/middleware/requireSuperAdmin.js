function requireSuperAdmin(req, res, next) {
  if (!req.isSuperAdmin)
    return res.status(403).json({ erro: 'Acesso restrito a super-administradores' });
  next();
}

module.exports = requireSuperAdmin;
