function requireRole(...allowed) {
  return (req, res, next) => {
    const role = req.userRoles?.[req.params.schema];
    if (!role || !allowed.includes(role))
      return res.status(403).json({ erro: 'permissão insuficiente' });
    next();
  };
}

// Como requireRole, mas libera vendedor quando req.params.tabela está no Set tabelasVendedor.
function requireRoleOuVendedorEm(tabelasVendedor) {
  return (req, res, next) => {
    const role = req.userRoles?.[req.params.schema];
    const tabela = (req.params.tabela || '').toUpperCase();
    const permitido = role === 'dono' || role === 'gerente' ||
      (role === 'vendedor' && tabelasVendedor.has(tabela));
    if (!permitido) return res.status(403).json({ erro: 'permissão insuficiente' });
    next();
  };
}

module.exports = { requireRole, requireRoleOuVendedorEm };
