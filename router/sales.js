// routes/sales.js
const express = require('express');
const db = require('../utils/postgres');
const { authenticateToken, requireMaster, requireOwnerOrMaster } = require('../utils/authMiddleware');
const fetch = require('node-fetch');
const { mlFetch } = require('../utils/mlClient');

const router = express.Router();

// Headers padrão para chamadas ao ML. x-format-new é recomendado pela doc
// atual para /shipments, garantindo o formato novo de resposta.
const mlHeaders = (access_token, extra = {}) => ({
  Authorization: `Bearer ${access_token}`,
  ...extra
});
// NÃO usar x-format-new: o formato novo do ML muda a estrutura do shipment e o
// campo logistic_type deixa de vir onde o código espera, fazendo a modalidade
// cair em "Outros". Mantemos o formato clássico (que traz logistic_type).
const shipmentHeaders = (access_token) => mlHeaders(access_token);

const clients = {};
// Buffer de eventos por clientId para o caso de o job começar/terminar antes
// do EventSource conectar (mais provável agora que o sync incremental é rápido).
// Sem isto, o evento de progresso 100 poderia se perder e a tela ficaria presa.
const pendingEvents = {};
// Mesmo motivo do shopee.js: uma reconexão que passe do TTL perderia o evento
// final e deixaria a conta presa em "sincronizando".
const PENDING_TTL_MS = 5 * 60 * 1000;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Recovery ceiling for an account whose cursor was previously stale. Normal
// incremental runs should be tiny; 10k lets an existing 5k backlog drain once
// and then return to the fast cursor path.
const MAX_ORDERS = parseInt(process.env.ML_MAX_ORDERS_PER_SYNC || '10000', 10);
const PAGE_LIMIT = 50;
// Concorrência de despacho por conta. O teto real de chamadas simultâneas ao
// ML é controlado GLOBALMENTE pelo limiter em utils/mlClient.js.
const SLA_CONCURRENCY = parseInt(process.env.ML_JOB_CONCURRENCY || '24', 10);
const UPSERT_BATCH_SIZE = 300;

const MAX_PROCESS_BATCH = 500;

/* Processamento de despacho em lote.
 *
 * Cada venda precisa da PRÓPRIA transação (uma falha de estoque não pode
 * desfazer as outras), e cada transação faz de 6 a 8 idas ao banco. Em série,
 * um lote de 500 vendas somava milhares de idas e voltas numa única conexão.
 *
 * A concorrência é modesta de propósito: o pool tem 15 conexões e o mesmo
 * banco atende as telas. Disputa de lock entre duas vendas do mesmo SKU é
 * tratada com repetição em série, não evitada por serializar tudo.
 */
const PROCESS_CONCURRENCY = configInt('SALES_PROCESS_CONCURRENCY', 4, 1, 8);
const LOCK_CONFLICT_CODES = new Set([
  '40P01', // deadlock_detected
  '40001', // serialization_failure
  '55P03', // lock_not_available
]);

/** Lê um inteiro de ambiente com limites, tolerando valor inválido. */
function configInt(name, fallback, min, max) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  const value = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(max, Math.max(min, value));
}

/* ----------------------- Cache curto do total de vendas -------------------
 * O COUNT(*) da view unificada varre as duas tabelas de origem e era refeito
 * em TODA requisição da tabela — inclusive ao trocar de página, quando o total
 * não muda. Com TTL curto, paginar e reabrir a tela deixa de pagar esse custo
 * e o número volta a se atualizar poucos segundos após uma sincronização.
 */
const salesCountCache = new Map();
const salesCountInFlight = new Map();
// 20s era pouco: paginar, abrir um filtro e voltar já estourava o TTL e pagava
// a contagem de novo. Uma sincronização leva minutos para rodar, então o total
// não muda com essa frequência.
const SALES_COUNT_TTL_MS = configInt('SALES_COUNT_TTL_MS', 90000, 5000, 600000);
const SALES_COUNT_CACHE_MAX = 500;

/* ---------------------- Cache curto de resposta agregada -------------------
 * Dashboard, facetas de filtro e opções do tabelão rodam de 5 a 7 agregações
 * cada, sobre as mesmas linhas, e a tela dispara todas juntas ao abrir — além
 * de repetir tudo a cada volta ao painel. O resultado é idêntico dentro de uma
 * janela de segundos, então vale guardar a resposta pronta.
 *
 * `inFlight` é tão importante quanto o TTL: sem ele, dois cliques rápidos (ou o
 * dashboard e a tabela abrindo juntos) disparam a mesma bateria de agregações
 * em paralelo e ocupam metade do pool de 15 conexões.
 */
const responseCache = new Map();
const responseInFlight = new Map();
const RESPONSE_CACHE_MAX = 400;

function withResponseCache(key, ttlMs, producer) {
  const hit = responseCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.payload);
  if (hit) responseCache.delete(key);

  const running = responseInFlight.get(key);
  if (running) return running;

  const promise = Promise.resolve()
    .then(producer)
    .then((payload) => {
      if (responseCache.size >= RESPONSE_CACHE_MAX) {
        const oldest = responseCache.keys().next().value;
        if (oldest !== undefined) responseCache.delete(oldest);
      }
      responseCache.set(key, { payload, at: Date.now() });
      return payload;
    })
    .finally(() => responseInFlight.delete(key));

  responseInFlight.set(key, promise);
  return promise;
}

/** Chave estável a partir dos parâmetros que realmente afetam o resultado. */
function cacheKeyFromQuery(prefix, query, fields) {
  const parts = fields.map((f) => `${f}=${String(query[f] ?? '').trim()}`);
  return `${prefix}|${parts.join('&')}`;
}

/* Teto da contagem exata.
 *
 * COUNT(*) sobre public.unified_sales é caro por um motivo específico: o
 * Postgres NÃO elimina colunas não usadas de um UNION ALL, então mesmo contando
 * linhas ele avalia a lista de saída da view — extração de JSONB, regex e cast
 * do prazo, thumbnail, comprador — para CADA linha das duas tabelas. No tabelão
 * admin, que não filtra por dono, isso varria a base inteira de todos os
 * clientes e era o que deixava a tela em dezenas de segundos.
 *
 * Contando com LIMIT, o trabalho fica limitado: filtros do dia a dia (que é o
 * uso real) devolvem número exato, e recortes gigantes viram "60.000+" em vez
 * de travar a tela para exibir um número que ninguém lê.
 *
 * O teto anterior (10.000) era menor que a base real e travava o número de
 * "todos os períodos" num valor que parecia errado. Como a contagem roda em
 * SEGUNDO PLANO (a página já foi entregue) e fica em cache, subir o teto não
 * atrasa a tela; no pior caso o total continua aproximado.
 */
const SALES_COUNT_MAX = parseInt(process.env.SALES_COUNT_MAX || '60000', 10);

/* Espera após uma contagem que falhou (normalmente statement timeout).
 * Sem isso, cada requisição dispararia de novo a mesma varredura pesada, já
 * que só sucesso vai para o cache. */
const salesCountCooldown = new Map();
const SALES_COUNT_COOLDOWN_MS = 60000;

function getCachedSalesCount(key) {
  const hit = salesCountCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > SALES_COUNT_TTL_MS) {
    salesCountCache.delete(key);
    return null;
  }
  return hit.total;
}

function setCachedSalesCount(key, total) {
  // O Map preserva ordem de inserção, então a primeira chave é a mais antiga.
  if (salesCountCache.size >= SALES_COUNT_CACHE_MAX) {
    const oldest = salesCountCache.keys().next().value;
    if (oldest !== undefined) salesCountCache.delete(oldest);
  }
  salesCountCache.set(key, { total, at: Date.now() });
}

/**
 * Executa no máximo um COUNT por combinação de filtros. A listagem não espera
 * esta Promise: ela entrega a página assim que o LIMIT termina e a contagem é
 * resolvida em segundo plano. Uma chamada countOnly pode aguardar a mesma
 * Promise sem disparar outra varredura concorrente.
 */
function loadSalesCount(key, query, params) {
  const cached = getCachedSalesCount(key);
  if (cached !== null) return Promise.resolve(cached);

  const running = salesCountInFlight.get(key);
  if (running) return running;

  const failedAt = salesCountCooldown.get(key);
  if (failedAt !== undefined) {
    if (Date.now() - failedAt < SALES_COUNT_COOLDOWN_MS) {
      return Promise.reject(new Error('Contagem indisponível: tentativa anterior excedeu o tempo limite.'));
    }
    salesCountCooldown.delete(key);
  }

  const promise = db.query(query, params)
    .then((result) => {
      const total = parseInt(result.rows[0]?.total || '0', 10);
      setCachedSalesCount(key, total);
      salesCountCooldown.delete(key);
      return total;
    })
    .catch((error) => {
      if (salesCountCooldown.size > SALES_COUNT_CACHE_MAX) salesCountCooldown.clear();
      salesCountCooldown.set(key, Date.now());
      throw error;
    })
    .finally(() => salesCountInFlight.delete(key));

  salesCountInFlight.set(key, promise);
  return promise;
}

/**
 * Contagem LIMITADA ao teto: em vez de varrer tudo, para de contar em
 * SALES_COUNT_MAX + 1. `counted` maior que o teto significa "há mais que isso".
 */
function buildBoundedCountQuery(whereClause) {
  return `
    SELECT COUNT(*)::int AS total
      FROM (
        SELECT 1
          FROM public.unified_sales s
          ${whereClause}
         LIMIT ${SALES_COUNT_MAX + 1}
      ) bounded`;
}

/* --------------------- Contagem direto nas tabelas base -------------------
 * O gargalo do COUNT não era ler as linhas: era a view.
 *
 * `public.unified_sales` é um UNION ALL, e o Postgres NÃO elimina colunas não
 * usadas da lista de saída de um set operation. Mesmo em `SELECT 1 FROM
 * unified_sales`, cada linha do lado do ML pagava a extração de raw_api_data
 * (status, shipping, thumbnail, permalink, item_id, comprador) e o regex + cast
 * do prazo — e raw_api_data é TOAST, ou seja, leitura fora da página em TODA
 * linha só para contar.
 *
 * A solução é contar em cada tabela de origem separadamente e somar. Aí a lista
 * de saída é literalmente `1`, e uma expressão de JSONB só é avaliada se o
 * PRÓPRIO FILTRO precisar dela.
 *
 * Para não duplicar os construtores de filtro (que já são grandes e vivem em
 * duas rotas), o WHERE continua sendo escrito UMA vez em cima dos nomes da
 * view; o mapa abaixo reescreve cada referência `s.<coluna>` para a expressão
 * equivalente na tabela real. Os mapas são o espelho exato do SELECT da view em
 * utils/init-db.js (UNIFIED_SALES_VIEW_SQL) — se a view mudar, mudar aqui.
 */
const ML_SLA_TEXT = `s.raw_api_data->'sla_data'->>'expected_date'`;
const SHOPEE_ITEM = `COALESCE(s.raw_api_data->'synced_item', s.raw_api_data->'item_list'->0)`;

const COUNT_SOURCES = [
  {
    from: 'public.sales s',
    cols: {
      marketplace: `'ML'::text`,
      id: 's.id::text',
      sku: 's.sku',
      uid: 's.uid',
      account_id: 's.seller_id::text',
      account_nickname: 's.account_nickname',
      sale_date: 's.sale_date',
      product_title: 's.product_title',
      quantity: 's.quantity',
      shipping_mode: 's.shipping_mode',
      shipping_deadline: `COALESCE(CASE WHEN ${ML_SLA_TEXT} ~ '^\\d{4}-\\d{2}-\\d{2}' THEN (${ML_SLA_TEXT})::timestamptz END, s.shipping_limit_date)`,
      shipping_status: 's.shipping_status',
      processed_at: 's.processed_at',
      updated_at: 's.updated_at',
      order_status: `s.raw_api_data->>'status'`,
      shipping_id: `s.raw_api_data->'shipping'->>'id'`,
      product_thumbnail: `s.raw_api_data->'order_items'->0->'item'->>'thumbnail'`,
      product_permalink: `s.raw_api_data->'order_items'->0->'item'->>'permalink'`,
      item_id: `s.raw_api_data->'order_items'->0->'item'->>'id'`,
      buyer_name: `TRIM(CONCAT_WS(' ', s.raw_api_data->'buyer'->>'first_name', s.raw_api_data->'buyer'->>'last_name'))`,
      buyer_nickname: `s.raw_api_data->'buyer'->>'nickname'`,
      raw_api_data: 's.raw_api_data',
    },
  },
  {
    from: 'public.shopee_sales s',
    cols: {
      marketplace: `'Shopee'::text`,
      id: 's.order_sn',
      sku: 's.sku',
      uid: 's.uid',
      account_id: 's.shop_id::text',
      account_nickname: 's.account_nickname',
      sale_date: 's.sale_date',
      product_title: 's.product_title',
      quantity: 's.quantity',
      shipping_mode: `COALESCE(NULLIF(s.shipping_carrier, ''), 'Shopee')`,
      shipping_deadline: 's.ship_by_date',
      shipping_status: 's.shipping_status',
      processed_at: 's.processed_at',
      updated_at: 's.updated_at',
      order_status: 's.order_status',
      shipping_id: 'NULL::text',
      product_thumbnail: `${SHOPEE_ITEM}->'image_info'->>'image_url'`,
      product_permalink: `CASE WHEN ${SHOPEE_ITEM}->>'item_id' IS NOT NULL
        THEN 'https://shopee.com.br/product/' || s.shop_id::text || '/' || (${SHOPEE_ITEM}->>'item_id') END`,
      item_id: `${SHOPEE_ITEM}->>'item_id'`,
      buyer_name: 's.recipient_name',
      buyer_nickname: 's.buyer_username',
      raw_api_data: 's.raw_api_data',
    },
  },
];

/**
 * Reescreve `s.<coluna>` (nomes da view) para a expressão da tabela de origem.
 * Lança se encontrar coluna fora do mapa — assim uma coluna nova na view nunca
 * produz contagem silenciosamente errada; o chamador cai de volta na view.
 * Aliases diferentes de `s` (o `sk` de public.skus, por exemplo) não casam.
 */
function translateWhereToSource(whereClause, cols) {
  return whereClause.replace(/\bs\.([a-z_][a-z0-9_]*)/gi, (_match, col) => {
    const mapped = cols[String(col).toLowerCase()];
    if (mapped === undefined) throw new Error(`coluna não mapeada para contagem: ${col}`);
    return mapped;
  });
}

/**
 * Contagem preferencial: soma de COUNT(*) limitado em cada tabela de origem.
 * Equivale ao COUNT da view (que é um UNION ALL sem filtro próprio), mas sem
 * pagar as expressões da view por linha.
 */
function buildCountQuery(whereClause) {
  try {
    const parts = COUNT_SOURCES.map(({ from, cols }) => `(
      SELECT COUNT(*)::int
        FROM (
          SELECT 1
            FROM ${from}
            ${translateWhereToSource(whereClause, cols)}
           LIMIT ${SALES_COUNT_MAX + 1}
        ) b
    )`);
    return `SELECT (${parts.join(' + ')})::int AS total`;
  } catch (error) {
    // Filtro usa algo que ainda não sabemos traduzir: melhor contar devagar do
    // que contar errado.
    console.warn(`[sales] contagem caiu para a view unificada: ${error.message}`);
    return buildBoundedCountQuery(whereClause);
  }
}

/** Traduz a contagem limitada no par (total exibido, é exato?). */
function resolveBoundedTotal(counted) {
  return counted > SALES_COUNT_MAX
    ? { total: SALES_COUNT_MAX, exact: false }
    : { total: counted, exact: true };
}

const sendEvent = (clientId, data) => {
  if (clients[clientId]) {
    clients[clientId].res.write(`data: ${JSON.stringify(data)}\n\n`);
    return;
  }
  // Ainda não conectou o SSE: guarda o evento para descarregar na conexão.
  if (!pendingEvents[clientId]) {
    pendingEvents[clientId] = { events: [], timer: null };
    pendingEvents[clientId].timer = setTimeout(() => {
      delete pendingEvents[clientId];
    }, PENDING_TTL_MS);
  }
  pendingEvents[clientId].events.push(data);
};

async function safeJson(res) {
  try {
    return await res.json();
  } catch (e) {
    return null;
  }
}

// Mapeia logistic_type/mode do ML para a modalidade exibida (mesma regra do
// buildInsertBatchRows). Usado também pela rota de correção de modalidades.
function mapShippingTypeMode(mode) {
  if (!mode) return 'Outros';
  switch (String(mode).toLowerCase()) {
    case 'fulfillment': return 'FULL';
    case 'self_service': return 'FLEX';
    case 'drop_off': return 'Correios';
    case 'xd_drop_off': return 'Agência';
    case 'cross_docking': return 'Coleta';
    case 'me2': return 'Envio Padrão';
    default: return 'Outros';
  }
}

// Assinatura de mudança relevante do pedido. Precisa bater EXATAMENTE com o
// backfill em init-db (status | shipping.status | shipping.substatus | tags).
// status/shipping.status usam o mesmo enum na busca de pedidos e no shipment,
// então a comparação é consistente entre buscas.
function computeSyncSignature(o) {
  const tags = Array.isArray(o?.tags) ? o.tags.slice().sort().join(',') : '';
  const st = o?.status || '';
  const shp = o?.shipping?.status || '';
  const sub = o?.shipping?.substatus || '';
  return `${st}|${shp}|${sub}|${tags}`;
}

/* Assinatura COMPARÁVEL entre execuções.
 *
 * A assinatura acima só serve depois do enriquecimento: `/shipments` preenche
 * shipping.status/substatus, que o resumo de /orders/search não traz (lá vem
 * apenas shipping.id). Guardar a versão enriquecida e comparar com o resumo
 * fazia as duas NUNCA baterem — por isso o log mostrava `pulados=0` em todas as
 * contas e cada clique refazia detalhe + shipment + SLA de tudo.
 *
 * `date_last_updated` é o carimbo que o próprio ML move quando algo muda no
 * pedido, e está presente nas duas pontas. É o sinal correto de comparação.
 */
function computeRemoteState(o) {
  const updated = o?.date_last_updated || '';
  const st = o?.status || '';
  const tags = Array.isArray(o?.tags) ? o.tags.slice().sort().join(',') : '';
  return `${updated}|${st}|${tags}`;
}

async function mapWithConcurrency(items, limit, mapper) {
  const ret = new Array(items.length);
  let i = 0;
  let active = 0;

  return new Promise((resolve) => {
    const next = () => {
      if (i === items.length && active === 0) return resolve(ret);
      while (active < limit && i < items.length) {
        const idx = i++;
        active++;
        Promise.resolve(mapper(items[idx], idx))
          .then((v) => {
            ret[idx] = v;
          })
          .catch(() => {
            ret[idx] = null;
          })
          .finally(() => {
            active--;
            next();
          });
      }
    };
    next();
  });
}

function buildInsertBatchRows(orders, targetUid, nickname) {
  const rows = [];
  for (const order of orders) {
    const slaData = order?.sla_data || null;
    const finalShippingLimitDate =
      slaData?.shipping_limit_date ||
      order?.shipping?.shipping_option?.estimated_delivery_time?.shipping_limit_date ||
      null;

    let shippingMode = order?.shipping?.logistic_type || order?.shipping?.mode || order?.shipping?.shipping_mode;
    // Só a tag 'fulfillment' indica FULL. NÃO usar 'pack_order' (isso é só um
    // pacote com múltiplos itens/unidades e pode ser FLEX/Correios/etc.) —
    // usar pack_order marcava FLEX como FULL por engano.
    if (!shippingMode && Array.isArray(order.tags)) {
      if (order.tags.includes('fulfillment')) {
        shippingMode = 'fulfillment';
      }
    }

    const mapShippingType = (mode) => {
      if (!mode) return 'Outros';
      switch (String(mode).toLowerCase()) {
        case 'fulfillment': return 'FULL';
        case 'self_service': return 'FLEX';
        case 'drop_off': return 'Correios';
        case 'xd_drop_off': return 'Agência';
        case 'cross_docking': return 'Coleta';
        case 'me2': return 'Envio Padrão';
        default: return 'Outros';
      }
    };

    const finalShippingMode = mapShippingType(shippingMode);

    for (const it of order?.order_items || []) {
      const sku = it?.item?.seller_sku || it?.item?.id || null;
      if (!sku) continue;

      // Garantir que seller_id seja um número válido
      let sellerId = order?.seller?.id;
      if (sellerId) {
        sellerId = parseInt(sellerId, 10);
        if (isNaN(sellerId)) {
          console.warn(`seller_id inválido para pedido ${order.id}: ${order?.seller?.id}`);
          sellerId = null;
        }
      }

      // Garantir que o ID do pedido seja um número válido
      let orderId = order.id;
      if (orderId && typeof orderId === 'string') {
        orderId = parseInt(orderId, 10);
        if (isNaN(orderId)) {
          console.warn(`ID do pedido inválido: ${order.id}`);
          continue; // Pular este pedido se o ID for inválido
        }
      }

      // Garantir que packages seja um número válido
      let packages = order.pack_id ? 1 : 0;
      if (packages && typeof packages === 'string') {
        packages = parseInt(packages, 10);
        if (isNaN(packages)) {
          packages = 0;
        }
      }

      rows.push({
        id: orderId,
        sku,
        uid: targetUid,
        seller_id: sellerId,
        channel: 'ML',
        account_nickname: nickname || null,
        sale_date: order.date_created,
        product_title: it?.item?.title || null,
        quantity: it?.quantity || 1,
        shipping_mode: finalShippingMode,
        shipping_limit_date: finalShippingLimitDate,
        packages: packages,
        date_last_updated: order?.date_last_updated || null,
        sync_signature: computeSyncSignature(order),
        // Sem marcador: enriquecimento incompleto ou outro fluxo de gravação.
        // Fica nulo de propósito para o pedido ser reavaliado na próxima vez.
        remote_state: order?.__remoteState || null,
        raw_api_data: order
      });
    }
  }
  return rows;
}

