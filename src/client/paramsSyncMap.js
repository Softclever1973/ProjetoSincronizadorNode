// Mapeia parâmetros do Firebird (PARAMETROS.ID_PARAMETRO) para as chaves
// correspondentes em sync_config no servidor. Fonte única — usado tanto pelo
// ciclo de sincronização (index.js) quanto pela tela local de Parâmetros (webui.js),
// para que as duas partes nunca fiquem dessincronizadas sobre o que é sincronizado.
//
// `global: true` marca parâmetros que devem convergir para o MESMO valor em
// todos os PDVs/filiais de um schema: o servidor não só recebe o valor local
// (push), como também grava de volta no Firebird (pull via setParam) quando
// outro PDV mudou o valor primeiro. Mantenha esta flag em sincronia manual com
// CHAVES_GLOBAIS em src/routes/sincronizacao.js (processos/deploys separados).
const paramsSyncMap = [
  { fbId: 67,    chave: 'utilizar_codigo_interno',     global: true  },
  { fbId: 122,   chave: 'codigo_interno_unico',        global: true  },
  { fbId: 71,    chave: 'venda_saldo_negativo',        global: true  },
  { fbId: 45051, chave: 'modalidade_frete',            global: false },
  { fbId: 91,    chave: 'forma_preenchimento_pedido',  global: true  },
];

module.exports = { paramsSyncMap };
