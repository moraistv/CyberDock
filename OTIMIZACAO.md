# OTIMIZAÇÃO — Sincronização de Vendas CyberDock (registro completo)

> Documento detalhado de tudo que foi analisado, decidido e implementado para
> resolver a lentidão (~7 min, chegando a 3–6 min por conta grande) e as
> contagens erradas ("atualizadas" fantasmas) na sincronização de vendas do
> Mercado Livre. Inclui o código, o porquê de cada decisão, os commits, as
> descobertas na API do ML e o que ainda falta.

---

## 1. Contexto e problema original

O CyberDock sincroniza vendas do Mercado Livre (ML) para PostgreSQL. Sintomas:

- Sincronização demorando **minutos** (ex.: 36s em 3 dias, 3m17s em 30 dias, 6m19s em 180 dias no tabelão master com 21 contas).
- O modal mostrava **"Novas Vendas Encontradas"** com números enormes e **repetidos** a cada clique (ex.: 95, 133, 329, 1641, 4052) — mesmo sem ter vendido nada.
- Risco de bloqueio (429) da API do ML ao aumentar concorrência sem controle.
- Modal feio, com emojis, sem informação útil (contas sem novidade poluindo a lista).

### Meta
- Clique responde rápido; sincronização incremental em segundos.
- "Atualizada" = mudança **real**, não regravação.
- Nunca tomar 429/bloqueio.
- Modal profissional, com números reais, progresso ao vivo e tempo.

---

## 2. Arquitetura / topologia de deploy (MUITO importante)

Existem **dois repositórios separados**, cada um é um serviço no Coolify:

| Repositório | O que é | Onde roda |
|---|---|---|
| `moraistv/CyberDock` (raiz do projeto) | **Backend** Node/Express (`server.js`, `router/`, `utils/`) | `api.cyberdock.com.br` |
| `moraistv/cyberdock-frontend` | **Frontend** Vue (build → nginx) | `cyberdock.com.br` |

> ⚠️ Existe também uma pasta `cyberdock-frontend/backend/` que é uma **cópia
> morta** do backend (não deployada). No começo, mudanças de backend foram
> feitas nela por engano e não surtiam efeito. **O backend real é o da raiz.**

Cada push na `main` do respectivo repo dispara o deploy daquele serviço no
Coolify. Uma correção de backend só vale quando o serviço do `CyberDock`
redeploya; uma de UI só vale quando o `cyberdock-frontend` redeploya.

---

## 3. Descobertas sobre a API do Mercado Livre (base das decisões)

1. **`/orders/search?seller=X` já retorna o pedido praticamente completo**:
   `id`, `status`, `status_detail`, `date_created`, `date_closed`,
   `date_last_updated`, `order_items`, `payments`, `shipping` (com `id`,
   `status`, `substatus`, `shipping_mode`), `buyer`, `seller`, `tags`.
   → Dá pra saber o que mudou **sem** baixar o detalhe.

2. **Filtro incremental**: a busca aceita `order.date_last_updated.from`, então
   é possível pedir "só o que mudou desde X".

3. **O ML altera `date_last_updated` por eventos internos**, sem mudança real.
   A doc de notificações admite: *"there are internal events that are not
   visible to the integrator, but that trigger notifications"* e *"sometimes
   there is no evident change from the previous JSON"*. Foi a causa das
   "atualizadas" fantasmas de vendas antigas.

4. **Status "final" pode mudar**: a doc lista substatus como `returned`,
   `returning_to_sender`, `stolen`, `refused_delivery` e tags como `restocked`,
   `claim_opened`/`claim_closed`. Ou seja, um pedido entregue pode virar
   devolução/reclamação depois — **não dá para assumir finalidade eterna**.

5. **Shipments** exigem chamadas separadas: `/shipments/{id}` e
   `/shipments/{id}/sla`, e a doc atual recomenda o header `x-format-new: true`.

6. **Rate limit / 429**: a doc recomenda backoff exponencial com jitter,
   respeitar `Retry-After`, reduzir concorrência e distribuir as chamadas.

