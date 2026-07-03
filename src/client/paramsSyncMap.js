// Mapeia parâmetros do Firebird (PARAMETROS.ID_PARAMETRO) para as chaves
// correspondentes em sync_config no servidor. Fonte única — usado tanto pelo
// ciclo de sincronização (index.js) quanto pela tela local de Parâmetros (webui.js),
// para que as duas partes nunca fiquem dessincronizadas sobre o que é sincronizado.
const paramsSyncMap = [
  { fbId: 67,    chave: 'utilizar_codigo_interno'     },
  { fbId: 122,   chave: 'codigo_interno_unico'        },
  { fbId: 71,    chave: 'venda_saldo_negativo'        },
  { fbId: 45051, chave: 'modalidade_frete'            },
  { fbId: 91,    chave: 'forma_preenchimento_pedido'  },
];

module.exports = { paramsSyncMap };
