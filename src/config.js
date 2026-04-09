const fs = require('fs');
const path = require('path');

/**
 * Lê o sirius.ini e retorna as configurações de conexão.
 * Formato do arquivo:
 *   Linha 1: servidor/porta:caminho_do_fdb  (ex: localhost/3050:C:\FDBS\MATRIZ.FDB)
 *   Linha 2: versão do Firebird (2 ou 3)
 *   Linha 3: porta HTTP do servidor (ex: 8080)
 */
function lerIni() {
  const caminhoIni = path.join(process.cwd(), 'sirius.ini');

  if (!fs.existsSync(caminhoIni)) {
    throw new Error(`sirius.ini não encontrado em: ${caminhoIni}`);
  }

  const linhas = fs.readFileSync(caminhoIni, 'utf8')
    .split('\n')
    .map(l => l.trim());

  const linha1 = linhas[0] || '';
  const versao = (linhas[1] || '3').trim().charAt(0);
  const portaHttp = parseInt(linhas[2] || '8080', 10);

  let caminhoBanco, caminhoServidor, porta;

  // Detecta se tem porta explícita (/3050, /3051, /3060)
  const temPortaExplicita =
    linha1.includes('/3050') ||
    linha1.includes('/3051') ||
    linha1.includes('/3060');

  if (temPortaExplicita) {
    // Formato: servidor/3050:C:\caminho\banco.fdb
    const posDosPontos = linha1.lastIndexOf(':');
    caminhoBanco = linha1.substring(posDosPontos + 1);
    const prefixo = linha1.substring(0, posDosPontos); // ex: localhost/3050
    const partes = prefixo.split('/');
    caminhoServidor = partes[0];
    porta = parseInt(partes[1], 10);
    // Converte barra invertida para o formato correto do Firebird
    caminhoBanco = caminhoBanco.replace(/\//g, '\\');
  } else {
    // Formato simples: servidor:C:\caminho\banco.fdb
    const posDosPontos = linha1.indexOf(':');
    caminhoServidor = linha1.substring(0, posDosPontos);
    caminhoBanco = linha1.substring(posDosPontos + 1);
    porta = 3050;
  }

  // Senha de acordo com a versão do Firebird
  const senha = versao === '2' ? 'masterkey' : 'Soft1973824650';

  return {
    banco: {
      host: caminhoServidor || 'localhost',
      port: porta || 3050,
      database: caminhoBanco,
      user: 'SYSDBA',
      password: senha,
    },
    portaHttp: isNaN(portaHttp) ? 8080 : portaHttp,
  };
}

module.exports = lerIni();