function buildMultiInsertQuery_DoUpdate(rows) {
  const cols = [
    'id', 'sku', 'uid', 'seller_id', 'channel', 'account_nickname',
    'sale_date', 'product_title', 'quantity', 'shipping_mode',
    'shipping_limit_date', 'packages', 'date_last_updated', 'sync_signature', 'remote_state', 'raw_api_data', 'updated_at'
  ];
  const values = [];
  const params = [];
  let p = 1;

  for (const r of rows) {
    // Garantir que todos os campos numéricos sejam do tipo correto
    let id = r.id;
    if (id && typeof id === 'string') {
      id = parseInt(id, 10);
      if (isNaN(id)) {
        console.warn(`id inválido para inserção: ${r.id}`);
        continue; // Pular esta linha se o ID for inválido
      }
    }

    let sellerId = r.seller_id;
    if (sellerId && typeof sellerId === 'string') {
      sellerId = parseInt(sellerId, 10);
      if (isNaN(sellerId)) {
        console.warn(`seller_id inválido para inserção: ${r.seller_id}`);
        sellerId = null;
      }
    }

    let quantity = r.quantity;
    if (quantity && typeof quantity === 'string') {
      quantity = parseInt(quantity, 10);
      if (isNaN(quantity)) {
        console.warn(`quantity inválido para inserção: ${r.quantity}`);
        quantity = 1;
      }
    }

    let packages = r.packages;
    if (packages && typeof packages === 'string') {
      packages = parseInt(packages, 10);
      if (isNaN(packages)) {
        console.warn(`packages inválido para inserção: ${r.packages}`);
        packages = 0;
      }
    }

    params.push(
      id, r.sku, r.uid, sellerId, 'ML', r.account_nickname,
      r.sale_date, r.product_title, quantity, r.shipping_mode,
      r.shipping_limit_date, packages, r.date_last_updated || null, r.sync_signature || null,
      r.remote_state || null, r.raw_api_data,
      new Date()
    );
    const placeholders = cols.map(() => `$${p++}`).join(', ');
    values.push(`(${placeholders})`);
  }

  /* RETURNING (xmax = 0) distingue INSERT de UPDATE (inserido: xmax=0).
   * O DO UPDATE só ocorre quando ALGO relevante mudou (IS DISTINCT FROM).
   *
   * A condição `processed_at IS NULL` foi REMOVIDA de propósito. Ela criava
   * dois problemas: a venda já processada nunca recebia status novo (ficava
   * congelada em "enviado" e nunca mostrava entregue/cancelado) e, sobretudo,
   * `remote_state` jamais era atualizado nela — então o pedido era rebaixado
   * com 3 chamadas à API em TODA sincronização, para sempre.
   *
   * O SET não toca em quantity, sku, sale_date, processed_at nem
   * shipping_status: baixa de estoque e status operacional interno seguem
   * intactos. Só metadados vindos do ML são atualizados.
   */
  const query = `
    INSERT INTO public.sales (${cols.join(', ')})
    VALUES ${values.join(', ')}
    ON CONFLICT (id, sku, uid) DO UPDATE SET
      shipping_mode = EXCLUDED.shipping_mode,
      shipping_limit_date = EXCLUDED.shipping_limit_date,
      packages = EXCLUDED.packages,
      date_last_updated = EXCLUDED.date_last_updated,
      sync_signature = EXCLUDED.sync_signature,
      remote_state = EXCLUDED.remote_state,
      raw_api_data = EXCLUDED.raw_api_data,
      updated_at = EXCLUDED.updated_at
    WHERE (
        public.sales.remote_state IS DISTINCT FROM EXCLUDED.remote_state
        OR public.sales.sync_signature IS DISTINCT FROM EXCLUDED.sync_signature
        OR public.sales.shipping_mode IS DISTINCT FROM EXCLUDED.shipping_mode
        OR public.sales.shipping_limit_date IS DISTINCT FROM EXCLUDED.shipping_limit_date
        OR public.sales.packages IS DISTINCT FROM EXCLUDED.packages
      )
    RETURNING (xmax = 0) AS inserted;
  `;

  return { query, params };
}

/** ======== HELPERS PARA BACKFILL ======== */

/**
 * Aquece o cache de thumbnails do Mercado Livre EM BACKGROUND.
 *
 * Antes isto rodava dentro do request, antes do res.json(): para cada conta
 * fazia lotes de chamadas à API do ML com sleep(200) entre eles, tudo
 * serializado. Numa página de 50 vendas isso somava SEGUNDOS a cada
 * carregamento — era a maior causa de lentidão das telas de venda.
 *
 * Agora a resposta sai direto do banco (milissegundos) e esta função roda
 * depois, só para gravar a thumbnail no raw_api_data. Na próxima visita a
 * imagem já vem do banco. O sync normal também popula esse campo, então a
 * maioria das linhas nunca precisa disto.
 *
 * @param {Array} rows Linhas já retornadas ao cliente (não são mutadas).
 * @param {string|null} uid Quando informado, restringe o UPDATE a esse dono.
 */
// Rolar a tabela dispara uma requisição por página, e cada uma agendava um
// aquecimento em background. Vários deles ao mesmo tempo competiam pelas
// conexões do pool com a própria consulta da tela. Um aquecimento por dono de
// cada vez é suficiente, já que o resultado é gravado no banco.
const warmingThumbnails = new Set();

async function warmMlThumbnailCache(rows, uid = null) {
  const warmKey = uid || '__all__';
  if (warmingThumbnails.has(warmKey)) return;
  warmingThumbnails.add(warmKey);
  try {
    // `marketplace` só existe nas linhas vindas da view unificada. Consultas
    // diretas em public.sales (ex.: /all) não têm o campo e são sempre ML.
    const isMlRow = (row) => !row.marketplace || row.marketplace === 'ML';

    const byAccount = {};
    for (const row of rows) {
      // Só ML: a Shopee já traz a imagem no payload e um item_id dela na API
      // do ML seria chamada perdida.
      if (isMlRow(row) && !row.product_thumbnail && row.ml_item_id) {
        const acct = row.account_nickname || '__unknown__';
        if (!byAccount[acct]) byAccount[acct] = new Set();
        byAccount[acct].add(String(row.ml_item_id).toUpperCase());
      }
    }

    const accountNames = Object.keys(byAccount);
    if (accountNames.length === 0) return;

    const tokenResult = await db.query(
      "SELECT access_token, nickname FROM public.ml_accounts WHERE status = 'active' ORDER BY updated_at DESC NULLS LAST"
    );
    if (tokenResult.rowCount === 0) return;

    const tokenByNickname = {};
    for (const t of tokenResult.rows) {
      if (t.nickname && !tokenByNickname[t.nickname]) tokenByNickname[t.nickname] = t.access_token;
    }
    const fallbackToken = tokenResult.rows[0].access_token;

    const thumbMap = {};
    const BATCH_SIZE = 20;

    for (const acctName of accountNames) {
      const itemIds = Array.from(byAccount[acctName]);
      const token = tokenByNickname[acctName] || fallbackToken;
      if (!token) continue;

      for (let i = 0; i < itemIds.length; i += BATCH_SIZE) {
        const batch = itemIds.slice(i, i + BATCH_SIZE).filter((id) => !thumbMap[id]);
        if (batch.length === 0) continue;
        try {
          const url = `https://api.mercadolibre.com/items?ids=${batch.join(',')}&attributes=id,thumbnail,secure_thumbnail`;
          const res = await mlFetch(url, { headers: { Authorization: `Bearer ${token}` } });
          if (res.ok) {
            const data = await res.json();
            for (const entry of data) {
              if (entry.code === 200 && entry.body) {
                const thumb = entry.body.secure_thumbnail || entry.body.thumbnail;
                if (thumb) thumbMap[String(entry.body.id).toUpperCase()] = thumb;
              }
            }
          }
        } catch { /* ignora: é só aquecimento de cache */ }
      }
    }

    if (Object.keys(thumbMap).length === 0) return;

    /* Gravação em UMA instrução, não uma por linha.
     *
     * Antes era um UPDATE por venda, em série. Cada um reescreve o documento
     * JSONB inteiro (novo TOAST, WAL e nova versão da tupla em todos os
     * índices) só para guardar uma URL de imagem: numa página de 50 vendas sem
     * thumbnail, 50 round-trips e 50 reescritas de blob competindo com a
     * consulta da própria tela pelas conexões do pool.
     */
    const updates = [];
    for (const row of rows) {
      if (!isMlRow(row) || row.product_thumbnail || !row.ml_item_id) continue;
      const thumb = thumbMap[String(row.ml_item_id).toUpperCase()];
      if (!thumb) continue;
      updates.push({ id: row.id, sku: row.sku, thumb });
    }
    if (updates.length === 0) return;

    try {
      await db.query(
        `UPDATE public.sales AS s
            SET raw_api_data = jsonb_set(
                  COALESCE(s.raw_api_data, '{}')::jsonb,
                  '{order_items,0,item,thumbnail}',
                  to_jsonb(v.thumb)
                )
           FROM (
             SELECT * FROM unnest($1::bigint[], $2::text[], $3::text[]) AS t(id, sku, thumb)
           ) AS v
          WHERE s.id = v.id
            AND s.sku = v.sku
            ${uid ? 'AND s.uid = $4' : ''}`,
        uid
          ? [updates.map((u) => u.id), updates.map((u) => u.sku), updates.map((u) => u.thumb), uid]
          : [updates.map((u) => u.id), updates.map((u) => u.sku), updates.map((u) => u.thumb)]
      );
    } catch (err) {
      console.warn('[THUMB] Falha ao gravar thumbnails em lote:', err.message);
    }
  } catch (err) {
    console.warn('[THUMB] Falha ao aquecer cache de thumbnails:', err.message);
  } finally {
    warmingThumbnails.delete(warmKey);
  }
}

function uniqByIdSku(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const k = `${r.id}::${r.sku}::${r.uid}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(r);
    }
  }
  return out;
}

// Atualiza em lote somente campos de enriquecimento sem tocar em processed_at
function buildMultiUpdateQuery_Backfill(rows) {
  // rows: [{ id, sku, uid, shipping_mode, shipping_limit_date, packages, raw_api_data }]
  const cols = ['id', 'sku', 'uid', 'shipping_mode', 'shipping_limit_date', 'packages', 'raw_api_data', 'updated_at'];
  const values = [];
  const params = [];
  let p = 1;

  for (const r of rows) {
    // Garantir que todos os campos numéricos sejam do tipo correto
    let id = r.id;
    if (id && typeof id === 'string') {
      id = parseInt(id, 10);
      if (isNaN(id)) {
        console.warn(`id inválido para backfill: ${r.id}`);
        continue; // Pular esta linha se o ID for inválido
      }
    }

    let packages = r.packages;
    if (packages && typeof packages === 'string') {
      packages = parseInt(packages, 10);
      if (isNaN(packages)) {
        console.warn(`packages inválido para backfill: ${r.packages}`);
        packages = null;
      }
    }

    params.push(
      id, r.sku, r.uid,
      r.shipping_mode ?? null,
      r.shipping_limit_date ?? null,
      packages,
      r.raw_api_data ?? null,
      new Date()
    );
    const placeholders = cols.map(() => `$${p++}`).join(', ');
    values.push(`(${placeholders})`);
  }

  const query = `
    WITH data (${cols.join(', ')}) AS (
      VALUES ${values.join(', ')}
    )
    UPDATE public.sales s
       SET shipping_mode = CASE
                              WHEN s.shipping_mode IS NULL OR s.shipping_mode = 'Outros'
                              THEN d.shipping_mode
                              ELSE s.shipping_mode
                           END,
           shipping_limit_date = COALESCE(s.shipping_limit_date, d.shipping_limit_date::timestamp with time zone),
           packages           = COALESCE(s.packages, d.packages::integer),
           raw_api_data       = COALESCE(d.raw_api_data::jsonb, s.raw_api_data),
           updated_at         = GREATEST(COALESCE(s.updated_at, d.updated_at::timestamp with time zone), d.updated_at::timestamp with time zone)
      FROM data d
     WHERE s.id = d.id::bigint
       AND s.sku = d.sku::text
       AND s.uid = d.uid::text;
  `;
  return { query, params };
}

// Passo de backfill: escaneia vendas salvas com dados faltantes e preenche
async function runBackfillMissing({ db, clientId, nickname, targetUid, userId, access_token, isMaster = false }) {
  sendEvent(clientId, { progress: 40, message: `[${nickname}] Procurando vendas com dados faltantes...`, type: 'info' });

  // Sempre restringir por (uid, seller_id). O backfill enriquece pedidos com o
  // token de UMA conta específica; filtrar só por uid (master antigo) enriquecia
  // vendas de outras contas do mesmo cliente com token errado (caller.id mismatch).
  const candidatesQ = `
      SELECT id, sku, uid, seller_id, account_nickname, sale_date
        FROM public.sales
       WHERE uid = $1
         AND seller_id = $2
         AND (
           raw_api_data IS NULL
           OR raw_api_data->'shipping' IS NULL
           OR raw_api_data->'sla_data' IS NULL
           OR shipping_mode IS NULL
           OR shipping_mode = 'Outros'
           OR shipping_limit_date IS NULL
         )
       ORDER BY sale_date DESC
       LIMIT $3;
    `;
  const cand = await db.query(candidatesQ, [targetUid, userId, MAX_ORDERS]);

  if (cand.rowCount === 0) {
    sendEvent(clientId, { progress: 55, message: `[${nickname}] Nada para completar. Nenhum dado faltante.`, type: 'success' });
    return;
  }

  const byOrder = {};
  for (const r of cand.rows) {
    if (!byOrder[r.id]) byOrder[r.id] = [];
    byOrder[r.id].push(r.sku);
  }
  const orderIds = Object.keys(byOrder);

  sendEvent(clientId, { progress: 50, message: `[${nickname}] Enriquecendo ${orderIds.length} pedidos salvos...`, type: 'info' });

  // 1) Detalhes do pedido + shipments + sla
  const detailedOrders = await mapWithConcurrency(orderIds, SLA_CONCURRENCY, async (orderId, idx) => {
    try {
      const r = await mlFetch(`https://api.mercadolibre.com/orders/${orderId}`, {
        headers: mlHeaders(access_token)
      });
      let order = r.ok ? await r.json() : null;

      if (order?.shipping?.id) {
        const shipId = order.shipping.id;
        const [shipRes, slaRes] = await Promise.all([
          mlFetch(`https://api.mercadolibre.com/shipments/${shipId}`, { headers: shipmentHeaders(access_token) }),
          mlFetch(`https://api.mercadolibre.com/shipments/${shipId}/sla`, { headers: shipmentHeaders(access_token) }),
        ]);

        if (shipRes.ok) {
          const ship = await safeJson(shipRes);
          order.shipping = { ...order.shipping, ...ship };
        }
        if (slaRes.ok) {
          order.sla_data = await safeJson(slaRes);
        }
      }

      if (idx > 0 && idx % 10 === 0) {
        const pct = 50 + Math.floor(((idx + 1) / orderIds.length) * 20);
        sendEvent(clientId, { progress: Math.min(70, pct), message: `[${nickname}] Backfill... ${idx + 1}/${orderIds.length}`, type: 'info' });
      }
      return order;
    } catch {
      return null;
    }
  });

  // 2) Linhas apenas para (id, sku, uid) já existentes
  const allowed = new Set(cand.rows.map(r => `${r.id}::${r.sku}::${r.uid}`));
  const rowsRaw = buildInsertBatchRows(detailedOrders.filter(Boolean), targetUid, nickname)
    .filter(r => allowed.has(`${r.id}::${r.sku}::${r.uid}`));
  
  // Garantir que todos os campos numéricos sejam do tipo correto para todas as linhas
  const rows = uniqByIdSku(rowsRaw).map(r => {
    // Converter ID para número
    if (r.id && typeof r.id === 'string') {
      const parsedId = parseInt(r.id, 10);
      if (!isNaN(parsedId)) {
        r.id = parsedId;
      } else {
        console.warn(`id inválido no backfill: ${r.id}`);
        return null; // Retornar null para filtrar esta linha
      }
    }

    // Converter seller_id para número
    if (r.seller_id && typeof r.seller_id === 'string') {
      const parsedSellerId = parseInt(r.seller_id, 10);
      if (!isNaN(parsedSellerId)) {
        r.seller_id = parsedSellerId;
      } else {
        console.warn(`seller_id inválido no backfill: ${r.seller_id}`);
        r.seller_id = null;
      }
    }

    // Converter packages para número
    if (r.packages && typeof r.packages === 'string') {
      const parsedPackages = parseInt(r.packages, 10);
      if (!isNaN(parsedPackages)) {
        r.packages = parsedPackages;
      } else {
        console.warn(`packages inválido no backfill: ${r.packages}`);
        r.packages = null;
      }
    }

    return r;
  }).filter(Boolean); // Remover linhas com ID inválido

  if (rows.length === 0) {
    sendEvent(clientId, { progress: 72, message: `[${nickname}] Nada a atualizar após o enriquecimento.`, type: 'info' });
    return;
  }

  sendEvent(clientId, { progress: 72, message: `[${nickname}] Atualizando ${rows.length} itens existentes...`, type: 'info' });

  const clientDb = await db.pool.connect();
  try {
    await clientDb.query('BEGIN');

    for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
      const chunk = rows.slice(i, i + UPSERT_BATCH_SIZE);
      const { query, params } = buildMultiUpdateQuery_Backfill(chunk);
      await clientDb.query(query, params);

      const pct = 72 + Math.floor(((i + chunk.length) / rows.length) * 13);
      if (i === 0 || i + UPSERT_BATCH_SIZE >= rows.length || i % (UPSERT_BATCH_SIZE * 3) === 0) {
        sendEvent(clientId, { progress: Math.min(85, pct), message: `[${nickname}] Backfill em lote... ${i + chunk.length}/${rows.length}`, type: 'info' });
      }
    }

    await clientDb.query('COMMIT');
    sendEvent(clientId, { progress: 88, message: `[${nickname}] Backfill concluído para ${rows.length} itens.`, type: 'success' });
  } catch (e) {
    await clientDb.query('ROLLBACK');
    throw e;
  } finally {
    clientDb.release();
  }
}

/** ======== ROTAS ======== */

router.get('/sync-status/:clientId', (req, res) => {
  const { clientId } = req.params;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    Connection: 'keep-alive',
    'Cache-Control': 'no-cache',
    // Impede o proxy de bufferizar o stream (eventos chegariam em lote, ou
    // nunca, e a conexão pareceria morta).
    'X-Accel-Buffering': 'no'
  });
  res.write(': ok\n\n');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  // Heartbeat: uma conta com backlog grande fica minutos entre eventos, e
  // proxy/balanceador derruba conexão ociosa. O ping mantém o canal vivo.
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 15000);

  clients[clientId] = { res, heartbeat };

  // Descarrega eventos que aconteceram antes do SSE conectar (incluindo um
  // eventual progresso 100 se o job já tiver terminado).
  const buffered = pendingEvents[clientId];
  if (buffered) {
    if (buffered.timer) clearTimeout(buffered.timer);
    for (const ev of buffered.events) {
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    }
    delete pendingEvents[clientId];
  } else {
    sendEvent(clientId, { progress: 5, message: 'Conexão estabelecida. Aguardando início...', type: 'info' });
  }

  req.on('close', () => {
    clearInterval(heartbeat);
    delete clients[clientId];
  });
});

router.get('/filter-options', authenticateToken, requireMaster, async (req, res) => {
  try {
    // Contas e clientes mudam quando alguém conecta uma loja ou cadastra um
    // usuário — algo raro. A tela, porém, pede esta lista em cada abertura.
    const payload = await withResponseCache('filter-options', 5 * 60 * 1000, async () => {
      // Contas dos DOIS marketplaces. `accounts` continua sendo uma lista de
      // nicknames (compatibilidade com o filtro atual) e `accountsDetailed`
      // traz o marketplace de cada uma, para a tela exibir o logo correto.
      const [mlResult, shopeeResult, userResult] = await Promise.all([
        db.query("SELECT DISTINCT nickname FROM public.ml_accounts WHERE nickname IS NOT NULL AND status = 'active' ORDER BY nickname"),
        db.query("SELECT DISTINCT shop_id, shop_name FROM public.shopee_accounts WHERE status = 'active' ORDER BY shop_name"),
        db.query("SELECT DISTINCT name FROM public.users WHERE name IS NOT NULL AND active = true ORDER BY name"),
      ]);

      const mlAccounts = mlResult.rows.map((r) => ({
        marketplace: 'ML',
        label: r.nickname,
        value: r.nickname,
      }));
      const shopeeAccounts = shopeeResult.rows.map((r) => ({
        marketplace: 'Shopee',
        label: r.shop_name || String(r.shop_id),
        value: r.shop_name || String(r.shop_id),
      }));

      return {
        accounts: [...mlAccounts, ...shopeeAccounts].map((a) => a.label),
        accountsDetailed: [...mlAccounts, ...shopeeAccounts],
        marketplaces: ['ML', 'Shopee'],
        users: userResult.rows.map(r => r.name),
      };
    });

    res.json(payload);
  } catch (err) {
    console.error('Erro ao buscar filter options:', err);
    res.status(500).json({ error: 'Falha ao buscar opções de filtro' });
  }
});

