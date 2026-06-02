const http = require('http');
const https = require('https');

const TOKEN = process.env.SYNC_TOKEN;

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
 *
 * Se idLoja e filtroFilial estiverem preenchidos, o servidor aplica
 * WHERE <filtroFilial> = idLoja — apenas registros da filial são retornados.
 *
 * Se colunaData estiver preenchida, o servidor aplica adicionalmente
 * WHERE <colunaData> >= NOW() - INTERVAL '2 years' — política de retenção.
 */
function buscarRegistrosParaAtualizar(baseURI, nomeTabela, idUltimaAtualizacaoMatriz, idLoja = null, filtroFilial = null, idPDV = null, colunaData = null, nomeFilial = '', filtroFilialViaFK = null) {
  let url = `${baseURI}/datasnap/rest/TSMSincronizacao/RegistrosParaAtualizar` +
    `?token=${TOKEN}&nomeTabela=${nomeTabela}&idUltimaAtualizacaoMatriz=${idUltimaAtualizacaoMatriz}`;
  if (idLoja != null && filtroFilial) {
    url += `&idLoja=${idLoja}&filtroFilial=${encodeURIComponent(filtroFilial)}`;
  } else if (idLoja != null) {
    url += `&idLoja=${idLoja}`;
  }
  if (idPDV != null)         url += `&idPDV=${idPDV}`;
  if (colunaData)            url += `&colunaData=${encodeURIComponent(colunaData)}`;
  if (nomeFilial)            url += `&nomeFilial=${encodeURIComponent(nomeFilial)}`;
  if (filtroFilialViaFK && idLoja != null)
    url += `&filtroFilialViaFK=${encodeURIComponent(filtroFilialViaFK)}`;
  return get(url);
}

/**
 * Busca registros para deletar de uma tabela.
 * Rota: /datasnap/rest/TSMSincronizacao/RegistrosParaDeletar
 */
function buscarRegistrosParaDeletar(baseURI, nomeTabela, idUltimoRegistroDeletado, nomeFilial = '') {
  let url = `${baseURI}/datasnap/rest/TSMSincronizacao/RegistrosParaDeletar` +
    `?token=${TOKEN}&nomeTabela=${nomeTabela}&idUltimoRegistroDeletado=${idUltimoRegistroDeletado}`;
  if (nomeFilial) url += `&nomeFilial=${encodeURIComponent(nomeFilial)}`;
  return get(url);
}

/**
 * Busca produtos para atualizar (endpoint específico com preço por loja).
 * Rota: /datasnap/rest/TSMProdutos/ProdutosParaAtualizar
 */
function buscarProdutosParaAtualizar(baseURI, idLoja, idUltimaAtualizacaoMatriz, idPDV = null, nomeFilial = '') {
  let url = `${baseURI}/datasnap/rest/TSMProdutos/ProdutosParaAtualizar` +
    `?token=${TOKEN}&idLoja=${idLoja}&idUltimaAtualizacaoMatriz=${idUltimaAtualizacaoMatriz}`;
  if (idPDV != null) url += `&idPDV=${idPDV}`;
  if (nomeFilial)    url += `&nomeFilial=${encodeURIComponent(nomeFilial)}`;
  return get(url);
}

/**
 * Envia um registro local ao servidor para sync bidirecional.
 * Se forcar=true, o servidor aplica sem verificar conflito.
 * Retorna { ok: true } ou { conflito: true, versaoServidor: {...} }
 */
function enviarRegistro(baseURI, idLoja, tabela, pk, registro, ultimaVersaoConhecida, forcar = false, idPDV = null, nomeFilial = '', deletar = false, temSrvId = false) {
  let url = `${baseURI}/datasnap/rest/TSMSincronizacao/ReceberRegistro` +
    `?token=${TOKEN}&idLoja=${idLoja}`;
  if (idPDV != null) url += `&idPDV=${idPDV}`;
  if (nomeFilial)    url += `&nomeFilial=${encodeURIComponent(nomeFilial)}`;
  return post(url, { tabela, pk, registro, ultimaVersaoConhecida, forcar, deletar, temSrvId });
}

/**
 * Envia o regime tributário (param 40026) ao servidor para ser armazenado no tenant.
 */
function atualizarRegime(baseURI, regime) {
  return post(
    `${baseURI}/datasnap/rest/TSMSincronizacao/AtualizarRegime?token=${TOKEN}`,
    { regime }
  );
}

module.exports = {
  buscarRegistrosParaAtualizar,
  buscarRegistrosParaDeletar,
  buscarProdutosParaAtualizar,
  enviarRegistro,
  atualizarRegime,
};
