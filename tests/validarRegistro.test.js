const { validarRegistro, campo } = require('../src/server/domain/validacao');

// Registro CLIENTES válido usado como base — cada teste sobrescreve só o que quer quebrar.
const clienteValido = {
  RAZAO_SOCIAL: 'Loja Exemplo',
  FANTASIA: 'Loja Exemplo',
  PESSOA_P_CONTATO: 'Fulano',
  CONSUMIDOR_FINAL: 'N',
  CPF: '11111111111',
};

describe('validarRegistro — tabelas sem regras', () => {
  test('tabela desconhecida sempre passa (retorna null)', () => {
    expect(validarRegistro('TABELA_SEM_REGRAS', {})).toBeNull();
  });

  test('nome da tabela é case-insensitive', () => {
    expect(validarRegistro('clientes', clienteValido)).toBeNull();
  });
});

describe('validarRegistro — isUpdate ignora todas as regras', () => {
  test('registro incompleto passa quando isUpdate=true', () => {
    expect(validarRegistro('CLIENTES', {}, { isUpdate: true })).toBeNull();
  });
});

describe('validarRegistro — CLIENTES', () => {
  test('bloqueia quando falta um campo obrigatório', () => {
    const { FANTASIA, ...semFantasia } = clienteValido;
    expect(validarRegistro('CLIENTES', semFantasia)).toBe('O campo "FANTASIA" é obrigatório');
  });

  test('exige CPF ou CNPJ quando nenhum foi informado', () => {
    const { CPF, ...semDocumento } = clienteValido;
    expect(validarRegistro('CLIENTES', semDocumento)).toBe('Informe o CPF ou o CNPJ do cliente');
  });

  test('rejeita CPF e CNPJ preenchidos ao mesmo tempo', () => {
    const comAmbos = { ...clienteValido, CNPJ: '11222333000181' };
    expect(validarRegistro('CLIENTES', comAmbos)).toBe('Informe apenas CPF ou CNPJ, não os dois ao mesmo tempo');
  });

  test('aceita apenas CNPJ preenchido (sem CPF)', () => {
    const { CPF, ...semCpf } = clienteValido;
    expect(validarRegistro('CLIENTES', { ...semCpf, CNPJ: '11222333000181' })).toBeNull();
  });

  test('rejeita Razão Social acima de 60 caracteres', () => {
    const nomeGrande = 'A'.repeat(61);
    expect(validarRegistro('CLIENTES', { ...clienteValido, RAZAO_SOCIAL: nomeGrande }))
      .toBe('Razão Social deve ter no máximo 60 caracteres');
  });

  test('rejeita Razão Social com caractere não permitido', () => {
    expect(validarRegistro('CLIENTES', { ...clienteValido, RAZAO_SOCIAL: 'Loja @Exemplo#' }))
      .toBe('Razão Social: use apenas letras, números, espaços e os caracteres & . -');
  });

  test('aceita Razão Social com acentos e & . -', () => {
    expect(validarRegistro('CLIENTES', { ...clienteValido, RAZAO_SOCIAL: 'João & Cia - Comércio Ltda.' }))
      .toBeNull();
  });

  test('rejeita Inscrição Estadual fora do intervalo de 8-14 dígitos', () => {
    expect(validarRegistro('CLIENTES', { ...clienteValido, INSC_ESTADUAL: '123' }))
      .toBe('Inscrição Estadual deve ter entre 8 e 14 dígitos, ou deixe em branco');
  });

  test('aceita Inscrição Estadual em branco', () => {
    expect(validarRegistro('CLIENTES', { ...clienteValido, INSC_ESTADUAL: '' })).toBeNull();
  });

  test('campo é lido de forma case-insensitive (frontend manda lowercase)', () => {
    const lowercase = {
      razao_social: 'Loja Exemplo',
      fantasia: 'Loja Exemplo',
      pessoa_p_contato: 'Fulano',
      consumidor_final: 'N',
      cpf: '11111111111',
    };
    expect(validarRegistro('CLIENTES', lowercase)).toBeNull();
  });
});

