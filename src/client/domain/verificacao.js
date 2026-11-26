/**
 * Verificação de sincronização (admin): regras puras que client (Firebird) e servidor (Postgres)
 * aplicam do mesmo jeito para comparar um registro. Cada valor vira uma string canônica pelo tipo
 * da coluna no Firebird; o hash da linha é feito sobre essas strings, na ordem das colunas.
 */
const crypto = require('crypto');

// Fuso das lojas: TIME/DATE do Firebird não têm fuso e o push os manda como ISO em UTC.
const FUSO_LOJA = 'America/Sao_Paulo';
// Divergências detalhadas por tabela (o resto só entra na contagem).
const MAX_DETALHES = 200;
// BLOB de texto: compara só o começo (o Firebird lê via CAST para VARCHAR, com limite de tamanho de linha).
const LIMITE_TEXTO_LONGO = 4000;

// Tipos do Firebird (RDB$FIELD_TYPE) → categoria de comparação; BLOB binário fica de fora.
function tipoComparacao(fieldType, subType) {
  switch (Number(fieldType)) {
    case 12: return 'data';
    case 13: return 'hora';
    case 35: return 'datahora';
    case 7: case 8: case 10: case 16: case 27: return 'numero';
    case 23: return 'booleano';
    case 261: return Number(subType) === 1 ? 'textoLongo' : null;
    default: return 'texto';
  }
}

const pad2 = n => String(n).padStart(2, '0');

// Partes de data/hora de um instante no fuso das lojas.
function partesNoFuso(instante) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: FUSO_LOJA, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(instante).map(x => [x.type, x.value]));
  return { data: `${p.year}-${p.month}-${p.day}`, hora: `${p.hour}:${p.minute}:${p.second}` };
}

// Date do node-firebird (horário local da máquina da loja).
function partesLocais(d) {
  return {
    data: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
    hora: `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`,
  };
}

const RE_ISO_COM_FUSO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
const RE_DATA = /^(\d{4}-\d{2}-\d{2})/;
const RE_HORA = /(\d{2}:\d{2}:\d{2})/;

// Texto de data/hora do servidor: ISO com fuso (push) → fuso da loja; sem fuso (site, timestamp) → já é local.
function partesDeTexto(s) {
  if (RE_ISO_COM_FUSO.test(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return partesNoFuso(d);
  }
  const data = s.match(RE_DATA)?.[1] ?? null;
  const resto = data ? s.slice(10) : s;
  return { data, hora: resto.match(RE_HORA)?.[1] ?? null };
}

/** Valor canônico (string ou null) de um valor de qualquer lado, pela categoria da coluna no Firebird. */
function valorCanonico(valor, categoria) {
  if (valor === undefined || valor === null) return null;
  if (typeof valor === 'function') return null; // BLOB não lido (leitura sem CAST): nunca comparar o código da função
  if (categoria === 'textoLongo') {
    const s = (Buffer.isBuffer(valor) ? valor.toString('latin1') : String(valor)).replace(/\x00/g, '').slice(0, LIMITE_TEXTO_LONGO).trimEnd();
    return s === '' ? null : s;
  }
  if (typeof valor === 'string') {
    valor = valor.replace(/\x00/g, '').trimEnd();
    if (valor === '') return null;
  }
  if (categoria === 'data' || categoria === 'hora' || categoria === 'datahora') {
    const p = valor instanceof Date ? partesLocais(valor) : partesDeTexto(String(valor));
    if (categoria === 'data') return p.data;
    if (categoria === 'hora') return p.hora;
    return p.data ? `${p.data} ${p.hora ?? '00:00:00'}` : null;
  }
  if (categoria === 'numero') {
    const n = Number(valor);
    return Number.isFinite(n) ? String(Math.round(n * 1e6) / 1e6) : String(valor);
  }
  if (categoria === 'booleano') {
    if (typeof valor === 'boolean') return valor ? '1' : '0';
    return ['1', 'true', 't', 's', 'S'].includes(String(valor).trim()) ? '1' : '0';
  }
  return String(valor);
}

/** Hash curto da linha a partir dos valores canônicos, na ordem de `colunas`. */
function hashLinha(canonicos) {
  return crypto.createHash('sha1').update(JSON.stringify(canonicos)).digest('hex').slice(0, 16);
}

/** Chave do registro: valores da PK (Firebird) unidos por '|', igual a SYNC_ALTERACOES_PENDENTES. */
function chaveRegistro(registro, pks) {
  const valores = pks.map(p => registro[p]);
  if (valores.some(v => v === null || v === undefined || v === '')) return null;
  // NUMERIC do Postgres vem como '10.00'; texto ('0010') fica como está.
  return valores.map(v => {
    if (typeof v !== 'string') return String(Number.isFinite(Number(v)) ? Number(v) : v);
    const s = v.trimEnd();
    return /^-?\d+\.\d+$/.test(s) ? String(Number(s)) : s;
  }).join('|');
}

/** Compara dois mapas chave→hash. */
function compararHashes(hashServidor, hashFirebird) {
  const iguais = [], diferentes = [], soServidor = [], soFirebird = [];
  for (const [chave, h] of hashServidor) {
    if (!hashFirebird.has(chave)) soServidor.push(chave);
    else if (hashFirebird.get(chave) === h) iguais.push(chave);
    else diferentes.push(chave);
  }
  for (const chave of hashFirebird.keys()) if (!hashServidor.has(chave)) soFirebird.push(chave);
  return { iguais, diferentes, soServidor, soFirebird };
}

/** Campos que diferem entre dois registros canônicos ({ coluna: valor }). */
function camposDiferentes(servidor, firebird, colunas) {
  return colunas
    .filter(c => (servidor?.[c] ?? null) !== (firebird?.[c] ?? null))
    .map(c => ({ coluna: c, servidor: servidor?.[c] ?? null, firebird: firebird?.[c] ?? null }));
}

module.exports = {
  FUSO_LOJA, MAX_DETALHES, LIMITE_TEXTO_LONGO,
  tipoComparacao, valorCanonico, hashLinha, chaveRegistro, compararHashes, camposDiferentes,
};
