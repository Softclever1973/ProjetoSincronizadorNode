require('dotenv').config();
const { getConnection, closeConnection, getParam } = require('./db');
const { sincronizarTabela } = require('./sync');
const { empurrarTabela } = require('./push');
const { setup } = require('./setup');
const { iniciarWebUI } = require('./webui');
const TABELAS = require('./tabelas');
const { tabelaAtiva } = require('./tabelasConfig');

// Intervalo entre cada ciclo de sincronização (em milissegundos)
const INTERVALO_MS = 30_000; // 30 segundos
const PORTA_WEBUI  = 3001;

let rodando = false;

// Contexto compartilhado com a WebUI para forçar envio ao resolver conflito
const contextoSync = { baseURI: null, idLoja: null };

function log(msg) {
  const hora = new Date().toLocaleTimeString('pt-BR');
  console.log(`[${hora}] ${msg}`);
}

/**
 * Executa um ciclo completo de sincronização:
 *   1. Pull: puxa atualizações e deleções do servidor → aplica na filial
 *   2. Push: envia alterações locais da filial → servidor
 */
async function executarCiclo() {
  if (rodando) return; // Evita ciclos sobrepostos
  rodando = true;

  const db = await getConnection();
  try {
    const baseURI = (await getParam(db, 60024)).replace(/\/+$/, '');
    const idLoja  = parseInt(await getParam(db, 50003), 10);

    if (!baseURI) {
      log('ERRO: Parâmetro 60024 (URL do servidor) não configurado.');
      return;
    }

    if (!idLoja) {
      log('ERRO: Parâmetro 50003 (número da loja) não configurado.');
      return;
    }

    contextoSync.baseURI = baseURI;
    contextoSync.idLoja  = idLoja;

    log(`Iniciando ciclo — servidor: ${baseURI} | loja: ${idLoja}`);

    // ── PULL (servidor → filial) ──────────────────────────────────────────
    for (const tabela of TABELAS.filter(t => tabelaAtiva(t.nome))) {
      try {
        await sincronizarTabela(db, baseURI, idLoja, tabela, log);
      } catch (e) {
        log(`[${tabela.nome}] Erro inesperado no pull: ${e.message}`);
      }
    }

    // ── PUSH (filial → servidor) ──────────────────────────────────────────
    for (const tabela of TABELAS.filter(t => tabelaAtiva(t.nome))) {
      try {
        await empurrarTabela(db, baseURI, idLoja, tabela, log);
      } catch (e) {
        log(`[${tabela.nome}] Erro inesperado no push: ${e.message}`);
      }
    }

    log('Ciclo concluído.');
  } catch (e) {
    log(`Erro no ciclo de sincronização: ${e.message}`);
  } finally {
    await closeConnection(db);
    rodando = false;
  }
}

// Inicialização
(async () => {
  log(`Cliente de sincronização iniciado. Intervalo: ${INTERVALO_MS / 1000}s`);

  // Cria tabelas e triggers de rastreamento no banco da filial (idempotente)
  const db = await getConnection();
  try {
    await setup(db, log);
  } finally {
    await closeConnection(db);
  }

  // Interface web para resolução de conflitos
  iniciarWebUI(PORTA_WEBUI, contextoSync);

  await executarCiclo();
  setInterval(executarCiclo, INTERVALO_MS);
})();