7. **Notificações (webhook)**: tópicos `orders`, `orders_v2`, `created_orders`,
   `shipments`. Corpo: `{ resource, user_id, topic, ... }`. Precisa responder
   HTTP 200 em até 20s; o ML reenvia por 12h se falhar.

Referências:
- Pedidos: https://developers.mercadolivre.com.br/en_us/api-docs/order-management
- Notificações: https://developers.mercadolivre.com.br/en_us/api-docs/products-receive-notifications
- Rate limit/429: https://developers.mercadolivre.com.br/en_us/api-docs/rate-limit-429-error

---

## 4. Mudanças no BACKEND (repo `CyberDock`)

### 4.1. Cliente ML central — `utils/mlClient.js` (NOVO)

Todas as chamadas ao ML passam por aqui. Resolve rate limit e resiliência.

- **Limitador GLOBAL de concorrência** (por processo, compartilhado por todas as
  contas/jobs): mesmo com várias contas em paralelo, o total de chamadas
  simultâneas nunca estoura o teto.
- **Timeout por requisição** (AbortController) — nenhuma chamada trava o job.
- **Backoff exponencial com jitter** para `429`, `408` e `5xx`; respeita
  `Retry-After`.
- **Concorrência adaptativa**: cai pela metade em `429` e se recupera devagar.

```js
const HARD_MAX = parseInt(process.env.ML_MAX_CONCURRENCY || '24', 10);
const MIN_LIMIT = parseInt(process.env.ML_MIN_CONCURRENCY || '4', 10);
let currentLimit = HARD_MAX, active = 0; const queue = [];

async function mlFetch(url, options = {}) {
  const { timeoutMs = 15000, retries = 4, ...fetchOpts } = options;
  await acquire();                       // respeita o limite global atual
  try {
    let attempt = 0, lastErr = null;
    while (attempt <= retries) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, { ...fetchOpts, signal: controller.signal });
        clearTimeout(timer);
        if (res.status === 429) throttleDown();
        if (isRetryableStatus(res.status) && attempt < retries) {
          await sleep(backoffDelay(attempt, res.headers.get('retry-after')));
          attempt++; continue;
        }
        return res;
      } catch (err) { clearTimeout(timer); /* backoff e retry */ }
    }
  } finally { release(); }
}
```

Variáveis de ambiente: `ML_MAX_CONCURRENCY` (24), `ML_MIN_CONCURRENCY` (4),
`ML_TIMEOUT_MS` (15000), `ML_MAX_RETRIES` (4), `ML_JOB_CONCURRENCY` (15).

### 4.2. `router/sales.js` — fluxo de sincronização

**(a) Headers e concorrência**
```js
const { mlFetch } = require('../utils/mlClient');
const shipmentHeaders = (t) => ({ Authorization: `Bearer ${t}`, 'x-format-new': 'true' });
const SLA_CONCURRENCY = parseInt(process.env.ML_JOB_CONCURRENCY || '15', 10);
```

**(b) Passagem ÚNICA de enriquecimento (antes eram 3 varreduras)**
Antes: uma passagem buscava detalhe de todos, outra buscava shipment de todos,
outra o SLA. Agora, por pedido: busca o detalhe e, se tiver envio, dispara
shipment **e** SLA em paralelo (`Promise.all`). Elimina uma passagem inteira e
paraleliza as duas chamadas de logística.