// ======== SEPARAÇÃO DE ITENS ========
// Lista os itens para separação/despacho (visão master) com filtros por
// período de venda, prazo para despachar, modalidade, conta e usuário.
// Retorna { items, total, summary } — o resumo é agregado sobre TODO o
// conjunto filtrado (não apenas a página), para os cards e o relatório PDF.
function buildSeparacaoWhere(req, skip = []) {
  // `skip` deixa de fora um filtro específico: é o que permite montar as
  // opções cruzadas (cada faceta aplica os outros filtros, menos ela mesma).
  const uses = (name) => !skip.includes(name);
  const conditions = [];
  const params = [];
  let paramIdx = 1;

  const saleDateStart = (req.query.saleDateStart || '').trim();
  const saleDateEnd = (req.query.saleDateEnd || '').trim();
  const shippingLimitStart = (req.query.shippingLimitStart || '').trim();
  const shippingLimitEnd = (req.query.shippingLimitEnd || '').trim();
  const shippingMode = (req.query.shippingMode || '').trim();
  const account = (req.query.account || '').trim();
  const userNickname = (req.query.userNickname || '').trim();
  const search = (req.query.search || '').trim();
  // Situação de despacho: 'nao' (default, a despachar) | 'sim' (despachados) | 'todos'
  const despacho = (req.query.despacho || 'nao').trim();

  if (saleDateStart) {
    conditions.push(`s.sale_date >= $${paramIdx}`);
    params.push(saleDateStart + 'T00:00:00-03:00');
    paramIdx++;
  } else if ((req.query.window || '').trim() !== 'all') {
    // Mesma proteção do tabelão: sem janela, a fila varreria o histórico das
    // duas tabelas de todos os clientes e estouraria o statement_timeout.
    // A fila de separação olha o que está para despachar, não o passado.
    conditions.push(`s.sale_date >= (
      ((now() AT TIME ZONE 'America/Sao_Paulo')::date - ($${paramIdx})::int)
    ) AT TIME ZONE 'America/Sao_Paulo'`);
    params.push(parseInt(process.env.ADMIN_SALES_WINDOW_DAYS || '30', 10));
    paramIdx++;
  }
  if (saleDateEnd) {
    conditions.push(`s.sale_date <= $${paramIdx}`);
    params.push(saleDateEnd + 'T23:59:59.999-03:00');
    paramIdx++;
  }
  // Canal: permite separar só ML, só Shopee, ou os dois (padrão).
  const marketplace = (req.query.marketplace || '').trim();
  if (uses('marketplace') && marketplace) {
    conditions.push(`s.marketplace = ANY($${paramIdx})`);
    params.push(marketplace.split(',').map((v) => v.trim()).filter(Boolean));
    paramIdx++;
  }
  // Prazo de despacho: a view já resolve o prazo real de cada canal (SLA do ML
  // e ship_by_date da Shopee), então a comparação é timestamp com timestamp.
  if (shippingLimitStart) {
    conditions.push(`s.shipping_deadline >= $${paramIdx}`);
    params.push(shippingLimitStart + 'T00:00:00-03:00');
    paramIdx++;
  }
  if (shippingLimitEnd) {
    conditions.push(`s.shipping_deadline <= $${paramIdx}`);
    params.push(shippingLimitEnd + 'T23:59:59.999-03:00');
    paramIdx++;
  }
  if (uses('shippingMode') && shippingMode) {
    // Modalidade canônica: cobre logistic_type do ML e transportadora Shopee.
    conditions.push(`${U_SHIPPING_MODE} = ANY($${paramIdx})`);
    params.push(shippingMode.split(',').map((m) => m.trim()).filter(Boolean));
    paramIdx++;
  }
  if (uses('account') && account) {
    // Chave com canal (ML:123 / Shopee:456) primeiro: contas de canais
    // diferentes costumam usar o MESMO nome, e comparar por nome misturava as
    // duas. Id e apelido seguem aceitos para links antigos.
    conditions.push(`(
      (s.marketplace || ':' || s.account_id) = ANY($${paramIdx})
      OR s.account_id = ANY($${paramIdx})
      OR s.account_nickname = ANY($${paramIdx})
    )`);
    params.push(account.split(',').map((v) => v.trim()).filter(Boolean));
    paramIdx++;
  }
  if (uses('userNickname') && userNickname) {
    conditions.push(`u.name ILIKE $${paramIdx}`);
    params.push(`%${userNickname}%`);
    paramIdx++;
  }
  if (search) {
    // `s.id` já é TEXT na view (order_id do ML e order_sn da Shopee).
    conditions.push(`(
      s.product_title ILIKE $${paramIdx}
      OR s.sku ILIKE $${paramIdx}
      OR s.account_nickname ILIKE $${paramIdx}
      OR u.name ILIKE $${paramIdx}
      OR s.id ILIKE $${paramIdx}
    )`);
    params.push(`%${search}%`);
    paramIdx++;
  }

  // Não mostrar vendas de usuários inativos
  conditions.push(`COALESCE(u.active, true) = true`);

  // ===== Regras da FILA DE SEPARAÇÃO =====
  // 1) FULL nunca entra: quem separa/expede FULL é o próprio Mercado Livre.
  //    Usa a modalidade canônica para não deixar passar um FULL cujo
  //    shipping_mode está vazio e só aparece no logistic_type.
  conditions.push(`${U_SHIPPING_MODE} IS DISTINCT FROM 'FULL'`);
  // 2) Não mostrar pedidos cancelados (regra única para os dois canais).
  conditions.push(`NOT ${U_CANCELLED}`);
  // 3) Situação de despacho pelo status operacional canônico: no ML vem do
  //    shipping.status do payload e na Shopee do order_status, em vez de
  //    depender de um campo que só existe no ML.
  if (despacho === 'sim') {
    conditions.push(`${U_OPERATIONAL_STATUS} IN ('shipped', 'delivered', 'completed')`);
  } else if (despacho === 'todos') {
    // Todos (a despachar + despachados), mantendo a exclusão de cancelados/FULL
  } else {
    // Padrão: só o que falta separar (ainda não despachado)
    conditions.push(`${U_OPERATIONAL_STATUS} NOT IN
      ('shipped', 'delivered', 'completed', 'not_delivered', 'cancelled', 'canceled')`);
  }

  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  return { whereClause, params, paramIdx };
}

/**
 * Opções de filtro da fila de separação, já cruzadas entre si.
 *
 * A tela oferecia modalidades fixas no código e todas as contas/clientes do
 * sistema, então era comum escolher um valor e receber fila vazia. Aqui cada
 * faceta aplica as MESMAS regras da listagem (janela de datas, sem FULL, sem
 * cancelado, situação de despacho) e ignora apenas o próprio campo.
 */
router.get('/separacao-facets', authenticateToken, requireMaster, async (req, res) => {
  try {
    const cacheKey = cacheKeyFromQuery('separacao-facets', req.query, [
      'saleDateStart', 'saleDateEnd', 'shippingLimitStart', 'shippingLimitEnd',
      'shippingMode', 'marketplace', 'account', 'userNickname', 'despacho',
      'search', 'window',
    ]);

    const payload = await withResponseCache(cacheKey, FACETS_TTL_MS, async () => {
      const facet = (skipName, keyExpr, extraSelect = '') => {
        const { whereClause, params } = buildSeparacaoWhere(req, [skipName]);
        return db.query(
          `SELECT ${keyExpr} AS value${extraSelect},
                  COUNT(DISTINCT (s.marketplace, COALESCE(s.account_id, ''), s.id))::int AS count
             FROM public.unified_sales s
             LEFT JOIN public.users u ON s.uid = u.uid
             ${whereClause}
            GROUP BY 1${extraSelect ? ', 2' : ''}
            ORDER BY count DESC
            LIMIT 60`,
          params
        );
      };

      const [marketplaces, modes, accounts, owners] = await Promise.all([
        facet('marketplace', 's.marketplace'),
        facet('shippingMode', U_SHIPPING_MODE),
        facet('account', U_ACCOUNT_KEY, `, COALESCE(NULLIF(s.account_nickname, ''), s.account_id) AS label`),
        facet('userNickname', `COALESCE(NULLIF(TRIM(u.name), ''), u.email)`),
      ]);

      const MK_LABEL = { ML: 'Mercado Livre', Shopee: 'Shopee' };
      return {
        marketplaces: marketplaces.rows.map((r) => ({
          value: r.value, label: MK_LABEL[r.value] || r.value, count: r.count,
        })),
        shippingModes: modes.rows.map((r) => ({ value: r.value, label: r.value, count: r.count })),
        accounts: accounts.rows.map((r) => ({
          value: r.value,
          label: r.label || r.value,
          marketplace: String(r.value || '').split(':')[0],
          count: r.count,
        })),
        // O filtro de cliente da tela casa por nome, então a faceta já entrega
        // o nome pronto e descarta cadastro sem nome nem e-mail.
        users: owners.rows
          .filter((r) => r.value)
          .map((r) => ({ value: r.value, label: r.value, count: r.count })),
      };
    });

    res.json(payload);
  } catch (error) {
    console.error('Erro ao montar opções da fila de separação:', error);
    res.status(500).json({ error: 'Erro interno ao carregar opções de filtro.' });
  }
});

router.get('/separacao', authenticateToken, requireMaster, async (req, res) => {
  try {
    const full = String(req.query.full || '') === '1';
    const page = full ? 1 : Math.max(1, parseInt(req.query.page) || 1);
    // O limite representa PACOTES: a página traz todas as linhas do pacote que
    // atendem ao filtro, então um pacote nunca é cortado entre duas páginas.
    const limit = full
      ? 5000
      : Math.min(200, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    const { whereClause, params, paramIdx } = buildSeparacaoWhere(req);
    // shipping_id é o identificador de pacote usado pelo ML. O UID faz a
    // chave ser segura entre contas; Shopee e ML sem envio ficam por pedido.
    const packageKeyExpr = `CONCAT(
      s.marketplace, ':', s.uid, ':',
      CASE
        WHEN s.marketplace = 'ML' AND NULLIF(s.shipping_id, '') IS NOT NULL
          THEN 'ship:' || s.shipping_id
        ELSE 'order:' || s.id
      END
    )`;

    const sort = (req.query.sort || 'prazo_asc').trim();
    let sortAggregate = 'MIN(f.shipping_deadline)';
    let sortDirection = 'ASC NULLS LAST';
    switch (sort) {
      case 'prazo_desc':
        sortAggregate = 'MAX(f.shipping_deadline)';
        sortDirection = 'DESC NULLS LAST';
        break;
      case 'venda_desc':
        sortAggregate = 'MAX(f.sale_date)';
        sortDirection = 'DESC NULLS LAST';
        break;
      case 'venda_asc':
        sortAggregate = 'MIN(f.sale_date)';
        sortDirection = 'ASC NULLS LAST';
        break;
      default:
        break;
    }

    // CTE enxuta: só as colunas necessárias para agrupar/ordenar/contar.
    // MATERIALIZED garante uma única varredura reaproveitada pelas agregações.
    // Ela carrega o MESMO filtro da listagem (inclusive a janela de datas), por
    // isso não varre o histórico das duas tabelas de todos os clientes.
    const packageKeysCte = `
      package_keys AS MATERIALIZED (
        SELECT
          ${packageKeyExpr} AS package_key,
          s.uid,
          s.quantity,
          s.shipping_deadline,
          s.sale_date,
          ${U_SHIPPING_MODE} AS shipping_mode
        FROM public.unified_sales s
        LEFT JOIN public.users u ON s.uid = u.uid
        ${whereClause}
      )
    `;

    const prazoDateExpr = `(k.shipping_deadline AT TIME ZONE 'America/Sao_Paulo')::date`;
    const hojeExpr = `(now() AT TIME ZONE 'America/Sao_Paulo')::date`;

    // OTIMIZAÇÃO: Query unificada evita duplo scan de unified_sales
    // Em vez de Promise.all com 2 queries materializando package_keys separadamente,
    // fazemos 1 query que retorna summary + dados paginados usando window functions
    const unifiedQuery = `
      WITH ${packageKeysCte},
      aggregated_summary AS (
        SELECT
          COUNT(DISTINCT k.package_key) AS total_pacotes,
          COUNT(*) AS total_itens,
          COALESCE(SUM(k.quantity), 0) AS total_unidades,
          COUNT(DISTINCT k.package_key) FILTER (WHERE ${prazoDateExpr} < ${hojeExpr}) AS atrasados,
          COUNT(DISTINCT k.package_key) FILTER (WHERE ${prazoDateExpr} = ${hojeExpr}) AS despachar_hoje,
          COUNT(DISTINCT k.uid) AS usuarios_ativos,
          (
            SELECT COALESCE(jsonb_object_agg(m.shipping_mode, m.pacotes), '{}'::jsonb)
              FROM (
                SELECT k2.shipping_mode, COUNT(DISTINCT k2.package_key) AS pacotes
                  FROM package_keys k2
                 GROUP BY k2.shipping_mode
              ) m
          ) AS por_modalidade
        FROM package_keys k
      ),
      selected_packages AS (
        SELECT f.package_key, ${sortAggregate} AS sort_value
          FROM package_keys f
         GROUP BY f.package_key
         ORDER BY sort_value ${sortDirection}, f.package_key
         LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
      )
      SELECT 
        -- Dados da linha
        s.id, s.sku, s.uid, s.account_nickname, s.quantity,
        s.marketplace,
        s.marketplace AS channel,
        s.shipping_id,
        sp.package_key,
        CASE
          WHEN s.marketplace = 'ML' THEN COALESCE(NULLIF(s.raw_api_data->>'pack_id', ''), s.shipping_id, s.id)
          ELSE s.id
        END AS pack_id,
        s.product_title,
        ${U_SHIPPING_MODE} AS shipping_mode,
        s.shipping_deadline AS shipping_limit_date,
        s.shipping_status,
        s.product_thumbnail,
        -- Mesmo fallback da tabela de vendas: sem nome no cadastro, usa o e-mail.
        COALESCE(NULLIF(TRIM(u.name), ''), u.email) AS user_nickname,
        sk.descricao AS sku_descricao,
        CASE WHEN s.marketplace = 'ML' THEN COALESCE(
          (SELECT oi->'item'->'variation_attributes'
             FROM jsonb_array_elements(COALESCE(s.raw_api_data->'order_items', '[]'::jsonb)) oi
            WHERE UPPER(TRIM(COALESCE(oi->'item'->>'seller_sku', oi->'item'->>'id', ''))) = UPPER(TRIM(s.sku))
            LIMIT 1),
          (SELECT oi->'item'->'variation_attributes'
             FROM jsonb_array_elements(COALESCE(s.raw_api_data->'order_items', '[]'::jsonb)) oi
            LIMIT 1)
        ) END AS variation_attributes,
        s.shipping_deadline AS sla_expected_date,
        ${U_OPERATIONAL_STATUS} AS shipping_status_live,
        s.buyer_name AS buyer_first_name,
        NULL::text AS buyer_last_name,
        s.buyer_nickname,
        -- Summary (mesmos valores em todas as linhas via CROSS JOIN)
        agg.total_pacotes,
        agg.total_itens,
        agg.total_unidades,
        agg.atrasados,
        agg.despachar_hoje,
        agg.usuarios_ativos,
        agg.por_modalidade
      FROM public.unified_sales s
      LEFT JOIN public.users u ON s.uid = u.uid
      LEFT JOIN LATERAL (
        SELECT sk_inner.descricao
        FROM public.skus sk_inner
        WHERE sk_inner.user_id = s.uid
          AND UPPER(TRIM(sk_inner.sku)) = UPPER(TRIM(s.sku))
          AND sk_inner.descricao IS NOT NULL AND TRIM(sk_inner.descricao) <> ''
        ORDER BY sk_inner.ativo DESC
        LIMIT 1
      ) sk ON true
      JOIN selected_packages sp ON sp.package_key = ${packageKeyExpr}
      CROSS JOIN aggregated_summary agg
      ${whereClause}
      ORDER BY sp.sort_value ${sortDirection}, sp.package_key, s.id, s.sku;
    `;

    const result = await db.query(unifiedQuery, [...params, limit, offset]);

    // Extrair summary da primeira linha (ou valores padrão se vazio)
    let summary;
    if (result.rows.length > 0) {
      const firstRow = result.rows[0];
      const porModalidade = {};
      for (const [mode, count] of Object.entries(firstRow.por_modalidade || {})) {
        porModalidade[mode] = parseInt(count, 10) || 0;
      }
      summary = {
        totalPacotes: parseInt(firstRow.total_pacotes, 10) || 0,
        totalItens: parseInt(firstRow.total_itens, 10) || 0,
        totalUnidades: parseInt(firstRow.total_unidades, 10) || 0,
        atrasados: parseInt(firstRow.atrasados, 10) || 0,
        despacharHoje: parseInt(firstRow.despachar_hoje, 10) || 0,
        usuariosAtivos: parseInt(firstRow.usuarios_ativos, 10) || 0,
        porModalidade,
      };
    } else {
      summary = {
        totalPacotes: 0,
        totalItens: 0,
        totalUnidades: 0,
        atrasados: 0,
        despacharHoje: 0,
        usuariosAtivos: 0,
        porModalidade: {},
      };
    }

    const totalPacotes = summary.totalPacotes;

    res.json({
      items: result.rows,
      total: totalPacotes,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(totalPacotes / limit)),
      summary,
    });
  } catch (err) {
    console.error('Erro ao buscar separação de itens:', err);
    res.status(500).json({ error: 'Falha ao buscar itens de separação' });
  }
});

