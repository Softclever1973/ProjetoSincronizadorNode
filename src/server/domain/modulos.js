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
 *   visualmente as funções genéricas (Exportação, Impressão — usadas por várias telas) num
 *   grupo à parte, com um divisor, pra deixar claro que não são uma área nova do sistema.
 * - `subDe` (opcional, só em entradas 'funcao') — chave de um módulo 'modulo' do qual esta
 *   função é uma ação específica (ex. `pedidos_inserir` é uma ação de `pedidos`, não uma
 *   função genérica como exportação). A tela de Permissões agrupa essas entradas logo abaixo
 *   do módulo pai, em vez de jogá-las no grupo genérico de funções — GET /superadmin/permissoes
 *   (adminEmpresas.js) é quem faz essa intercalação a partir deste campo.
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
  pedidos_inserir:  { label: 'Inserir',                  tipo: 'funcao', subDe: 'pedidos' },
  pedidos_editar:   { label: 'Editar',                   tipo: 'funcao', subDe: 'pedidos' },
  pedidos_realizar: { label: 'Realizar',                 tipo: 'funcao', subDe: 'pedidos' },
  pedidos_cancelar: { label: 'Cancelar',                 tipo: 'funcao', subDe: 'pedidos' },
  produtos_movimentacao: { label: 'Movimentação de Estoque', tipo: 'funcao', subDe: 'produtos' },
});

const MODULOS = Object.freeze(Object.keys(MODULOS_DEF));

const NIVEL_VALIDO = new Set(['--', 'r-', 'rw']);

module.exports = { MODULOS, MODULOS_DEF, NIVEL_VALIDO };
