const fs = require('fs');
const path = require('path');

const ARQUIVO = path.join(process.cwd(), 'conflitos.json');

function lerTodos() {
  if (!fs.existsSync(ARQUIVO)) return [];
  try {
    return JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
  } catch {
    return [];
  }
}

function salvar(lista) {
  const tmp = ARQUIVO + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(lista, null, 2), 'utf8');
  fs.renameSync(tmp, ARQUIVO);
}

/**
 * Persiste um novo conflito detectado durante o envio ao servidor.
 */
function salvarConflito(conflito) {
  const lista = lerTodos();
  conflito.id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  conflito.resolvido = false;
  conflito.criadoEm = new Date().toISOString();
  lista.push(conflito);
  salvar(lista);
  return conflito.id;
}

/**
 * Atualiza um conflito não resolvido existente para (tabela + pkValor) em vez de duplicar.
 * Se não existir conflito pendente para esse par, cria um novo normalmente.
 * Retorna o id do conflito (novo ou atualizado).
 */
function atualizarOuSalvarConflito(conflito) {
  const lista = lerTodos();
  const idx = lista.findIndex(
    c => !c.resolvido && c.tabela === conflito.tabela && c.pkValor === conflito.pkValor
  );

  if (idx !== -1) {
    // Atualiza o conflito pendente existente preservando id e criadoEm originais
    lista[idx] = {
      ...lista[idx],
      pk: conflito.pk,
      versaoLocal: conflito.versaoLocal,
      versaoServidor: conflito.versaoServidor,
      atualizadoEm: new Date().toISOString(),
    };
    salvar(lista);
    return lista[idx].id;
  }

  // Nenhum conflito pendente existente — cria normalmente
  return salvarConflito(conflito);
}

/**
 * Retorna todos os conflitos ainda não resolvidos.
 */
function listarPendentes() {
  return lerTodos().filter(c => !c.resolvido);
}

/**
 * Marca um conflito como resolvido com a escolha feita.
 * escolha: 'local' | 'servidor' | 'mesclar'
 */
function resolverConflito(id, escolha) {
  const lista = lerTodos();
  const idx = lista.findIndex(c => c.id === id);
  if (idx === -1) throw new Error(`Conflito ${id} não encontrado`);
  lista[idx].resolvido = true;
  lista[idx].escolha = escolha;
  lista[idx].resolvidoEm = new Date().toISOString();
  salvar(lista);
  return lista[idx];
}

/**
 * Persiste múltiplos conflitos de uma vez, otimizando o I/O.
 */
function salvarLoteConflitos(lote) {
  const lista = lerTodos();
  const IDs = [];

  for (const c of lote) {
    c.id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    c.resolvido = false;
    c.criadoEm = new Date().toISOString();
    lista.push(c);
    IDs.push(c.id);
  }

  salvar(lista);
  return IDs;
}

module.exports = { 
  salvarConflito, 
  atualizarOuSalvarConflito, 
  salvarLoteConflitos,
  listarPendentes, 
  resolverConflito, 
  lerTodos 
};
