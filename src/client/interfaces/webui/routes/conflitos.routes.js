const express = require('express');
const { listarPendentes, resolverConflito, lerTodos } = require('../../../infrastructure/persistence/conflitos');
const { getConnection, query: dbQuery, execute: dbExecute, closeConnection } = require('../../../infrastructure/firebird/db');
const { gerarNovoPK: utilGerarPK } = require('../../../infrastructure/firebird/db-utils');
const { aplicarRegistroLocal } = require('../../../application/syncEngine/resolverConflito');
const { enviarRegistro } = require('../../../http');
const { renderCampos } = require('../viewHelpers');

function criarConflitosRouter(contexto) {
  const router = express.Router();

  // ── CONFLITOS ────────────────────────────────────────────────────────────
  router.get('/', (req, res) => {
    const mostrarResolvidos = req.query.todos === '1';
    const POR_PAGINA = 30;
    const pendentes = listarPendentes();
    const listaCompleta = (mostrarResolvidos ? lerTodos() : pendentes).slice().reverse();
    const total = listaCompleta.length;
    const totalGeral = lerTodos().length;

    const totalPaginas = Math.max(1, Math.ceil(total / POR_PAGINA));
    const pagina = Math.min(Math.max(1, parseInt(req.query.pagina, 10) || 1), totalPaginas);
    const inicio = (pagina - 1) * POR_PAGINA;
    const lista  = listaCompleta.slice(inicio, inicio + POR_PAGINA);

    const base      = mostrarResolvidos ? '/?todos=1' : '/';
    const linkPagina = p => `${base}${base.includes('?') ? '&' : '?'}pagina=${p}`;

    const paginacaoHTML = (() => {
      if (totalPaginas <= 1) return '';
      const fim = Math.min(inicio + POR_PAGINA, total);
      const partes = [];
      if (pagina > 1) partes.push(`<a href="${linkPagina(pagina - 1)}" style="padding:4px 10px;border:1px solid #3498db;border-radius:4px;color:#3498db;text-decoration:none">← Anterior</a>`);
      const de = Math.max(1, pagina - 2), ate = Math.min(totalPaginas, pagina + 2);
      if (de > 1) partes.push(`<span style="color:#aaa">…</span>`);
      for (let p = de; p <= ate; p++) {
        partes.push(p === pagina
          ? `<span style="padding:4px 10px;border:1px solid #3498db;border-radius:4px;background:#3498db;color:white;font-weight:bold">${p}</span>`
          : `<a href="${linkPagina(p)}" style="padding:4px 10px;border:1px solid #ccc;border-radius:4px;color:#555;text-decoration:none">${p}</a>`);
      }
      if (ate < totalPaginas) partes.push(`<span style="color:#aaa">…</span>`);
      if (pagina < totalPaginas) partes.push(`<a href="${linkPagina(pagina + 1)}" style="padding:4px 10px;border:1px solid #3498db;border-radius:4px;color:#3498db;text-decoration:none">Próxima →</a>`);
      const irParaForm = `<form method="get" action="${base.split('?')[0]}" style="display:inline-flex;align-items:center;gap:4px;margin-left:12px">${mostrarResolvidos ? '<input type="hidden" name="todos" value="1">' : ''}<label style="font-size:12px;color:#888">Ir para:</label><input type="number" name="pagina" min="1" max="${totalPaginas}" value="${pagina}" style="width:54px;padding:3px 6px;border:1px solid #ccc;border-radius:4px;font-size:13px;text-align:center"><button type="submit" style="padding:3px 8px;border:1px solid #3498db;border-radius:4px;background:#3498db;color:white;font-size:12px;cursor:pointer">→</button></form>`;
      return `<div style="display:flex;align-items:center;gap:6px;margin-top:20px;flex-wrap:wrap">${partes.join('')}<span style="margin-left:8px;font-size:12px;color:#888">${inicio + 1}–${fim} de ${total}</span>${irParaForm}</div>`;
    })();

    const conflitos = lista.map(c => ({ ...c, rendered: renderCampos(c.versaoLocal, c.versaoServidor, c.id) }));

    res.render('conflitos', {
      conflitos, numPendentes: pendentes.length,
      total, totalGeral, pagina, totalPaginas, inicio,
      mostrarResolvidos, paginacaoHTML,
    });
  });

  router.post('/conflitos/:id/resolver', async (req, res) => {
    const { id } = req.params;
    const { escolha, campos } = req.body;

    if (!['local', 'servidor', 'mesclar', 'manter_ambos'].includes(escolha)) {
      return res.status(400).json({ ok: false, message: 'escolha inválida' });
    }

    if (escolha === 'mesclar' && (typeof campos !== 'object' || campos === null)) {
      return res.status(400).json({ ok: false, message: 'campos obrigatório para escolha mesclar' });
    }

    let conflito;
    try {
      conflito = resolverConflito(id, escolha);
    } catch (e) {
      return res.status(404).json({ ok: false, message: e.message });
    }

    if (escolha === 'local') {
      // Força envio da versão local ao servidor (ignora conflito)
      if (!contexto.baseURI || !contexto.idLoja) {
        return res.status(500).json({ ok: false, message: 'Configuração do servidor não disponível ainda' });
      }

      // Se versaoLocal está ausente (conflito antigo), lê o dado atual do Firebird
      let versaoParaEnviar = conflito.versaoLocal;
      if (!versaoParaEnviar) {
        const db = await getConnection();
        try {
          const pks = Array.isArray(conflito.pk) ? conflito.pk : [conflito.pk];
          const pkValores = conflito.pkValor.split('|');
          const whereParts = pks.map(p => `${p} = ?`).join(' AND ');
          const rows = await dbQuery(db, `SELECT * FROM ${conflito.tabela} WHERE ${whereParts}`, pkValores);
          if (rows.length === 0) {
            return res.status(400).json({ ok: false, message: 'Registro local não encontrado — pode ter sido deletado' });
          }
          versaoParaEnviar = rows[0];
        } catch (e) {
          return res.status(500).json({ ok: false, message: `Falha ao ler registro local: ${e.message}` });
        } finally {
          await closeConnection(db);
        }
      }

      try {
        const resultado = await enviarRegistro(contexto.baseURI, contexto.idLoja,
          conflito.tabela, conflito.pk, versaoParaEnviar, 0, true);

        // Registra a versão do servidor para que o próximo pull não re-detecte como conflito
        if (resultado?.novoId) {
          const db = await getConnection();
          try {
            await dbExecute(db,
              `UPDATE OR INSERT INTO SYNC_VERSOES_SERVIDOR (NOME_TABELA, PK_VALOR, ID_ULTIMA_ATUALIZACAO_MATRIZ)
               VALUES (?, ?, ?) MATCHING (NOME_TABELA, PK_VALOR)`,
              [conflito.tabela, conflito.pkValor, resultado.novoId]
            );
            await dbExecute(db,
              `DELETE FROM SYNC_ALTERACOES_PENDENTES WHERE NOME_TABELA = ? AND PK_VALOR = ?`,
              [conflito.tabela, conflito.pkValor]
            ).catch(() => {});
          } finally {
            await closeConnection(db);
          }
        }
      } catch (e) {
        return res.status(500).json({ ok: false, message: `Falha ao enviar ao servidor: ${e.message}` });
      }
    } else if (escolha === 'servidor') {
      // Aplica a versão do servidor no banco local da filial
      const db = await getConnection();
      try {
        const reg = conflito.versaoServidor;
        await aplicarRegistroLocal(db, conflito.tabela, conflito.pk, reg);
        // Atualiza versão conhecida do servidor
        if (reg.ID_ULTIMA_ATUALIZACAO_MATRIZ) {
          await dbExecute(db,
            `UPDATE OR INSERT INTO SYNC_VERSOES_SERVIDOR (NOME_TABELA, PK_VALOR, ID_ULTIMA_ATUALIZACAO_MATRIZ)
             VALUES (?, ?, ?) MATCHING (NOME_TABELA, PK_VALOR)`,
            [conflito.tabela, conflito.pkValor, reg.ID_ULTIMA_ATUALIZACAO_MATRIZ]
          ).catch(() => {});
        }
      } catch (e) {
        return res.status(500).json({ ok: false, message: `Falha ao aplicar versão do servidor: ${e.message}` });
      } finally {
        await closeConnection(db);
      }
    } else if (escolha === 'mesclar') {
      // Constrói registro mesclado: base local, sobrescreve campos escolhidos do servidor
      const base = { ...conflito.versaoLocal };
      for (const [col, origem] of Object.entries(campos)) {
        if (origem === 'servidor') {
          base[col] = conflito.versaoServidor?.[col] ?? null;
        }
      }

      // 1. Aplica o registro mesclado no banco local (igual ao fluxo 'servidor')
      const db = await getConnection();
      try {
        await aplicarRegistroLocal(db, conflito.tabela, conflito.pk, base);
      } catch (e) {
        return res.status(500).json({ ok: false, message: `Falha ao aplicar mesclagem localmente: ${e.message}` });
      } finally {
        await closeConnection(db);
      }

      // 2. Envia o registro mesclado ao servidor forçando (igual ao fluxo 'local')
      if (!contexto.baseURI || !contexto.idLoja) {
        return res.status(500).json({ ok: false, message: 'Configuração do servidor não disponível ainda' });
      }
      try {
        const resultadoMescla = await enviarRegistro(contexto.baseURI, contexto.idLoja,
          conflito.tabela, conflito.pk, base, 0, true);

        if (resultadoMescla?.novoId) {
          const db2 = await getConnection();
          try {
            await dbExecute(db2,
              `UPDATE OR INSERT INTO SYNC_VERSOES_SERVIDOR (NOME_TABELA, PK_VALOR, ID_ULTIMA_ATUALIZACAO_MATRIZ)
               VALUES (?, ?, ?) MATCHING (NOME_TABELA, PK_VALOR)`,
              [conflito.tabela, conflito.pkValor, resultadoMescla.novoId]
            );
            await dbExecute(db2,
              `DELETE FROM SYNC_ALTERACOES_PENDENTES WHERE NOME_TABELA = ? AND PK_VALOR = ?`,
              [conflito.tabela, conflito.pkValor]
            ).catch(() => {});
          } finally {
            await closeConnection(db2);
          }
        }
      } catch (e) {
        return res.status(500).json({ ok: false, message: `Falha ao enviar mesclagem ao servidor: ${e.message}` });
      }

    } else if (escolha === 'manter_ambos') {
      // Local mantém o PK original. O registro do servidor ganha um novo ID auto-gerado nos dois bancos.
      if (!contexto.baseURI || !contexto.idLoja) {
        return res.status(500).json({ ok: false, message: 'Configuração do servidor não disponível ainda' });
      }
      if (!conflito.versaoLocal || !conflito.versaoServidor) {
        return res.status(400).json({ ok: false, message: 'Conflito sem dados suficientes para manter ambos' });
      }

      const pks         = Array.isArray(conflito.pk) ? conflito.pk : [conflito.pk];
      const pkPrincipal = pks[pks.length - 1];
      const pkValores   = conflito.pkValor.split('|');

      let novoValorPK;
      let novoPKValorStr;

      const db = await getConnection();
      try {
        // 1. Gera novo PK (MAX + 1) para o registro do servidor — antes de qualquer alteração
        novoValorPK    = await utilGerarPK(db, conflito.tabela, conflito.pk, conflito.versaoServidor);
        novoPKValorStr = pks.map((p, i) => p === pkPrincipal ? String(novoValorPK) : pkValores[i]).join('|');

        // 2. Insere o registro do servidor localmente com o novo PK
        const regServidor = { ...conflito.versaoServidor, [pkPrincipal]: novoValorPK };
        await aplicarRegistroLocal(db, conflito.tabela, conflito.pk, regServidor);

        // 3. Remove pendente do PK original (será resolvido pelo force-push abaixo)
        await dbExecute(db,
          `DELETE FROM SYNC_ALTERACOES_PENDENTES WHERE NOME_TABELA = ? AND PK_VALOR = ?`,
          [conflito.tabela, conflito.pkValor]
        ).catch(() => {});

      } catch (e) {
        await closeConnection(db);
        return res.status(500).json({ ok: false, message: `Falha ao inserir registro do servidor localmente: ${e.message}` });
      }
      await closeConnection(db);

      // 4. Envia o registro LOCAL (PK original) ao servidor — sobrescreve o conflito no servidor
      try {
        const resultado = await enviarRegistro(contexto.baseURI, contexto.idLoja,
          conflito.tabela, conflito.pk, conflito.versaoLocal, 0, true);

        if (resultado?.novoId) {
          const db2 = await getConnection();
          try {
            await dbExecute(db2,
              `UPDATE OR INSERT INTO SYNC_VERSOES_SERVIDOR (NOME_TABELA, PK_VALOR, ID_ULTIMA_ATUALIZACAO_MATRIZ)
               VALUES (?, ?, ?) MATCHING (NOME_TABELA, PK_VALOR)`,
              [conflito.tabela, conflito.pkValor, resultado.novoId]
            );
          } finally {
            await closeConnection(db2);
          }
        }
      } catch (e) {
        return res.status(500).json({ ok: false, message: `Falha ao enviar versão local ao servidor: ${e.message}` });
      }

      // 5. Envia o registro do servidor com o novo PK ao servidor — cria o segundo registro
      const regParaEnviar = { ...conflito.versaoServidor, [pkPrincipal]: novoValorPK };
      try {
        const resultado = await enviarRegistro(contexto.baseURI, contexto.idLoja,
          conflito.tabela, conflito.pk, regParaEnviar, 0, true);

        if (resultado?.novoId) {
          const db2 = await getConnection();
          try {
            await dbExecute(db2,
              `UPDATE OR INSERT INTO SYNC_VERSOES_SERVIDOR (NOME_TABELA, PK_VALOR, ID_ULTIMA_ATUALIZACAO_MATRIZ)
               VALUES (?, ?, ?) MATCHING (NOME_TABELA, PK_VALOR)`,
              [conflito.tabela, novoPKValorStr, resultado.novoId]
            );
            await dbExecute(db2,
              `DELETE FROM SYNC_ALTERACOES_PENDENTES WHERE NOME_TABELA = ? AND PK_VALOR = ?`,
              [conflito.tabela, novoPKValorStr]
            ).catch(() => {});
          } finally {
            await closeConnection(db2);
          }
        }
      } catch (e) {
        return res.status(500).json({ ok: false, message: `Falha ao enviar registro do servidor com novo ID: ${e.message}` });
      }
    }

    res.json({ ok: true });
  });

  // ── API: contagem para badge ─────────────────────────────────────────────
  router.get('/api/conflitos/count', (_req, res) => {
    res.json({ total: listarPendentes().length });
  });

  return router;
}

module.exports = { criarConflitosRouter };