router.get('/all', authenticateToken, requireMaster, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;
    const search = (req.query.search || '').trim();
    const shippingStatus = (req.query.shippingStatus || '').trim();
    const saleStatus = (req.query.saleStatus || '').trim();
    const saleDateStart = (req.query.saleDateStart || '').trim();
    const saleDateEnd = (req.query.saleDateEnd || '').trim();
    const account = (req.query.account || '').trim();
    const buyer = (req.query.buyer || '').trim();
    const shippingLimitStart = (req.query.shippingLimitStart || '').trim();
    const shippingLimitEnd = (req.query.shippingLimitEnd || '').trim();
    const shippingMode = (req.query.shippingMode || '').trim();
    const processed = (req.query.processed || '').trim(); // 'yes' = processados | 'no' = não processados
    // Canal: 'ML' | 'Shopee' | lista em CSV | vazio = todos.
    const marketplace = (req.query.marketplace || '').trim();

    const conditions = [];
    const params = [];
    let paramIdx = 1;

    const asList = (value) => String(value || '').split(',').map((v) => v.trim()).filter(Boolean);

    const userNickname = (req.query.userNickname || '').trim();

    /* --------------------- Filtros de usuário resolvidos antes ---------------
     * O tabelão global não filtra por dono, então o LEFT JOIN em users existia
     * só para (a) esconder cliente inativo, (b) buscar por nome e (c) exibir o
     * nome. Com o JOIN dentro da consulta paginada, o Postgres precisava juntar
     * a base inteira ANTES de ordenar por data e cortar a página — era o custo
     * dominante da tela.
     *
     * public.users tem dezenas de linhas: resolver os uid aqui é barato e deixa
     * a consulta pesada com predicados apenas sobre as tabelas de venda, que
     * têm índice por (sale_date DESC). O nome volta a ser buscado depois do
     * LIMIT, para as 50 linhas da página.
     */
    const [inactiveUsers, searchUsers, nicknameUsers] = await Promise.all([
      db.query(`SELECT uid FROM public.users WHERE active = false`),
      search
        ? db.query(`SELECT uid FROM public.users WHERE name ILIKE $1`, [`%${search}%`])
        : Promise.resolve({ rows: [] }),
      userNickname
        ? db.query(`SELECT uid FROM public.users WHERE name ILIKE $1`, [`%${userNickname}%`])
        : Promise.resolve({ rows: [] }),
    ]);

    const inactiveUids = inactiveUsers.rows.map((r) => r.uid);
    if (inactiveUids.length) {
      conditions.push(`s.uid <> ALL($${paramIdx})`);
      params.push(inactiveUids);
      paramIdx++;
    }

    if (marketplace) {
      conditions.push(`s.marketplace = ANY($${paramIdx})`);
      params.push(asList(marketplace));
      paramIdx++;
    }
    if (search) {
      // `s.id` já é TEXT na view unificada (order_id do ML e order_sn da Shopee),
      // então o CAST anterior deixou de ser necessário.
      const searchParts = [
        `s.product_title ILIKE $${paramIdx}`,
        `s.sku ILIKE $${paramIdx}`,
        `s.account_nickname ILIKE $${paramIdx}`,
        `s.id ILIKE $${paramIdx}`,
      ];
      params.push(`%${search}%`);
      paramIdx++;

      // Busca por nome do cliente vira comparação direta de uid.
      const searchUids = searchUsers.rows.map((r) => r.uid);
      if (searchUids.length) {
        searchParts.push(`s.uid = ANY($${paramIdx})`);
        params.push(searchUids);
        paramIdx++;
      }
      conditions.push(`(${searchParts.join(' OR ')})`);
    }
    if (shippingStatus) {
      // Mesma expressão canônica da tela do usuário: sem ela, "Pendente"
      // (status ausente) e diferenças de caixa não casavam com nada.
      const wanted = asList(shippingStatus).map((v) => v.toLowerCase());
      const wantsCancelled = wanted.includes('cancelled');
      const shippingWanted = wanted.filter((v) => v !== 'cancelled');
      const parts = [];
      if (shippingWanted.length) {
        parts.push(`LOWER(${U_SHIPPING_STATUS}) = ANY($${paramIdx})`);
        params.push(shippingWanted);
        paramIdx++;
      }
      if (wantsCancelled) {
        parts.push(`LOWER(COALESCE(s.order_status, '')) = 'cancelled'`);
      }
      if (parts.length) conditions.push(`(${parts.join(' OR ')})`);
    }
    if (saleStatus) {
      // Sem caixa e por lista: a Shopee grava o status do pedido em maiúsculas
      // (COMPLETED, CANCELLED) e o ML em minúsculas, então a comparação exata
      // deixava metade dos canais de fora da opção escolhida.
      conditions.push(`LOWER(COALESCE(s.order_status, '')) = ANY($${paramIdx})`);
      params.push(asList(saleStatus).map((v) => v.toLowerCase()));
      paramIdx++;
    }
    /* ------------------------ Janela padrão de datas -------------------------
     * Sem recorte de data, este tabelão pede "as 50 vendas mais recentes de
     * TODOS os clientes" e o Postgres tem de considerar o histórico inteiro das
     * duas tabelas. Na prática isso batia no statement_timeout de 30s do pool e
     * a tela devolvia 500 — era o "29 segundos" observado.
     *
     * Com uma janela padrão o intervalo vira uma leitura por índice em
     * (sale_date DESC), que é limitada por natureza. O cliente continua podendo
     * pedir qualquer período: `window=all` desliga o padrão explicitamente.
     */
    const windowMode = (req.query.window || '').trim();
    const WINDOW_DAYS = {
      today: 0,
      '7d': 7,
      '30d': 30,
      '90d': 90,
    };
    const DEFAULT_WINDOW_DAYS = parseInt(process.env.ADMIN_SALES_WINDOW_DAYS || '30', 10);
    let defaultWindowDays = null;

    if (saleDateStart) {
      conditions.push(`s.sale_date >= $${paramIdx}`);
      // Limite do dia em horário de Brasília (UTC-3). Antes usava meia-noite
      // UTC, o que trazia vendas do fim da noite de ontem (BRT) no filtro "hoje".
      params.push(saleDateStart + 'T00:00:00-03:00');
      paramIdx++;
    } else if (windowMode !== 'all') {
      defaultWindowDays = Object.prototype.hasOwnProperty.call(WINDOW_DAYS, windowMode)
        ? WINDOW_DAYS[windowMode]
        : DEFAULT_WINDOW_DAYS;
      // Início do dia em Brasília, para "hoje" bater com o calendário do usuário.
      conditions.push(`s.sale_date >= (
        ((now() AT TIME ZONE 'America/Sao_Paulo')::date - ($${paramIdx})::int)
      ) AT TIME ZONE 'America/Sao_Paulo'`);
      params.push(defaultWindowDays);
      paramIdx++;
    }
    if (saleDateEnd) {
      conditions.push(`s.sale_date <= $${paramIdx}`);
      params.push(saleDateEnd + 'T23:59:59.999-03:00');
      paramIdx++;
    }
    if (account) {
      // Aceita a chave com canal (ML:123 / Shopee:456), que é o valor devolvido
      // pelas opções de filtro, e também id puro ou apelido, formatos usados por
      // links antigos. Lista em CSV permite selecionar mais de uma conta.
      conditions.push(`(
        (s.marketplace || ':' || s.account_id) = ANY($${paramIdx})
        OR s.account_id = ANY($${paramIdx})
        OR s.account_nickname = ANY($${paramIdx})
      )`);
      params.push(asList(account));
      paramIdx++;
    }
    if (buyer) {
      conditions.push(`(s.buyer_name ILIKE $${paramIdx} OR s.buyer_nickname ILIKE $${paramIdx})`);
      params.push(`%${buyer}%`);
      paramIdx++;
    }
    if (shippingMode) {
      // Modalidade derivada igual à do usuário (logistic_type do ML e
      // transportadora da Shopee), senão chips válidos voltavam vazios.
      conditions.push(`${U_SHIPPING_MODE} = ANY($${paramIdx})`);
      params.push(asList(shippingMode));
      paramIdx++;
    }
    // Filtro de PROCESSADO / NÃO PROCESSADO (abatimento de estoque).
    if (processed === 'yes') {
      conditions.push(`s.processed_at IS NOT NULL`);
    } else if (processed === 'no') {
      conditions.push(`s.processed_at IS NULL`);
    }
    if (userNickname) {
      // Nenhum cliente com esse nome: devolve vazio sem varrer as vendas.
      const nicknameUids = nicknameUsers.rows.map((r) => r.uid);
      if (nicknameUids.length === 0) {
        return res.json({
          data: [], total: 0, totalExact: true, hasNext: false,
          page, limit, totalPages: 1,
        });
      }
      conditions.push(`s.uid = ANY($${paramIdx})`);
      params.push(nicknameUids);
      paramIdx++;
    }
    if (shippingLimitStart) {
      // A view já resolve o prazo real (SLA do ML / ship_by_date da Shopee),
      // então o filtro compara timestamp com timestamp, não texto.
      conditions.push(`s.shipping_deadline >= $${paramIdx}`);
      params.push(shippingLimitStart + 'T00:00:00-03:00');
      paramIdx++;
    }
    if (shippingLimitEnd) {
      conditions.push(`s.shipping_deadline <= $${paramIdx}`);
      params.push(shippingLimitEnd + 'T23:59:59.999-03:00');
      paramIdx++;
    }
    // Ao filtrar por PRAZO DE EXPEDIÇÃO, exclui FULL: o vendedor não despacha
    // pedido FULL (o ML expede), então ele não faz parte da fila de expedição.
    // IS DISTINCT FROM mantém linhas com shipping_mode NULL.
    if (shippingLimitStart || shippingLimitEnd) {
      conditions.push(`${U_SHIPPING_MODE} IS DISTINCT FROM 'FULL'`);
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    // Sem JOIN, com teto e contando nas tabelas de origem (a view faria o
    // Postgres avaliar JSONB linha por linha só para contar).
    const countQuery = buildCountQuery(whereClause);

    // Mesma estratégia da tela do usuário: recorta a página primeiro e só
    // depois resolve SKU/JSON, para o custo por linha valer apenas 1 página.
    const dataQuery = `
      WITH page_rows AS MATERIALIZED (
        SELECT s.*
          FROM public.unified_sales s
          ${whereClause}
         -- Ordena SÓ por sale_date: as duas tabelas de origem têm índice
         -- (sale_date DESC), então o Postgres percorre os índices e para na
         -- página pedida. Acrescentar marketplace/id/sku aqui como desempate
         -- obrigava ORDENAR TODAS as vendas de TODOS os clientes antes do
         -- LIMIT, e era o custo dominante desta tela. O desempate para exibição
         -- continua no ORDER BY externo, aplicado só às 50 linhas da página.
         ORDER BY s.sale_date DESC
         LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
      )
      SELECT s.id, s.sku, s.uid, s.marketplace,
        s.marketplace AS channel,
        s.account_id AS seller_id,
        s.account_nickname, s.sale_date,
        s.product_title, s.quantity, s.shipping_mode,
        s.shipping_deadline AS shipping_limit_date,
        s.shipping_status, s.updated_at, s.processed_at,
        -- Nome do cliente resolvido DEPOIS do LIMIT: 50 buscas por chave
        -- primária, em vez de juntar a base inteira antes de ordenar.
        -- Cai no e-mail quando o cadastro não tem nome: antes a tela mostrava
        -- "N/A" como se a venda não tivesse dono, o que aparecia principalmente
        -- nas lojas Shopee cujo usuário foi criado sem nome.
        COALESCE(NULLIF(TRIM(u.name), ''), u.email) AS user_nickname,
        -- raw_api_data enxuto: o payload cheio chega a dezenas de KB por linha.
        jsonb_build_object(
          'status', s.order_status,
          'tags', COALESCE(s.raw_api_data->'tags', '[]'::jsonb),
          'sla_data', jsonb_build_object('expected_date', s.shipping_deadline),
          'shipping', jsonb_build_object(
            'id', s.shipping_id,
            'logistic_type', s.raw_api_data->'shipping'->>'logistic_type'
          ),
          'seller', jsonb_build_object('id', s.account_id),
          'buyer', jsonb_build_object(
            'first_name', s.buyer_name,
            'last_name', NULL,
            'nickname', s.buyer_nickname
          )
        ) AS raw_api_data,
        s.order_status as sale_status,
        s.shipping_id,
        s.shipping_deadline as sla_expected_date,
        s.product_thumbnail,
        s.product_permalink,
        s.item_id as ml_item_id,
        s.buyer_name as buyer_first_name,
        NULL::text as buyer_last_name,
        s.buyer_nickname,
        COALESCE(skm.mapped, false) AS is_sku_mapped,
        skm.descricao AS sku_descricao,
        CASE WHEN s.marketplace = 'ML' THEN COALESCE(
          (SELECT oi->'item'->'variation_attributes'
             FROM jsonb_array_elements(COALESCE(s.raw_api_data->'order_items', '[]'::jsonb)) oi
            WHERE UPPER(TRIM(COALESCE(oi->'item'->>'seller_sku', oi->'item'->>'id', ''))) = UPPER(TRIM(s.sku))
            LIMIT 1),
          (SELECT oi->'item'->'variation_attributes'
             FROM jsonb_array_elements(COALESCE(s.raw_api_data->'order_items', '[]'::jsonb)) oi
            LIMIT 1)
        ) END AS variation_attributes
      FROM page_rows s
      LEFT JOIN public.users u ON s.uid = u.uid
      LEFT JOIN LATERAL (
        SELECT
          bool_or(sk.ativo) AS mapped,
          (array_agg(sk.descricao ORDER BY sk.ativo DESC)
             FILTER (WHERE sk.descricao IS NOT NULL AND TRIM(sk.descricao) <> ''))[1] AS descricao
        FROM public.skus sk
        WHERE sk.user_id = s.uid
          AND UPPER(TRIM(sk.sku)) = UPPER(TRIM(s.sku))
      ) skm ON TRUE
      ORDER BY s.sale_date DESC, s.marketplace, s.id, s.sku;
    `;

    // O tabelão global varre as duas tabelas de TODOS os clientes; contar isso
    // em cada página era o maior custo da tela. Agora a contagem é separada.
    const countKey = `admin|${whereClause}|${JSON.stringify(params)}`;
    const cachedTotal = getCachedSalesCount(countKey);

    if (req.query.countOnly === '1') {
      // A contagem é um refinamento do número já exibido. Se ela falhar ou
      // estiver em espera, a tela mantém o total aproximado em vez de erro.
      let counted;
      try {
        counted = cachedTotal === null
          ? await loadSalesCount(countKey, countQuery, params)
          : cachedTotal;
      } catch (countError) {
        console.error('Total do tabelão indisponível:', countError.message);
        return res.json({ total: null, totalExact: false, totalPages: page + 1 });
      }
      const bounded = resolveBoundedTotal(counted);
      return res.json({
        total: bounded.total,
        totalExact: bounded.exact,
        totalPages: bounded.exact ? (Math.ceil(bounded.total / limit) || 1) : page + 1,
      });
    }

    const dataResult = await db.query(dataQuery, [...params, limit + 1, offset]);
    const hasNext = dataResult.rows.length > limit;
    const rows = hasNext ? dataResult.rows.slice(0, limit) : dataResult.rows;

    let total = null;
    let totalExact = false;

    if (cachedTotal !== null) {
      const bounded = resolveBoundedTotal(cachedTotal);
      total = bounded.total;
      totalExact = bounded.exact;
    } else if (!hasNext) {
      // Última página: o total sai da própria posição, sem contar nada.
      total = offset + rows.length;
      totalExact = true;
      setCachedSalesCount(countKey, total);
    } else {
      total = offset + rows.length + 1;
    }

    res.json({
      data: rows,
      total,
      totalExact,
      hasNext,
      page,
      limit,
      totalPages: totalExact ? (Math.ceil(total / limit) || 1) : page + 1,
      // A tela avisa qual janela está em uso, para o número não parecer errado.
      defaultWindowDays,
    });

    if (!totalExact) {
      setImmediate(() => {
        loadSalesCount(countKey, countQuery, params).catch((error) => {
          console.error('Erro ao aquecer total do tabelão:', error);
        });
      });
    }
    // Aquece a thumbnail que faltou. A função agrupa por conta e usa o token
    // daquela conta, então funciona no tabelão global; sem isso, venda cuja
    // imagem ainda não foi gravada no banco aparece sem foto.
    setImmediate(() => warmMlThumbnailCache(rows));
  } catch (error) {
    console.error("Erro interno ao buscar todas as vendas:", error);
    res.status(500).json({ error: 'Erro interno ao buscar vendas globais.' });
  }
});

/**
 * Métricas agregadas do Dashboard.
 *
 * Antes o Dashboard pedia /my-sales?page=1&limit=50 e calculava tudo no
 * navegador sobre essas 50 linhas: com milhares de vendas, os números
 * exibidos estavam simplesmente errados (mostravam no máximo 50). Aqui a
 * agregação é feita no banco, sobre TODO o período, e volta pronta.
 *
 * Filtros: período (from/to), marketplace e conta.
 */

/* ------------------- Filtros canônicos da view unificada -------------------
 * As expressões abaixo são usadas ao MESMO tempo no filtro, na agregação e na
 * listagem de opções. Se filtro e rótulo divergirem, o usuário clica em algo
 * que existe na tela e recebe lista vazia — foi o que acontecia com o rótulo
 * genérico "Outros".
 */
const U_ACCOUNT_KEY = `(s.marketplace || ':' || COALESCE(s.account_id, ''))`;
const U_SHIPPING_STATUS = `COALESCE(NULLIF(s.shipping_status, ''), 'Pendente')`;
// Quando o ML não traz shipping_mode, a modalidade real está no logistic_type.
// Sem isso, quase todo pedido caía num "Outros" que não dizia nada.
const U_SHIPPING_MODE = `COALESCE(
  NULLIF(s.shipping_mode, ''),
  CASE WHEN s.marketplace = 'ML' THEN
    CASE LOWER(COALESCE(s.raw_api_data->'shipping'->>'logistic_type', ''))
      WHEN 'fulfillment'   THEN 'FULL'
      WHEN 'self_service'  THEN 'FLEX'
      WHEN 'cross_docking' THEN 'Coleta'
      WHEN 'drop_off'      THEN 'Agência'
      WHEN 'xd_drop_off'   THEN 'Agência'
      ELSE NULL
    END
  END,
  CASE WHEN s.marketplace = 'Shopee' THEN 'Shopee' END,
  'Sem modalidade'
)`;
const U_OPERATIONAL_STATUS = `LOWER(COALESCE(
  CASE WHEN s.marketplace = 'ML' THEN s.raw_api_data->'shipping'->>'status' END,
  s.order_status,
  s.shipping_status,
  ''
))`;
const U_CANCELLED = `(${U_OPERATIONAL_STATUS} IN ('cancelled', 'canceled', 'in_cancel')
   OR LOWER(COALESCE(s.order_status, '')) IN ('cancelled', 'canceled', 'in_cancel'))`;
const U_PENDING = `(s.shipping_mode IS DISTINCT FROM 'FULL'
   AND NOT ${U_CANCELLED}
   AND ${U_OPERATIONAL_STATUS} NOT IN ('shipped', 'delivered', 'completed', 'not_delivered'))`;
const U_SKU_MAPPED = `EXISTS (
  SELECT 1 FROM public.skus sk
   WHERE sk.user_id = s.uid
     AND UPPER(TRIM(sk.sku)) = UPPER(TRIM(s.sku))
     AND sk.ativo = TRUE
)`;

const asFilterList = (value) =>
  String(value || '').split(',').map((v) => v.trim()).filter(Boolean);

/**
 * Monta o WHERE da view unificada a partir da query string.
 *
 * `skip` permite excluir um filtro específico: é isso que torna as opções
 * dependentes entre si (cross-filtering). Ao listar as modalidades de envio,
 * por exemplo, aplicamos conta e canal mas ignoramos a própria modalidade —
 * assim escolher só contas Shopee faz as modalidades do ML desaparecerem.
 *
 * @param {object} query req.query
 * @param {string} uid dono das vendas
 * @param {{ skip?: string[], startIndex?: number, dateRange?: {from: string, to: string} }} options
 */
function buildUnifiedFilters(query, uid, options = {}) {
  const {
    skip = [], startIndex = 1, dateRange = null,
    includeUids = null, excludeUids = null,
  } = options;
  const uses = (name) => !skip.includes(name);

  const conditions = [];
  const params = [];
  let p = startIndex;

  /* Escopo do dono.
   *
   * `uid` preenchido é a tela do cliente: um único dono, sem exceção. `uid`
   * nulo existe só para a visão master global, que em vez de um dono fixo
   * recorta por clientes ativos e, opcionalmente, pelo cliente escolhido no
   * filtro. Usuário comum nunca chega aqui sem uid. */
  if (uid) {
    conditions.push(`s.uid = $${p}`); params.push(uid); p++;
  }
  if (uses('userNickname') && Array.isArray(includeUids)) {
    conditions.push(`s.uid = ANY($${p})`); params.push(includeUids); p++;
  }
  if (Array.isArray(excludeUids) && excludeUids.length) {
    conditions.push(`s.uid <> ALL($${p})`); params.push(excludeUids); p++;
  }

  const from = dateRange ? dateRange.from : (query.from || '').trim();
  const to = dateRange ? dateRange.to : (query.to || '').trim();

  if (uses('period') && from) {
    conditions.push(`s.sale_date >= $${p}`); params.push(`${from}T00:00:00-03:00`); p++;
  } else if (uses('period') && (query.window || '').trim() !== 'all') {
    /* Janela padrão obrigatória.
     *
     * Dashboard e facetas rodam de 5 a 7 agregações sobre a view unificada. Sem
     * recorte de data, cada uma varre TODO o histórico do usuário nos dois
     * canais, com extração de JSONB por linha — passava do statement_timeout de
     * 30s e ainda ocupava várias conexões do pool ao mesmo tempo.
     *
     * `window=all` continua disponível como escolha explícita.
     */
    const DEFAULT_DAYS = configInt('SALES_STATS_WINDOW_DAYS', 30, 1, 3650);
    conditions.push(`s.sale_date >= (
      ((now() AT TIME ZONE 'America/Sao_Paulo')::date - ($${p})::int)
    ) AT TIME ZONE 'America/Sao_Paulo'`);
    params.push(DEFAULT_DAYS); p++;
  }
  if (uses('period') && to) {
    conditions.push(`s.sale_date <= $${p}`); params.push(`${to}T23:59:59.999-03:00`); p++;
  }

  // Prazo de ENVIO é uma janela independente da data da venda: a operação
  // pergunta "o que vendi neste período" e "o que tenho de despachar neste
  // outro". A view já resolve o prazo real de cada canal.
  const shipFrom = (query.shipFrom || '').trim();
  const shipTo = (query.shipTo || '').trim();
  if (uses('shipPeriod') && shipFrom) {
    conditions.push(`s.shipping_deadline >= $${p}`); params.push(`${shipFrom}T00:00:00-03:00`); p++;
  }
  if (uses('shipPeriod') && shipTo) {
    conditions.push(`s.shipping_deadline <= $${p}`); params.push(`${shipTo}T23:59:59.999-03:00`); p++;
  }
  // Filtrar por prazo de despacho exclui FULL: quem expede FULL é o marketplace.
  if (uses('shipPeriod') && (shipFrom || shipTo)) {
    conditions.push(`${U_SHIPPING_MODE} IS DISTINCT FROM 'FULL'`);
  }

  const marketplace = (query.marketplace || '').trim();
  if (uses('marketplace') && marketplace) {
    conditions.push(`s.marketplace = ANY($${p})`); params.push(asFilterList(marketplace)); p++;
  }

  const account = (query.account || '').trim();
  if (uses('account') && account) {
    // Aceita a chave nova com canal (ML:123 / Shopee:456) e também os formatos
    // antigos (só o id ou o apelido), para não invalidar links salvos.
    conditions.push(`(${U_ACCOUNT_KEY} = ANY($${p}) OR s.account_id = ANY($${p}) OR s.account_nickname = ANY($${p}))`);
    params.push(asFilterList(account)); p++;
  }

  // Busca textual: o tabelão manda `search` junto dos filtros. Sem aplicá-la
  // aqui, as opções ofereciam valores que o próprio termo digitado já havia
  // descartado da listagem.
  const search = (query.search || '').trim();
  if (uses('search') && search) {
    conditions.push(`(
      s.product_title ILIKE $${p}
      OR s.sku ILIKE $${p}
      OR s.account_nickname ILIKE $${p}
      OR s.id ILIKE $${p}
    )`);
    params.push(`%${search}%`); p++;
  }

  const shippingStatus = (query.shippingStatus || '').trim();
  if (uses('shippingStatus') && shippingStatus) {
    /* Mesma regra da listagem, porque a opção mostrada precisa prever a linha
     * que a tabela vai trazer:
     *  - comparação sem caixa, já que o status configurado pelo usuário e o
     *    gravado na venda divergem em maiúsculas/minúsculas;
     *  - "cancelled" é status do PEDIDO, não de expedição. Sem este desvio a
     *    faceta ficava vazia justamente quando o usuário filtrava por
     *    Cancelado, e os demais filtros zeravam junto. */
    const wanted = asFilterList(shippingStatus).map((v) => v.toLowerCase());
    const wantsCancelled = wanted.includes('cancelled');
    const shippingWanted = wanted.filter((v) => v !== 'cancelled');
    const parts = [];
    if (shippingWanted.length) {
      parts.push(`LOWER(${U_SHIPPING_STATUS}) = ANY($${p})`);
      params.push(shippingWanted); p++;
    }
    if (wantsCancelled) parts.push(`LOWER(COALESCE(s.order_status, '')) = 'cancelled'`);
    if (parts.length) conditions.push(`(${parts.join(' OR ')})`);
  }

  const shippingMode = (query.shippingMode || '').trim();
  if (uses('shippingMode') && shippingMode) {
    conditions.push(`${U_SHIPPING_MODE} = ANY($${p})`); params.push(asFilterList(shippingMode)); p++;
  }

  const saleStatus = (query.saleStatus || '').trim();
  if (uses('saleStatus') && saleStatus) {
    conditions.push(`LOWER(COALESCE(s.order_status, '')) = ANY($${p})`);
    params.push(asFilterList(saleStatus).map((v) => v.toLowerCase())); p++;
  }

  const processed = (query.processed || '').trim();
  if (uses('processed') && processed === 'yes') conditions.push('s.processed_at IS NOT NULL');
  if (uses('processed') && processed === 'no') conditions.push('s.processed_at IS NULL');

  const skuMapped = (query.skuMapped || '').trim();
  if (uses('skuMapped') && skuMapped === 'yes') conditions.push(U_SKU_MAPPED);
  if (uses('skuMapped') && skuMapped === 'no') conditions.push(`NOT ${U_SKU_MAPPED}`);

  const queue = (query.queue || '').trim();
  if (uses('queue') && queue === 'pending') conditions.push(U_PENDING);
  if (uses('queue') && queue === 'cancelled') conditions.push(U_CANCELLED);
  if (uses('queue') && queue === 'valid') conditions.push(`NOT ${U_CANCELLED}`);

  // A visão master global pode não ter nenhum predicado (por exemplo com
  // `window=all` e sem cliente inativo), e `WHERE` sozinho seria SQL inválido.
  return {
    where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
    nextIndex: p,
  };
}

/**
 * Opções disponíveis para cada filtro, já considerando os outros filtros
 * ativos. Cada faceta ignora apenas o próprio campo, de modo que o usuário
 * nunca veja uma combinação que resultaria em lista vazia.
 */
/* Campos que alteram o resultado de facetas e dashboard. Usados para montar a
 * chave de cache: qualquer outro parâmetro (page, limit, _t) não muda a
 * agregação e não deve gerar uma entrada nova. */
const UNIFIED_FILTER_FIELDS = [
  'from', 'to', 'shipFrom', 'shipTo', 'window',
  'marketplace', 'account', 'shippingStatus', 'shippingMode', 'saleStatus',
  'processed', 'skuMapped', 'queue', 'search',
  // Escopo master: `scope=all` troca o dono fixo pela visão global e
  // `userNickname` recorta por cliente. Ambos mudam a agregação, então precisam
  // entrar na chave de cache.
  'scope', 'userNickname',
];

const FACETS_TTL_MS = configInt('SALES_FACETS_TTL_MS', 60000, 5000, 600000);
const DASHBOARD_TTL_MS = configInt('SALES_DASHBOARD_TTL_MS', 60000, 5000, 600000);

router.get('/filter-facets', authenticateToken, async (req, res) => {
  /* Escopo. Master pode pedir a visão global (`scope=all`), que é o que o
   * tabelão do painel admin lista. Qualquer outro caso — inclusive um usuário
   * comum tentando `scope=all` — permanece preso ao próprio uid do token. */
  const isMaster = req.user.role === 'master';
  const globalScope = isMaster && (req.query.scope || '').trim() === 'all';
  const uid = globalScope ? null : req.user.uid;

  try {
    const cacheKey = cacheKeyFromQuery(`facets|${req.user.uid}`, req.query, UNIFIED_FILTER_FIELDS);
    const payload = await withResponseCache(
      cacheKey,
      FACETS_TTL_MS,
      () => buildFacets(req, uid, { globalScope })
    );
    res.json(payload);
  } catch (error) {
    console.error('Erro ao montar opções de filtro:', error);
    res.status(500).json({ error: 'Erro interno ao carregar opções de filtro.' });
  }
});

