# Manual de Configuração Inicial do Cliente

Este manual ensina, passo a passo pelas telas, como colocar um cliente novo para funcionar: da criação da empresa até o envio dos dados que já existiam na filial.

Se você só precisa reconfigurar um cliente já instalado, vá direto para a seção 2.

---

## Visão geral do fluxo completo

São quatro etapas, sempre nessa ordem. As três primeiras acontecem em lugares diferentes — o painel administrativo (na nuvem), a máquina da filial e a web UI do cliente — então vale entender o que cada uma faz antes de sair clicando.

**1. Criar a empresa e o usuário dono.** Feito uma única vez por quem administra o sistema (super-admin), no painel **https://sirius-web-frontend-tau.vercel.app/admin.html**. É aqui que nasce o **token de sincronização** — a credencial que vai identificar essa filial junto ao servidor central — e o login do **dono**, que a empresa vai usar depois para acessar o SiriusWebFrontend no dia a dia. Sem esse passo, não há o que colar no wizard da etapa 2. Detalhes na [seção 1](#1-criando-a-empresa-e-o-usuário-dono-adminhtml).

**2. Rodar o assistente de configuração (wizard) na filial.** Acontece na máquina física da loja, na primeira vez que o `client.exe` é aberto. O wizard pede o token gerado na etapa 1, o endereço do servidor e os dados de conexão com o Firebird local. Ao final desse passo, o cliente já está rodando e sincronizando **dali para frente** — mas ainda não os dados antigos. Detalhes na [seção 2](#2-assistente-de-configuração-do-cliente-wizard).

**3. Carga inicial de dados.** Um botão na web UI do próprio cliente (`http://localhost:3001`, que só existe depois do wizard concluído), disparado manualmente uma única vez, para empurrar ao servidor tudo que já existia no Firebird **antes** da instalação. Pular essa etapa é a causa mais comum de "cadastrei o cliente mas os dados antigos não aparecem no sistema". Detalhes na [seção 3](#3-carga-inicial-de-dados).

**4. Verificação.** Conferir, tanto na web UI do cliente quanto no SiriusWebFrontend logado como o dono da empresa, que os dados realmente chegaram e que os ciclos de sincronização estão rodando sem erro. Detalhes na [seção 4](#4-verificando-a-sincronização).

---

## 1. Criando a empresa e o usuário dono (admin.html)

### Acessando o painel

1. Abra **https://sirius-web-frontend-tau.vercel.app/** no navegador — isso cai na tela de login comum (`login.html`).
2. Na barra de endereço, troque `login.html` por `admin.html`, ficando **https://sirius-web-frontend-tau.vercel.app/admin.html**. Essa página tem sua própria tela de login embutida.
3. Entre com um e-mail/senha de **super-admin** (não é o login de `dono`/`gerente`/`vendedor` de uma empresa específica).

> **Importante:** enquanto você estiver logado no `admin.html`, o navegador guarda esse login de super-admin. Se mais tarde você tentar acessar a tela de login comum (`login.html`) pra entrar como `dono`/`gerente`/`vendedor`, o sistema vai te mandar de volta pro `admin.html` automaticamente, sem pedir e-mail/senha. Pra logar como `dono`, primeiro clique em **Sair** aqui no `admin.html`.

> Não tem usuário super-admin ainda? Ele precisa ser criado por quem tem acesso ao servidor, rodando `node scripts/create-usuario.js --email=... --senha=... --super-admin` — não existe cadastro público.

Na aba **Empresas**, clique em **"+ Nova Empresa"**. O formulário pede:

| Campo | Observação |
|---|---|
| Nome | Nome de exibição da empresa (ex.: "JB Atacado"). |
| Schema | Preenchido automaticamente a partir do nome — pode deixar como está. |
| Regime tributário | Selecione na lista. |
| Token | Gerado automaticamente. Há um botão para gerar outro valor e um botão **Copiar**. |
| Nome do dono | Nome de quem vai administrar essa empresa no SiriusWebFrontend. |
| E-mail do dono | Vai ser o login do dono. |
| Senha temporária | Mínimo 6 caracteres — o dono pode trocar depois. |

Ao confirmar, o sistema cria tudo de uma vez: a empresa, o token de sincronização e o usuário **dono** já vinculado a ela.

> **Guarde o token agora.** Depois de criar a empresa, a tela mostra o token numa caixa com o aviso "guarde este valor — não será exibido novamente". Copie e envie para quem vai instalar o cliente na filial (será colado no wizard, seção 2). Se for perdido, não tem como recuperar depois.

### Criando mais usuários para uma empresa já existente

Aba **Usuários** → **"+ Novo Usuário"**, selecionando a empresa e o papel (`dono`, `gerente` ou `vendedor`).

### Ativar/desativar ou resetar uma empresa

Na aba **Empresas**, cada linha tem os botões **Ativar/Desativar** e **Resetar dados**. "Resetar" apaga todos os dados da empresa — use com cuidado, não tem como desfazer.

---

## 2. Assistente de configuração do cliente (wizard)

Acontece na máquina da **filial**, na primeira vez que o `client.exe` é aberto.

### Passo a passo

**1. Token de sincronização** — cole o token copiado na tela de criação da empresa (seção 1).

**2. URL do servidor** — endereço do servidor central (peça a quem administra o servidor). Exemplo: `http://192.168.1.100:8080`

**3. Caminho do banco Firebird** — caminho do arquivo `.FDB` da filial. Exemplo: `C:\FDBS\FILIAL.FDB`. O arquivo precisa já existir.

**4. Senha do Firebird** — obrigatória, não tem padrão.

**5 a 7. Host, porta e usuário** — pode deixar em branco e apertar **Enter** em todos para aceitar os valores padrão (`localhost`, `3050`, `SYSDBA`).

> Depois desses 5 campos (3 a 7), o wizard testa a conexão de verdade com o Firebird. Se falhar, mostra o motivo do erro e pede os 5 campos de novo — não dá pra seguir em frente com uma credencial errada.

**8. Intervalo entre ciclos** — em milissegundos. Enter aceita o padrão (`30000` = 30 segundos).

**9. Nome da filial** — opcional (ex.: "Loja Centro"). Ajuda a identificar essa loja depois, tanto no Firebird quanto na lista de filiais do servidor.

**10. ID da loja** — número que identifica essa filial dentro da empresa. Como o wizard já testou a conexão com o servidor no passo 2, ele mostra quais IDs já estão em uso pelas outras filiais e sugere automaticamente o próximo disponível — normalmente basta apertar **Enter**. **Nunca repita o ID de uma filial que já existe**: os dados das duas se sobrescrevem.

> Dica: Ctrl+V funciona para colar nos campos.

Ao final, uma janela preta vai mostrar mensagens de inicialização até aparecer `Ciclo concluído.` — nesse momento o cliente já está rodando.

Para **reconfigurar** (trocar de empresa, corrigir algo digitado errado), peça ajuda técnica para apagar a configuração salva e abrir o programa de novo.

---

## 3. Carga inicial de dados

Depois do wizard, o cliente já sincroniza tudo que muda **a partir de agora**. Os dados que já existiam antes da instalação precisam ser enviados manualmente, uma única vez.

1. Abra **`http://localhost:3001`** no navegador da filial. A página pede login — use:

   | Campo | Valor |
   |---|---|
   | Usuário | `admin` |
   | Senha | `admin` |

2. Vá ao menu **Configurações**.
3. Clique no botão **"Forçar Carga Inicial"**.
4. Confirme as tabelas marcadas e clique em **Iniciar Carga**.
5. Acompanhe o progresso na própria tela — pode levar de minutos a horas dependendo do volume de dados. Pode fechar o navegador: o envio continua em segundo plano.

Use esse botão sempre logo depois da primeira instalação, ou sempre que precisar reenviar uma tabela do zero.

---

## 4. Verificando a sincronização

- Na web UI do cliente (`http://localhost:3001`, login `admin`/`admin` → **Status**), veja se as tabelas estão sincronizadas.
- No SiriusWebFrontend, logado como o `dono` dessa empresa, abra as telas de Produtos/Clientes/Pedidos e confira se os dados aparecem.

  > **Se você estava logado no `admin.html` (super-admin):** clique em **Sair** primeiro. O login de super-admin fica salvo no navegador e, se você só trocar a URL para `login.html` sem deslogar, o sistema te manda de volta pro `admin.html` automaticamente. Só depois de deslogar é que a tela de login normal aceita o e-mail/senha do `dono` (criados na seção 1).

---

## Problemas comuns

| Situação | O que fazer |
|---|---|
| Modal "Nova Empresa" avisa que o schema já está em uso | Escolha outro nome, ou confira se a empresa já existe na lista |
| Modal avisa que o token já está cadastrado | Clique em gerar outro token e tente de novo |
| Modal avisa que o e-mail já está cadastrado | Use outro e-mail, ou vincule o usuário existente pela tela de Usuários do próprio sistema |
| Perdi o token mostrado na criação da empresa | Não há como recuperar — crie um usuário/token novo via `admin.html` |
| "Não foi possível conectar ao Firebird" (wizard) | Verifique caminho, host, porta e senha informados |
| Ctrl+V não funciona no wizard | Cole o texto manualmente |
| Cliente inicia mas não sincroniza | Confirme se o token bate com o cadastrado na empresa |
| Registros antigos não aparecem no servidor mesmo com o cliente rodando há dias | A carga inicial nunca foi disparada — clique em "Forçar Carga Inicial" (seção 3) |
| Botão "Forçar Carga Inicial" parece travado | O envio continua em segundo plano mesmo se a página fechar — reabra Configurações para ver o progresso atualizado |
| Alguns registros nunca saem da fila de envio | Veja a tela "Erros" na web UI do cliente — casos assim ficam registrados lá |
