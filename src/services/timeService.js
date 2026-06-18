/**
 * Obtém a hora oficial de Brasília via worldtimeapi.org.
 * Cacheia por 1 hora e aplica offset para chamadas intermediárias,
 * evitando uma requisição HTTP a cada INSERT.
 * Fallback: relógio local do servidor se a API estiver indisponível.
 */

const https = require('https');

const REFRESH_MS    = 3_600_000; // 1 h
const MAX_RETRIES   = 3;
const RETRY_BASE_MS = 1_000;     // delay entre tentativas: 1 s, 2 s, 3 s

// APIs em ordem de preferência — a segunda é tentada apenas se a primeira falhar todas as retries
const APIS = [
  {
    url:   'https://worldtimeapi.org/api/timezone/America/Sao_Paulo',
    parse: body => new Date(JSON.parse(body).datetime),
  },
  {
    url:   'https://timeapi.io/api/time/current/zone?timeZone=America/Sao_Paulo',
    parse: body => new Date(JSON.parse(body).dateTime),
  },
];

let _apiTime      = null; // Date obtida da API no último fetch bem-sucedido
let _localMs      = 0;    // Date.now() no momento do fetch
let _fetchPromise = null; // impede múltiplas requisições concorrentes

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function _fetchOnce({ url, parse }) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 5000 }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(parse(body));
        } catch {
          reject(new Error('Resposta inesperada da API de tempo'));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout na API de tempo (5 s)'));
    });
  });
}

async function _fetchApiTime() {
  for (const api of APIS) {
    let lastErr;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await _fetchOnce(api);
      } catch (e) {
        lastErr = e;
        if (attempt < MAX_RETRIES) await _sleep(RETRY_BASE_MS * attempt);
      }
    }
    // Todas as retries desta API falharam — tenta a próxima
    console.warn(`[timeService] API ${new URL(api.url).hostname} indisponível (${lastErr.message}); tentando próxima fonte…`);
  }
  throw new Error('Todas as fontes de tempo falharam');
}

/**
 * Retorna a hora atual em Brasília.
 * Na primeira chamada (ou após REFRESH_MS) consulta a API externa.
 * Nas demais aplica o offset acumulado desde o último fetch.
 *
 * @returns {Promise<Date>}
 */
async function getCurrentTime() {
  const now = Date.now();
  if (_apiTime && now - _localMs < REFRESH_MS) {
    return new Date(_apiTime.getTime() + (now - _localMs));
  }

  // Colapsa chamadas concorrentes: todas aguardam a mesma promise em voo.
  if (!_fetchPromise) {
    _fetchPromise = _fetchApiTime()
      .then(apiDate => {
        _apiTime = apiDate;
        _localMs  = Date.now();
        console.log(`[timeService] Hora sincronizada via API: ${_apiTime.toISOString()}`);
      })
      .catch(e => {
        // Mantém cache antigo se houver — é melhor que o relógio local.
        console.warn(`[timeService] Falha ao sincronizar hora (${e.message}); usando ${_apiTime ? 'cache anterior' : 'relógio local'}.`);
      })
      .finally(() => { _fetchPromise = null; });
  }

  await _fetchPromise;

  if (_apiTime) {
    return new Date(_apiTime.getTime() + (Date.now() - _localMs));
  }
  return new Date();
}

module.exports = { getCurrentTime };