async function buildFacets(req, uid, options = {}) {
  {
    const { globalScope = false } = options;

    /* Na visão global não existe dono fixo: o recorte por usuário é resolvido
     * aqui, do mesmo modo que /sales/all faz — esconde cliente inativo e, se o
     * filtro de cliente estiver preenchido, restringe aos uids daquele nome. */
    let excludeUids = null;
    let includeUids = null;
    const userNickname = (req.query.userNickname || '').trim();
    if (globalScope) {
      const [inactive, byName] = await Promise.all([
        db.query('SELECT uid FROM public.users WHERE active = false'),
        userNickname
          ? db.query('SELECT uid FROM public.users WHERE name ILIKE $1', [`%${userNickname}%`])
          : Promise.resolve({ rows: [] }),
      ]);
      excludeUids = inactive.rows.map((r) => r.uid);
      // Lista vazia é intencional: nome sem cliente correspondente não tem
      // opção alguma, e é isso que a tela deve mostrar.
      if (userNickname) includeUids = byName.rows.map((r) => r.uid);
    }

    const facet = (skipName, keyExpr, extraSelect = '') => {
      const { where, params } = buildUnifiedFilters(req.query, uid, {
        skip: [skipName], includeUids, excludeUids,
      });
      return db.query(
        `SELECT ${keyExpr} AS value${extraSelect},
                COUNT(DISTINCT (s.marketplace, COALESCE(s.account_id, ''), s.id))::int AS count
           FROM public.unified_sales s
           ${where}
          GROUP BY 1${extraSelect ? ', 2' : ''}
          ORDER BY count DESC
          LIMIT 60`,
        params
      );
    };

    const [marketplaces, accounts, statuses, modes, saleStatuses, owners] = await Promise.all([
      facet('marketplace', 's.marketplace'),
      facet('account', U_ACCOUNT_KEY, `, COALESCE(NULLIF(s.account_nickname, ''), s.account_id) AS label`),
      facet('shippingStatus', U_SHIPPING_STATUS),
      facet('shippingMode', U_SHIPPING_MODE),
      facet('saleStatus', `LOWER(COALESCE(NULLIF(s.order_status, ''), 'sem_status'))`),
      // O filtro de cliente só existe na visão master.
      globalScope ? facet('userNickname', 's.uid') : Promise.resolve({ rows: [] }),
    ]);

    /* O filtro do painel admin casa o cliente por NOME, então a faceta traduz
     * uid em nome e soma os totais de quem compartilha o mesmo nome. */
    let users = [];
    if (globalScope && owners.rows.length) {
      const uids = owners.rows.map((r) => r.value).filter(Boolean);
      const named = uids.length
        ? await db.query(
          `SELECT uid, COALESCE(NULLIF(TRIM(name), ''), email) AS label
             FROM public.users
            WHERE uid = ANY($1)`,
          [uids]
        )
        : { rows: [] };
      const labelByUid = new Map(named.rows.map((r) => [r.uid, r.label]));
      const totals = new Map();
      for (const row of owners.rows) {
        const label = labelByUid.get(row.value);
        if (!label) continue;
        totals.set(label, (totals.get(label) || 0) + row.count);
      }
      users = [...totals.entries()]
        .map(([label, count]) => ({ value: label, label, count }))
        .sort((a, b) => b.count - a.count);
    }

    const MK_LABEL = { ML: 'Mercado Livre', Shopee: 'Shopee' };
    return {
      marketplaces: marketplaces.rows.map((r) => ({
        value: r.value, label: MK_LABEL[r.value] || r.value, count: r.count,
      })),
      accounts: accounts.rows.map((r) => ({
        value: r.value,
        label: r.label || r.value,
        marketplace: String(r.value || '').split(':')[0],
        count: r.count,
      })),
      shippingStatuses: statuses.rows.map((r) => ({ value: r.value, label: r.value, count: r.count })),
      shippingModes: modes.rows.map((r) => ({ value: r.value, label: r.value, count: r.count })),
      saleStatuses: saleStatuses.rows.map((r) => ({ value: r.value, label: r.value, count: r.count })),
      users,
    };
  }
}

router.get('/dashboard-stats', authenticateToken, async (req, res) => {
  const { uid } = req.user;
  try {
    const cacheKey = cacheKeyFromQuery(`dashboard|${uid}`, req.query, UNIFIED_FILTER_FIELDS);
    const payload = await withResponseCache(cacheKey, DASHBOARD_TTL_MS, () => buildDashboardStats(req, uid));
    res.json(payload);
  } catch (error) {
    console.error('Erro ao montar métricas do dashboard:', error);
    res.status(500).json({ error: 'Erro interno ao carregar métricas.' });
  }
});

async function buildDashboardStats(req, uid) {
  const from = (req.query.from || '').trim();
  const to = (req.query.to || '').trim();

  {
    // Mesmo construtor usado por /filter-facets: garante que o número do card
    // e a opção clicada no filtro venham exatamente da mesma regra.
    const current = buildUnifiedFilters(req.query, uid);
    const where = current.where;
    const params = current.params;

    // Mesmo recorte, deslocado para o período imediatamente anterior de igual
    // duração. Serve para os cards mostrarem a variação, em vez de um número
    // solto sem referência.
    let previousWhere = null;
    let previousParams = [];
    if (from && to) {
      const start = new Date(`${from}T00:00:00Z`);
      const end = new Date(`${to}T00:00:00Z`);
      const days = Math.max(1, Math.round((end - start) / 86400000) + 1);
      const prevEnd = new Date(start); prevEnd.setUTCDate(prevEnd.getUTCDate() - 1);
      const prevStart = new Date(prevEnd); prevStart.setUTCDate(prevStart.getUTCDate() - (days - 1));
      const iso = (d) => d.toISOString().slice(0, 10);

      // Mesmos filtros, apenas deslocando a janela de datas.
      const previousFilters = buildUnifiedFilters(req.query, uid, {
        dateRange: { from: iso(prevStart), to: iso(prevEnd) },
      });
      previousWhere = previousFilters.where;
      previousParams = previousFilters.params;
    }

    // A view possui uma linha por SKU do pedido. Todos os indicadores de
    // pedidos precisam deduplicar por canal + conta + ID para não inflar os
    // números quando uma compra contém mais de um produto.
    const orderKey = `(s.marketplace, COALESCE(s.account_id, ''), s.id)`;
    // Cancelamento e fila de despacho vêm das expressões canônicas, as mesmas
    // que o filtro `queue` aplica — card e filtro nunca divergem.
    const cancelledExpr = U_CANCELLED;
    const pendingExpr = U_PENDING;

    const [totals, byStatus, byDay, byMarketplace, byShippingMode, topSkus, previous] = await Promise.all([
      db.query(
        `SELECT
           COUNT(DISTINCT ${orderKey})::int AS orders,
           COUNT(DISTINCT ${orderKey})::int AS sales,
           COALESCE(SUM(s.quantity), 0)::int AS units,
           (COUNT(DISTINCT ${orderKey}) FILTER (WHERE ${pendingExpr}))::int AS pending_orders,
           (COUNT(DISTINCT ${orderKey}) FILTER (WHERE ${pendingExpr}))::int AS pending,
           (COUNT(DISTINCT ${orderKey}) FILTER (WHERE NOT (${cancelledExpr})))::int AS valid_orders,
           (COUNT(DISTINCT ${orderKey}) FILTER (WHERE ${cancelledExpr}))::int AS cancelled_orders,
           (COUNT(DISTINCT ${orderKey}) FILTER (WHERE ${cancelledExpr}))::int AS cancelled,
           (COUNT(DISTINCT ${orderKey}) FILTER (WHERE s.processed_at IS NOT NULL))::int AS processed_orders,
           (COUNT(DISTINCT ${orderKey}) FILTER (WHERE s.processed_at IS NOT NULL))::int AS processed,
           COUNT(*) FILTER (WHERE s.processed_at IS NOT NULL)::int AS processed_lines,
           COUNT(DISTINCT s.sku)::int AS distinct_skus
         FROM public.unified_sales s ${where}`,
        params
      ),
      db.query(
        `SELECT ${U_SHIPPING_STATUS} AS label,
                COUNT(DISTINCT ${orderKey})::int AS value
         FROM public.unified_sales s ${where}
         GROUP BY 1 ORDER BY value DESC LIMIT 9`,
        params
      ),
      db.query(
        // Dia no fuso de Brasília, para casar com o que o usuário vê na tela.
        `SELECT (s.sale_date AT TIME ZONE 'America/Sao_Paulo')::date AS day,
                COUNT(DISTINCT ${orderKey})::int AS value
         FROM public.unified_sales s ${where}
         GROUP BY 1 ORDER BY 1 ASC`,
        params
      ),
      db.query(
        `SELECT s.marketplace, COUNT(DISTINCT ${orderKey})::int AS value
         FROM public.unified_sales s ${where}
         GROUP BY 1 ORDER BY value DESC`,
        params
      ),
      db.query(
        `SELECT ${U_SHIPPING_MODE} AS mode,
                COUNT(DISTINCT ${orderKey})::int AS value
         FROM public.unified_sales s ${where}
         GROUP BY 1 ORDER BY value DESC LIMIT 8`,
        params
      ),
      db.query(
        `SELECT s.sku,
                (array_agg(s.product_title ORDER BY s.sale_date DESC))[1] AS title,
                COALESCE(SUM(s.quantity), 0)::int AS units,
                COUNT(DISTINCT ${orderKey})::int AS orders
         FROM public.unified_sales s ${where}
         GROUP BY s.sku ORDER BY units DESC LIMIT 8`,
        params
      ),
      previousWhere
        ? db.query(
            `SELECT COUNT(DISTINCT ${orderKey})::int AS orders,
                    COUNT(DISTINCT ${orderKey})::int AS sales,
                    COALESCE(SUM(s.quantity), 0)::int AS units
             FROM public.unified_sales s ${previousWhere}`,
            previousParams
          )
        : Promise.resolve({ rows: [] }),
    ]);

    return {
      totals: totals.rows[0] || {
        orders: 0, sales: 0, units: 0, pending_orders: 0, pending: 0,
        valid_orders: 0, cancelled_orders: 0, cancelled: 0,
        processed_orders: 0, processed: 0, processed_lines: 0, distinct_skus: 0,
      },
      previousTotals: previous.rows[0] || null,
      byStatus: byStatus.rows,
      byDay: byDay.rows.map((r) => ({
        day: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10),
        value: r.value,
      })),
      byMarketplace: byMarketplace.rows,
      byShippingMode: byShippingMode.rows,
      topSkus: topSkus.rows,
    };
  }
}

/**
 * Payload bruto e completo de UMA venda, sob demanda.
 *
 * A listagem envia um raw_api_data enxuto por performance; quem precisa do
 * JSON íntegro (modal "Ver JSON" do master) busca aqui, uma venda por vez.
 */
router.get('/raw/:marketplace/:id/:sku', authenticateToken, async (req, res) => {
  const { marketplace, id, sku } = req.params;
  const { uid, role } = req.user;
  const isShopee = String(marketplace).toLowerCase() === 'shopee';

  try {
    const table = isShopee ? 'public.shopee_sales' : 'public.sales';
    const idColumn = isShopee ? 'order_sn' : 'id';

    // Usuário comum só vê o próprio pedido; master vê de qualquer um.
    const conditions = [`${idColumn}::text = $1`, 'sku = $2'];
    const params = [id, sku];
    if (role !== 'master') {
      conditions.push('uid = $3');
      params.push(uid);
    }

    const { rows } = await db.query(
      `SELECT raw_api_data FROM ${table} WHERE ${conditions.join(' AND ')} LIMIT 1`,
      params
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Venda não encontrada.' });

    res.json({ raw_api_data: rows[0].raw_api_data });
  } catch (error) {
    console.error('Erro ao buscar payload bruto da venda:', error);
    res.status(500).json({ error: 'Erro interno ao buscar dados da venda.' });
  }
});

/**
 * Contadores leves usados pelo painel de armazenamento. Evita transferir até
 * 250 vendas (incluindo JSON) apenas para calcular um único número na tela.
 */
router.get('/user/:uid/stats', authenticateToken, requireOwnerOrMaster, async (req, res) => {
  const { uid } = req.params;
  try {
    /* Conta nas TABELAS DE ORIGEM, não na view.
     *
     * Era o único COUNT(*) do sistema sem teto nem janela sobre
     * public.unified_sales. O Postgres não elimina colunas não usadas de um
     * UNION ALL, então mesmo contando linhas ele avaliava a lista de saída da
     * view para cada linha das duas tabelas: extração de JSONB, regex e cast do
     * prazo, montagem do nome do comprador. Somando direto nas tabelas, a
     * contagem usa os índices por uid e não toca em JSON nenhum.
     */
    const { rows } = await db.query(`
      WITH ml AS (
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (
            WHERE LOWER(COALESCE(shipping_status, '')) IN
              ('custom_06_despachado', 'expedited', 'despachado', 'shipped')
          )::int AS expedited,
          COUNT(*) FILTER (WHERE processed_at IS NOT NULL)::int AS processed
        FROM public.sales WHERE uid = $1
      ), sp AS (
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (
            WHERE LOWER(COALESCE(shipping_status, '')) IN
              ('custom_06_despachado', 'expedited', 'despachado', 'shipped')
          )::int AS expedited,
          COUNT(*) FILTER (WHERE processed_at IS NOT NULL)::int AS processed
        FROM public.shopee_sales WHERE uid = $1
      )
      SELECT
        (ml.total + sp.total)         AS total_sales,
        (ml.expedited + sp.expedited) AS expedited_count,
        (ml.processed + sp.processed) AS processed_count
      FROM ml, sp
    `, [uid]);
    res.json(rows[0] || { total_sales: 0, expedited_count: 0, processed_count: 0 });
  } catch (error) {
    console.error('Erro ao buscar contadores de vendas do usuário:', error);
    res.status(500).json({ error: 'Erro interno ao buscar contadores de vendas.' });
  }
});

/**
 * Últimas vendas de um usuário.
 *
 * Era master-only, mas a tela /armazenamento é de cliente comum e chama esta
 * rota com o próprio uid — todo usuário não-master levava 403 ali. Mesmo caso
 * de /users/statuses/:uid e /users/contracts/:uid: o dono vê os próprios
 * dados, o master vê de qualquer um.
 *
 * Passou a ler de public.unified_sales para que as vendas Shopee também
 * apareçam. Os apelidos de coluna mantêm o contrato antigo (`channel` e
 * `shipping_limit_date`) para não mexer em quem já consome.
 */
router.get('/user/:uid', authenticateToken, requireOwnerOrMaster, async (req, res) => {
  const { uid } = req.params;
  if (!uid) return res.status(400).json({ error: 'O UID do usuário é obrigatório.' });
  try {
    /* raw_api_data ENXUTO.
     *
     * Esta rota devolvia o payload cru do pedido para 250 linhas. O payload
     * completo do ML passa de dezenas de KB por venda, então a resposta chegava
     * a vários MB — baixados e parseados a cada abertura da tela, para exibir
     * meia dúzia de campos. Aqui vão apenas os caminhos que as telas usam, no
     * mesmo formato de /sales/all e /sales/my-sales.
     */
    const query = `
      SELECT s.id, s.sku, s.uid,
             s.account_id            AS seller_id,
             s.marketplace,
             s.marketplace           AS channel,
             s.account_nickname, s.sale_date, s.product_title, s.quantity,
             s.shipping_mode,
             s.shipping_deadline     AS shipping_limit_date,
             s.shipping_status, s.order_status, s.product_thumbnail,
             jsonb_build_object(
               'status', s.order_status,
               'tags', COALESCE(s.raw_api_data->'tags', '[]'::jsonb),
               'sla_data', jsonb_build_object('expected_date', s.shipping_deadline),
               'shipping', jsonb_build_object(
                 'id', s.shipping_id,
                 'logistic_type', s.raw_api_data->'shipping'->>'logistic_type'
               ),
               'seller', jsonb_build_object('id', s.account_id),
               'buyer', jsonb_build_object(
                 'first_name', s.buyer_name,
                 'last_name', NULL,
                 'nickname', s.buyer_nickname
               )
             )                       AS raw_api_data,
             s.buyer_name            AS buyer_first_name,
             NULL::text              AS buyer_last_name,
             s.buyer_nickname,
             s.updated_at, s.processed_at
      FROM public.unified_sales s
      WHERE s.uid = $1
      ORDER BY s.sale_date DESC
      LIMIT 250;
    `;
    const { rows } = await db.query(query, [uid]);
    res.json(rows);
  } catch (error) {
    console.error('Erro ao buscar vendas do usuário:', error);
    res.status(500).json({ error: 'Erro interno ao buscar vendas.' });
  }
});

router.get('/my-sales', authenticateToken, async (req, res) => {
  const { uid } = req.user;
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;
    
    const search = (req.query.search || '').trim();
    const shippingStatus = (req.query.shippingStatus || '').trim();
    const saleStatus = (req.query.saleStatus || '').trim();
    const saleDateStart = (req.query.saleDateStart || '').trim();
    const saleDateEnd = (req.query.saleDateEnd || '').trim();
    const account = (req.query.account || '').trim(); // Expected to be seller_id or account_nickname
    const buyer = (req.query.buyer || '').trim();
    const shippingLimitStart = (req.query.shippingLimitStart || '').trim();
    const shippingLimitEnd = (req.query.shippingLimitEnd || '').trim();
    const shippingMode = (req.query.shippingMode || '').trim();
    const processed = (req.query.processed || '').trim(); // 'yes' = processados | 'no' = não processados
    // 'ML' | 'Shopee' | vazio = todos os marketplaces.
    const marketplace = (req.query.marketplace || '').trim();

    // Consulta a view unificada (public.unified_sales): as colunas já vêm
    // normalizadas entre Mercado Livre e Shopee, então um único conjunto de
    // filtros serve para os dois canais.
    const conditions = ['s.uid = $1'];
    const params = [uid];
    let paramIdx = 2;

    // Os filtros de seleção múltipla chegam como lista separada por vírgula.
    // Uma lista com um único item funciona igual ao filtro simples anterior,
    // então o contrato antigo continua válido.
    const asList = (value) => value.split(',').map((v) => v.trim()).filter(Boolean);

    if (marketplace) {
      conditions.push(`s.marketplace = ANY($${paramIdx})`);
      params.push(asList(marketplace));
      paramIdx++;
    }
    if (search) {
      conditions.push(`(
        s.product_title ILIKE $${paramIdx}
        OR s.sku ILIKE $${paramIdx}
        OR s.account_nickname ILIKE $${paramIdx}
        OR s.id ILIKE $${paramIdx}
      )`);
      params.push(`%${search}%`);
      paramIdx++;
    }
    if (shippingStatus) {
      // Comparação em minúsculas porque a tela monta as opções a partir de duas
      // fontes (status configurados pelo usuário e valores vistos nas vendas),
      // que divergem na caixa — "Pendente" x "pendente" precisa casar igual.
      const wanted = asList(shippingStatus).map((v) => v.toLowerCase());

      // "Cancelado" não é um status de expedição: vive em order_status. Sem esse
      // desvio, escolher Cancelado no filtro devolvia lista vazia.
      const wantsCancelled = wanted.includes('cancelled');
      const shippingWanted = wanted.filter((v) => v !== 'cancelled');

      const parts = [];
      if (shippingWanted.length) {
        parts.push(`LOWER(COALESCE(NULLIF(s.shipping_status, ''), 'Pendente')) = ANY($${paramIdx})`);
        params.push(shippingWanted);
        paramIdx++;
      }
      if (wantsCancelled) {
        parts.push(`LOWER(COALESCE(s.order_status, '')) = 'cancelled'`);
      }
      if (parts.length) conditions.push(`(${parts.join(' OR ')})`);
    }
    if (saleStatus) {
      // Mesma regra do tabelão admin: sem caixa e por lista, para cobrir o
      // status em maiúsculas da Shopee e o em minúsculas do Mercado Livre.
      conditions.push(`LOWER(COALESCE(s.order_status, '')) = ANY($${paramIdx})`);
      params.push(asList(saleStatus).map((v) => v.toLowerCase()));
      paramIdx++;
    }
    /* Janela padrão, igual à do tabelão admin.
     *
     * Esta tela é a do cliente e não tinha recorte de data nenhum: sem filtro,
     * varria o histórico completo do usuário nos dois canais, com extração de
     * JSONB por linha. Era o principal caminho para o "Carregando vendas..."
     * eterno seguido de erro por tempo limite.
     */
    const windowMode = (req.query.window || '').trim();
    const WINDOW_DAYS = { today: 0, '7d': 7, '30d': 30, '90d': 90 };
    let defaultWindowDays = null;

    if (saleDateStart) {
      conditions.push(`s.sale_date >= $${paramIdx}`);
      // Limite do dia em horário de Brasília (UTC-3), consistente com o tabelão.
      params.push(saleDateStart + 'T00:00:00-03:00');
      paramIdx++;
    } else if (windowMode !== 'all') {
      defaultWindowDays = Object.prototype.hasOwnProperty.call(WINDOW_DAYS, windowMode)
        ? WINDOW_DAYS[windowMode]
        : configInt('USER_SALES_WINDOW_DAYS', 30, 1, 3650);
      conditions.push(`s.sale_date >= (
        ((now() AT TIME ZONE 'America/Sao_Paulo')::date - ($${paramIdx})::int)
      ) AT TIME ZONE 'America/Sao_Paulo'`);
      params.push(defaultWindowDays);
      paramIdx++;
    }
    if (saleDateEnd) {
      conditions.push(`s.sale_date <= $${paramIdx}`);
      params.push(saleDateEnd + 'T23:59:59.999-03:00');
      paramIdx++;
    }
    if (account) {
      // Valores novos usam namespace (ML:123 / Shopee:123), impedindo que
      // IDs numéricos iguais de canais diferentes se contaminem. O segundo
      // termo preserva compatibilidade com links/filtros antigos sem prefixo.
      conditions.push(`(
        (s.marketplace || ':' || s.account_id) = ANY($${paramIdx})
        OR s.account_id = ANY($${paramIdx})
        OR s.account_nickname = ANY($${paramIdx})
      )`);
      params.push(asList(account));
      paramIdx++;
    }
    if (buyer) {
      conditions.push(`(s.buyer_name ILIKE $${paramIdx} OR s.buyer_nickname ILIKE $${paramIdx})`);
      params.push(`%${buyer}%`);
      paramIdx++;
    }
    if (shippingMode) {
      // Mesma expressão das opções de filtro: sem isso, um chip legítimo como
      // "Agência" (derivado do logistic_type do ML) não casaria com nada.
      conditions.push(`${U_SHIPPING_MODE} = ANY($${paramIdx})`);
      params.push(asList(shippingMode));
      paramIdx++;
    }
    if (shippingLimitStart) {
      conditions.push(`s.shipping_deadline >= $${paramIdx}`);
      params.push(shippingLimitStart + 'T00:00:00-03:00');
      paramIdx++;
    }
    if (shippingLimitEnd) {
      conditions.push(`s.shipping_deadline <= $${paramIdx}`);
      params.push(shippingLimitEnd + 'T23:59:59.999-03:00');
      paramIdx++;
    }
    // Ao filtrar por PRAZO DE EXPEDIÇÃO, exclui FULL (vendedor não despacha FULL).
    // Usa a modalidade canônica: um FULL cujo shipping_mode está vazio e só
    // aparece no logistic_type passava por aqui, e as opções de filtro (que já
    // usam a expressão canônica) não previam essa linha.
    if (shippingLimitStart || shippingLimitEnd) {
      conditions.push(`${U_SHIPPING_MODE} IS DISTINCT FROM 'FULL'`);
    }
    // Filtro de PROCESSADO / NÃO PROCESSADO (abatimento de estoque).
    if (processed === 'yes') {
      conditions.push(`s.processed_at IS NOT NULL`);
    } else if (processed === 'no') {
      conditions.push(`s.processed_at IS NULL`);
    }

    // Combinações operacionais adicionais, com a MESMA regra usada nos cards do
    // dashboard: fila de despacho, cancelados e SKU ainda sem cadastro.
    const queue = (req.query.queue || '').trim();
    if (queue === 'pending') conditions.push(U_PENDING);
    else if (queue === 'cancelled') conditions.push(U_CANCELLED);
    else if (queue === 'valid') conditions.push(`NOT ${U_CANCELLED}`);

    const skuMapped = (req.query.skuMapped || '').trim();
    if (skuMapped === 'yes') conditions.push(U_SKU_MAPPED);
    else if (skuMapped === 'no') conditions.push(`NOT ${U_SKU_MAPPED}`);

    const whereClause = 'WHERE ' + conditions.join(' AND ');

    // Contagem com teto e nas tabelas de origem, pelo mesmo motivo do tabelão.
    const countQuery = buildCountQuery(whereClause);
    // Primeiro recorta somente a página pedida. O MATERIALIZED é intencional:
    // garante que lookup de SKU, expansão de JSON e montagem do payload sejam
    // executados para no máximo limit + 1 linhas, nunca para todo o histórico.
    const dataQuery = `
      WITH page_rows AS MATERIALIZED (
        SELECT s.*
          FROM public.unified_sales s
          ${whereClause}
         -- Só sale_date, para aproveitar o índice (sale_date DESC) das tabelas
         -- de origem e não ordenar o histórico inteiro antes do LIMIT.
         ORDER BY s.sale_date DESC
         LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
      )
      SELECT s.id, s.sku, s.uid, s.marketplace,
        s.marketplace AS channel,
        s.account_id AS seller_id,
        s.account_nickname, s.sale_date,
        s.product_title, s.quantity, s.shipping_mode,
        s.shipping_deadline AS shipping_limit_date,
        s.shipping_status, s.updated_at, s.processed_at,
        -- raw_api_data ENXUTO: o payload completo do pedido chega a dezenas de
        -- KB. Apenas os caminhos efetivamente usados pela tela seguem aqui.
        jsonb_build_object(
          'status', s.order_status,
          'tags', COALESCE(s.raw_api_data->'tags', '[]'::jsonb),
          'sla_data', jsonb_build_object('expected_date', s.shipping_deadline),
          'shipping', jsonb_build_object(
            'id', s.shipping_id,
            'logistic_type', s.raw_api_data->'shipping'->>'logistic_type'
          ),
          'seller', jsonb_build_object('id', s.account_id),
          'buyer', jsonb_build_object(
            'first_name', s.buyer_name,
            'last_name', NULL,
            'nickname', s.buyer_nickname
          )
        ) AS raw_api_data,
        s.order_status as sale_status,
        s.shipping_id,
        s.shipping_deadline as sla_expected_date,
        s.product_thumbnail,
        s.product_permalink,
        s.item_id as ml_item_id,
        s.buyer_name as buyer_first_name,
        NULL::text as buyer_last_name,
        s.buyer_nickname,
        COALESCE(skm.mapped, false) AS is_sku_mapped,
        skm.descricao AS sku_descricao,
        CASE WHEN s.marketplace = 'ML' THEN COALESCE(
          (SELECT oi->'item'->'variation_attributes'
             FROM jsonb_array_elements(COALESCE(s.raw_api_data->'order_items', '[]'::jsonb)) oi
            WHERE UPPER(TRIM(COALESCE(oi->'item'->>'seller_sku', oi->'item'->>'id', ''))) = UPPER(TRIM(s.sku))
            LIMIT 1),
          (SELECT oi->'item'->'variation_attributes'
             FROM jsonb_array_elements(COALESCE(s.raw_api_data->'order_items', '[]'::jsonb)) oi
            LIMIT 1)
        ) END AS variation_attributes
      FROM page_rows s
      LEFT JOIN LATERAL (
        SELECT
          bool_or(sk.ativo) AS mapped,
          (array_agg(sk.descricao ORDER BY sk.ativo DESC)
             FILTER (WHERE sk.descricao IS NOT NULL AND TRIM(sk.descricao) <> ''))[1] AS descricao
        FROM public.skus sk
        WHERE sk.user_id = $1
          AND UPPER(TRIM(sk.sku)) = UPPER(TRIM(s.sku))
      ) skm ON TRUE
      ORDER BY s.sale_date DESC, s.marketplace, s.id, s.sku;
    `;

    // A página rápida nunca aguarda o COUNT do histórico. `countOnly=1` é
    // chamado em segundo plano pelo frontend e compartilha a mesma Promise de
    // contagem, evitando varreduras duplicadas.
    const countKey = `${uid}|${whereClause}|${JSON.stringify(params)}`;
    const cachedTotal = getCachedSalesCount(countKey);

    if (req.query.countOnly === '1') {
      // Mesma regra do tabelão: o total é um refinamento, não pode virar erro.
      let counted;
      try {
        counted = cachedTotal === null
          ? await loadSalesCount(countKey, countQuery, params)
          : cachedTotal;
      } catch (countError) {
        console.error('Total de vendas indisponível:', countError.message);
        return res.json({ total: null, totalExact: false, totalPages: page + 1 });
      }
      const bounded = resolveBoundedTotal(counted);
      return res.json({
        total: bounded.total,
        totalExact: bounded.exact,
        totalPages: bounded.exact ? (Math.ceil(bounded.total / limit) || 1) : page + 1,
      });
    }

    // Busca uma linha extra para descobrir se existe próxima página sem COUNT.
    const dataResult = await db.query(dataQuery, [...params, limit + 1, offset]);
    const hasNext = dataResult.rows.length > limit;
    const rows = hasNext ? dataResult.rows.slice(0, limit) : dataResult.rows;

    let total = null;
    let totalExact = false;

    if (cachedTotal !== null) {
      const bounded = resolveBoundedTotal(cachedTotal);
      total = bounded.total;
      totalExact = bounded.exact;
    } else if (!hasNext) {
      // Última página: o total sai da posição atual, sem contar nada.
      total = offset + rows.length;
      totalExact = true;
      setCachedSalesCount(countKey, total);
    } else {
      // Limite inferior enquanto a contagem roda em segundo plano.
      total = offset + rows.length + 1;
    }

    res.json({
      data: rows,
      total,
      totalExact,
      hasNext,
      page,
      limit,
      totalPages: totalExact ? (Math.ceil(total / limit) || 1) : page + 1,
      // A tela avisa qual janela está em uso, para o total não parecer errado.
      defaultWindowDays,
    });

    if (!totalExact) {
      setImmediate(() => {
        loadSalesCount(countKey, countQuery, params).catch((error) => {
          console.error('Erro ao aquecer total de vendas:', error);
        });
      });
    }
    setImmediate(() => warmMlThumbnailCache(rows, uid));
  } catch (error) {
    console.error("Erro interno ao buscar minhas vendas:", error);
    res.status(500).json({ error: 'Erro interno ao buscar vendas.' });
  }
});

