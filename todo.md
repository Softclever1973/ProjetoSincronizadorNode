TODO: Fazer algum tipo de notificação quando tiver erro, além de criar uma tabela para salvar os erros
STATUS: Concluído — veja src/client/erros.js, alterações em index.js e webui.js
TODO: Verifique se o status do TODO acima está concluido mesmo
STATUS: Concluído — confirmado
TODO: Fazer com que os erros venha de um banco de dados ao em vez de um json
STATUS: Concluído — erros.js reescrito para persistir em SYNC_ERROS (Firebird); setup.js cria a tabela
TODO: Notificar os erros dentro da plataforma caso tenha algum
STATUS: Concluído — badge no nav via SSE + Notification API já estavam implementados
TODO: Adicionar um sinal de notificação para o conflitos também
STATUS: Concluído — badge no nav (conflitos-badge), SSE evento novo-conflito, OS Notification para conflitos
TODO: Realizar uma notificação no windows mesmo caso o usuario dê acesso ao browser lançar notificações
STATUS: Concluído — Notification.requestPermission() no template + new Notification() para erros e conflitos


TODO: VERIFICAR SE O SIRIUS WEB BACKUP ESTÁ FUNCIONANDO CORRETAMENTE!!!