```js
const enrichedOrders = await mapWithConcurrency(toProcess, SLA_CONCURRENCY, async (summary) => {
  let order = summary;
  const r = await mlFetch(`https://api.mercadolibre.com/orders/${summary.id}`, { headers: mlHeaders(access_token) });
  if (r.ok) order = await r.json();
  const shipmentId = order?.shipping?.id;
  if (shipmentId) {
    const [shipRes, slaRes] = await Promise.all([
      mlFetch(`.../shipments/${shipmentId}`, { headers: shipmentHeaders(access_token) }),
      mlFetch(`.../shipments/${shipmentId}/sla`, { headers: shipmentHeaders(access_token) }),
    ]);
    // merge shipment + sla no order
  }
  return order;
});
```

**(c) Busca por `date_last_updated` (corrige bug do `date_created`)**
Antes filtrava localmente por `date_created >= lastSyncDate`, o que **descartava
pedidos antigos atualizados recentemente**. Agora usa
`order.date_last_updated.from` e aproveita todos os resultados da busca.

**(d) Cursor incremental + fim do seletor de período**
A janela de busca usa o **maior `date_last_updated` já salvo** da conta como
marco (menos 2 min de margem). Assim, clicar de novo busca só o que mudou desde
a última vez. O dropdown de 3/7/180 dias foi **removido** (não fazia sentido e
induzia a reler tudo).

```sql
SELECT MAX(date_last_updated) AS cursor FROM public.sales WHERE uid=$1 AND seller_id=$2
```

**(e) Correção do backfill master**: agora sempre filtra por `(uid, seller_id)`
(antes o master filtrava só por `uid`, enriquecendo vendas de outras contas do
mesmo cliente com o token errado → risco de `caller.id mismatch`).

**(f) Buffer de eventos SSE**: como o sync incremental ficou rápido, o job podia
terminar **antes** do `EventSource` conectar e o evento `progress:100` se perdia
(tela travava). Agora os eventos são guardados e entregues assim que o SSE
conecta.

### 4.3. Contagem honesta: novas × atualizadas × sem alteração

**Problema:** o backend mandava `newSalesCount = allRows.length` (tudo que
processou), então toda venda regravada contava como "nova". E o `DO UPDATE`
rodava sempre, contando como "atualizada" mesmo sem mudança.

**Correções:**
- `RETURNING (xmax = 0) AS inserted` no upsert distingue INSERT (xmax=0) de
  UPDATE. Assim `newSalesCount` = inserções reais.
- O `DO UPDATE` só ocorre quando algo relevante mudou (`IS DISTINCT FROM`), então
  "atualizada" = mudança real e não há escrita à toa no banco.
- Resultado final envia `newSalesCount`, `updatedCount` e `skippedCount`
  (sem alteração = pulados antes de baixar + baixados-mas-iguais).

### 4.4. A grande virada: pular por ASSINATURA de mudança real

**Evolução da estratégia (o porquê de cada passo):**
1. Primeiro tentei pular por `date_last_updated` (se não avançou, pula). Mas o ML
   **bumpa** essa data em pedidos antigos sem mudança real → milhares de
   "atualizadas" fantasmas.
2. Tentei "pedido finalizado (entregue/cancelado) nunca reprocessa". Errado: a
   doc do ML mostra que entregue pode virar **devolução/reclamação** depois.
3. Solução correta: **assinatura de mudança**. Como a busca já traz `status`,
   `shipping.status`, `shipping.substatus` e `tags`, comparo:

```
sync_signature = status | shipping.status | shipping.substatus | tags(ordenadas)
```

- **Igual** à salva → nada relevante mudou (só bump interno) → **pula sem baixar**.
- **Diferente** → mudança real (pagou, despachou, entregou, devolveu, reclamou) →
  **processa**.

Isso não assume finalidade: devolução/reclamação muda a assinatura e é captada.

**Coluna dedicada + backfill** (em `utils/init-db.js`), para ser confiável e não
depender de parsear JSON toda hora:
```sql
ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS sync_signature TEXT;
UPDATE public.sales SET sync_signature =
   COALESCE(raw_api_data->>'status','') || '|' ||
   COALESCE(raw_api_data->'shipping'->>'status','') || '|' ||
   COALESCE(raw_api_data->'shipping'->>'substatus','') || '|' ||
   COALESCE((SELECT string_agg(t, ',' ORDER BY t)
               FROM jsonb_array_elements_text(raw_api_data->'tags') t), '')
 WHERE sync_signature IS NULL AND raw_api_data IS NOT NULL;
