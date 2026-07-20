// Mapeia parâmetros do Firebird (PARAMETROS.ID_PARAMETRO) pras chaves de sync_config
// no servidor — fonte única usada tanto pelo ciclo de sync (index.js) quanto pela tela
// de Parâmetros (webui.js).
// `global: true` marca parâmetros que devem convergir pro mesmo valor em todos os PDVs:
// o servidor grava de volta no Firebird (setParam) quando outro PDV mudou primeiro.
// Mantenha em sincronia manual com CHAVES_GLOBAIS em src/routes/sincronizacao.js.
const paramsSyncMap = [
  { fbId: 67,    chave: 'utilizar_codigo_interno',     global: true  },
  { fbId: 122,   chave: 'codigo_interno_unico',        global: true  },
  { fbId: 71,    chave: 'venda_saldo_negativo',        global: true  },
  { fbId: 45051, chave: 'modalidade_frete',            global: false },
  { fbId: 91,    chave: 'forma_preenchimento_pedido',  global: true  },
];

module.exports = { paramsSyncMap };
