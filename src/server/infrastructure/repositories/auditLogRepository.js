const { pool } = require('#server/infrastructure/db.js');

/**
 * Insere uma linha no audit_log de forma assíncrona (fire-and-forget).
 * Nunca lança erro (não bloqueia a resposta), mas loga a falha para não sumir sem rastro.
 *
 * @param {import('express').Request} req
 * @param {string} schema
 * @param {string} tabela
 * @param {'INSERT'|'UPDATE'|'DELETE'} operacao
 * @param {string} pkStr       — valor(es) da PK concatenados com '|'
 * @param {object|null} dados  — payload enviado (null para DELETE)
 * @param {object|null} dadosAntes — snapshot antes da operação (null para INSERT)
 */
function registrarAuditLog(req, schema, tabela, operacao, pkStr, dados, dadosAntes) {
  // req.ip já usa o X-Forwarded-For quando TRUST_PROXY está ligado; ler o header cru deixava forjar o IP.
  const ip = req.ip || null;
  pool.query(
    `INSERT INTO public.audit_log
       (id_usuario, schema_name, tabela, operacao, pk_valor, dados, dados_antes, ip_cliente)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [req.userId, schema, tabela.toUpperCase(), operacao, pkStr, dados, dadosAntes, ip]
  ).catch(e => console.error(`[AUDITORIA] falha ao gravar ${operacao} em ${schema}.${tabela} (${pkStr}): ${e.message}`));
}

module.exports = { registrarAuditLog };