```

Helper em JS (tem que bater EXATO com o SQL):
```js
function computeSyncSignature(o) {
  const tags = Array.isArray(o?.tags) ? o.tags.slice().sort().join(',') : '';
  return `${o?.status||''}|${o?.shipping?.status||''}|${o?.shipping?.substatus||''}|${tags}`;
}
```

Skip na sincronização:
```js
const remoteSig = computeSyncSignature(summary);
if (storedSig != null && storedSig === remoteSig) { skippedCount++; continue; }
toProcess.push(summary);
```

### 4.5. Pool PostgreSQL e índices — `utils/postgres.js` e `utils/init-db.js`

Pool dimensionado + timeouts (jobs paralelos não esgotam conexões nem deixam
query travada segurando conexão):
```js
max: process.env.PGPOOL_MAX ? +process.env.PGPOOL_MAX : 15,
connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000,
statement_timeout: 30000, query_timeout: 30000,
application_name: 'cyberdock-backend',
```

Índices (com `SET LOCAL statement_timeout = 0` na transação para não abortar em
tabela grande):
```
idx_sales_uid_seller_updated (uid, seller_id, updated_at DESC)
idx_sales_uid_seller_saledate (uid, seller_id, sale_date DESC)
idx_sales_uid_seller_dlu (uid, seller_id, date_last_updated DESC)
```
Colunas novas: `date_last_updated TIMESTAMPTZ`, `sync_signature TEXT` (ambas com
backfill a partir do `raw_api_data`).

### 4.6. Webhook do Mercado Livre — `POST /api/sales/webhook/ml` (tempo real)

Receptor de notificações. Responde 200 na hora e sincroniza **só o pedido
notificado** (detalhe + shipment + SLA + upsert), com renovação de token e dedup
simples. Trata `orders`, `orders_v2`, `created_orders` e `shipments` (para
shipments, busca o shipment para achar o `order_id`).

```js
router.post('/webhook/ml', async (req, res) => {
  res.sendStatus(200);                       // ML exige 200 rápido
  const { resource, user_id: sellerId, topic } = req.body || {};
  // dedup 10s; resolve conta pelo seller; extrai orderId de /orders/ ou /shipments/
  // fetchOrderEnriched(orderId) -> upsertSingleOrder(order, uid, nickname)
});
```

> Para ativar: no painel do app ML, **Callback URL** =
> `https://api.cyberdock.com.br/api/sales/webhook/ml` e marcar os tópicos.
> Com isso, vendas entram/atualizam **sozinhas** em segundos, sem clicar.

---

## 5. Mudanças no FRONTEND (repo `cyberdock-frontend`)

### 5.1. `composables/useSyncManager.js` — orquestração

- **Sync incremental por padrão**: cliques repetidos leem só o que mudou; deixou
  de reler a janela inteira; backfill pesado só na primeira vez.
- **`syncAccountsBatch(accounts, { concurrency })`**: sincroniza várias contas em
  **paralelo controlado** (3 por vez), cada uma com seu próprio canal SSE. Antes
  era uma conta por vez, com `setTimeout(1000)` entre cada e `fetchSales()` a
  cada conta (recarregava a tabela N vezes).
- **`liveAccounts`**: estado ao vivo por conta (progresso, status, mensagem,
  novas/atualizadas/sem alteração, duração) atualizado em tempo real via SSE.
- **Métricas propagadas**: `newSalesCount`, `updatedCount`, `skippedCount` e
  duração por conta e total.

### 5.2. Telas `TabelaVendas.vue` e `AdminView.vue`

- Removidas as **esperas de 1s** e as **recargas por conta** (recarrega uma vez
  ao final).
- Passaram a usar `syncAccountsBatch`.
- **Removido o seletor de período** (3/7/180 dias): a sincronização é sempre
  incremental (só mudanças).

### 5.3. Modal de resultado — redesign profissional

- **Sem emojis**; ícones **SVG** de verdade.
- Cartões: **Contas · Vendas novas · Atualizadas · Sem alteração · Falharam ·
  Tempo total**, com **contadores animados** (count-up via gsap), hover, sombras
  e números tabulares.
- Badges por conta ("2 novas", "5 atualizadas", "sem alteração") e **tempo por
  conta**.
- No tabelão master (`AdminView`), só lista **contas com novidade** (as sem nada
  não poluem); estado "Tudo em dia" quando nada mudou.

### 5.4. Painel de progresso AO VIVO — `components/SyncLiveModal.vue` (NOVO)

Durante a sincronização abre um painel com **barra geral** + **uma barra por
conta** enchendo em tempo real, spinner por conta, status (na fila → sincronizando
→ concluída/erro) e badges. Ao terminar, fecha e abre o resumo animado.

