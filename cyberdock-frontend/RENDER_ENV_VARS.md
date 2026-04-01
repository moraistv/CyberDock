# Variáveis de Ambiente para o Render

## ⚠️ IMPORTANTE: Configurar EXATAMENTE como mostrado abaixo

No dashboard do Render (https://dashboard.render.com), configure:

### Variáveis Obrigatórias

| Nome da Variável | Valor |
|------------------|-------|
| `NODE_ENV` | `production` |
| `PORT` | `3001` |
| `FRONTEND_URL` | `https://cyberdock.com.br` |
| `ML_CLIENT_ID` | `8423050287338772` |
| `ML_CLIENT_SECRET` | `WWYgt9KH0HtZFH4YzD2yhrOLYHCUST9D` |
| `ML_REDIRECT_URI` | `https://cyberdock-backend.onrender.com/api/ml/callback` |

### ⚠️ ATENÇÃO CRÍTICA

**Estas 2 variáveis são CRUCIAIS para o funcionamento correto:**

1. **FRONTEND_URL** = `https://cyberdock.com.br`
   - Após autenticar no ML, o usuário será redirecionado para: `https://cyberdock.com.br/contas`
   - ❌ Se estiver vazio ou incorreto, o usuário não volta para o site

2. **ML_REDIRECT_URI** = `https://cyberdock-backend.onrender.com/api/ml/callback`
   - Esta URL recebe o callback do Mercado Livre
   - ⚠️ DEVE ter `/api/ml/callback` (não apenas `/ml/callback`)

### ⚠️ ATENÇÃO ESPECIAL

**ML_REDIRECT_URI DEVE TER `/api/ml/callback`** (não apenas `/ml/callback`)

✅ Correto: `https://cyberdock-backend.onrender.com/api/ml/callback`
❌ Errado: `https://cyberdock-backend.onrender.com/ml/callback`

### Variáveis PostgreSQL (se ainda não configuradas)

| Nome da Variável | Valor |
|------------------|-------|
| `PGUSER` | `postgres_cyber_dock_user` |
| `PGHOST` | `dpg-d29mquer433s739ir01g-a.oregon-postgres.render.com` |
| `PGDATABASE` | `postgres_cyber_dock` |
| `PGPASSWORD` | `KVT8w15r7n2EDQQ7w4TNxI8HvR09JZ0u` |
| `PGPORT` | `5432` |

## Como Adicionar/Editar no Render

1. Acesse: https://dashboard.render.com
2. Clique no serviço `cyberdock-backend`
3. Vá em **Environment** no menu lateral esquerdo
4. Para editar uma variável existente:
   - Clique no ícone de lápis ao lado da variável
   - Altere o valor
   - Clique em **Save**
5. Para adicionar uma nova variável:
   - Clique em **Add Environment Variable**
   - Digite o nome e valor
   - Clique em **Save**
6. Após salvar, clique em **Save Changes** no topo da página
7. O Render fará o redeploy automaticamente (aguarde 2-3 minutos)

## Verificação

Após configurar, teste:

```bash
curl https://cyberdock-backend.onrender.com/api/ml/config-check
```

Deve retornar:
```json
{
  "status": "ok",
  "redirectUri": "https://cyberdock-backend.onrender.com/api/ml/callback",
  ...
}
```

Se o `redirectUri` não tiver `/api`, a variável ainda está incorreta.
