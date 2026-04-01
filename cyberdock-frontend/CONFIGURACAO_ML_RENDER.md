# Configuração do Mercado Livre no Render - Guia Completo

## Status Atual da Integração

✅ **Frontend configurado corretamente**
- Botão "Conectar Conta Mercado Livre" em `/contas`
- Redirecionamento automático para o backend do Render
- Suporte a múltiplas contas ML

✅ **Backend configurado corretamente**
- Rotas OAuth implementadas em `backend/router/mercadolivre.js`
- PKCE (Proof Key for Code Exchange) implementado
- Refresh token automático
- Tabela `ml_accounts` criada automaticamente

✅ **Banco de dados configurado**
- Tabela `ml_accounts` com schema correto
- Suporte a múltiplas contas por usuário

## URLs Importantes

### Backend (Render)
```
https://cyberdock-backend.onrender.com
```

### Endpoints do Mercado Livre
```
/api/ml/auth       - Inicia autenticação OAuth
/api/ml/callback   - Recebe callback do ML
/api/ml/contas/:uid - Lista contas conectadas
/api/ml/test       - Testa conexão (debug)
```

## Passo a Passo: Configurar no Painel do Mercado Livre

### 1. Acessar o Painel de Desenvolvedores

1. Acesse: https://developers.mercadolivre.com.br/devcenter
2. Faça login com sua conta do Mercado Livre
3. Localize a aplicação com Client ID: `8423050287338772`

### 2. Configurar Redirect URIs

Na seção **"Redirect URIs"**, adicione as seguintes URLs **EXATAMENTE** como mostrado:

```
https://cyberdock-backend.onrender.com/api/ml/callback
http://localhost:3001/api/ml/callback
```

⚠️ **IMPORTANTE:**
- Use `https://` para o Render
- Use `http://` para localhost
- Inclua `/api/ml/callback` no final
- Não adicione barras extras

### 3. Configurar Domínios Permitidos

Na seção **"Allowed Domains"**, adicione:

```
cyberdock.com.br
cyberdock-backend.onrender.com
localhost
```

### 4. Verificar Modo de Produção

✅ Certifique-se de que a aplicação está em **MODO PRODUÇÃO** (não sandbox)

### 5. Salvar e Aguardar

- Clique em **Salvar**
- Aguarde **5-10 minutos** para as configurações propagarem

## Configuração no Render

### Variáveis de Ambiente Necessárias

No painel do Render, configure as seguintes variáveis de ambiente:

```env
NODE_ENV=production
PORT=3001

# Frontend URL
FRONTEND_URL=https://cyberdock.com.br

# Mercado Livre OAuth
ML_CLIENT_ID=8423050287338772
ML_CLIENT_SECRET=WWYgt9KH0HtZFH4YzD2yhrOLYHCUST9D
ML_REDIRECT_URI=https://cyberdock-backend.onrender.com/api/ml/callback

# PostgreSQL (se não estiver configurado)
PGUSER=postgres_cyber_dock_user
PGHOST=dpg-d29mquer433s739ir01g-a.oregon-postgres.render.com
PGDATABASE=postgres_cyber_dock
PGPASSWORD=KVT8w15r7n2EDQQ7w4TNxI8HvR09JZ0u
PGPORT=5432
```

### Como Adicionar Variáveis no Render

1. Acesse o dashboard do Render: https://dashboard.render.com
2. Selecione o serviço `cyberdock-backend`
3. Vá em **Environment** no menu lateral
4. Adicione cada variável de ambiente listada acima
5. Clique em **Save Changes**
6. O Render irá fazer o redeploy automaticamente

## Testando a Integração

### 1. Verificar se o Backend Está Online

```bash
curl https://cyberdock-backend.onrender.com/health
```

**Resposta esperada:**
```json
{"ok":true}
```

### 2. Testar Rotas do Mercado Livre

```bash
curl https://cyberdock-backend.onrender.com/api/ml/config-check
```

**Resposta esperada:**
```json
{
  "status": "ok",
  "redirectUri": "https://cyberdock-backend.onrender.com/api/ml/callback",
  "clientIdConfigured": true,
  "clientSecretConfigured": true
}
```

### 3. Testar no Frontend

1. Acesse: https://cyberdock.com.br/contas
2. Clique em **"Conectar Conta Mercado Livre"**
3. Leia o aviso sobre múltiplas contas
4. Clique em **"Conectar"**
5. Você será redirecionado para o login do Mercado Livre
6. Faça login e autorize a aplicação
7. Você será redirecionado de volta para `/contas` com a mensagem de sucesso

## Fluxo de Autenticação OAuth

```
1. Usuário clica em "Conectar Conta"
   ↓
2. Frontend redireciona para:
   https://cyberdock-backend.onrender.com/api/ml/auth?uid=USER_UID
   ↓
3. Backend gera PKCE e redireciona para:
   https://auth.mercadolibre.com/authorization?...
   ↓
4. Usuário faz login no Mercado Livre
   ↓
5. ML redireciona de volta para:
   https://cyberdock-backend.onrender.com/api/ml/callback?code=...
   ↓
6. Backend troca o code por access_token e refresh_token
   ↓
7. Backend salva tokens no PostgreSQL (tabela ml_accounts)
   ↓
8. Backend redireciona para:
   https://cyberdock.com.br/contas?success=Conta conectada!
```

