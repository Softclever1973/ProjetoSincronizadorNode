# Manual de Configuração Inicial do Cliente

Este manual descreve o assistente de configuração interativo executado automaticamente na primeira vez que o cliente (`client.exe` ou `npm run client`) é iniciado sem um arquivo `.env` configurado.

---

## Quando o wizard é executado

O wizard é iniciado automaticamente quando o arquivo `src/client/.env` não existe. Após a configuração ser concluída, o arquivo é criado e nas próximas execuções o wizard não aparece mais.

Para **reconfigurar**, basta apagar o arquivo `.env` e reiniciar o cliente.

---

## Passo a passo

### 1. SYNC_TOKEN

```
SYNC_TOKEN (fornecido pelo administrador do servidor):
>
```

Token de autenticação compartilhado entre o cliente e o servidor. Deve ser fornecido pelo administrador responsável pelo servidor (matriz). O token precisa ser **idêntico** nos dois lados.

- Campo obrigatório.
- Suporta Ctrl+V para colar (Windows).

---

### 2. URL do servidor

```
URL do servidor
  ex: http://192.168.1.100:8080
>
```

Endereço HTTP completo do servidor da matriz. Inclui o IP (ou hostname) e a porta configurada no servidor.

- Campo obrigatório.
- Barras finais são removidas automaticamente (`http://servidor/` → `http://servidor`).
- Esta URL também será gravada automaticamente no banco Firebird local (`PARAMETROS` onde `ID_PARAMETRO = 60024`).

---

### 3. Caminho do banco Firebird

```
Caminho do banco Firebird
  ex: C:\FDBS\FILIAL.FDB
>
```

Caminho absoluto do arquivo `.FDB` da filial no sistema operacional local.

- Campo obrigatório.
- O arquivo `.fdb` **deve existir previamente** — o sincronizador não cria o banco de dados, apenas se conecta a ele.
- Use o caminho como ele aparece no sistema de arquivos do servidor Firebird (pode ser diferente do caminho visto pelo cliente se o Firebird for remoto).

---

### 4. Senha do Firebird

```
Senha do Firebird:
>
```

Senha do usuário Firebird. Não há valor padrão — sempre informe explicitamente.

- Campo obrigatório.

---

### 5. Host do Firebird

```
Host do Firebird [localhost]:
>
```

Endereço do servidor Firebird. Pressione Enter para aceitar o padrão `localhost`.

- Padrão: `localhost`
- Informe um IP ou hostname apenas se o Firebird estiver em outra máquina.

---

### 6. Porta do Firebird

```
Porta do Firebird [3050]:
>
```

Porta TCP em que o Firebird está escutando. Pressione Enter para aceitar o padrão.

- Padrão: `3050`

---

### 7. Usuário do Firebird

```
Usuario do Firebird [SYSDBA]:
>
```

Nome de usuário para conexão ao Firebird. Pressione Enter para aceitar o padrão.

- Padrão: `SYSDBA`

---

### 8. Intervalo entre ciclos

```
Intervalo entre ciclos em ms [30000]:
>
```

Tempo em milissegundos entre cada ciclo de sincronização. Pressione Enter para aceitar o padrão de 30 segundos.

- Padrão: `30000` (30 segundos)
- Valores menores aumentam a frequência de sync mas também a carga na rede e no banco.

---

## Resultado

Ao final, o wizard cria o arquivo `.env` com o seguinte formato:

```env
SYNC_TOKEN=seu-token-aqui
FIREBIRD_HOST=localhost
FIREBIRD_PORT=3050
FIREBIRD_DATABASE=C:\FDBS\FILIAL.FDB
FIREBIRD_USER=SYSDBA
FIREBIRD_PASSWORD=sua-senha
INTERVALO_MS=30000
```

E grava a URL do servidor no banco Firebird:

```
PARAMETROS onde ID_PARAMETRO = 60024, PARAMETRO = http://192.168.1.100:8080
```

Caso a conexão com o Firebird falhe nesta etapa, uma mensagem de aviso é exibida e a URL precisa ser configurada manualmente:

```sql
UPDATE OR INSERT INTO PARAMETROS (ID_PARAMETRO, PARAMETRO)
VALUES (60024, 'http://192.168.1.100:8080')
MATCHING (ID_PARAMETRO);
```

---

## Cancelar a configuração

Pressione **Ctrl+C** a qualquer momento para cancelar. O arquivo `.env` não será criado e o cliente encerrará sem erros.

---

## Reconfigurar

Para executar o wizard novamente:

1. Apague o arquivo `.env` localizado em `src/client/.env` (ou na pasta do executável, se usando `client.exe`).
2. Reinicie o cliente.

---

## Problemas comuns

| Situação | Causa provável | Solução |
|---|---|---|
| `[!] Nao foi possivel conectar ao Firebird` | Caminho, host, porta ou senha incorretos | Verifique os dados e configure `PARAMETROS(60024)` manualmente |
| Ctrl+V não funciona | Terminal não é TTY ou não é Windows | Cole o texto manualmente |
| Cliente inicia mas não sincroniza | `SYNC_TOKEN` diferente do servidor | Confirme o token com o administrador |
| URL gravada errada no Firebird | Erro de digitação | Execute `UPDATE` manual na tabela `PARAMETROS` |
