require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });

const { getConnection, closeConnection, getParam } = require('./db');
const { sincronizarTabela } = require('./sync');
const { empurrarTabela } = require('./push');
const { setup } = require('./setup');
const { iniciarWebUI } = require('./webui');
const TABELAS = require('./tabelas');
const { tabelaAtiva } = require('./tabelasConfig');
const { salvarErro } = require('./erros');
const { limparRegistrosAntigos } = require('./limpeza');

if (!process.env.SYNC_TOKEN) {
  console.error('[ERRO] SYNC_TOKEN não configurado.');
  console.error('       Adicione o token na linha 3 do sirius-client.ini ou em SYNC_TOKEN= no .env');
  process.exit(1);
}

// Intervalo entre cada ciclo de sincronização (em milissegundos)
const INTERVALO_MS = parseInt((process.env.INTERVALO_MS || '30000').replace(/_/g, ''), 10);
const PORTA_WEBUI  = 3001;

let rodando = false;

// Contexto compartilhado com a WebUI para forçar envio ao resolver conflito
const contextoSync = { baseURI: null, idLoja: null, idPDV: null };

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
    const baseURI  = (await getParam(db, 60024)).replace(/\/+$/, '');
    const idLoja   = parseInt(await getParam(db, 50003), 10);
    const idPDVRaw = await getParam(db, 50004);
    const idPDV    = idPDVRaw ? parseInt(idPDVRaw, 10) : null;

    if (!baseURI) {
      const msg = 'Parâmetro 60024 (URL do servidor) não configurado.';
      log('ERRO: ' + msg);
      salvarErro({ operacao: 'config', mensagem: msg });
      return;
    }

    if (!idLoja) {
      const msg = 'Parâmetro 50003 (número da loja) não configurado.';
      log('ERRO: ' + msg);
      salvarErro({ operacao: 'config', mensagem: msg });
      return;
    }

    contextoSync.baseURI = baseURI;
    contextoSync.idLoja  = idLoja;
    contextoSync.idPDV   = idPDV;

    log(`Iniciando ciclo — servidor: ${baseURI} | loja: ${idLoja}${idPDV ? ` | PDV: ${idPDV}` : ''}`);

    // ── PULL (servidor → filial) ──────────────────────────────────────────
    for (const tabela of TABELAS.filter(t => tabelaAtiva(t.nome))) {
      try {
        await sincronizarTabela(db, baseURI, idLoja, tabela, log, idPDV);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`[${tabela.nome}] Erro inesperado no pull: ${msg}`);
        salvarErro({ tabela: tabela.nome, operacao: 'pull', mensagem: msg });
      }
    }

    // ── PUSH (filial → servidor) ──────────────────────────────────────────
    for (const tabela of TABELAS.filter(t => tabelaAtiva(t.nome))) {
      try {
        await empurrarTabela(db, baseURI, idLoja, tabela, log, idPDV);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`[${tabela.nome}] Erro inesperado no push: ${msg}`);
        salvarErro({ tabela: tabela.nome, operacao: 'push', mensagem: msg });
      }
    }

    log('Ciclo concluído.');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`Erro no ciclo de sincronização: ${msg}`);
    salvarErro({ operacao: 'ciclo', mensagem: msg });
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

  // Limpeza diária de registros com mais de 2 anos (primeira execução após 24h)
  const VINTE_QUATRO_HORAS_MS = 24 * 60 * 60 * 1000;
  setInterval(() => limparRegistrosAntigos(log), VINTE_QUATRO_HORAS_MS);
})().catch(e => {
  console.error(`[ERRO FATAL] ${e.message}`);
  process.exit(1);
});
