function requireRole(...allowed) {
  return (req, res, next) => {
    const role = req.userRoles?.[req.params.schema];
    if (!role || !allowed.includes(role))
      return res.status(403).json({ erro: 'permissão insuficiente' });
    next();
  };
}

module.exports = { requireRole };