### 5.5. Tempo de sincronização

Medido no composable: **total** e **por conta**. Exibido no painel ao vivo e no
modal final (`820ms`, `3,4s`, `1m 05s`).

### 5.6. Bug corrigido: página congelava após fechar o modal

Era conflito de **trava de scroll** entre os dois modais (o painel ao vivo e o
resumo sobrescreviam o `overflow` do `body`). Correção: o painel ao vivo não mexe
mais na trava (`lock-scroll=false`); só o modal de resumo gerencia.

### 5.7. Lição de deploy: o build trata lint como erro

O build do frontend (`vue-cli-service build`) falha em `no-unused-vars`. Um
`eventSource` órfão derrubou um deploy. Desde então, sempre rodar
`npx eslint` / `npm run build` antes de commitar frontend. `node --check` só pega
sintaxe, não lint.

---

## 6. Linha do tempo de commits

### Backend (`moraistv/CyberDock`)
- `9e9d94f` — porta as otimizações para o backend real (mlClient, passagem única, contagem, buffer SSE, pool, índices).
- `c782b79` — skip confiável (uid+id, base em date_last_updated).
- `adf6671` — sincronização incremental por cursor.
- `06b4b77` — coluna `date_last_updated` + skip antes de baixar + "atualizada = mudança real".
- `518e223` — webhook do ML (orders/orders_v2/created_orders/shipments).
- `b0f1b7f` — (tentativa) pular finalizados — depois substituída.
- `2447ca8` — **pular por assinatura** (status/shipping/substatus/tags); pega devolução/reclamação e mata as "atualizadas" fantasmas.

### Frontend (`moraistv/cyberdock-frontend`)
- `26b13ee` — cliente/orquestração: sync paralelo, sem esperas/recargas.
- `78c1c3a` — fix lint que quebrava o build.
- `f412788` — contagem real de novas (xmax).
- `ee9f0a0` — pular pedidos inalterados.
- `2a30062` — redesign do modal (SVG, sem emojis, números reais).
- `a7a1c5c` — modal com contadores animados.
- `c03371a` — modal global (master) no mesmo padrão; só contas com novidade.
- `11b7dd6` — painel de progresso ao vivo por conta.
- `43d53c2` — fix da página congelada + tempo de sincronização.
- `48d88c7` — remove seletor de período (sempre incremental).

---

## 7. Resultado esperado

- **1ª sincronização** de uma conta nova: baixa o período/tudo uma vez (carimba
  `date_last_updated` e `sync_signature`).
- **Sincronizações seguintes**: a busca traz só os pedidos que o ML mexeu; a
  **assinatura** filtra pra processar só os que mudaram de verdade. Poucos
  pedidos processados → **segundos**, e "atualizadas" reflete mudança real.
- Devolução/reclamação em pedido antigo **é captada** (assinatura muda).
- Nunca toma 429 (limiter global + backoff).

Diagnóstico nos logs do Coolify:
```
[SYNC] CONTA uid=... seller=... cursor=... from=... 
[SYNC] CONTA encontrados=1200 paraProcessar=8 pulados=1192 (estadoSalvo=1200)
```
`paraProcessar` pequeno = skip funcionando.

---

## 8. O que ainda falta / próximos passos

1. **Ativar o webhook** no painel do ML (Callback URL + tópicos) — leva a
   experiência a "tempo real" de verdade (venda entra sozinha).
2. **Tempo real na tela**: o webhook mantém o banco atualizado, mas a tela só
   mostra ao recarregar. Falta um empurrão via SSE/WebSocket do backend para o
   frontend atualizar a lista sozinho quando um webhook chega.
3. **Segurança (P0 da auditoria original)**: `/ml/refresh-token` sem auth, tokens
   ML chegando ao frontend, SSE sem auth, `JWT_SECRET` com fallback inseguro.
   Continua pendente (foi despriorizado a pedido, mas é importante).
4. **Constraint única `(id, sku, uid)`**: garantir formalmente no schema (o
   upsert depende dela); auditar duplicatas antes.
