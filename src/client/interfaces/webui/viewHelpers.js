const { saoIguais } = require('#client/domain/auditoria.js');

function formatDisplay(v) {
  if (v === null || v === undefined) return '<span style="color:#aaa;font-style:italic">NULL</span>';
  if (typeof v === 'string' && v.trim() === '') return '<span style="color:#aaa;font-style:italic">"" (vazio)</span>';
  return v;
}

// Padrão de colunas sempre exibidas para identificação rápida do registro
const COLUNAS_IDENTIFICACAO = /DESCRI|^NOME$|PRECO|VALOR|REFERENCIA|CODIGO|EAN|UNIDADE|MARCA|CATEGORIA|TIPO/i;

/**
 * Renderiza as tabelas de campos do conflito em seções colapsáveis ordenadas por importância.
 * Retorna { divergentesTable, localRows, servidorRows, numDivergentes } onde:
 *   - divergentesTable: tabela única com 4 colunas (campo, valor local, radio escolha, valor servidor)
 *   - localRows / servidorRows: <tbody> para identificação e outros campos (layout lado a lado)
 */
function renderCampos(versaoLocal, versaoServidor, conflitoid) {
  const todasColunas = [...new Set([
    ...Object.keys(versaoLocal || {}),
    ...Object.keys(versaoServidor || {}),
  ])];

  const divergentes   = todasColunas.filter(c => !saoIguais(versaoLocal?.[c], versaoServidor?.[c]));
  const identificacao = todasColunas.filter(c => COLUNAS_IDENTIFICACAO.test(c) && !divergentes.includes(c));
  const outros        = todasColunas.filter(c => !divergentes.includes(c) && !identificacao.includes(c));

  const renderLinha = (col, isDif, grupo, startOpen) => {
    const style = isDif ? ' class="diff"' : '';
    const hidden = startOpen ? '' : ' style="display:none"';
    return {
      local:    `<tr${style} data-group="${grupo}"${hidden}><td>${col}</td><td>${formatDisplay(versaoLocal?.[col])}</td></tr>`,
      servidor: `<tr${style} data-group="${grupo}"${hidden}><td>${col}</td><td>${formatDisplay(versaoServidor?.[col])}</td></tr>`,
    };
  };

  // Cada seção tem um ID único compartilhado pelas duas tabelas (local e servidor)
  const uid = Math.random().toString(36).slice(2, 7);

  function secao(cols, grupo, label, corFundo, corTexto, isDif, startOpen = false) {
    if (cols.length === 0) return { local: '', servidor: '' };

    const seta = startOpen ? '&#9660;' : '&#9654;';
    const toggleStyle = `background:${corFundo};font-size:11px;font-weight:bold;color:${corTexto};padding:6px 8px;cursor:pointer;user-select:none;text-transform:uppercase`;
    const headerRow = `<tr onclick="
      document.querySelectorAll('[data-group=\\'${grupo}-${uid}\\']').forEach(function(el){
        el.style.display = el.style.display === '' ? 'none' : '';
      });
      this.querySelector('.seta').innerHTML = this.querySelector('.seta').innerHTML === '&#9654;' ? '&#9660;' : '&#9654;';
    ">
      <td colspan="2" style="${toggleStyle}">
        <span class="seta">${seta}</span> ${label} (${cols.length})
      </td>
    </tr>`;

    let local = headerRow;
    let servidor = headerRow;

    for (const col of cols) {
      const l = renderLinha(col, isDif, `${grupo}-${uid}`, startOpen);
      local    += l.local;
      servidor += l.servidor;
    }

    return { local, servidor };
  }

  // Tabela única de campos divergentes com radio buttons por linha
  let divergentesTable = '';
  if (divergentes.length > 0) {
    const headerStyle = `background:#f8d7da;font-size:11px;font-weight:bold;color:#721c24;padding:6px 8px;text-transform:uppercase;text-align:center`;
    const rows = divergentes.map(col => {
      const radioLocal    = `<input type="radio" name="campo-${conflitoid}-${col}" value="local" checked>`;
      const radioServidor = `<input type="radio" name="campo-${conflitoid}-${col}" value="servidor">`;
      return `<tr class="diff">
        <td style="font-weight:bold;color:#555;width:20%">${col}</td>
        <td style="width:30%">${formatDisplay(versaoLocal?.[col])}</td>
        <td style="text-align:center;width:20%;white-space:nowrap">
          <label style="margin-right:8px">${radioLocal} Local</label>
          <label>${radioServidor} Servidor</label>
        </td>
        <td style="width:30%">${formatDisplay(versaoServidor?.[col])}</td>
      </tr>`;
    }).join('');

    divergentesTable = `
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:12px">
        <thead>
          <tr>
            <th style="${headerStyle}">Campo</th>
            <th style="${headerStyle}">Valor Local</th>
            <th style="${headerStyle}">Escolha</th>
            <th style="${headerStyle}">Valor Servidor</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  const s2 = secao(identificacao, 'iden', 'Identificação',      '#eaf3fb', '#2471a3', false, false);
  const s3 = secao(outros,        'out',  'Outros campos',      '#f5f5f5', '#666',    false, false);

  return {
    divergentesTable,
    localRows:    `<tbody>${s2.local}${s3.local}</tbody>`,
    servidorRows: `<tbody>${s2.servidor}${s3.servidor}</tbody>`,
    numDivergentes: divergentes.length,
  };
}

module.exports = { formatDisplay, renderCampos, COLUNAS_IDENTIFICACAO };
