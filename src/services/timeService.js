/**
 * Obtém a hora oficial de Brasília via worldtimeapi.org.
 * Cacheia por 1 hora e aplica offset para chamadas intermediárias,
 * evitando uma requisição HTTP a cada INSERT.
 * Fallback: relógio local do servidor se a API estiver indisponível.
 */

const https = require('https');

const REFRESH_MS = 3_600_000; // 1 h

let _apiTime = null; // Date obtida da API no último fetch
let _localMs  = 0;   // Date.now() no momento do fetch

function _fetchApiTime() {
  return new Promise((resolve, reject) => {
    const req = https.get(
      'https://worldtimeapi.org/api/timezone/America/Sao_Paulo',
      { timeout: 5000 },
      res => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            const { datetime } = JSON.parse(body);
            resolve(new Date(datetime));
          } catch {
            reject(new Error('Resposta inesperada da API de tempo'));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout na API de tempo (5 s)'));
    });
  });
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

  try {
    const apiDate = await _fetchApiTime();
    _apiTime = apiDate;
    _localMs  = Date.now();
    console.log(`[timeService] Hora sincronizada via API: ${_apiTime.toISOString()}`);
    return new Date(_apiTime);
  } catch (e) {
    console.warn(`[timeService] Falha ao sincronizar hora (${e.message}); usando relógio local.`);
    return new Date();
  }
}

module.exports = { getCurrentTime };
