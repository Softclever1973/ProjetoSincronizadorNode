const { pool } = require('../db');

/**
 * Insere uma linha no audit_log de forma assíncrona (fire-and-forget).
 * Nunca lança erro — falha silenciosa intencional para não bloquear a resposta.
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
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || null;
  pool.query(
    `INSERT INTO public.audit_log
       (id_usuario, schema_name, tabela, operacao, pk_valor, dados, dados_antes, ip_cliente)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [req.userId, schema, tabela.toUpperCase(), operacao, pkStr, dados, dadosAntes, ip]
  ).catch(() => {});
}

module.exports = { registrarAuditLog };
