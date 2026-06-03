const _blacklist = new Set();

module.exports = {
  revogar(token)  { _blacklist.add(token); },
  revogado(token) { return _blacklist.has(token); },
};
