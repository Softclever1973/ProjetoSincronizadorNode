/**
 * Registro único dos módulos do sistema de permissões (plano × módulo, role × módulo).
 * Para adicionar um módulo novo (uma tela inteira ou só uma feature pontual, ex.
 * exportação): acrescentar uma linha aqui com a chave, o rótulo exibido na tela de
 * Permissões do superadmin, e o tipo — nenhum outro arquivo precisa saber da lista
 * antecipadamente. Sem entrada no banco, o módulo nasce fail-closed ('--') em todo
 * plano/role até alguém liberar pela própria tela; para já nascer liberado nalgum
 * plano/role, adicionar também em `SEED_PERMISSOES_PLANO`/`SEED_PERMISSOES_ROLE`
 * (src/server/infrastructure/db-init.js).
 *
 * `tipo`:
 * - 'modulo' — uma tela inteira do dashboard (Produtos, Financeiro, etc.), com guard de
 *   página (`AUTH.requireModulo`) e entrada em modulosRegistry.js.
 * - 'funcao' — uma capacidade pontual sem tela própria (ex. exportação de planilha),
 *   gateada só no ponto específico onde aparece. A tela de Permissões do superadmin separa
 *   visualmente os dois tipos (funções vêm depois, com um divisor) pra deixar claro que não
 *   é uma área nova do sistema.
 *
 * Depois de registrado, gatear o acesso de verdade:
 * - backend: `requireModulo(chave, 'r'|'w')` na rota (ou `requireModuloDaTabela` se for
 *   uma tabela do CRUD genérico — ver domain/tabelaModulo.js);
 * - frontend: `AUTH.podeLerModulo(chave)` / `AUTH.podeEscreverModulo(chave)` no botão/tela.
 */
const MODULOS_DEF = Object.freeze({
  produtos:      { label: 'Produtos',      tipo: 'modulo' },
  clientes:      { label: 'Clientes',      tipo: 'modulo' },
  pedidos:       { label: 'Pedidos',       tipo: 'modulo' },
  fornecedores:  { label: 'Fornecedores',  tipo: 'modulo' },
  usuarios:      { label: 'Usuários',      tipo: 'modulo' },
  financeiro:    { label: 'Financeiro',    tipo: 'modulo' },
  faturamento:   { label: 'Faturamento',   tipo: 'modulo' },
  auditoria:     { label: 'Auditoria',     tipo: 'modulo' },
  configuracoes: { label: 'Configurações', tipo: 'modulo' },
  exportacao:    { label: 'Exportação (CSV/Excel)', tipo: 'funcao' },
  imprimir:      { label: 'Impressão', tipo: 'funcao' },
});

const MODULOS = Object.freeze(Object.keys(MODULOS_DEF));

const NIVEL_VALIDO = new Set(['--', 'r-', 'rw']);

module.exports = { MODULOS, MODULOS_DEF, NIVEL_VALIDO };
