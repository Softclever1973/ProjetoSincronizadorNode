// Cor do log do client no console: nível tirado do texto da mensagem.
const { nivelDoLog, colorir } = require('../src/client/domain/corLog');

test.each([
  ['[PRODUTOS] Erro no push: conexão recusada', 'vermelho'],
  ['ERRO: Parâmetro 60024 (URL do servidor) não configurado.', 'vermelho'],
  ['Firebird indisponível no ciclo: timeout — aguardando próximo intervalo', 'vermelho'],
  ['[Verificação] MOVIMENTACOES 7: correção falhou — Registro não existe mais no Firebird', 'vermelho'],
  // Erro que se resolve sozinho no próximo ciclo: atenção.
  ['[PRODUTOS] ERRO ao gravar SRV_ID local (1798): Deadlock, Update conflicts with concurrent update - re-enfileirando para retry', 'amarelo'],
  ['[CLIENTES] Aviso: colunas texto no Firebird e numéricas no servidor: CEP', 'amarelo'],
  ['[MOVIMENTACOES] WARN FK ID_PRODUTO: ID_PRODUTO=5 sem SRV_ID — enfileirando PRODUTOS para sync', 'amarelo'],
  ['[PEDIDOS] Conflito detectado (12) — resolva em http://localhost:3001', 'amarelo'],
  ['Sincronização pausada pelo operador — retome em http://localhost:3001/status', 'amarelo'],
  ['Ciclo concluído.', 'verde'],
  ['[PRODUTOS] SRV_ID=154 gravado localmente (1798)', 'verde'],
  ['[PRODUTOS] recebendo 50 registro(s) do servidor', null],
  ['Iniciando ciclo — servidor: http://srv | loja: 1', null],
])('%s → %s', (msg, nivel) => {
  expect(nivelDoLog(msg)).toBe(nivel);
});

test('colorir só põe código de cor quando ativo e com nível', () => {
  expect(colorir('[10:00] Ciclo concluído.', 'Ciclo concluído.', true)).toBe('\x1b[32m[10:00] Ciclo concluído.\x1b[0m');
  expect(colorir('[10:00] Ciclo concluído.', 'Ciclo concluído.', false)).toBe('[10:00] Ciclo concluído.');
  expect(colorir('[10:00] recebendo 5', 'recebendo 5', true)).toBe('[10:00] recebendo 5');
});