5. **Fila persistente** (ex.: `FOR UPDATE SKIP LOCKED`) para o job não se perder
   em redeploy e para orquestração multi-conta robusta.

---

## 9. Variáveis de ambiente (backend)

| Var | Padrão | Função |
|---|---|---|
| `ML_MAX_CONCURRENCY` | 24 | Teto global de chamadas ML simultâneas |
| `ML_MIN_CONCURRENCY` | 4 | Piso quando em 429 |
| `ML_TIMEOUT_MS` | 15000 | Timeout por requisição ML |
| `ML_MAX_RETRIES` | 4 | Tentativas em 429/5xx |
| `ML_JOB_CONCURRENCY` | 15 | Concorrência de despacho por conta |
| `PGPOOL_MAX` | 15 | Máx. de conexões no pool PostgreSQL |
| `ML_CLIENT_ID` / `ML_CLIENT_SECRET` | — | OAuth do app ML (refresh de token) |

---

## 10. Correção do "Outros" na modalidade de envio (pós-otimização)

### O que apareceu
Depois das mudanças de sincronização, várias vendas passaram a aparecer com a
modalidade **"Outros"** — o que **nunca acontecia** antes. Modalidades válidas:
FULL, FLEX, Correios, Agência, Coleta, Envio Padrão. "Outros" é o fallback.

### Causa raiz
A modalidade é derivada de `order.shipping.logistic_type`, que é preenchido pelo
**detalhe do shipment** (`/shipments/{id}`). Na fase de otimização eu havia
adicionado o header **`x-format-new: true`** nessas chamadas (era uma
"recomendação" da auditoria, item #13). No **formato novo** do ML a estrutura do
shipment muda e o `logistic_type` **não vem no mesmo lugar** → o código lia
`undefined` → `mapShippingType(undefined)` retornava **"Outros"**.

Ou seja: foi um efeito colateral do `x-format-new`, não um problema de dados.

### Correções aplicadas (backend `CyberDock`)
- **Removido o `x-format-new`** dos shipments (voltou o formato clássico, que
  traz `logistic_type`). (commit `5b4386c`)
- **Fallback** na resolução da modalidade:
  `order.shipping.logistic_type || order.shipping.mode || order.shipping.shipping_mode`.
- **Autocorreção incremental**: o skip por assinatura abre exceção para vendas
  salvas como "Outros"/nula, reprocessando-as uma vez para gravar a modalidade
  correta.
- **Endpoint de manutenção** `GET /api/sales/fix-shipping-modes` (master):
  rebusca o shipment (com `logistic_type`), recalcula e corrige em lotes; aceita
  `?limit=` e `?sellerId=`. (commits `41d5a0c`, `d518745`)

### Descoberta útil da API (documentada para o futuro)
O `/orders/search` já retorna, por pedido: `status`, `shipping.status`,
`shipping.substatus`, `tags`, `date_created`, `date_last_updated`,
`order_items`, `shipping.id`, `shipping.shipping_mode`. Por isso a decisão de
"mudou ou não" (assinatura) e a modalidade podem sair da própria busca, barato.

### Resultado e limpeza de UI
- Rodada a correção pelo botão do master: **mais de 4.000 vendas** reprocessadas,
  **tudo OK**, "Outros" zerado.
- Como não deve mais existir "Outros", foi **removida a opção "Outros"** do
  filtro de Modo de Envio (tabelão master).
- O **botão "Corrigir modalidades"** foi **removido** após cumprir o papel (o
  endpoint de backend permanece disponível para manutenção futura, se preciso).

### Bônus: falha de deploy no Coolify (infra, não código)
Dois deploys do frontend falharam — um morrendo no `npm run build` e outro ainda
antes, no `apt-get` (unpacking do curl). São sintomas de **falta de recurso na
VPS** (disco cheio e/ou RAM/memória esgotada), não de erro de código (compila
100% local). Mitigações: `productionSourceMap: false` no `vue.config.js` (menos
memória/tempo de build, bundle menor — commit `4dd867e`) e, na VPS, limpar
imagens/cache do Docker (`docker builder/image/system prune -af`, sem
`--volumes`) e adicionar swap se a RAM for baixa.
