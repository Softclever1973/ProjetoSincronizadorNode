const http = require('http');
const https = require('https');

// GET simples que devolve o corpo já parseado como JSON — usado pelas rotas que consultam
// o servidor diretamente (status, auditoria), não pelo fluxo de sync (ver ../../http.js,
// cujo get() sempre normaliza o retorno pra array e trata 401/erro de status).
function getJSON(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const urlObj = new URL(url);

    const opcoes = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
    };

    const req = lib.request(opcoes, (res) => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error('Resposta inválida')); }
      });
    });

    req.setTimeout(15_000, () => req.destroy(new Error('Timeout de 15s ao conectar ao servidor')));
    req.on('error', reject);
    req.end();
  });
}

module.exports = { getJSON };