## Conectar Múltiplas Contas

Para conectar múltiplas contas do Mercado Livre:

1. Conecte a primeira conta normalmente
2. **IMPORTANTE:** Faça logout do Mercado Livre no navegador
3. Volte em `/contas` e clique novamente em "Conectar Conta Mercado Livre"
4. Faça login com a segunda conta
5. Repita o processo para quantas contas precisar

⚠️ **Por quê preciso deslogar?**
O Mercado Livre mantém a sessão ativa, então se você não deslogar, ele vai reconectar a mesma conta.

## Solução de Problemas

### Erro: "Cannot GET /api/ml/test" no Render

**Possíveis causas:**
1. O código não foi deployado no Render
2. O servidor está crashando ao iniciar
3. As rotas não estão sendo registradas

**Solução:**
1. Verifique os logs do Render
2. Force um novo deploy:
   ```bash
   git commit --allow-empty -m "Trigger Render deploy"
   git push
   ```
3. Aguarde o deploy completar (pode levar 2-5 minutos)
4. Teste novamente: `curl https://cyberdock-backend.onrender.com/api/ml/test`

### Erro 403 CloudFront

Este erro ocorre **antes** da página de login carregar.

**Causa:** URL de callback não está cadastrada no painel do ML

**Solução:**
1. Verifique se `https://cyberdock-backend.onrender.com/api/ml/callback` está na lista de Redirect URIs
2. Certifique-se de que está **exatamente** como mostrado (com https://)
3. Aguarde 5-10 minutos após salvar
4. Limpe o cache do navegador (Ctrl+Shift+Del)
5. Tente novamente

### Erro: invalid_grant

**Causa:** URL de callback incorreta ou não cadastrada

**Solução:**
1. Confirme que a URL no código é **exatamente** igual à URL cadastrada no ML
2. Verifique o arquivo `backend/router/mercadolivre.js` linha 21:
   ```javascript
   const REDIRECT_URI = process.env.ML_REDIRECT_URI || 'https://cyberdock-backend.onrender.com/api/ml/callback';
   ```
3. Se a variável de ambiente `ML_REDIRECT_URI` estiver configurada, ela deve ter o valor correto

### Conta não aparece na lista

**Causa:** Erro ao salvar no banco de dados

**Solução:**
1. Verifique os logs do Render
2. Confirme que as variáveis de ambiente do PostgreSQL estão corretas
3. Teste a conexão com o banco:
   ```sql
   SELECT * FROM ml_accounts;
   ```

## Arquivos Relevantes

### Frontend
- `src/views/ContasView.vue` - Página de contas
- `src/components/MercadoLivreConnect.vue` - Botão de conexão
- `src/config.js` - URLs do backend

### Backend
- `backend/router/mercadolivre.js` - Rotas OAuth do ML
- `backend/router/index.js` - Registro das rotas
- `backend/server.js` - Servidor principal
- `backend/utils/init-db.js` - Schema do banco de dados
- `backend/utils/postgres.js` - Conexão com PostgreSQL

## Verificação Final

Antes de considerar a configuração completa, verifique:

- [ ] Variáveis de ambiente configuradas no Render
- [ ] URLs de callback cadastradas no painel do ML
- [ ] Domínios permitidos configurados
- [ ] Aplicação em modo **Produção** (não sandbox)
- [ ] Backend respondendo: `curl https://cyberdock-backend.onrender.com/health`
- [ ] Rotas ML respondendo: `curl https://cyberdock-backend.onrender.com/api/ml/config-check`
- [ ] Teste completo de conexão funcionando
- [ ] Contas aparecendo na lista após conexão

## Logs Úteis

### Ver logs do Render
1. Acesse: https://dashboard.render.com
2. Selecione `cyberdock-backend`
3. Clique em **Logs** no menu lateral
4. Procure por:
   ```
   [ML Auth] Iniciando autenticação para UID: ...
   [ML Callback] Processando callback com redirect_uri: ...
   ```

### Ver logs do PostgreSQL
```sql
-- Ver todas as contas conectadas
SELECT uid, user_id, nickname, status, connected_at
FROM ml_accounts
ORDER BY connected_at DESC;

-- Ver tokens (apenas para debug, não compartilhe!)
SELECT * FROM ml_accounts WHERE uid = 'SEU_UID';
```

## Contato e Suporte

Se após seguir todos os passos a integração ainda não funcionar:

1. Verifique os logs do Render
2. Confirme que **todas** as URLs estão **exatamente** como especificado
3. Aguarde 10 minutos após salvar no painel do ML
4. Tente em uma aba anônima
5. Teste com curl antes de testar no navegador

## Links Importantes

- **Painel de Desenvolvedores ML:** https://developers.mercadolivre.com.br/devcenter
- **Documentação OAuth ML:** https://developers.mercadolivre.com.br/pt_br/autenticacao-e-autorizacao
- **Dashboard Render:** https://dashboard.render.com
- **CyberDock Frontend:** https://cyberdock.com.br
- **CyberDock Backend:** https://cyberdock-backend.onrender.com
