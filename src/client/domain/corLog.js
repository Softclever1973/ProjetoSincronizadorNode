// Cor da linha de log do client no console, pelo texto: vermelho = erro, amarelo = atenção, verde = sucesso.
const CORES = { vermelho: '\x1b[31m', amarelo: '\x1b[33m', verde: '\x1b[32m' };
const RESET = '\x1b[0m';

// Erro que o próprio client resolve no próximo ciclo: atenção, não erro grave.
const RECUPERAVEL = /re-?enfileir|\bretry\b/i;
const ERRO = /\berro\b|\bfalh(a|ou|aram)\b|indisponível|uncaught|bloquead/i;
const ATENCAO = /\bwarn\b|\baviso\b|conflito|colisão|pausad|ignorad/i;
const SUCESSO = /ciclo concluído|atualizado com sucesso|gravado localmente|cliente iniciado/i;

/** 'vermelho' | 'amarelo' | 'verde' | null (sem cor). */
function nivelDoLog(msg) {
  const s = String(msg);
  if (ERRO.test(s)) return RECUPERAVEL.test(s) ? 'amarelo' : 'vermelho';
  if (ATENCAO.test(s) || RECUPERAVEL.test(s)) return 'amarelo';
  if (SUCESSO.test(s)) return 'verde';
  return null;
}

function colorir(linha, msg, ativo) {
  const nivel = ativo ? nivelDoLog(msg) : null;
  return nivel ? `${CORES[nivel]}${linha}${RESET}` : linha;
}

module.exports = { nivelDoLog, colorir };