describe('validarRegistro — PRODUTOS', () => {
  test('rejeita CEST com tamanho diferente de 7 dígitos', () => {
    expect(validarRegistro('PRODUTOS', { CODIGO_CEST: '123456' }))
      .toBe('CEST inválido — deve ter exatamente 7 dígitos');
  });

  test('aceita CEST vazio (campo opcional)', () => {
    expect(validarRegistro('PRODUTOS', {})).toBeNull();
  });

  test('exige alíquota de ICMS quando CST_ICMS_ECF é 00', () => {
    expect(validarRegistro('PRODUTOS', { CST_ICMS_ECF: '00' }))
      .toBe('Alíquota ICMS é obrigatória quando CST ICMS é 00');
  });

  test('aceita CST_ICMS_ECF 00 quando ALIQUOTA_ICMS está presente', () => {
    expect(validarRegistro('PRODUTOS', { CST_ICMS_ECF: '00', ALIQUOTA_ICMS: 18 })).toBeNull();
  });

  test('rejeita CFOP com tamanho diferente de 3 dígitos', () => {
    expect(validarRegistro('PRODUTOS', { CFOP_ECF: '12' }))
      .toBe('CFOP inválido — deve ter exatamente 3 dígitos');
  });
});

describe('validarRegistro — PEDIDOS', () => {
  test('exige ID_CLIENTE e STATUS', () => {
    expect(validarRegistro('PEDIDOS', { STATUS: 'P' }))
      .toBe('O campo "ID_CLIENTE" é obrigatório');
    expect(validarRegistro('PEDIDOS', { ID_CLIENTE: 1 }))
      .toBe('O campo "STATUS" é obrigatório');
  });

  test('passa quando ID_CLIENTE e STATUS estão presentes', () => {
    expect(validarRegistro('PEDIDOS', { ID_CLIENTE: 1, STATUS: 'P' })).toBeNull();
  });
});

describe('validarRegistro — PEDIDOS_ITENS', () => {
  const itemValido = { ID_PEDIDO: 1, ID_PRODUTO: 1, QUANTIDADE: 2, VALOR_UNITARIO: 10 };

  test('rejeita quantidade zero ou negativa', () => {
    expect(validarRegistro('PEDIDOS_ITENS', { ...itemValido, QUANTIDADE: 0 }))
      .toBe('Quantidade deve ser maior que zero');
    expect(validarRegistro('PEDIDOS_ITENS', { ...itemValido, QUANTIDADE: -1 }))
      .toBe('Quantidade deve ser maior que zero');
  });

  test('rejeita valor unitário negativo', () => {
    expect(validarRegistro('PEDIDOS_ITENS', { ...itemValido, VALOR_UNITARIO: -0.01 }))
      .toBe('Valor unitário não pode ser negativo');
  });

  test('aceita valor unitário zero (permitido, só bloqueia negativo)', () => {
    expect(validarRegistro('PEDIDOS_ITENS', { ...itemValido, VALOR_UNITARIO: 0 })).toBeNull();
  });

  test('passa com item válido', () => {
    expect(validarRegistro('PEDIDOS_ITENS', itemValido)).toBeNull();
  });
});

describe('validarRegistro — PEDIDOS_PARCELAS_PAGAMENTOS', () => {
  test('rejeita valor zero ou negativo', () => {
    expect(validarRegistro('PEDIDOS_PARCELAS_PAGAMENTOS', { ID_PEDIDO: 1, PARCELA: 1, VALOR: 0 }))
      .toBe('Valor do pagamento deve ser maior que zero');
  });

  test('passa com parcela válida', () => {
    expect(validarRegistro('PEDIDOS_PARCELAS_PAGAMENTOS', { ID_PEDIDO: 1, PARCELA: 1, VALOR: 50 }))
      .toBeNull();
  });
});

describe('campo() — helper de leitura case-insensitive', () => {
  test('encontra o campo independente da caixa', () => {
    expect(campo({ nome_produto: 'X' }, 'NOME_PRODUTO')).toBe('X');
  });

  test('retorna undefined para null, undefined ou string vazia/só espaços', () => {
    expect(campo({ A: null }, 'A')).toBeUndefined();
    expect(campo({ A: undefined }, 'A')).toBeUndefined();
    expect(campo({ A: '   ' }, 'A')).toBeUndefined();
    expect(campo({}, 'A')).toBeUndefined();
  });
});
