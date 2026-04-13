const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const ARQUIVO = path.join(process.cwd(), 'erros.json');
const MAX_ERROS = 200;

// Emite 'novo-erro' para cada erro salvo — consumido pelo SSE em webui.js.
// Não chama setMaxListeners: o cleanup correto via req.on('close') é a garantia real.
const emitter = new EventEmitter();

function lerTodos() {
  if (!fs.existsSync(ARQUIVO)) return [];
  try {
    return JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
  } catch {
    return [];
  }
}

function salvar(lista) {
  // Tmp file único por PID + timestamp — evita colisão se dois ciclos overlapparem
  const tmp = `${ARQUIVO}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(lista, null, 2), 'utf8');
  fs.renameSync(tmp, ARQUIVO);
}

/**
 * Persiste um erro de sincronização e notifica os clientes SSE.
 * @param {object} params
 * @param {string|null} params.tabela    - Nome da tabela envolvida (ou null para erros gerais)
 * @param {string|null} params.operacao  - 'pull' | 'push' | 'ciclo' | 'config'
 * @param {string}      params.mensagem  - Mensagem de erro
 */
function salvarErro({ tabela = null, operacao = null, mensagem = '' }) {
  const erro = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    tabela,
    operacao,
    mensagem: String(mensagem),
    criadoEm: new Date().toISOString(),
  };

  // Emite imediatamente para os clientes SSE (não depende do I/O concluir)
  emitter.emit('novo-erro', erro);

  // Persiste de forma não-bloqueante — não segura o event loop do ciclo de sync
  setImmediate(() => {
    const lista = lerTodos();
    lista.push(erro);
    if (lista.length > MAX_ERROS) {
      lista.splice(0, lista.length - MAX_ERROS);
    }
    salvar(lista);
  });

  return erro.id;
}

function limparErros() {
  salvar([]);
}

module.exports = { salvarErro, lerTodos, limparErros, emitter };
