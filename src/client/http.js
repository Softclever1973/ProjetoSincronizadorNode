const http = require('http');
const https = require('https');

const TOKEN = '773a5d8b-d762-4ebd-b632-d1577d78c1f2';

/**
 * Faz um POST JSON para a URL informada e retorna o corpo parseado.
 */
function post(url, corpo) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const dados = JSON.stringify(corpo);
    const urlObj = new URL(url);

    const opcoes = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(dados),
      },
    };

    const req = lib.request(opcoes, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        if (res.statusCode === 401) return reject(new Error('Filial bloqueada (401)'));
        if (res.statusCode !== 200) return reject(new Error(`Servidor retornou ${res.statusCode}: ${data}`));
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Resposta inválida do servidor: ${data}`));
        }
      });
    });

    req.setTimeout(15_000, () => req.destroy(new Error('Timeout de 15s ao conectar ao servidor')));
    req.on('error', reject);
    req.write(dados);
    req.end();
  });
}

/**
 * Faz um GET para a URL informada e retorna o corpo como array de objetos.
 * Equivalente ao TServicosRest.Get() do Delphi.
 */
function get(url) {
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
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        if (res.statusCode === 401) {
          return reject(new Error('Filial bloqueada (401)'));
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Servidor retornou ${res.statusCode}: ${data}`));
        }
        try {
          const parsed = JSON.parse(data);
          // Normaliza: sempre retorna array
          resolve(Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []));
        } catch {
          reject(new Error(`Resposta inválida do servidor: ${data}`));
        }
      });
    });

    req.setTimeout(15_000, () => req.destroy(new Error('Timeout de 15s ao conectar ao servidor')));
    req.on('error', reject);
    req.end();
  });
}

/**
 * Busca registros para atualizar de uma tabela genérica.
 * Rota: /datasnap/rest/TSMSincronizacao/RegistrosParaAtualizar
 */
function buscarRegistrosParaAtualizar(baseURI, nomeTabela, idUltimaAtualizacaoMatriz) {
  const url = `${baseURI}/datasnap/rest/TSMSincronizacao/RegistrosParaAtualizar` +
    `?token=${TOKEN}&nomeTabela=${nomeTabela}&idUltimaAtualizacaoMatriz=${idUltimaAtualizacaoMatriz}`;
  return get(url);
}

/**
 * Busca registros para deletar de uma tabela.
 * Rota: /datasnap/rest/TSMSincronizacao/RegistrosParaDeletar
 */
function buscarRegistrosParaDeletar(baseURI, nomeTabela, idUltimoRegistroDeletado) {
  const url = `${baseURI}/datasnap/rest/TSMSincronizacao/RegistrosParaDeletar` +
    `?token=${TOKEN}&nomeTabela=${nomeTabela}&idUltimoRegistroDeletado=${idUltimoRegistroDeletado}`;
  return get(url);
}

/**
 * Busca produtos para atualizar (endpoint específico com preço por loja).
 * Rota: /datasnap/rest/TSMProdutos/ProdutosParaAtualizar
 */
function buscarProdutosParaAtualizar(baseURI, idLoja, idUltimaAtualizacaoMatriz) {
  const url = `${baseURI}/datasnap/rest/TSMProdutos/ProdutosParaAtualizar` +
    `?token=${TOKEN}&idLoja=${idLoja}&idUltimaAtualizacaoMatriz=${idUltimaAtualizacaoMatriz}`;
  return get(url);
}

/**
 * Envia um registro local ao servidor para sync bidirecional.
 * Se forcar=true, o servidor aplica sem verificar conflito.
 * Retorna { ok: true } ou { conflito: true, versaoServidor: {...} }
 */
function enviarRegistro(baseURI, idLoja, tabela, pk, registro, ultimaVersaoConhecida, forcar = false) {
  const url = `${baseURI}/datasnap/rest/TSMSincronizacao/ReceberRegistro` +
    `?token=${TOKEN}&idLoja=${idLoja}`;
  return post(url, { tabela, pk, registro, ultimaVersaoConhecida, forcar });
}

module.exports = {
  buscarRegistrosParaAtualizar,
  buscarRegistrosParaDeletar,
  buscarProdutosParaAtualizar,
  enviarRegistro,
};
