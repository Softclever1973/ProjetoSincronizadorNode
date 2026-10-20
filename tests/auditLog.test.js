// Auditoria: IP vem de req.ip (respeita TRUST_PROXY) e falha ao gravar aparece no log.
jest.mock('../src/server/infrastructure/db', () => ({ pool: { query: jest.fn() } }));
const { pool } = require('../src/server/infrastructure/db');
const { registrarAuditLog } = require('../src/server/infrastructure/repositories/auditLogRepository');

const req = { ip: '10.0.0.5', userId: 3, headers: { 'x-forwarded-for': '1.2.3.4' } };

beforeEach(() => pool.query.mockReset());

test('usa req.ip, não o X-Forwarded-For cru (que o cliente pode forjar)', async () => {
  pool.query.mockResolvedValue({});
  registrarAuditLog(req, 'empresa_kr', 'clientes', 'UPDATE', '5', { A: 1 }, null);
  const params = pool.query.mock.calls[0][1];
  expect(params[7]).toBe('10.0.0.5');
  expect(params[2]).toBe('CLIENTES');
});

test('falha ao gravar não lança, mas vai para o console.error', async () => {
  const erro = jest.spyOn(console, 'error').mockImplementation(() => {});
  pool.query.mockRejectedValue(new Error('disco cheio'));
  expect(() => registrarAuditLog(req, 'empresa_kr', 'PEDIDOS', 'DELETE', '9', null, null)).not.toThrow();
  await new Promise(r => setImmediate(r));
  expect(erro).toHaveBeenCalledWith(expect.stringContaining('disco cheio'));
  erro.mockRestore();
});