router.put('/status', authenticateToken, requireMaster, async (req, res) => {
  const { saleId, sku, uid, shippingStatus, force } = req.body;
  if (!saleId || !sku || !uid || !shippingStatus) {
    return res.status(400).json({ error: 'Dados incompletos.' });
  }

  const isDespachado = /despachado/i.test(String(shippingStatus));

  if (isDespachado) {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      const saleQ = `
        SELECT id, sku, uid, quantity, processed_at
          FROM public.sales
         WHERE id = $1 AND sku = $2 AND uid = $3
         FOR UPDATE;
      `;
      const saleR = await client.query(saleQ, [saleId, sku, uid]);
      if (saleR.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Venda não encontrada.' });
      }

      const sale = saleR.rows[0];

      if (sale.processed_at) {
        if (!force) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Venda já processada.' });
        }

        const updForced = `
          UPDATE public.sales
             SET shipping_status = $1,
                 updated_at     = NOW()
           WHERE id = $2 AND sku = $3 AND uid = $4
           RETURNING id, shipping_status, processed_at;
        `;
        const forcedRes = await client.query(updForced, [shippingStatus, saleId, sku, uid]);
        await client.query('COMMIT');
        return res.status(200).json({
          message: 'Status atualizado (forçado) sem reprocessar estoque.',
          sale: forcedRes.rows[0]
        });
      }

      const quantitySold = Number(sale.quantity || 0);
      if (!quantitySold) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Quantidade da venda inválida.' });
      }

      const skuQ = `
        SELECT s.id, s.quantidade, s.is_kit, s.package_type_id, s.sku as sku_code
          FROM public.skus s
         WHERE UPPER(TRIM(s.sku)) = UPPER(TRIM($1))
           AND s.user_id = $2
         FOR UPDATE;
      `;
      const skuR = await client.query(skuQ, [sku, uid]);
      if (skuR.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `SKU '${sku}' não encontrado.` });
      }

      const stock = skuR.rows[0];

      // A embalagem faturada sempre pertence ao SKU efetivamente vendido.
      // Um SKU individual pode participar de vários kits, mas essa relação
      // não transforma uma venda unitária em venda de kit.
      
      // Handle kit vs regular SKU logic
      if (stock.is_kit) {
        // For kits, check component availability and deduct from child SKUs
        const kitComponentsQuery = `
          SELECT child_sku_id, quantity_per_kit
          FROM public.sku_kit_components
          WHERE kit_sku_id = $1
          ORDER BY child_sku_id
        `;
        const kitComponents = await client.query(kitComponentsQuery, [stock.id]);

        if (kitComponents.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `Kit '${sku}' não possui componentes configurados.` });
        }

        // Check if we have enough stock of all child SKUs
        for (const component of kitComponents.rows) {
          const childSkuQuery = 'SELECT id, sku, quantidade FROM public.skus WHERE id = $1 FOR UPDATE';
          const childSku = await client.query(childSkuQuery, [component.child_sku_id]);
          
          if (childSku.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: `SKU filho não encontrado para o kit '${sku}'.` });
          }
          
          const requiredQuantity = component.quantity_per_kit * quantitySold;
          if (childSku.rows[0].quantidade < requiredQuantity) {
            await client.query('ROLLBACK');
            return res.status(400).json({ 
              error: `Estoque insuficiente do SKU filho ${childSku.rows[0].sku} para o kit '${sku}'. Disponível: ${childSku.rows[0].quantidade}, Necessário: ${requiredQuantity}` 
            });
          }
        }

        // Deduct from child SKUs
        for (const component of kitComponents.rows) {
          const requiredQuantity = component.quantity_per_kit * quantitySold;
          
          // Update child SKU quantity
          const updateChildQuery = `
            UPDATE public.skus SET quantidade = quantidade - $1, updated_at = NOW() WHERE id = $2;
          `;
          await client.query(updateChildQuery, [requiredQuantity, component.child_sku_id]);
          
          // Record movement for child SKU
          const insertChildMovementQuery = `
            INSERT INTO public.stock_movements (sku_id, user_id, movement_type, quantity_change, reason, related_sale_id)
            VALUES ($1, $2, 'saida', $3, $4, $5)
          `;
          await client.query(insertChildMovementQuery, [
            component.child_sku_id, 
            uid, 
            requiredQuantity, 
            `Saída por Kit: Saída por Venda - ID: ${saleId}`, 
            saleId
          ]);
        }

        // Movimento faturável do kit vendido; as baixas dos filhos acima são
        // apenas movimentos físicos e não geram outra cobrança de embalagem.
        const insertKitMovementQuery = `
          INSERT INTO public.stock_movements
            (sku_id, user_id, movement_type, quantity_change, reason, related_sale_id, package_type_id, package_type_context)
          VALUES ($1, $2, 'saida', $3, $4, $5, $6, $7)
        `;
        await client.query(insertKitMovementQuery, [
          stock.id,
          uid,
          quantitySold,
          `Saída por Venda - ID: ${saleId}`,
          saleId,
          stock.package_type_id,
          `Kit vendido: ${stock.sku_code}`
        ]);
      } else {
        // Regular SKU logic
        if (Number(stock.quantidade) < quantitySold) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `Estoque insuficiente para SKU '${sku}'.` });
        }

        await client.query(
          'UPDATE public.skus SET quantidade = quantidade - $1, updated_at = NOW() WHERE id = $2',
          [quantitySold, stock.id]
        );

        const reason = `Saída por Venda - ID: ${saleId}`;
        await client.query(
          `INSERT INTO public.stock_movements
             (sku_id, user_id, movement_type, quantity_change, reason, related_sale_id, package_type_id, package_type_context)
           VALUES ($1, $2, 'saida', $3, $4, $5, $6, $7)`,
          [stock.id, uid, quantitySold, reason, saleId, stock.package_type_id, 'SKU vendido diretamente']
        );
      }

      const updSaleQ = `
        UPDATE public.sales
           SET shipping_status = $1,
               processed_at   = NOW(),
               updated_at     = NOW()
         WHERE id  = $2
           AND sku = $3
           AND uid = $4
         RETURNING id, shipping_status, processed_at;
      `;
      const { rows } = await client.query(updSaleQ, [shippingStatus, saleId, sku, uid]);

      await client.query('COMMIT');
      return res.json({ message: 'Status atualizado e estoque abatido.', sale: rows[0] });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
      return res.status(400).json({ error: err.message || 'Erro interno ao processar despacho.' });
    } finally {
      client.release();
    }
  }

  try {
    const query = `
      UPDATE public.sales
         SET shipping_status = $1,
             updated_at      = NOW()
       WHERE id = $2
         AND sku = $3
         AND uid = $4
       RETURNING id, shipping_status, processed_at;
    `;
    const { rows, rowCount } = await db.query(query, [shippingStatus, saleId, sku, uid]);
    if (rowCount === 0) return res.status(404).json({ error: 'Venda não encontrada ou sem permissão.' });
    return res.json({ message: 'Status atualizado.', sale: rows[0] });
  } catch (err) {
    return res.status(500).json({ error: 'Erro interno.' });
  }
});

router.post('/process', authenticateToken, requireMaster, async (req, res) => {
  const { salesToProcess } = req.body;

  if (!Array.isArray(salesToProcess) || salesToProcess.length === 0) {
    return res.status(400).json({ error: 'Nenhuma venda para processar.' });
  }

  const sanitized = salesToProcess.map((sale) => ({
    id: sale.id,
    sku: String(sale.sku || '').trim(),
    uid: sale.uid,
  }));

  if (sanitized.length > MAX_PROCESS_BATCH) {
    return res.status(413).json({
      error: `Lote muito grande. Envie até ${MAX_PROCESS_BATCH} itens por requisição.`
    });
  }

  const results = { success: [], failed: [] };

  /** Processa UMA venda, na própria conexão e na própria transação. */
  const runOne = async (requestedSale) => {
    if (!requestedSale.id || !requestedSale.sku || !requestedSale.uid) {
      throw new Error('Dados da venda incompletos (id, sku, uid).');
    }

    const client = await db.pool.connect();
    try {
      try {
        await client.query('BEGIN');

        // A venda é bloqueada antes do estoque. Chamadas simultâneas ficam em
        // fila e a segunda encontra processed_at preenchido, sem nova baixa.
        // A quantidade usada é sempre a persistida no banco, nunca o payload.
        const saleResult = await client.query(
          `SELECT id, sku, uid, quantity, processed_at
             FROM public.sales
            WHERE id = $1
              AND UPPER(TRIM(sku)) = UPPER(TRIM($2))
              AND uid = $3
            FOR UPDATE`,
          [requestedSale.id, requestedSale.sku, requestedSale.uid]
        );
        if (saleResult.rowCount === 0) throw new Error('Venda não encontrada.');

        const sale = saleResult.rows[0];
        if (sale.processed_at) {
          await client.query('COMMIT');
          return { saleId: sale.id, sku: sale.sku, alreadyProcessed: true };
        }

        sale.quantity = Number(sale.quantity);
        if (!Number.isInteger(sale.quantity) || sale.quantity <= 0) {
          throw new Error('Quantidade inválida na venda salva.');
        }

        const skuResult = await client.query(
          `SELECT id, sku, quantidade, is_kit, package_type_id
             FROM public.skus
            WHERE UPPER(TRIM(sku)) = UPPER(TRIM($1))
              AND user_id = $2
              AND ativo = true
            ORDER BY id
            LIMIT 2
            FOR UPDATE`,
          [sale.sku, sale.uid]
        );
        if (skuResult.rowCount === 0) throw new Error(`SKU '${sale.sku}' não encontrado ou inativo.`);
        if (skuResult.rowCount > 1) throw new Error(`SKU '${sale.sku}' está duplicado no armazenamento.`);

        const stock = skuResult.rows[0];
        if (stock.is_kit) {
          const kitComponents = await client.query(
            `SELECT child_sku_id, quantity_per_kit
               FROM public.sku_kit_components
              WHERE kit_sku_id = $1
              ORDER BY child_sku_id`,
            [stock.id]
          );
          if (kitComponents.rowCount === 0) {
            throw new Error(`Kit '${sale.sku}' não possui componentes configurados.`);
          }

          for (const component of kitComponents.rows) {
            const childSku = await client.query(
              'SELECT id, sku, quantidade, ativo FROM public.skus WHERE id = $1 FOR UPDATE',
              [component.child_sku_id]
            );
            if (childSku.rowCount === 0 || !childSku.rows[0].ativo) {
              throw new Error(`SKU filho não encontrado ou inativo para o kit '${sale.sku}'.`);
            }
            const required = Number(component.quantity_per_kit) * sale.quantity;
            if (Number(childSku.rows[0].quantidade) < required) {
              throw new Error(`Estoque insuficiente do SKU filho ${childSku.rows[0].sku} para o kit '${sale.sku}'. Disponível: ${childSku.rows[0].quantidade}, necessário: ${required}.`);
            }
          }

          for (const component of kitComponents.rows) {
            const required = Number(component.quantity_per_kit) * sale.quantity;
            await client.query(
              'UPDATE public.skus SET quantidade = quantidade - $1, updated_at = NOW() WHERE id = $2',
              [required, component.child_sku_id]
            );
            await client.query(
              `INSERT INTO public.stock_movements
                 (sku_id, user_id, movement_type, quantity_change, reason, related_sale_id)
               VALUES ($1, $2, 'saida', $3, $4, $5)`,
              [component.child_sku_id, sale.uid, required, `Saída por Kit: Venda Mercado Livre - ID ${sale.id}`, sale.id]
            );
          }

          // Movimento faturável do kit efetivamente vendido. Os movimentos
          // dos filhos representam somente a baixa do estoque compartilhado.
          await client.query(
            `INSERT INTO public.stock_movements
               (sku_id, user_id, movement_type, quantity_change, reason, related_sale_id, package_type_id, package_type_context)
             VALUES ($1, $2, 'saida', $3, $4, $5, $6, $7)`,
            [
              stock.id,
              sale.uid,
              sale.quantity,
              `Saída por Venda Mercado Livre - ID ${sale.id}`,
              sale.id,
              stock.package_type_id,
              `Kit vendido: ${stock.sku}`
            ]
          );
        } else {
          if (Number(stock.quantidade) < sale.quantity) {
            throw new Error(`Estoque insuficiente para SKU '${sale.sku}'. Disponível: ${stock.quantidade}, necessário: ${sale.quantity}.`);
          }

          await client.query(
            'UPDATE public.skus SET quantidade = quantidade - $1, updated_at = NOW() WHERE id = $2',
            [sale.quantity, stock.id]
          );
          await client.query(
            `INSERT INTO public.stock_movements
               (sku_id, user_id, movement_type, quantity_change, reason, related_sale_id, package_type_id, package_type_context)
             VALUES ($1, $2, 'saida', $3, $4, $5, $6, $7)`,
            [
              stock.id,
              sale.uid,
              sale.quantity,
              `Saída por Venda Mercado Livre - ID ${sale.id}`,
              sale.id,
              stock.package_type_id,
              'SKU vendido diretamente'
            ]
          );
        }

        const updatedSale = await client.query(
          `UPDATE public.sales
              SET processed_at = NOW(), updated_at = NOW()
            WHERE id = $1 AND sku = $2 AND uid = $3 AND processed_at IS NULL
            RETURNING id, processed_at`,
          [sale.id, sale.sku, sale.uid]
        );
        if (updatedSale.rowCount === 0) throw new Error('Venda já processada por outra operação.');

        await client.query('COMMIT');
        return { saleId: sale.id, sku: sale.sku, quantity: sale.quantity };
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
        throw error;
      }
    } finally {
      client.release();
    }
  };

  try {
    const outcomes = await mapWithConcurrency(sanitized, PROCESS_CONCURRENCY, async (sale) => {
      try {
        return { ok: true, value: await runOne(sale) };
      } catch (error) {
        return { ok: false, sale, error };
      }
    });

    // Duas vendas do mesmo lote podem disputar o mesmo SKU (ou o mesmo filho de
    // kit) e o Postgres aborta uma das transações. Isso não é erro do operador,
    // é só ordem de execução: esses casos voltam em série, onde não há disputa.
    const contended = [];
    for (const outcome of outcomes) {
      if (outcome?.ok) {
        results.success.push(outcome.value);
        continue;
      }
      if (outcome && LOCK_CONFLICT_CODES.has(outcome.error?.code)) {
        contended.push(outcome.sale);
        continue;
      }
      results.failed.push({
        saleId: outcome?.sale?.id ?? null,
        sku: outcome?.sale?.sku ?? null,
        reason: outcome?.error?.message || 'Falha inesperada ao processar a venda.',
      });
    }

    for (const sale of contended) {
      try {
        results.success.push(await runOne(sale));
      } catch (error) {
        results.failed.push({ saleId: sale.id, sku: sale.sku, reason: error.message });
      }
    }

    return res.json({ message: 'Processamento concluído.', ...results });
  } catch (error) {
    console.error('Erro crítico no processamento em lote:', error);
    return res.status(500).json({ error: 'Erro crítico no processamento em lote.' });
  }
});

