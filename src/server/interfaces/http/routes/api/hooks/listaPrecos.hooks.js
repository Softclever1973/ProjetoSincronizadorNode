// Hooks de handleSave (crud.js) da LISTA_PRECOS: validação do cadastro e recálculo do PRECO dos produtos ao mudar o ajuste.
const { execute } = require('#server/infrastructure/db.js');
const { ehValorFixo } = require('#server/domain/listaPrecos.js');

const erroValidacao = msg => Object.assign(new Error(msg), { isValidation: true });
const chave = (registro, nome) => Object.keys(registro).find(k => k.toUpperCase() === nome);

// Colunas DECIMAL(5,2) no Firebird: |valor| < 1000.
const CAMPOS_DECIMAIS = {
  PERCENTUAL_ACRESCIMO_REDUCAO: 'Ajuste',
  PERCENTUAL_DE_COMISSAO: 'Comissão do vendedor',
  PERCENTUAL_COMISSAO_REPRES: 'Comissão do representante',
  PERCENTUAL_COMISSAO_SUPERV: 'Comissão do supervisor',
  PERCENTUAL_DE_COMISSAO_GERENTE: 'Comissão do gerente',
};

function antesDaTransacao(_db, registro) {
  const kDesc = chave(registro, 'DESCRICAO') ?? 'DESCRICAO';
  const desc = String(registro[kDesc] ?? '').trim();
  if (!desc) throw erroValidacao('Informe a descrição da lista.');
  if (desc.length > 100) throw erroValidacao('A descrição deve ter no máximo 100 caracteres.');
  registro[kDesc] = desc;

  const kTipo = chave(registro, 'PERCENTUAL_OU_VALOR');
  if (kTipo !== undefined) {
    const tipo = String(registro[kTipo] ?? '').trim().toUpperCase();
    if (!['P', 'V'].includes(tipo)) throw erroValidacao('Tipo inválido: use Percentual (P) ou Valor (V).');
    registro[kTipo] = tipo;
  }

  for (const [campo, rotulo] of Object.entries(CAMPOS_DECIMAIS)) {
    const k = chave(registro, campo);
    if (k === undefined || registro[k] === null || registro[k] === '') continue;
    const n = Number(registro[k]);
    if (!Number.isFinite(n) || Math.abs(n) >= 1000) throw erroValidacao(`${rotulo}: informe um número entre -999,99 e 999,99.`);
    if (campo !== 'PERCENTUAL_ACRESCIMO_REDUCAO' && n < 0) throw erroValidacao(`${rotulo} não pode ser negativa.`);
    registro[k] = Math.round(n * 100) / 100;
  }

  // A/R acompanha o sinal do ajuste (negativo = redução).
  const kAjuste = chave(registro, 'PERCENTUAL_ACRESCIMO_REDUCAO');
  if (kAjuste !== undefined && registro[kAjuste] !== null && registro[kAjuste] !== '') {
    for (const k of Object.keys(registro)) if (k.toUpperCase() === 'ACRESCIMO_OU_REDUCAO') delete registro[k];
    registro.ACRESCIMO_OU_REDUCAO = Number(registro[kAjuste]) < 0 ? 'R' : 'A';
  }

  const kRel = chave(registro, 'MOSTRAR_NO_RELATORIO');
  if (kRel !== undefined && registro[kRel] != null) registro[kRel] = String(registro[kRel]).trim().toUpperCase() === 'S' ? 'S' : 'N';
}

// Edição que muda ajuste ou tipo: recalcula o PRECO gravado dos produtos (o trigger de seq leva a mudança às filiais).
async function depoisDeGravar(db, { registro, update, dadosAntes }) {
  if (!update || !dadosAntes) return;
  const valor = nome => { const k = chave(registro, nome); return k === undefined ? dadosAntes[nome] : registro[k]; };
  const ajuste = Number(valor('PERCENTUAL_ACRESCIMO_REDUCAO')) || 0;
  const valorFixo = ehValorFixo({ PERCENTUAL_OU_VALOR: valor('PERCENTUAL_OU_VALOR') });
  const mudou = ajuste !== (Number(dadosAntes.PERCENTUAL_ACRESCIMO_REDUCAO) || 0)
    || valorFixo !== ehValorFixo(dadosAntes);
  if (!mudou) return;
  await execute(db, `
    UPDATE PRODUTOS_X_LISTA px
    SET PRECO = GREATEST(0, ROUND(CASE WHEN $2 THEN pr.PRECO_VENDA + $1 ELSE pr.PRECO_VENDA * (1 + $1 / 100.0) END, 2))
    FROM PRODUTOS pr
    WHERE pr.ID_PRODUTO = px.ID_PRODUTO AND px.ID_LISTA = $3`,
    [ajuste, valorFixo, Number(valor('ID_LISTA'))]).catch(e => {
    // Tabela de vínculos ainda não existe no servidor: nada a recalcular.
    if (e.code !== '42P01') throw e;
  });
}

module.exports = { antesDaTransacao, depoisDeGravar };
