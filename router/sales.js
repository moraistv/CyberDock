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
const PENDING_TTL_MS = 60000;

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

/* ----------------------- Cache curto do total de vendas -------------------
 * O COUNT(*) da view unificada varre as duas tabelas de origem e era refeito
 * em TODA requisição da tabela — inclusive ao trocar de página, quando o total
 * não muda. Com TTL curto, paginar e reabrir a tela deixa de pagar esse custo
 * e o número volta a se atualizar poucos segundos após uma sincronização.
 */
const salesCountCache = new Map();
const salesCountInFlight = new Map();
const SALES_COUNT_TTL_MS = 20000;
const SALES_COUNT_CACHE_MAX = 500;

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

  const promise = db.query(query, params)
    .then((result) => {
      const total = parseInt(result.rows[0]?.total || '0', 10);
      setCachedSalesCount(key, total);
      return total;
    })
    .finally(() => salesCountInFlight.delete(key));

  salesCountInFlight.set(key, promise);
  return promise;
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
    'shipping_limit_date', 'packages', 'date_last_updated', 'sync_signature', 'raw_api_data', 'updated_at'
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
      r.shipping_limit_date, packages, r.date_last_updated || null, r.sync_signature || null, r.raw_api_data,
      new Date()
    );
    const placeholders = cols.map(() => `$${p++}`).join(', ');
    values.push(`(${placeholders})`);
  }

  // RETURNING (xmax = 0) distingue INSERT de UPDATE (inserido: xmax=0).
  // O DO UPDATE só ocorre quando ALGO relevante mudou (IS DISTINCT FROM):
  // assim "atualizada" significa mudança real, e vendas tocadas mas iguais
  // não são regravadas nem contadas (nem geram escrita à toa no banco).
  const query = `
    INSERT INTO public.sales (${cols.join(', ')})
    VALUES ${values.join(', ')}
    ON CONFLICT (id, sku, uid) DO UPDATE SET
      shipping_mode = EXCLUDED.shipping_mode,
      shipping_limit_date = EXCLUDED.shipping_limit_date,
      packages = EXCLUDED.packages,
      date_last_updated = EXCLUDED.date_last_updated,
      sync_signature = EXCLUDED.sync_signature,
      raw_api_data = EXCLUDED.raw_api_data,
      updated_at = EXCLUDED.updated_at
    WHERE public.sales.processed_at IS NULL
      AND (
        public.sales.sync_signature IS DISTINCT FROM EXCLUDED.sync_signature
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

    // Grava a thumbnail encontrada nas vendas correspondentes. Só ML, pois o
    // destino é public.sales (id BIGINT).
    for (const row of rows) {
      if (!isMlRow(row) || row.product_thumbnail || !row.ml_item_id) continue;
      const thumb = thumbMap[String(row.ml_item_id).toUpperCase()];
      if (!thumb) continue;
      try {
        const sql = `
          UPDATE public.sales
             SET raw_api_data = jsonb_set(
                   COALESCE(raw_api_data, '{}')::jsonb,
                   '{order_items,0,item,thumbnail}',
                   $1::jsonb
                 )
           WHERE id = $2 AND sku = $3` + (uid ? ' AND uid = $4' : '');
        const args = uid
          ? [JSON.stringify(thumb), row.id, row.sku, uid]
          : [JSON.stringify(thumb), row.id, row.sku];
        await db.query(sql, args);
      } catch { /* ignora linha problemática */ }
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
    'Cache-Control': 'no-cache'
  });
  clients[clientId] = { res };

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
    delete clients[clientId];
  });
});

router.get('/filter-options', authenticateToken, requireMaster, async (req, res) => {
  try {
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

    res.json({
      accounts: [...mlAccounts, ...shopeeAccounts].map((a) => a.label),
      accountsDetailed: [...mlAccounts, ...shopeeAccounts],
      marketplaces: ['ML', 'Shopee'],
      users: userResult.rows.map(r => r.name)
    });
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
function buildSeparacaoWhere(req) {
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
  }
  if (saleDateEnd) {
    conditions.push(`s.sale_date <= $${paramIdx}`);
    params.push(saleDateEnd + 'T23:59:59.999-03:00');
    paramIdx++;
  }
  // Prazo de despacho: usa o SLA (expected_date) quando houver, senão o
  // shipping_limit_date. É o MESMO campo exibido na tela, garantindo coerência.
  const prazoExpr = `COALESCE(s.raw_api_data->'sla_data'->>'expected_date', s.shipping_limit_date::text)`;
  if (shippingLimitStart) {
    conditions.push(`${prazoExpr} >= $${paramIdx}`);
    params.push(shippingLimitStart);
    paramIdx++;
  }
  if (shippingLimitEnd) {
    conditions.push(`${prazoExpr} <= $${paramIdx}`);
    params.push(shippingLimitEnd + 'T23:59:59.999Z');
    paramIdx++;
  }
  if (shippingMode) {
    const modes = shippingMode.split(',').map(m => m.trim()).filter(Boolean);
    if (modes.length === 1) {
      conditions.push(`s.shipping_mode = $${paramIdx}`);
      params.push(modes[0]);
      paramIdx++;
    } else if (modes.length > 1) {
      conditions.push(`s.shipping_mode = ANY($${paramIdx})`);
      params.push(modes);
      paramIdx++;
    }
  }
  if (account) {
    conditions.push(`(s.seller_id::text = $${paramIdx} OR s.account_nickname ILIKE $${paramIdx + 1})`);
    params.push(account, `%${account}%`);
    paramIdx += 2;
  }
  if (userNickname) {
    conditions.push(`u.name ILIKE $${paramIdx}`);
    params.push(`%${userNickname}%`);
    paramIdx++;
  }
  if (search) {
    conditions.push(`(
      s.product_title ILIKE $${paramIdx}
      OR s.sku ILIKE $${paramIdx}
      OR s.account_nickname ILIKE $${paramIdx}
      OR u.name ILIKE $${paramIdx}
      OR CAST(s.id AS TEXT) ILIKE $${paramIdx}
    )`);
    params.push(`%${search}%`);
    paramIdx++;
  }

  // Não mostrar vendas de usuários inativos
  conditions.push(`COALESCE(u.active, true) = true`);

  // ===== Regras da FILA DE SEPARAÇÃO =====
  // 1) FULL nunca entra: quem separa/expede FULL é o próprio Mercado Livre.
  conditions.push(`s.shipping_mode IS DISTINCT FROM 'FULL'`);
  // 2) Não mostrar pedidos cancelados.
  conditions.push(`COALESCE(s.raw_api_data->>'status','') <> 'cancelled'`);
  // 3) Situação de despacho. Usa o status REAL do envio (raw shipping.status),
  //    não a coluna local shipping_status (alterada durante o processamento).
  if (despacho === 'sim') {
    // Já despachados (enviados/entregues)
    conditions.push(`COALESCE(s.raw_api_data->'shipping'->>'status','') IN ('shipped','delivered')`);
  } else if (despacho === 'todos') {
    // Todos (a despachar + despachados), mantendo apenas a exclusão de cancelados/FULL
  } else {
    // Padrão: só o que falta separar (não despachado)
    conditions.push(`COALESCE(s.raw_api_data->'shipping'->>'status','') NOT IN ('shipped','delivered','not_delivered','cancelled','canceled')`);
  }

  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  return { whereClause, params, paramIdx };
}

router.get('/separacao', authenticateToken, requireMaster, async (req, res) => {
  try {
    const full = String(req.query.full || '') === '1';
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = full
      ? 5000
      : Math.min(200, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    const { whereClause, params, paramIdx } = buildSeparacaoWhere(req);

    // Ordenação: por prazo de despacho (mais próximo primeiro) por padrão.
    const sort = (req.query.sort || 'prazo_asc').trim();
    let orderBy;
    switch (sort) {
      case 'prazo_desc':
        orderBy = `COALESCE(s.raw_api_data->'sla_data'->>'expected_date', s.shipping_limit_date::text) DESC NULLS LAST`;
        break;
      case 'venda_desc':
        orderBy = `s.sale_date DESC`;
        break;
      case 'venda_asc':
        orderBy = `s.sale_date ASC`;
        break;
      case 'prazo_asc':
      default:
        orderBy = `COALESCE(s.raw_api_data->'sla_data'->>'expected_date', s.shipping_limit_date::text) ASC NULLS LAST`;
        break;
    }

    // Expressão do prazo de despacho (SLA quando houver, senão shipping_limit_date),
    // convertida para data no fuso de Brasília para os buckets atrasado/hoje.
    const prazoDateExpr = `(NULLIF(COALESCE(s.raw_api_data->'sla_data'->>'expected_date', s.shipping_limit_date::text), '')::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date`;
    const hojeExpr = `(now() AT TIME ZONE 'America/Sao_Paulo')::date`;

    // Resumo agregado sobre TODO o conjunto filtrado (fila de separação)
    const summaryQuery = `
      SELECT
        COUNT(*) AS total_itens,
        COALESCE(SUM(s.quantity), 0) AS total_unidades,
        COUNT(*) FILTER (WHERE ${prazoDateExpr} < ${hojeExpr}) AS atrasados,
        COUNT(*) FILTER (WHERE ${prazoDateExpr} = ${hojeExpr}) AS despachar_hoje,
        COUNT(DISTINCT s.uid) AS usuarios_ativos
      FROM public.sales s
      LEFT JOIN public.users u ON s.uid = u.uid
      ${whereClause}
    `;
    // Contagem por modalidade
    const modeQuery = `
      SELECT COALESCE(s.shipping_mode, 'Outros') AS mode, COUNT(*) AS count
      FROM public.sales s
      LEFT JOIN public.users u ON s.uid = u.uid
      ${whereClause}
      GROUP BY COALESCE(s.shipping_mode, 'Outros')
      ORDER BY count DESC
    `;

    // Página de itens
    const dataQuery = `
      SELECT s.id, s.sku, s.uid, s.account_nickname, s.quantity,
        s.product_title, s.shipping_mode, s.shipping_limit_date, s.shipping_status,
        u.name AS user_nickname,
        -- Descrição interna cadastrada no Armazenamento (prioridade 1 na exibição)
        (SELECT sk.descricao FROM public.skus sk
          WHERE sk.user_id = s.uid
            AND UPPER(TRIM(sk.sku)) = UPPER(TRIM(s.sku))
            AND sk.descricao IS NOT NULL AND TRIM(sk.descricao) <> ''
          ORDER BY sk.ativo DESC
          LIMIT 1) AS sku_descricao,
        -- Variação escolhida na venda (cor, tamanho...). Casa o item do pedido
        -- pelo seller_sku da linha; se não achar, usa o primeiro item.
        COALESCE(
          (SELECT oi->'item'->'variation_attributes'
             FROM jsonb_array_elements(COALESCE(s.raw_api_data->'order_items', '[]'::jsonb)) oi
            WHERE UPPER(TRIM(COALESCE(oi->'item'->>'seller_sku', oi->'item'->>'id', ''))) = UPPER(TRIM(s.sku))
            LIMIT 1),
          (SELECT oi->'item'->'variation_attributes'
             FROM jsonb_array_elements(COALESCE(s.raw_api_data->'order_items', '[]'::jsonb)) oi
            LIMIT 1)
        ) AS variation_attributes,
        s.raw_api_data->'sla_data'->>'expected_date' AS sla_expected_date,
        COALESCE(s.shipping_status, s.raw_api_data->'shipping'->>'status') AS shipping_status_live,
        s.raw_api_data->'buyer'->>'first_name' AS buyer_first_name,
        s.raw_api_data->'buyer'->>'last_name' AS buyer_last_name,
        s.raw_api_data->'buyer'->>'nickname' AS buyer_nickname
      FROM public.sales s
      LEFT JOIN public.users u ON s.uid = u.uid
      ${whereClause}
      ORDER BY ${orderBy}
      LIMIT $${paramIdx} OFFSET $${paramIdx + 1};
    `;

    // Executa as 3 queries em paralelo (mais rápido)
    const [summaryResult, modeResult, dataResult] = await Promise.all([
      db.query(summaryQuery, params),
      db.query(modeQuery, params),
      db.query(dataQuery, [...params, limit, offset]),
    ]);

    const sRow = summaryResult.rows[0] || {};
    const totalItens = parseInt(sRow.total_itens, 10) || 0;
    const total = totalItens;

    const porModalidade = {};
    for (const r of modeResult.rows) {
      porModalidade[r.mode] = parseInt(r.count, 10) || 0;
    }

    const summary = {
      totalItens,
      totalUnidades: parseInt(sRow.total_unidades, 10) || 0,
      atrasados: parseInt(sRow.atrasados, 10) || 0,
      despacharHoje: parseInt(sRow.despachar_hoje, 10) || 0,
      usuariosAtivos: parseInt(sRow.usuarios_ativos, 10) || 0,
      porModalidade,
    };

    res.json({
      items: dataResult.rows,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
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

    if (marketplace) {
      conditions.push(`s.marketplace = ANY($${paramIdx})`);
      params.push(asList(marketplace));
      paramIdx++;
    }
    if (search) {
      // `s.id` já é TEXT na view unificada (order_id do ML e order_sn da Shopee),
      // então o CAST anterior deixou de ser necessário.
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
      conditions.push(`s.order_status = $${paramIdx}`);
      params.push(saleStatus);
      paramIdx++;
    }
    if (saleDateStart) {
      conditions.push(`s.sale_date >= $${paramIdx}`);
      // Limite do dia em horário de Brasília (UTC-3). Antes usava meia-noite
      // UTC, o que trazia vendas do fim da noite de ontem (BRT) no filtro "hoje".
      params.push(saleDateStart + 'T00:00:00-03:00');
      paramIdx++;
    }
    if (saleDateEnd) {
      conditions.push(`s.sale_date <= $${paramIdx}`);
      params.push(saleDateEnd + 'T23:59:59.999-03:00');
      paramIdx++;
    }
    if (account) {
      // `/filter-options` devolve apelido do ML e nome da loja Shopee, mas
      // links antigos ainda mandam o id numérico — os três formatos casam.
      conditions.push(`(s.account_id = $${paramIdx} OR s.account_nickname ILIKE $${paramIdx + 1})`);
      params.push(account, `%${account}%`);
      paramIdx += 2;
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
    const userNickname = (req.query.userNickname || '').trim();
    if (userNickname) {
      conditions.push(`u.name ILIKE $${paramIdx}`);
      params.push(`%${userNickname}%`);
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
      conditions.push(`s.shipping_mode IS DISTINCT FROM 'FULL'`);
    }

    // Default system filter: do not show sales of inactive users in the master table
    conditions.push(`COALESCE(u.active, true) = true`);

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const countQuery = `
      SELECT COUNT(*) as total
        FROM public.unified_sales s
        LEFT JOIN public.users u ON s.uid = u.uid
        ${whereClause}`;

    // Mesma estratégia da tela do usuário: recorta a página primeiro e só
    // depois resolve SKU/JSON, para o custo por linha valer apenas 1 página.
    const dataQuery = `
      WITH page_rows AS MATERIALIZED (
        SELECT s.*, u.name AS user_nickname
          FROM public.unified_sales s
          LEFT JOIN public.users u ON s.uid = u.uid
          ${whereClause}
         ORDER BY s.sale_date DESC, s.marketplace, s.id, s.sku
         LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
      )
      SELECT s.id, s.sku, s.uid, s.marketplace,
        s.marketplace AS channel,
        s.account_id AS seller_id,
        s.account_nickname, s.sale_date,
        s.product_title, s.quantity, s.shipping_mode,
        s.shipping_deadline AS shipping_limit_date,
        s.shipping_status, s.updated_at, s.processed_at,
        s.user_nickname,
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
      const total = cachedTotal === null
        ? await loadSalesCount(countKey, countQuery, params)
        : cachedTotal;
      return res.json({ total, totalPages: Math.ceil(total / limit) || 1 });
    }

    const dataResult = await db.query(dataQuery, [...params, limit + 1, offset]);
    const hasNext = dataResult.rows.length > limit;
    const rows = hasNext ? dataResult.rows.slice(0, limit) : dataResult.rows;

    let total = cachedTotal;
    let totalExact = cachedTotal !== null;

    if (total === null && !hasNext) {
      total = offset + rows.length;
      totalExact = true;
      setCachedSalesCount(countKey, total);
    }
    if (total === null) total = offset + rows.length + 1;

    res.json({
      data: rows,
      total,
      totalExact,
      hasNext,
      page,
      limit,
      totalPages: totalExact ? (Math.ceil(total / limit) || 1) : page + 1,
    });

    if (!totalExact) {
      setImmediate(() => {
        loadSalesCount(countKey, countQuery, params).catch((error) => {
          console.error('Erro ao aquecer total do tabelão:', error);
        });
      });
    }
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
  const { skip = [], startIndex = 1, dateRange = null } = options;
  const uses = (name) => !skip.includes(name);

  const conditions = [`s.uid = $${startIndex}`];
  const params = [uid];
  let p = startIndex + 1;

  const from = dateRange ? dateRange.from : (query.from || '').trim();
  const to = dateRange ? dateRange.to : (query.to || '').trim();

  if (uses('period') && from) {
    conditions.push(`s.sale_date >= $${p}`); params.push(`${from}T00:00:00-03:00`); p++;
  }
  if (uses('period') && to) {
    conditions.push(`s.sale_date <= $${p}`); params.push(`${to}T23:59:59.999-03:00`); p++;
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

  const shippingStatus = (query.shippingStatus || '').trim();
  if (uses('shippingStatus') && shippingStatus) {
    conditions.push(`${U_SHIPPING_STATUS} = ANY($${p})`); params.push(asFilterList(shippingStatus)); p++;
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

  return { where: `WHERE ${conditions.join(' AND ')}`, params, nextIndex: p };
}

/**
 * Opções disponíveis para cada filtro, já considerando os outros filtros
 * ativos. Cada faceta ignora apenas o próprio campo, de modo que o usuário
 * nunca veja uma combinação que resultaria em lista vazia.
 */
router.get('/filter-facets', authenticateToken, async (req, res) => {
  const { uid } = req.user;
  try {
    const facet = (skipName, keyExpr, extraSelect = '') => {
      const { where, params } = buildUnifiedFilters(req.query, uid, { skip: [skipName] });
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

    const [marketplaces, accounts, statuses, modes, saleStatuses] = await Promise.all([
      facet('marketplace', 's.marketplace'),
      facet('account', U_ACCOUNT_KEY, `, COALESCE(NULLIF(s.account_nickname, ''), s.account_id) AS label`),
      facet('shippingStatus', U_SHIPPING_STATUS),
      facet('shippingMode', U_SHIPPING_MODE),
      facet('saleStatus', `LOWER(COALESCE(NULLIF(s.order_status, ''), 'sem_status'))`),
    ]);

    const MK_LABEL = { ML: 'Mercado Livre', Shopee: 'Shopee' };
    res.json({
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
    });
  } catch (error) {
    console.error('Erro ao montar opções de filtro:', error);
    res.status(500).json({ error: 'Erro interno ao carregar opções de filtro.' });
  }
});

router.get('/dashboard-stats', authenticateToken, async (req, res) => {
  const { uid } = req.user;
  const from = (req.query.from || '').trim();
  const to = (req.query.to || '').trim();

  try {
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

    res.json({
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
    });
  } catch (error) {
    console.error('Erro ao montar métricas do dashboard:', error);
    res.status(500).json({ error: 'Erro interno ao carregar métricas.' });
  }
});

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
    const { rows } = await db.query(`
      SELECT
        COUNT(*)::int AS total_sales,
        COUNT(*) FILTER (
          WHERE LOWER(COALESCE(shipping_status, '')) IN
            ('custom_06_despachado', 'expedited', 'despachado', 'shipped')
        )::int AS expedited_count,
        COUNT(*) FILTER (WHERE processed_at IS NOT NULL)::int AS processed_count
      FROM public.unified_sales
      WHERE uid = $1
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
    const query = `
      SELECT s.id, s.sku, s.uid,
             s.account_id            AS seller_id,
             s.marketplace,
             s.marketplace           AS channel,
             s.account_nickname, s.sale_date, s.product_title, s.quantity,
             s.shipping_mode,
             s.shipping_deadline     AS shipping_limit_date,
             s.shipping_status, s.order_status, s.product_thumbnail,
             s.raw_api_data, s.updated_at, s.processed_at
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
      conditions.push(`s.order_status = $${paramIdx}`);
      params.push(saleStatus);
      paramIdx++;
    }
    if (saleDateStart) {
      conditions.push(`s.sale_date >= $${paramIdx}`);
      // Limite do dia em horário de Brasília (UTC-3), consistente com o tabelão.
      params.push(saleDateStart + 'T00:00:00-03:00');
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
    if (shippingLimitStart || shippingLimitEnd) {
      conditions.push(`s.shipping_mode IS DISTINCT FROM 'FULL'`);
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

    // Count e página usam os mesmos filtros e são independentes; executá-los
    // juntos elimina uma ida sequencial ao banco em toda troca de filtro.
    const countQuery = `SELECT COUNT(*) as total FROM public.unified_sales s ${whereClause}`;
    // Primeiro recorta somente a página pedida. O MATERIALIZED é intencional:
    // garante que lookup de SKU, expansão de JSON e montagem do payload sejam
    // executados para no máximo limit + 1 linhas, nunca para todo o histórico.
    const dataQuery = `
      WITH page_rows AS MATERIALIZED (
        SELECT s.*
          FROM public.unified_sales s
          ${whereClause}
         ORDER BY s.sale_date DESC, s.marketplace, s.id, s.sku
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
      const total = cachedTotal === null
        ? await loadSalesCount(countKey, countQuery, params)
        : cachedTotal;
      return res.json({ total, totalPages: Math.ceil(total / limit) || 1 });
    }

    // Busca uma linha extra para descobrir se existe próxima página sem COUNT.
    const dataResult = await db.query(dataQuery, [...params, limit + 1, offset]);
    const hasNext = dataResult.rows.length > limit;
    const rows = hasNext ? dataResult.rows.slice(0, limit) : dataResult.rows;

    let total = cachedTotal;
    let totalExact = cachedTotal !== null;

    // Se não veio a linha extra, esta é a última página e o total já é exato.
    if (total === null && !hasNext) {
      total = offset + rows.length;
      totalExact = true;
      setCachedSalesCount(countKey, total);
    }

    // Enquanto a contagem exata aquece, devolve um limite inferior suficiente
    // para a UI habilitar "Próximo" e renderizar os dados imediatamente.
    if (total === null) total = offset + rows.length + 1;

    res.json({
      data: rows,
      total,
      totalExact,
      hasNext,
      page,
      limit,
      totalPages: totalExact ? (Math.ceil(total / limit) || 1) : page + 1,
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
      
      // Check if this SKU is a component of any kit (for package_type logic)
      let isKitComponent = false;
      let kitPackageTypeId = null;
      let kitSkuCode = null;
      
      if (!stock.is_kit) {
        // Check if this SKU is used as a component in any kit
        const kitComponentCheckQuery = `
          SELECT kc.kit_sku_id, ks.sku as kit_sku_code, ks.package_type_id
          FROM public.sku_kit_components kc
          JOIN public.skus ks ON kc.kit_sku_id = ks.id
          WHERE kc.child_sku_id = $1 AND ks.user_id = $2
        `;
        const kitComponentCheck = await client.query(kitComponentCheckQuery, [stock.id, uid]);
        
        if (kitComponentCheck.rows.length > 0) {
          isKitComponent = true;
          // Use the first kit's package_type (assuming one component can't be in multiple kits)
          kitPackageTypeId = kitComponentCheck.rows[0].package_type_id;
          kitSkuCode = kitComponentCheck.rows[0].kit_sku_code;
        }
      }
      
      // Handle kit vs regular SKU logic
      if (stock.is_kit) {
        // For kits, check component availability and deduct from child SKUs
        const kitComponentsQuery = `
          SELECT child_sku_id, quantity_per_kit
          FROM public.sku_kit_components
          WHERE kit_sku_id = $1
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

        // Record movement for the kit itself (informational)
        const insertKitMovementQuery = `
          INSERT INTO public.stock_movements (sku_id, user_id, movement_type, quantity_change, reason, related_sale_id)
          VALUES ($1, $2, 'saida', $3, $4, $5)
        `;
        await client.query(insertKitMovementQuery, [
          stock.id, 
          uid, 
          quantitySold, 
          `Saída por Venda - ID: ${saleId}`, 
          saleId
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
        
        // Determine which package_type to use based on context
        let effectivePackageTypeId = stock.package_type_id;
        let packageTypeContext = 'SKU próprio';
        
        if (isKitComponent && kitPackageTypeId) {
          // If this SKU is a kit component, use the kit's package_type for billing
          effectivePackageTypeId = kitPackageTypeId;
          packageTypeContext = `Kit: ${kitSkuCode}`;
        }
        
        await client.query(
          `INSERT INTO public.stock_movements
             (sku_id, user_id, movement_type, quantity_change, reason, related_sale_id, package_type_id, package_type_context)
           VALUES ($1, $2, 'saida', $3, $4, $5, $6, $7)`,
          [stock.id, uid, quantitySold, reason, saleId, effectivePackageTypeId, packageTypeContext]
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
  const client = await db.pool.connect();

  try {
    for (const requestedSale of sanitized) {
      try {
        if (!requestedSale.id || !requestedSale.sku || !requestedSale.uid) {
          throw new Error('Dados da venda incompletos (id, sku, uid).');
        }

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
          results.success.push({ saleId: sale.id, sku: sale.sku, alreadyProcessed: true });
          continue;
        }

        sale.quantity = Number(sale.quantity);
        if (!Number.isInteger(sale.quantity) || sale.quantity <= 0) {
          throw new Error('Quantidade inválida na venda salva.');
        }

        const skuResult = await client.query(
          `SELECT id, sku, quantidade, is_kit
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
              WHERE kit_sku_id = $1`,
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

          // Movimento informativo do kit; o estoque físico está nos filhos.
          await client.query(
            `INSERT INTO public.stock_movements
               (sku_id, user_id, movement_type, quantity_change, reason, related_sale_id)
             VALUES ($1, $2, 'saida', $3, $4, $5)`,
            [stock.id, sale.uid, sale.quantity, `Saída por Venda Mercado Livre - ID ${sale.id}`, sale.id]
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
               (sku_id, user_id, movement_type, quantity_change, reason, related_sale_id)
             VALUES ($1, $2, 'saida', $3, $4, $5)`,
            [stock.id, sale.uid, sale.quantity, `Saída por Venda Mercado Livre - ID ${sale.id}`, sale.id]
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
        results.success.push({ saleId: sale.id, sku: sale.sku, quantity: sale.quantity });
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
        results.failed.push({
          saleId: requestedSale.id,
          sku: requestedSale.sku,
          reason: error.message,
        });
      }
    }

    return res.json({ message: 'Processamento concluído.', ...results });
  } catch (error) {
    console.error('Erro crítico no processamento em lote:', error);
    return res.status(500).json({ error: 'Erro crítico no processamento em lote.' });
  } finally {
    client.release();
  }
});

router.post('/sync-account', authenticateToken, async (req, res) => {
  const { userId, accountNickname: nickname, clientId, force, backfill, clientUid, daysToSync } = req.body;
  let targetUid = clientUid || req.user.uid;

  if (!userId || !clientId) return res.status(400).json({ error: 'ID usuário e clientId obrigatórios.' });

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
                MAX(sync_signature) AS sig,
                bool_or(shipping_mode IS NULL OR shipping_mode = 'Outros') AS needs_fix
           FROM public.sales
          WHERE uid = $1 AND id = ANY($2::bigint[])
          GROUP BY id`,
        [targetUid, orderIdList]
      );
      for (const r of stateRes.rows) {
        savedState.set(String(r.id), { sig: r.sig, needsFix: r.needs_fix === true });
      }
    }

    const toProcess = [];
    let skippedCount = 0;
    for (const summary of orderSummaries) {
      const st = savedState.get(String(summary.id));
      const remoteSig = computeSyncSignature(summary);
      // Pula ANTES de baixar quando a assinatura (status/envio/substatus/tags) é
      // idêntica à salva: nada relevante mudou, foi só "bump" interno do ML.
      // EXCEÇÃO: se a venda ficou com modalidade "Outros"/nula (efeito do header
      // antigo), reprocessa uma vez para corrigir a modalidade.
      if (st && st.sig != null && st.sig === remoteSig && !st.needsFix) {
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
      try {
        const orderDetailsRes = await mlFetch(`https://api.mercadolibre.com/orders/${summary.id}`, { headers: mlHeaders(access_token) });
        if (orderDetailsRes.ok) {
          order = await orderDetailsRes.json();
        }
      } catch (e) {
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
          }
          if (slaRes.ok) {
            const slaData = await safeJson(slaRes);
            if (slaData) order.sla_data = slaData;
          }
        } catch (e) {
          console.error(`Falha ao enriquecer envio ${shipmentId}:`, e);
        }
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

    // Busca a última venda sincronizada para esta conta
    const lastSyncRes = await db.query(
      `SELECT MAX(updated_at) AS last_sale FROM public.sales WHERE uid = $1 AND seller_id = $2`,
      [targetUid, mlAccountId]
    );
 
    const lastSync = lastSyncRes.rows[0]?.last_sale;
    
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