router.post('/sync-account', authenticateToken, async (req, res) => {
  const { userId, accountNickname: nickname, clientId, force, backfill, clientUid, daysToSync } = req.body;
  let targetUid = clientUid || req.user.uid;

  if (!userId || !clientId) return res.status(400).json({ error: 'ID usuário e clientId obrigatórios.' });

  /* Clique repetido não vale uma varredura nova.
   *
   * Mesmo com o skip funcionando (o log mostra `pulados` alto), cada clique
   * ainda pergunta ao Mercado Livre "mudou algo?" para CADA conta. Com 32
   * contas isso é uma rodada inteira de chamadas e de orçamento de rate limit
   * para descobrir o que já sabíamos: em poucos segundos nada mudou.
   *
   * `ml_sync_cursors.updated_at` avança em toda execução bem-sucedida — mesmo
   * nas que não acharam nada — então serve como carimbo do último "está em dia".
   * Chave por seller_id: o id do vendedor é único por conta ML e evita depender
   * de resolver o dono antes de decidir.
   *
   * force, backfill e daysToSync passam direto: são os caminhos de quem quer,
   * explicitamente, varrer de novo agora ou olhar mais para trás.
   */
  if (!force && !backfill && !daysToSync) {
    const cooldownSeconds = configInt('ML_SYNC_COOLDOWN_SECONDS', 60, 0, 3600);
    if (cooldownSeconds > 0) {
      try {
        const recent = await db.query(
          `SELECT EXTRACT(EPOCH FROM (NOW() - updated_at))::int AS age_seconds
             FROM public.ml_sync_cursors
            WHERE seller_id = $1
              AND updated_at > NOW() - ($2::int * interval '1 second')
            ORDER BY updated_at DESC
            LIMIT 1`,
          [userId, cooldownSeconds]
        );

        if (recent.rowCount > 0) {
          const age = recent.rows[0].age_seconds ?? 0;
          console.log(`[SYNC] ${nickname}: carência ativa, concluída há ${age}s; nenhuma chamada ao ML.`);
          res.status(200).json({ message: 'Conta já estava atualizada.', fromCooldown: true });
          sendEvent(clientId, {
            progress: 100,
            message: `[${nickname}] Já estava atualizada (sincronizada há ${age}s).`,
            type: 'success',
            newSalesCount: 0,
            updatedCount: 0,
            skippedCount: 0,
            workCompleted: 1,
            workTotal: 1,
            fromCooldown: true,
          });
          return;
        }
      } catch (cooldownError) {
        // Carência é otimização. Se a consulta falhar, sincroniza normalmente.
        console.warn(`[SYNC] ${nickname}: carência não verificada (${cooldownError.message}).`);
      }
    }
  }

  res.status(202).json({ message: 'Sincronização iniciada. Acompanhe status.' });

  try {
    sendEvent(clientId, { progress: 10, message: `[${nickname}] Buscando credenciais...`, type: 'info' });
    
    // Resolver credenciais da conta ML (permitir MASTER sincronizar sem estar logado no dono)
    let access_token, refresh_token;
    if (req.user.role === 'master') {
      if (clientUid) {
        const accRes = await db.query(
          'SELECT access_token, refresh_token FROM public.ml_accounts WHERE user_id = $1 AND uid = $2',
          [userId, clientUid]
        );
        if (accRes.rowCount === 0) {
          // Fallback: localizar pela conta ML (seller_id) e deduzir o UID do dono
          const fallback = await db.query(
            'SELECT access_token, refresh_token, uid FROM public.ml_accounts WHERE user_id = $1 LIMIT 1',
            [userId]
          );
          if (fallback.rowCount === 0) throw new Error('Conta ML não encontrada.');
          ({ access_token, refresh_token } = fallback.rows[0]);
          targetUid = fallback.rows[0].uid;
        } else {
          ({ access_token, refresh_token } = accRes.rows[0]);
          targetUid = clientUid;
        }
      } else {
        // MASTER sem clientUid: localizar pela conta ML (seller_id) e deduzir o UID do dono
        const accRes = await db.query(
          'SELECT access_token, refresh_token, uid FROM public.ml_accounts WHERE user_id = $1 LIMIT 1',
          [userId]
        );
        if (accRes.rowCount === 0) throw new Error('Conta ML não encontrada.');
        ({ access_token, refresh_token } = accRes.rows[0]);
        targetUid = accRes.rows[0].uid;
      }
    } else {
      const accRes = await db.query(
        'SELECT access_token, refresh_token FROM public.ml_accounts WHERE user_id = $1 AND uid = $2',
        [userId, targetUid]
      );
      if (accRes.rowCount === 0) throw new Error('Conta ML não encontrada ou não pertence ao usuário.');
      ({ access_token, refresh_token } = accRes.rows[0]);
    }

    if (backfill) {
      await runBackfillMissing({ 
        db, 
        clientId, 
        nickname, 
        targetUid, 
        userId, 
        access_token, 
        isMaster: req.user.role === 'master' 
      });
    }

    let lastSyncDate;
    const maxLookbackDate = new Date();
    maxLookbackDate.setDate(maxLookbackDate.getDate() - 180);

    // Cursor incremental por conta: o MAIOR date_last_updated já salvo (coluna
    // dedicada, confiável e indexada).
    const cursorRes = await db.query(
      `SELECT COALESCE(
                (SELECT last_remote_updated_at
                   FROM public.ml_sync_cursors
                  WHERE uid = $1 AND seller_id = $2),
                (SELECT MAX(date_last_updated)
                   FROM public.sales
                  WHERE uid = $1 AND seller_id = $2)
              ) AS cursor`,
      [targetUid, userId]
    );
    const syncCursor = cursorRes.rows[0]?.cursor ? new Date(cursorRes.rows[0].cursor) : null;

    // Janela de busca (por date_last_updated):
    // - dropdown (daysToSync) tem precedência: o usuário escolhe até onde olhar;
    // - senão, forçada = 180 dias;
    // - senão, incremental pelo cursor (só o que mudou desde a última vez).
    // Em todos os casos o "skip antes de baixar" garante velocidade.
    if (!syncCursor && daysToSync) {
      lastSyncDate = new Date();
      lastSyncDate.setDate(lastSyncDate.getDate() - parseInt(daysToSync, 10));
      if (lastSyncDate < maxLookbackDate) lastSyncDate = maxLookbackDate;
      sendEvent(clientId, { progress: 15, message: `[${nickname}] Verificando alterações dos últimos ${daysToSync} dias...`, type: 'info' });
    } else if (!syncCursor && force) {
      lastSyncDate = maxLookbackDate;
      sendEvent(clientId, { progress: 15, message: `[${nickname}] Sincronização completa iniciada...`, type: 'info' });
    } else if (syncCursor) {
      lastSyncDate = new Date(syncCursor.getTime() - 2 * 60 * 1000);
      if (lastSyncDate < maxLookbackDate) lastSyncDate = maxLookbackDate;
      sendEvent(clientId, { progress: 15, message: `[${nickname}] Buscando novidades desde a última sincronização...`, type: 'info' });
    } else {
      lastSyncDate = maxLookbackDate;
      sendEvent(clientId, { progress: 15, message: `[${nickname}] Sincronização completa iniciada...`, type: 'info' });
    }
    console.log(`[SYNC] ${nickname} uid=${targetUid} seller=${userId} cursor=${syncCursor ? syncCursor.toISOString() : 'none'} from=${lastSyncDate.toISOString()} force=${!!force} days=${daysToSync || '-'}`);

    sendEvent(clientId, { progress: 20, message: `[${nickname}] Buscando resumo de vendas desde ${lastSyncDate.toLocaleDateString('pt-BR')}...`, type: 'info' });

    let orderSummaries = [];
    let offset = 0;
    let searchFullyConsumed = false;

    while (orderSummaries.length < MAX_ORDERS) {
      const limit = Math.min(PAGE_LIMIT, MAX_ORDERS - orderSummaries.length);
      const ordersUrl =
        `https://api.mercadolibre.com/orders/search` +
        `?seller=${userId}&offset=${offset}&limit=${limit}&sort=date_desc` +
        `&order.date_last_updated.from=${encodeURIComponent(lastSyncDate.toISOString())}`;

      let ordersResponse = await mlFetch(ordersUrl, { headers: mlHeaders(access_token) });

      if (ordersResponse.status === 401) {
        sendEvent(clientId, { progress: 25, message: `[${nickname}] Token expirado. Tentando renovar...`, type: 'info' });
        const CLIENT_ID = process.env.ML_CLIENT_ID;
        const CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
        const refreshResponse = await fetch('https://api.mercadolibre.com/oauth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            refresh_token: refresh_token
          })
        });
        if (!refreshResponse.ok) {
          // Marca apenas a conta específica (user_id) como necessitando reconexão
          await db.query("UPDATE public.ml_accounts SET status = 'reconnect_needed' WHERE user_id = $1 AND uid = $2", [userId, targetUid]);
          throw new Error('Falha ao renovar token. É necessário reconectar a conta.');
        }
        const newTokenData = await refreshResponse.json();
        access_token = newTokenData.access_token;
        refresh_token = newTokenData.refresh_token;
        if (req.user.role === 'master') {
          await db.query(
            'UPDATE public.ml_accounts SET access_token = $1, refresh_token = $2, expires_in = $3, status = \'active\', updated_at = NOW() WHERE user_id = $4 AND uid = $5',
            [access_token, refresh_token, newTokenData.expires_in, userId, targetUid]
          );
        } else {
          await db.query(
            'UPDATE public.ml_accounts SET access_token = $1, refresh_token = $2, expires_in = $3, status = \'active\', updated_at = NOW() WHERE user_id = $4 AND uid = $5',
            [access_token, refresh_token, newTokenData.expires_in, userId, targetUid]
          );
        }
        sendEvent(clientId, { progress: 30, message: `[${nickname}] Token atualizado. Retomando busca...`, type: 'info' });
        ordersResponse = await mlFetch(ordersUrl, { headers: mlHeaders(access_token) });
      }

      if (!ordersResponse.ok) {
        const errorBody = await safeJson(ordersResponse);
        const errorMessage = errorBody?.message || ordersResponse.statusText;
        
        // Tratamento específico para erro de permissão
        if (errorMessage.includes('caller.id does not match buyer or seller')) {
          console.error(`[${nickname}] Erro de permissão na API: ${errorMessage}`);
          sendEvent(clientId, {
            progress: 0,
            message: `[${nickname}] Erro de permissão: Token e conta não correspondem (caller.id mismatch). Verifique se está sincronizando a conta correta. Não é necessário reconectar.`,
            type: 'error'
          });
          
          // Marcar conta como necessitando reconexão
          // Não marque a conta para reconexão para este erro específico,
          // pois normalmente é causado por parâmetro 'seller' incorreto (account mismatch).
          throw new Error(`Erro de permissão na API do Mercado Livre: ${errorMessage}. Verifique se a conta selecionada corresponde ao token conectado (seller_id incorreto). O status da conta não foi alterado.`);
        }
        
        throw new Error(`Erro na API do Mercado Livre: ${errorMessage}`);
      }

      const pageData = await ordersResponse.json();
      const items = pageData.results || [];
      const remoteTotal = Number(pageData?.paging?.total) || 0;
      if (items.length === 0) {
        searchFullyConsumed = true;
        break;
      }

      // A API já filtra por date_last_updated.from; aproveitamos todos os
      // resultados (sem refiltrar por date_created, que descartava updates de
      // pedidos antigos — bug #12 da auditoria).
      orderSummaries.push(...items);
      sendEvent(clientId, {
        progress: 20 + Math.min(14, Math.floor((orderSummaries.length / Math.max(1, Math.min(remoteTotal, MAX_ORDERS))) * 14)),
        message: `[${nickname}] Lendo alteracoes... ${orderSummaries.length}/${remoteTotal || orderSummaries.length}`,
        type: 'info',
        workCompleted: orderSummaries.length,
        workTotal: Math.max(orderSummaries.length, Math.min(remoteTotal || orderSummaries.length, MAX_ORDERS))
      });

      if (items.length < limit) {
        searchFullyConsumed = true;
        break;
      }
      offset += limit;
    }

    // Keep an API cursor independent from the rows that need an upsert. The ML
    // may advance date_last_updated for an internal event while the relevant
    // order signature stays unchanged. Those orders are skipped, but the API
    // cursor must still move forward or the same range is fetched forever.
    const observedCursor = orderSummaries.reduce((max, order) => {
      const value = order?.date_last_updated ? new Date(order.date_last_updated) : null;
      return value && !Number.isNaN(value.getTime()) && (!max || value > max) ? value : max;
    }, null);
    const persistObservedCursor = async () => {
      // Never move past unseen results when the safety cap was reached.
      if (!observedCursor || !searchFullyConsumed) return;
      await db.query(
        `INSERT INTO public.ml_sync_cursors (uid, seller_id, last_remote_updated_at, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (uid, seller_id) DO UPDATE
             SET last_remote_updated_at = GREATEST(
                   public.ml_sync_cursors.last_remote_updated_at,
                   EXCLUDED.last_remote_updated_at
                 ),
                 updated_at = NOW()`,
        [targetUid, userId, observedCursor]
      );
    };

    if (orderSummaries.length === 0) {
      /* Marca o ponto até onde já procuramos, mesmo sem ter achado nada.
       *
       * Sem isto, uma conta sem vendas na janela ficava presa em modo completo
       * PARA SEMPRE: não havia linha em `sales`, então /last-sync devolvia null,
       * o frontend mandava force=true e a sincronização varria 180 dias de novo
       * em TODO clique. Com 32 contas, algumas nessa situação, era a maior
       * parcela do tempo do botão Sincronizar.
       *
       * A marca é o instante da varredura: a próxima execução parte daqui e
       * passa a ser incremental.
       */
      if (searchFullyConsumed) {
        await db.query(
          `INSERT INTO public.ml_sync_cursors (uid, seller_id, last_remote_updated_at, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (uid, seller_id) DO UPDATE
               SET last_remote_updated_at = GREATEST(
                     public.ml_sync_cursors.last_remote_updated_at,
                     EXCLUDED.last_remote_updated_at
                   ),
                   updated_at = NOW()`,
          [targetUid, userId, new Date()]
        );
      }
      sendEvent(clientId, { progress: 100, message: `[${nickname}] Nenhuma venda nova encontrada. Tudo atualizado!`, type: 'success', newSalesCount: 0, updatedCount: 0, skippedCount: 0, workCompleted: 1, workTotal: 1 });
      return;
    }

    // ====== SKIP DE PEDIDOS INALTERADOS (o maior ganho) ======
    // Consulta o estado já salvo destes pedidos e pula os que não mudaram
    // (date_last_updated igual) e já estão enriquecidos. Assim, clicar de novo
    // não refaz detalhe/shipment/SLA do que não mudou — cai de milhares de
    // chamadas para praticamente zero.
    sendEvent(clientId, { progress: 35, message: `[${nickname}] Verificando o que mudou desde a última sincronização...`, type: 'info' });

    const orderIdList = [...new Set(orderSummaries.map(o => o.id).filter(Boolean).map(id => parseInt(id, 10)).filter(n => !isNaN(n)))];
    const savedState = new Map(); // id(string) -> { sig, needsFix }
    if (orderIdList.length > 0) {
      const stateRes = await db.query(
        `SELECT id,
                MAX(remote_state) AS remote_state,
                bool_or(
                  shipping_mode IS NULL
                  OR shipping_mode = 'Outros'
                  OR remote_state IS NULL
                ) AS needs_fix
           FROM public.sales
          WHERE uid = $1 AND id = ANY($2::bigint[])
          GROUP BY id`,
        [targetUid, orderIdList]
      );
      for (const r of stateRes.rows) {
        savedState.set(String(r.id), {
          remoteState: r.remote_state,
          needsFix: r.needs_fix === true,
        });
      }
    }

    const toProcess = [];
    let skippedCount = 0;
    for (const summary of orderSummaries) {
      const st = savedState.get(String(summary.id));
      const remoteState = computeRemoteState(summary);
      // Pula ANTES de baixar quando o pedido não mudou no ML desde a última
      // gravação. Isso evita detalhe + shipment + SLA (3 chamadas por pedido).
      // Se o pedido não mudou no ML, rebaixá-lo não traria dado novo.
      // EXCEÇÃO: modalidade "Outros"/nula é reprocessada para se corrigir.
      if (st && st.remoteState != null && st.remoteState === remoteState && !st.needsFix) {
        skippedCount++;
        continue;
      }
      toProcess.push(summary);
    }
    console.log(`[SYNC] ${nickname} encontrados=${orderSummaries.length} paraProcessar=${toProcess.length} pulados=${skippedCount} (estadoSalvo=${savedState.size})`);

    const accountWorkTotal = orderSummaries.length + (toProcess.length * 3);
    sendEvent(clientId, {
      progress: 45,
      message: `[${nickname}] ${toProcess.length} alterado(s), ${skippedCount} sem mudanca.`,
      type: 'info',
      workCompleted: orderSummaries.length,
      workTotal: Math.max(1, accountWorkTotal)
    });

    if (toProcess.length === 0) {
      await persistObservedCursor();
      sendEvent(clientId, {
        progress: 100,
        message: `[${nickname}] Tudo atualizado. ${skippedCount} pedido(s) sem mudança.`,
        type: 'success',
        newSalesCount: 0,
        updatedCount: 0,
        skippedCount,
        workCompleted: Math.max(1, accountWorkTotal),
        workTotal: Math.max(1, accountWorkTotal)
      });
      return;
    }

    // Passagem ÚNICA: detalhe do pedido + shipment + SLA (em paralelo) por pedido.
    // Só roda para os pedidos que realmente mudaram (toProcess).
    sendEvent(clientId, { progress: 45, message: `[${nickname}] Processando ${toProcess.length} pedido(s) alterado(s) (${skippedCount} sem mudança)...`, type: 'info' });
    let processedCount = 0;
    const enrichedOrders = await mapWithConcurrency(toProcess, SLA_CONCURRENCY, async (summary) => {
      let order = summary;
      // Estado medido no RESUMO da busca, que é a mesma fonte usada na
      // comparação da próxima execução. Guardar o valor do detalhe faria as
      // duas pontas divergirem de novo.
      const remoteStateFromSearch = computeRemoteState(summary);
      let fullyEnriched = true;

      try {
        const orderDetailsRes = await mlFetch(`https://api.mercadolibre.com/orders/${summary.id}`, { headers: mlHeaders(access_token) });
        if (orderDetailsRes.ok) {
          order = await orderDetailsRes.json();
        } else {
          fullyEnriched = false;
        }
      } catch (e) {
        fullyEnriched = false;
        console.error(`Falha ao buscar detalhes do pedido ${summary.id}:`, e);
      }

      const shipmentId = order?.shipping?.id;
      if (shipmentId) {
        try {
          const [shipRes, slaRes] = await Promise.all([
            mlFetch(`https://api.mercadolibre.com/shipments/${shipmentId}`, { headers: shipmentHeaders(access_token) }),
            mlFetch(`https://api.mercadolibre.com/shipments/${shipmentId}/sla`, { headers: shipmentHeaders(access_token) }),
          ]);
          if (shipRes.ok) {
            const shipmentDetails = await safeJson(shipRes);
            if (shipmentDetails) order.shipping = { ...order.shipping, ...shipmentDetails };
            else fullyEnriched = false;
          } else {
            fullyEnriched = false;
          }
          if (slaRes.ok) {
            const slaData = await safeJson(slaRes);
            if (slaData) order.sla_data = slaData;
          } else if (slaRes.status !== 404) {
            // 404 é resposta legítima (envio sem SLA). Outros erros são falha.
            fullyEnriched = false;
          }
        } catch (e) {
          fullyEnriched = false;
          console.error(`Falha ao enriquecer envio ${shipmentId}:`, e);
        }
      }

      /* Só marca o pedido como "já visto neste estado" se o enriquecimento
       * completou. Marcar após falha parcial gravaria dado incompleto e o
       * pedido nunca seria retentado. enumerable:false mantém o marcador fora
       * de raw_api_data. */
      if (fullyEnriched) {
        Object.defineProperty(order, '__remoteState', {
          value: remoteStateFromSearch,
          enumerable: false,
          configurable: true,
        });
      }

      processedCount++;
      if (processedCount % 25 === 0) {
        const pct = 45 + Math.floor((processedCount / toProcess.length) * 40);
        sendEvent(clientId, {
          progress: Math.min(85, pct),
          message: `[${nickname}] Enriquecendo... ${processedCount}/${toProcess.length}`,
          type: 'info',
          workCompleted: orderSummaries.length + (processedCount * 3),
          workTotal: Math.max(1, accountWorkTotal)
        });
      }
      return order;
    });

    const allRows = buildInsertBatchRows(enrichedOrders.filter(Boolean), targetUid, nickname);
    sendEvent(clientId, { progress: 85, message: `[${nickname}] Preparando ${allRows.length} itens para salvar...`, type: 'info' });

    const clientDb = await db.pool.connect();
    try {
      await clientDb.query('BEGIN');
      let insertedCount = 0;
      let updatedCount = 0;
      for (let i = 0; i < allRows.length; i += UPSERT_BATCH_SIZE) {
        const chunk = allRows.slice(i, i + UPSERT_BATCH_SIZE);

        const { query, params } = buildMultiInsertQuery_DoUpdate(chunk);
        const result = await clientDb.query(query, params);
        for (const row of result.rows) {
          if (row.inserted) insertedCount++;
          else updatedCount++;
        }

        const pct = 85 + Math.floor(((i + chunk.length) / allRows.length) * 15);
        if (i === 0 || i + UPSERT_BATCH_SIZE >= allRows.length || i % (UPSERT_BATCH_SIZE * 3) === 0) {
          sendEvent(clientId, { progress: Math.min(99, pct), message: `[${nickname}] Salvando lote... ${i + chunk.length}/${allRows.length}`, type: 'info' });
        }
      }
      await clientDb.query('COMMIT');
      await persistObservedCursor();
      // Pedidos que foram baixados mas cujos dados eram idênticos (não mudaram
      // no banco) contam como "sem alteração", junto com os pulados antes de baixar.
      const noopCount = Math.max(0, allRows.length - insertedCount - updatedCount);
      const unchangedTotal = skippedCount + noopCount;
      const doneMsg = insertedCount > 0
        ? `[${nickname}] Concluída. ${insertedCount} venda(s) nova(s), ${updatedCount} atualizada(s), ${unchangedTotal} sem mudança.`
        : `[${nickname}] Concluída. Nenhuma venda nova (${updatedCount} atualizada(s), ${unchangedTotal} sem mudança).`;
      sendEvent(clientId, {
        progress: 100,
        message: doneMsg,
        type: 'success',
        newSalesCount: insertedCount,
        updatedCount: updatedCount,
        skippedCount: unchangedTotal,
        processedCount: allRows.length,
        workCompleted: Math.max(1, accountWorkTotal),
        workTotal: Math.max(1, accountWorkTotal)
      });
    } catch (e) {
      await clientDb.query('ROLLBACK');
      throw e;
    } finally {
      clientDb.release();
    }
  } catch (error) {
    console.error(`[SYNC ERROR] Cliente ${clientId} | Conta ${nickname}:`, error);
    sendEvent(clientId, { progress: 100, message: `Erro em [${nickname}]: ${error.message}`, type: 'error' });
  } finally {
    if (clients[clientId]) {
      clients[clientId].res.end();
      delete clients[clientId];
    }
  }
});

// Endpoint para enriquecer vendas existentes com dados de etiquetas
router.post('/enrich-existing-sales', authenticateToken, async (req, res) => {
  const { userId, accountNickname: nickname, clientId, clientUid } = req.body;
  const { uid, role } = req.user;
  
  let targetUid = clientUid || uid;
  
  res.status(202).json({ message: 'Enriquecimento iniciado.' });
  
  try {
    console.log(`[ENRICH] Iniciando enriquecimento para userId: ${userId}, nickname: ${nickname}, clientUid: ${clientUid}, role: ${role}`);
    
    // Busca o token de acesso da conta (mesma lógica do endpoint de sincronização)
    let access_token, refresh_token;
    
    if (role === 'master') {
      if (clientUid) {
        const accRes = await db.query(
          'SELECT access_token, refresh_token FROM public.ml_accounts WHERE user_id = $1 AND uid = $2',
          [userId, clientUid]
        );
        if (accRes.rows.length > 0) {
          ({ access_token, refresh_token } = accRes.rows[0]);
        } else {
          // Fallback: localizar pela conta ML (seller_id) e deduzir o UID do dono
          const fallback = await db.query(
            'SELECT access_token, refresh_token, uid FROM public.ml_accounts WHERE user_id = $1 LIMIT 1',
            [userId]
          );
          if (fallback.rows.length > 0) {
            ({ access_token, refresh_token } = fallback.rows[0]);
            targetUid = fallback.rows[0].uid;
          }
        }
      } else {
        // MASTER sem clientUid: localizar pela conta ML (seller_id) e deduzir o UID do dono
        const accRes = await db.query(
          'SELECT access_token, refresh_token, uid FROM public.ml_accounts WHERE user_id = $1 LIMIT 1',
          [userId]
        );
        if (accRes.rows.length > 0) {
          ({ access_token, refresh_token } = accRes.rows[0]);
          targetUid = accRes.rows[0].uid;
        }
      }
    } else {
      const accRes = await db.query(
        'SELECT access_token, refresh_token FROM public.ml_accounts WHERE user_id = $1 AND uid = $2',
        [userId, targetUid]
      );
      if (accRes.rows.length > 0) {
        ({ access_token, refresh_token } = accRes.rows[0]);
      }
    }
    
    if (!access_token) {
      console.log(`[ENRICH] Conta não encontrada para userId: ${userId}, targetUid: ${targetUid}, role: ${role}`);
      sendEvent(clientId, { progress: 100, message: 'Conta não encontrada ou sem permissão.', type: 'error' });
      if (clients[clientId]) {
        clients[clientId].res.end();
        delete clients[clientId];
      }
      return;
    }
    
    console.log(`[ENRICH] Token encontrado para userId: ${userId}, targetUid: ${targetUid}`);
    
    // Busca vendas existentes que precisam ser enriquecidas
    let salesQuery, salesParams;
    if (role === 'master') {
      salesQuery = `
        SELECT id, raw_api_data 
        FROM public.sales 
        WHERE uid = $1 AND seller_id = $2 
        AND (raw_api_data->'shipping'->>'id' IS NOT NULL)
        AND (raw_api_data->'shipping'->>'id' != '')
        ORDER BY sale_date DESC
        LIMIT 100
      `;
      salesParams = [targetUid, userId];
    } else {
      salesQuery = `
        SELECT id, raw_api_data 
        FROM public.sales 
        WHERE uid = $1 AND seller_id = $2 
        AND (raw_api_data->'shipping'->>'id' IS NOT NULL)
        AND (raw_api_data->'shipping'->>'id' != '')
        ORDER BY sale_date DESC
        LIMIT 100
      `;
      salesParams = [targetUid, userId];
    }
    
    const salesResult = await db.query(salesQuery, salesParams);
    const salesToEnrich = salesResult.rows;
    
    if (salesToEnrich.length === 0) {
      sendEvent(clientId, { progress: 100, message: 'Nenhuma venda encontrada para enriquecer.', type: 'success' });
      if (clients[clientId]) {
        clients[clientId].res.end();
        delete clients[clientId];
      }
      return;
    }
    
    sendEvent(clientId, { 
      progress: 10, 
      message: `[${nickname}] Enriquecendo ${salesToEnrich.length} vendas com dados de etiquetas...`, 
      type: 'info' 
    });
    
    let enrichedCount = 0;
    const SLA_CONCURRENCY = 15;
    
    // Função para enriquecer uma venda com dados de etiqueta
    const enrichSale = async (sale, index) => {
      try {
        const rawData = sale.raw_api_data;
        const shipmentId = rawData?.shipping?.id;
        
        if (!shipmentId) return sale;
        
        // Busca dados do shipment
        const shipmentRes = await fetch(`https://api.mercadolibre.com/shipments/${shipmentId}`, { 
          headers: { Authorization: `Bearer ${access_token}` } 
        });
        
        if (shipmentRes.ok) {
          const shipmentDetails = await safeJson(shipmentRes);
          if (shipmentDetails) {
            rawData.shipping = { ...rawData.shipping, ...shipmentDetails };
          }
        }
        
        // Busca dados de SLA
        const slaRes = await fetch(`https://api.mercadolibre.com/shipments/${shipmentId}/sla`, { 
          headers: { Authorization: `Bearer ${access_token}` } 
        });
        
        if (slaRes.ok) {
          const slaData = await safeJson(slaRes);
          if (slaData) {
            rawData.sla_data = slaData;
          }
        }
        
        // Atualiza a venda no banco
        await db.query(
          'UPDATE public.sales SET raw_api_data = $1, updated_at = NOW() WHERE id = $2',
          [JSON.stringify(rawData), sale.id]
        );
        
        enrichedCount++;
        
        if (index > 0 && index % 10 === 0) {
          const pct = 10 + Math.floor(((index + 1) / salesToEnrich.length) * 80);
          sendEvent(clientId, { 
            progress: Math.min(90, pct), 
            message: `[${nickname}] Enriquecendo... ${index + 1}/${salesToEnrich.length}`, 
            type: 'info' 
          });
        }
        
        return sale;
      } catch (e) {
        console.error(`Falha ao enriquecer venda ${sale.id}:`, e);
        return sale;
      }
    };
    
    // Processa as vendas com concorrência limitada
    const processBatch = async (batch) => {
      const promises = batch.map((sale, index) => enrichSale(sale, index));
      return Promise.all(promises);
    };
    
    // Processa em lotes para controlar concorrência
    for (let i = 0; i < salesToEnrich.length; i += SLA_CONCURRENCY) {
      const batch = salesToEnrich.slice(i, i + SLA_CONCURRENCY);
      await processBatch(batch);
      
      // Pequena pausa entre lotes para não sobrecarregar a API
      if (i + SLA_CONCURRENCY < salesToEnrich.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    sendEvent(clientId, { 
      progress: 100, 
      message: `[${nickname}] Enriquecimento concluído. ${enrichedCount} vendas atualizadas.`, 
      type: 'success',
      enrichedCount: enrichedCount
    });
    
    sendEvent(clientId, { 
      progress: 100, 
      message: 'Enriquecimento concluído com sucesso.', 
      type: 'success',
      enrichedCount: enrichedCount
    });
    
  } catch (error) {
    console.error(`[ENRICH ERROR] Cliente ${clientId} | Conta ${nickname}:`, error);
    sendEvent(clientId, { 
      progress: 100, 
      message: `Erro em [${nickname}]: ${error.message}`, 
      type: 'error' 
    });
  } finally {
    if (clients[clientId]) {
      clients[clientId].res.end();
      delete clients[clientId];
    }
  }
});

// Endpoint para verificar a última sincronização de uma conta
router.get('/last-sync/:mlAccountId', authenticateToken, async (req, res) => {
  try {
    const { mlAccountId } = req.params;
    let targetUid = req.query.clientUid || req.user.uid;

    if (!mlAccountId) {
      return res.status(400).json({ error: 'ID da conta ML é obrigatório.' });
    }

    // Se MASTER e nenhum clientUid informado, descobrir automaticamente o dono da conta ML
    if (req.user.role === 'master' && !req.query.clientUid) {
      const owner = await db.query('SELECT uid FROM public.ml_accounts WHERE user_id = $1 LIMIT 1', [mlAccountId]);
      if (owner.rowCount > 0) {
        targetUid = owner.rows[0].uid;
      }
    }

    /* Considera o CURSOR, não apenas a existência de vendas.
     *
     * O frontend usa esta resposta para decidir `force` (e `backfill`): sem
     * lastSync, ele pede sincronização completa de 180 dias. Olhar só
     * MAX(updated_at) em `sales` fazia com que TODA conta sem vendas salvas
     * — loja nova, conta sem pedidos na janela, conta cujo dono foi remapeado —
     * caísse no modo completo em cada clique, para sempre.
     *
     * O cursor em ml_sync_cursors é a marca de "já varri até aqui", e é gravado
     * mesmo quando a busca não devolve nenhum pedido. Com ele, essas contas
     * passam a ser incrementais a partir da segunda execução.
     */
    const lastSyncRes = await db.query(
      `SELECT GREATEST(
                COALESCE((SELECT MAX(updated_at)
                            FROM public.sales
                           WHERE uid = $1 AND seller_id = $2), 'epoch'::timestamptz),
                COALESCE((SELECT last_remote_updated_at
                            FROM public.ml_sync_cursors
                           WHERE uid = $1 AND seller_id = $2), 'epoch'::timestamptz)
              ) AS last_sale`,
      [targetUid, mlAccountId]
    );

    const raw = lastSyncRes.rows[0]?.last_sale;
    // GREATEST com o fallback 'epoch' nunca devolve null: epoch significa que
    // não há nem venda nem cursor, ou seja, conta realmente nunca sincronizada.
    const lastSync = raw && new Date(raw).getTime() > 0 ? new Date(raw) : null;

    res.json({
      lastSync: lastSync ? lastSync.toISOString() : null,
      accountId: mlAccountId,
      message: lastSync ? 'Última sincronização encontrada' : 'Nunca sincronizada'
    });

  } catch (error) {
    console.error('Erro ao verificar última sincronização:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

/** ======== CORREÇÃO DE MODALIDADES "Outros" (uso manual do master) ======== */
// URL discreta (sem botão). Ex.: GET /api/sales/fix-shipping-modes?limit=1000
// Opcional: &sellerId=123 para uma conta específica.
// Rebusca o shipment (formato clássico, com logistic_type), recalcula a
// modalidade e corrige as vendas que ficaram como "Outros"/nula.
router.get('/fix-shipping-modes', async (req, res) => {
  // Autenticação flexível: aceita JWT no header Authorization OU em ?token=
  // (para poder abrir a URL direto no navegador). Exige role master.
  const jwt = require('jsonwebtoken');
  const JWT_SECRET = process.env.JWT_SECRET || 'seu-segredo-super-secreto-para-jwt';
  const authHeader = req.headers['authorization'];
  const tokenFromHeader = authHeader && authHeader.split(' ')[1];
  const token = tokenFromHeader || req.query.token;
  if (!token) {
    return res.status(401).json({ error: 'Não autorizado. Passe ?token=<seu JWT de master> na URL.' });
  }
  let authUser;
  try {
    authUser = jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return res.status(403).json({ error: 'Token inválido ou expirado.' });
  }
  if (!authUser || authUser.role !== 'master') {
    return res.status(403).json({ error: 'Acesso negado. Apenas master.' });
  }

  const limit = Math.min(parseInt(req.query.limit, 10) || 500, 5000);
  const sellerFilter = (req.query.sellerId || '').trim();

  try {
    // Total de candidatos (para saber quanto ainda falta).
    const totalRes = await db.query(
      `SELECT COUNT(DISTINCT id) AS total
         FROM public.sales
        WHERE (shipping_mode IS NULL OR shipping_mode = 'Outros'
               OR (shipping_mode = 'FULL' AND (raw_api_data->'shipping'->>'logistic_type') IS DISTINCT FROM 'fulfillment'))
          AND raw_api_data->'shipping'->>'id' IS NOT NULL
          ${sellerFilter ? 'AND seller_id = $1' : ''}`,
      sellerFilter ? [sellerFilter] : []
    );
    const totalRemaining = parseInt(totalRes.rows[0].total, 10);

    // Candidatos desta rodada (um por pedido).
    const candRes = await db.query(
      `SELECT DISTINCT ON (id) id, uid, seller_id,
              raw_api_data->'shipping'->>'id' AS shipment_id
         FROM public.sales
        WHERE (shipping_mode IS NULL OR shipping_mode = 'Outros'
               OR (shipping_mode = 'FULL' AND (raw_api_data->'shipping'->>'logistic_type') IS DISTINCT FROM 'fulfillment'))
          AND raw_api_data->'shipping'->>'id' IS NOT NULL
          ${sellerFilter ? 'AND seller_id = $2' : ''}
        ORDER BY id
        LIMIT $1`,
      sellerFilter ? [limit, sellerFilter] : [limit]
    );
    const candidates = candRes.rows;
    if (candidates.length === 0) {
      return res.json({ message: 'Nenhuma venda em "Outros" para corrigir.', totalRemaining, processed: 0, fixed: 0 });
    }

    // Tokens por conta (seller_id).
    const sellerIds = [...new Set(candidates.map(c => c.seller_id).filter(Boolean))];
    const tokRes = await db.query(
      'SELECT user_id AS seller_id, uid, access_token, refresh_token FROM public.ml_accounts WHERE user_id = ANY($1::bigint[])',
      [sellerIds]
    );
    const tokenBySeller = new Map();
    for (const r of tokRes.rows) tokenBySeller.set(String(r.seller_id), { access_token: r.access_token, refresh_token: r.refresh_token, uid: r.uid });

    let fixed = 0, stillOutros = 0, failed = 0;

    await mapWithConcurrency(candidates, SLA_CONCURRENCY, async (c) => {
      const acc = tokenBySeller.get(String(c.seller_id));
      if (!acc) { failed++; return; }
      try {
        let r = await mlFetch(`https://api.mercadolibre.com/shipments/${c.shipment_id}`, { headers: mlHeaders(acc.access_token) });
        if (r.status === 401) {
          acc.access_token = await refreshAccountToken(c.seller_id, acc.uid, acc.refresh_token);
          r = await mlFetch(`https://api.mercadolibre.com/shipments/${c.shipment_id}`, { headers: mlHeaders(acc.access_token) });
        }
        if (!r.ok) { failed++; return; }
        const ship = await safeJson(r);
        const logisticType = ship?.logistic_type || null;
        const mapped = mapShippingTypeMode(logisticType);
        if (mapped === 'Outros') { stillOutros++; return; }

        // Corrige a modalidade e grava o logistic_type no raw_api_data.
        await db.query(
          `UPDATE public.sales
              SET shipping_mode = $1,
                  raw_api_data = jsonb_set(
                    COALESCE(raw_api_data, '{}'::jsonb),
                    '{shipping,logistic_type}',
                    to_jsonb($2::text),
                    true
                  ),
                  updated_at = NOW()
            WHERE id = $3 AND uid = $4 AND seller_id = $5
              AND (shipping_mode IS NULL OR shipping_mode = 'Outros'
                   OR (shipping_mode = 'FULL' AND (raw_api_data->'shipping'->>'logistic_type') IS DISTINCT FROM 'fulfillment'))`,
          [mapped, logisticType, c.id, c.uid, c.seller_id]
        );
        fixed++;
      } catch (e) {
        failed++;
      }
    });

    return res.json({
      message: 'Correção de modalidades concluída (rodada).',
      totalRemaining,
      processed: candidates.length,
      fixed,
      stillOutros,
      failed,
      hint: totalRemaining > candidates.length ? `Ainda restam ~${totalRemaining - fixed}. Rode novamente para continuar.` : 'Tudo processado.'
    });
  } catch (error) {
    console.error('[FIX-MODES] erro:', error);
    return res.status(500).json({ error: error.message || 'Erro ao corrigir modalidades.' });
  }
});

/** ======== WEBHOOK DO MERCADO LIVRE (tempo real) ======== */
// O ML envia POST aqui no instante em que um pedido/envio muda. A gente responde
// 200 na hora e sincroniza SÓ aquele pedido. Sem clique, sem período, sem varrer.
// Configurar a Callback URL no painel do app ML apontando para:
//   https://api.cyberdock.com.br/api/sales/webhook/ml
// Tópicos: orders / orders_v2 / created_orders / shipments.

const webhookDedup = new Map(); // key -> timestamp (evita processar duplicatas em rajada)

async function refreshAccountToken(userId, uid, refresh_token) {
  const CLIENT_ID = process.env.ML_CLIENT_ID;
  const CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
  const r = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token
    })
  });
  if (!r.ok) throw new Error('Falha ao renovar token no webhook.');
  const t = await r.json();
  await db.query(
    "UPDATE public.ml_accounts SET access_token = $1, refresh_token = $2, expires_in = $3, status = 'active', updated_at = NOW() WHERE user_id = $4 AND uid = $5",
    [t.access_token, t.refresh_token, t.expires_in, userId, uid]
  );
  return t.access_token;
}

async function fetchOrderEnriched(orderId, access_token) {
  const r = await mlFetch(`https://api.mercadolibre.com/orders/${orderId}`, { headers: mlHeaders(access_token) });
  if (r.status === 401) return { status: 401, order: null };
  if (!r.ok) return { status: r.status, order: null };
  const order = await r.json();
  const shipmentId = order?.shipping?.id;
  if (shipmentId) {
    const [shipRes, slaRes] = await Promise.all([
      mlFetch(`https://api.mercadolibre.com/shipments/${shipmentId}`, { headers: shipmentHeaders(access_token) }),
      mlFetch(`https://api.mercadolibre.com/shipments/${shipmentId}/sla`, { headers: shipmentHeaders(access_token) }),
    ]);
    if (shipRes.ok) { const s = await safeJson(shipRes); if (s) order.shipping = { ...order.shipping, ...s }; }
    if (slaRes.ok) { const s = await safeJson(slaRes); if (s) order.sla_data = s; }
  }
  return { status: 200, order };
}

async function upsertSingleOrder(order, targetUid, nickname) {
  const rows = buildInsertBatchRows([order].filter(Boolean), targetUid, nickname);
  if (rows.length === 0) return { inserted: 0, updated: 0 };
  const { query, params } = buildMultiInsertQuery_DoUpdate(rows);
  const result = await db.query(query, params);
  let inserted = 0, updated = 0;
  for (const row of result.rows) { if (row.inserted) inserted++; else updated++; }
  return { inserted, updated };
}

router.post('/webhook/ml', async (req, res) => {
  // Responde imediatamente (o ML exige 200 em até 20s, senão reenvia).
  res.sendStatus(200);

  try {
    const body = req.body || {};
    const resource = body.resource;
    const topic = body.topic || '';
    const sellerId = body.user_id;
    if (!resource || !sellerId) return;

    // Dedup simples: ignora o mesmo resource repetido em menos de 10s.
    const key = `${sellerId}:${resource}`;
    const now = Date.now();
    const last = webhookDedup.get(key);
    if (last && now - last < 10000) return;
    webhookDedup.set(key, now);
    if (webhookDedup.size > 5000) webhookDedup.clear();

    // Resolve a conta (token + dono) pelo seller (user_id da notificação).
    const accRes = await db.query(
      'SELECT access_token, refresh_token, uid, nickname FROM public.ml_accounts WHERE user_id = $1 LIMIT 1',
      [sellerId]
    );
    if (accRes.rowCount === 0) {
      console.warn(`[WEBHOOK] Conta não encontrada para seller ${sellerId}`);
      return;
    }
    let { access_token, refresh_token, uid, nickname } = accRes.rows[0];

    // Descobre o orderId a partir do recurso.
    let orderId = null;
    if (resource.includes('/orders/')) {
      orderId = resource.split('/orders/')[1].split(/[/?]/)[0];
    } else if (resource.includes('/shipments/')) {
      // Notificação de envio: busca o shipment para achar o order_id.
      const shipId = resource.split('/shipments/')[1].split(/[/?]/)[0];
      let sr = await mlFetch(`https://api.mercadolibre.com/shipments/${shipId}`, { headers: shipmentHeaders(access_token) });
      if (sr.status === 401) {
        access_token = await refreshAccountToken(sellerId, uid, refresh_token);
        sr = await mlFetch(`https://api.mercadolibre.com/shipments/${shipId}`, { headers: shipmentHeaders(access_token) });
      }
      if (sr.ok) { const sj = await safeJson(sr); orderId = sj?.order_id; }
    } else {
      return; // tópico não tratado (items, questions, etc.)
    }
    if (!orderId) return;

    let { status, order } = await fetchOrderEnriched(orderId, access_token);
    if (status === 401) {
      access_token = await refreshAccountToken(sellerId, uid, refresh_token);
      ({ status, order } = await fetchOrderEnriched(orderId, access_token));
    }
    if (!order) return;

    const { inserted, updated } = await upsertSingleOrder(order, uid, nickname);
    console.log(`[WEBHOOK] ${topic} order=${orderId} seller=${sellerId} novas=${inserted} atualizadas=${updated}`);
  } catch (e) {
    console.error('[WEBHOOK] erro:', e.message);
  }
});

module.exports = router;
