// routes/shopee.js
//
// Integração Shopee (Open Platform API v2), no mesmo padrão arquitetural do
// Mercado Livre (router/mercadolivre.js + router/sales.js):
//   - OAuth por LOJA (shop_id), tokens em public.shopee_accounts.
//   - Sincronização incremental de vendas com progresso via SSE, salvando em
//     public.shopee_sales (equivalente à public.sales do ML).
//   - Abatimento de estoque reaproveitando public.skus / stock_movements,
//     igual ao fluxo /sales/process do ML.
//
// Diferenças da Shopee em relação ao ML:
//   - Autenticação: partner_id + partner_key + assinatura HMAC-SHA256 por
//     chamada (não é OAuth Bearer). Um access_token/refresh_token por LOJA.
//   - Pedidos vêm em 3 passos: get_order_list (paginado por cursor) →
//     get_order_detail (lotes de até 50) → get_escrow_detail (financeiro real).

const express = require('express');
const crypto = require('crypto');
const db = require('../utils/postgres');
const { authenticateToken, requireMaster } = require('../utils/authMiddleware');
const {
  getShopeePartnerCredentials,
  getShopeeAuthUrl,
  exchangeShopeeCode,
  refreshShopeeToken,
  getShopeeShopName,
  getShopeeOrderList,
  getShopeeOrderDetail,
  getShopeeEscrowDetail,
} = require('../utils/shopeeClient');
const { calculateShopeeFinancials, SHOPEE_FINANCIAL_RULE_VERSION } = require('../utils/shopeeFinance');

const router = express.Router();

const REDIRECT_URI = process.env.SHOPEE_REDIRECT_URI || 'https://api.cyberdock.com.br/api/shopee/callback';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://cyberdock.com.br';

const oauthStates = new Map(); // state -> { uid, createdAt }
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of oauthStates.entries()) {
    if (now - v.createdAt > 15 * 60 * 1000) oauthStates.delete(k);
  }
}, 5 * 60 * 1000);

/* --------------------------- SSE (mesmo padrão de /sales) --------------------------- */
const clients = {};
const pendingEvents = {};
const PENDING_TTL_MS = 60000;

const sendEvent = (clientId, data) => {
  if (clients[clientId]) {
    clients[clientId].res.write(`data: ${JSON.stringify(data)}\n\n`);
    return;
  }
  if (!pendingEvents[clientId]) {
    pendingEvents[clientId] = { events: [], timer: null };
    pendingEvents[clientId].timer = setTimeout(() => {
      delete pendingEvents[clientId];
    }, PENDING_TTL_MS);
  }
  pendingEvents[clientId].events.push(data);
};

router.get('/sync-status/:clientId', (req, res) => {
  const { clientId } = req.params;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    Connection: 'keep-alive',
    'Cache-Control': 'no-cache',
  });
  clients[clientId] = { res };

  const buffered = pendingEvents[clientId];
  if (buffered) {
    if (buffered.timer) clearTimeout(buffered.timer);
    for (const ev of buffered.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    delete pendingEvents[clientId];
  } else {
    sendEvent(clientId, { progress: 5, message: 'Conexão estabelecida. Aguardando início...', type: 'info' });
  }

  req.on('close', () => {
    delete clients[clientId];
  });
});

/* ------------------------------- OAuth: Auth ------------------------------- */
// Igual ao padrão do /ml/auth: navegação de página inteira (não é fetch), por
// isso não dá para enviar o header Authorization. O uid vem via query string,
// como já é feito em router/mercadolivre.js.
router.get('/auth', (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).send('UID do usuário é obrigatório.');

  const { partnerId, partnerKey } = getShopeePartnerCredentials();
  if (!partnerId || !partnerKey) {
    return res.status(500).json({ error: 'Credenciais Shopee ausentes (SHOPEE_PARTNER_ID / SHOPEE_PARTNER_KEY).' });
  }

  const state = crypto.randomUUID();
  oauthStates.set(state, { uid, createdAt: Date.now() });

  const authUrl = getShopeeAuthUrl(partnerId, partnerKey, `${REDIRECT_URI}?state=${state}`);
  res.redirect(authUrl);
});

/* ----------------------------- OAuth: Callback ----------------------------- */
router.get('/callback', async (req, res) => {
  const { code, shop_id, state } = req.query;
  const shopId = shop_id || req.query.shopid;

  const stateObj = state ? oauthStates.get(state) : null;
  if (!code || !shopId || !stateObj) {
    return res.redirect(`${FRONTEND_URL}/contas?error=${encodeURIComponent('Autorização Shopee falhou. Dados ausentes ou sessão expirada.')}`);
  }
  oauthStates.delete(state);
  const { uid } = stateObj;

  try {
    const { partnerId, partnerKey } = getShopeePartnerCredentials();
    const tokens = await exchangeShopeeCode(code, shopId, partnerId, partnerKey);
    const expiresAt = new Date(Date.now() + Math.max(30, tokens.expire_in - 60) * 1000);
    const shopName = await getShopeeShopName(tokens.shop_id, tokens.access_token, partnerId, partnerKey);

    const upsertQuery = `
      INSERT INTO public.shopee_accounts (
        uid, shop_id, shop_name, merchant_id, access_token, refresh_token,
        expires_at, status, connected_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', NOW(), NOW())
      ON CONFLICT (uid, shop_id) DO UPDATE SET
        shop_name    = EXCLUDED.shop_name,
        merchant_id  = EXCLUDED.merchant_id,
        access_token = EXCLUDED.access_token,
        refresh_token= EXCLUDED.refresh_token,
        expires_at   = EXCLUDED.expires_at,
        status       = 'active',
        updated_at   = NOW();
    `;
    await db.query(upsertQuery, [
      uid,
      Number(tokens.shop_id),
      shopName,
      tokens.merchant_id,
      tokens.access_token,
      tokens.refresh_token,
      expiresAt,
    ]);

    res.redirect(`${FRONTEND_URL}/contas?success=${encodeURIComponent(`Loja Shopee ${shopName || tokens.shop_id} conectada com sucesso!`)}`);
  } catch (error) {
    console.error('[Shopee Callback] Erro:', error);
    res.redirect(`${FRONTEND_URL}/contas?error=${encodeURIComponent(error.message || 'Erro desconhecido ao conectar loja Shopee.')}`);
  }
});

/* -------------------------------- Contas -------------------------------- */
router.get('/contas/:uid', authenticateToken, async (req, res) => {
  const { uid } = req.params;
  try {
    const { rows } = await db.query(
      'SELECT shop_id, shop_name, status, connected_at, expires_at FROM public.shopee_accounts WHERE uid = $1',
      [uid]
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

router.delete('/contas/:shopId', authenticateToken, async (req, res) => {
  const { shopId } = req.params;
  const { uid } = req.user;
  if (!shopId || !uid) return res.status(400).json({ error: 'Parâmetros inválidos para exclusão.' });

  try {
    const result = await db.query('DELETE FROM public.shopee_accounts WHERE shop_id = $1 AND uid = $2', [shopId, uid]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Loja não encontrada ou não pertence a este usuário.' });
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: 'Erro interno ao excluir a loja.' });
  }
});

/* ------------------------------ Helpers de sync ------------------------------ */

function rec(value) {
  return value !== null && typeof value === 'object' ? value : {};
}

function toFiniteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function truncate(str, max) {
  if (typeof str !== 'string' || !str) return '';
  return str.length > max ? str.substring(0, max) : str;
}

function epochSeconds(d) {
  return Math.floor(d.getTime() / 1000);
}

const SP_OFFSET_SECONDS = 3 * 60 * 60;

/** create_time (epoch UTC) → naive wall-clock de São Paulo (mesma convenção do ML). */
function toSaoPauloWallClock(epochSecondsUtc) {
  return new Date((epochSecondsUtc - SP_OFFSET_SECONDS) * 1000);
}

/** Executa uma operação escopada à loja, renovando o token 1x em caso de invalid_access_token. */
async function withTokenRetry(account, op, partnerId, partnerKey) {
  try {
    return await op(account.accessToken);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('invalid_access_token') || msg.includes('invalid_acceess_token')) {
      const refreshed = await refreshShopeeToken(
        { uid: account.uid, shopId: account.shopId, refreshToken: account.refreshToken },
        partnerId,
        partnerKey
      );
      account.accessToken = refreshed.access_token;
      account.refreshToken = refreshed.refresh_token;
      return op(account.accessToken);
    }
    throw err;
  }
}

const MAX_WINDOW_DAYS = 15;

/** Busca + enriquece pedidos de uma janela (list -> detail -> escrow). */
async function fetchWindowOrders(account, from, to, partnerId, partnerKey) {
  const orderSnList = [];
  let cursor;
  do {
    const list = await withTokenRetry(
      account,
      (accessToken) =>
        getShopeeOrderList({
          partnerId,
          partnerKey,
          accessToken,
          shopId: account.shopId,
          createTimeFrom: epochSeconds(from),
          createTimeTo: epochSeconds(to),
          pageSize: 100,
          cursor,
        }),
      partnerId,
      partnerKey
    );
    if (list?.order_list) list.order_list.forEach((o) => orderSnList.push(String(o.order_sn)));
    cursor = list?.more ? list.next_cursor : undefined;
  } while (cursor);

  if (orderSnList.length === 0) return [];

  const detailed = [];
  const batches = [];
  for (let i = 0; i < orderSnList.length; i += 50) batches.push(orderSnList.slice(i, i + 50));

  await Promise.allSettled(
    batches.map((batch) =>
      withTokenRetry(
        account,
        (accessToken) =>
          getShopeeOrderDetail({ partnerId, partnerKey, accessToken, shopId: account.shopId, orderSnList: batch.join(',') }),
        partnerId,
        partnerKey
      ).then((res) => {
        if (res?.order_list) detailed.push(...res.order_list);
      })
    )
  );

  // Escrow (financeiro real) com concorrência limitada.
  const ESCROW_CONCURRENCY = 8;
  let idx = 0;
  async function escrowWorker() {
    while (idx < detailed.length) {
      const order = detailed[idx++];
      try {
        order.escrow_details = await withTokenRetry(
          account,
          (accessToken) => getShopeeEscrowDetail({ partnerId, partnerKey, accessToken, shopId: account.shopId, orderSn: String(order.order_sn) }),
          partnerId,
          partnerKey
        );
      } catch {
        order.escrow_details = {};
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(ESCROW_CONCURRENCY, detailed.length) }, () => escrowWorker()));

  return detailed;
}

/** Percorre janelas de tempo desde `since` até agora. */
async function fetchOrdersSince(account, since, partnerId, partnerKey, onProgress) {
  const all = [];
  const MAX_ORDERS_PER_SHOP = 10000;
  const now = new Date();
  let windowStart = since;
  while (windowStart < now && all.length < MAX_ORDERS_PER_SHOP) {
    const windowEnd = new Date(Math.min(windowStart.getTime() + MAX_WINDOW_DAYS * 86400000, now.getTime()));
    const orders = await fetchWindowOrders(account, windowStart, windowEnd, partnerId, partnerKey);
    all.push(...orders);
    if (onProgress) onProgress(all.length);
    windowStart = new Date(windowEnd.getTime() + 1);
  }
  return all.slice(0, MAX_ORDERS_PER_SHOP);
}

function roundCurrency(value) {
  const rounded = Math.round((value + Number.EPSILON) * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** SKU do primeiro item do pedido. */
function firstSkuOfOrder(order) {
  const itemList = Array.isArray(order.item_list) ? order.item_list : [];
  const firstItem = itemList[0] || {};
  const skuRaw = firstItem.item_sku || firstItem.model_sku || firstItem.variation_sku || null;
  return skuRaw ? truncate(String(skuRaw), 255) : null;
}

/** Custo (mais recente) de cada SKU, em lote, para o CMV — reaproveita public.skus. */
async function fetchCostBySku(skus, uid) {
  const map = new Map();
  const unique = Array.from(new Set(skus.filter(Boolean)));
  if (unique.length === 0) return map;

  const { rows } = await db.query(
    `SELECT sku, quantidade FROM public.skus WHERE user_id = $1 AND UPPER(TRIM(sku)) = ANY($2::text[])`,
    [uid, unique.map((s) => s.toUpperCase().trim())]
  );
  for (const r of rows) map.set(r.sku.toUpperCase().trim(), { quantity: r.quantidade });
  return map;
}

/** Mapeia um pedido enriquecido para uma linha de upsert em shopee_sales. */
function orderToRow(order, account, nickname) {
  const orderSn = String(order.order_sn);
  const dataVenda = toSaoPauloWallClock(toFiniteNumber(order.create_time) ?? 0);
  const itemList = Array.isArray(order.item_list) ? order.item_list : [];
  const fin = calculateShopeeFinancials(order);

  const titulo = truncate(itemList[0]?.item_name, 500) || 'Pedido';
  const firstItem = itemList[0] || {};
  const sku = firstSkuOfOrder(order) || String(firstItem.item_id || orderSn);
  const recipient = rec(order.recipient_address);
  const comprador = truncate(order.buyer_username, 255) || 'Comprador';
  const recipientName = truncate(recipient.name, 255) || null;
  const shipByDateRaw = toFiniteNumber(order.ship_by_date);
  const shipByDate = shipByDateRaw && shipByDateRaw > 0 ? new Date(shipByDateRaw * 1000) : null;

  const pkg = rec((order.package_list || [])[0]);
  const trackingNumber = truncate(pkg.tracking_number, 255) || null;
  const shippingCarrier = truncate(pkg.shipping_carrier || order.shipping_carrier, 100) || null;

  const paymentDetailsExtended = {
    ...rec(order.escrow_details),
    financialRuleVersion: SHOPEE_FINANCIAL_RULE_VERSION,
    productValueBreakdown: fin.paymentBreakdown,
  };
  const shipmentDetailsExtended = {
    shipping_carrier: shippingCarrier,
    logistics_status: truncate(pkg.logistics_status, 100) || null,
    recipient_name: recipientName,
    ...fin.shipmentBreakdown,
    ...pkg,
  };

  return {
    orderSn,
    sku,
    uid: account.uid,
    shopId: account.shopId,
    accountNickname: nickname,
    saleDate: dataVenda,
    productTitle: titulo,
    quantity: fin.quantity || 1,
    unitPrice: fin.unitPrice,
    totalAmount: fin.effectiveProductSubtotal,
    platformFee: fin.platformFee,
    freight: fin.freight,
    netRevenue: fin.netRevenue,
    orderStatus: String(order.order_status || 'DESCONHECIDO'),
    buyerUsername: comprador,
    recipientName,
    trackingNumber,
    shippingCarrier,
    shipByDate,
    rawApiData: { ...order, paymentDetails: paymentDetailsExtended, shipmentDetails: shipmentDetailsExtended },
  };
}

const UPSERT_QUERY = `
  INSERT INTO public.shopee_sales (
    order_sn, sku, uid, shop_id, account_nickname, sale_date, product_title,
    quantity, unit_price, total_amount, platform_fee, freight, net_revenue,
    order_status, buyer_username, recipient_name, tracking_number,
    shipping_carrier, ship_by_date, raw_api_data, updated_at
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,NOW())
  ON CONFLICT (order_sn, sku, uid) DO UPDATE SET
    order_status     = EXCLUDED.order_status,
    tracking_number   = EXCLUDED.tracking_number,
    shipping_carrier  = EXCLUDED.shipping_carrier,
    ship_by_date      = EXCLUDED.ship_by_date,
    raw_api_data      = EXCLUDED.raw_api_data,
    updated_at        = NOW()
  WHERE public.shopee_sales.processed_at IS NULL
     OR public.shopee_sales.order_status IS DISTINCT FROM EXCLUDED.order_status;
`;

async function upsertRow(row) {
  await db.query(UPSERT_QUERY, [
    row.orderSn,
    row.sku,
    row.uid,
    row.shopId,
    row.accountNickname,
    row.saleDate,
    row.productTitle,
    row.quantity,
    row.unitPrice,
    row.totalAmount,
    row.platformFee,
    row.freight,
    row.netRevenue,
    row.orderStatus,
    row.buyerUsername,
    row.recipientName,
    row.trackingNumber,
    row.shippingCarrier,
    row.shipByDate,
    JSON.stringify(row.rawApiData),
  ]);
}

/* --------------------------- Sincronização (SSE) --------------------------- */
router.post('/sync-account', authenticateToken, async (req, res) => {
  const { shopId, clientId, force, clientUid } = req.body;
  let targetUid = clientUid || req.user.uid;

  if (!shopId || !clientId) return res.status(400).json({ error: 'shopId e clientId são obrigatórios.' });

  res.status(202).json({ message: 'Sincronização Shopee iniciada. Acompanhe status.' });

  try {
    sendEvent(clientId, { progress: 10, message: 'Buscando credenciais da loja...', type: 'info' });

    let accRes;
    if (req.user.role === 'master' && clientUid) {
      accRes = await db.query('SELECT * FROM public.shopee_accounts WHERE shop_id = $1 AND uid = $2', [shopId, clientUid]);
    } else if (req.user.role === 'master') {
      accRes = await db.query('SELECT * FROM public.shopee_accounts WHERE shop_id = $1 LIMIT 1', [shopId]);
    } else {
      accRes = await db.query('SELECT * FROM public.shopee_accounts WHERE shop_id = $1 AND uid = $2', [shopId, targetUid]);
    }
    if (accRes.rowCount === 0) throw new Error('Loja Shopee não encontrada.');
    const accRow = accRes.rows[0];
    targetUid = accRow.uid;

    const account = {
      uid: accRow.uid,
      shopId: String(accRow.shop_id),
      shopName: accRow.shop_name,
      accessToken: accRow.access_token,
      refreshToken: accRow.refresh_token,
    };
    const nickname = account.shopName || account.shopId;

    const { partnerId, partnerKey } = getShopeePartnerCredentials();

    // Renova o token se estiver perto de expirar.
    const expiresAt = accRow.expires_at ? new Date(accRow.expires_at).getTime() : 0;
    if (expiresAt - Date.now() < 10 * 60 * 1000) {
      sendEvent(clientId, { progress: 15, message: `[${nickname}] Renovando token...`, type: 'info' });
      const refreshed = await refreshShopeeToken(account, partnerId, partnerKey);
      account.accessToken = refreshed.access_token;
      account.refreshToken = refreshed.refresh_token;
    }

    // Cursor incremental: última venda salva - 1 dia de margem.
    const lastRes = await db.query(
      'SELECT MAX(sale_date) AS last_sale FROM public.shopee_sales WHERE uid = $1 AND shop_id = $2',
      [targetUid, shopId]
    );
    const lastSale = lastRes.rows[0]?.last_sale ? new Date(lastRes.rows[0].last_sale) : null;
    let since;
    if (force || !lastSale) {
      since = new Date('2024-01-01T00:00:00.000Z');
      sendEvent(clientId, { progress: 20, message: `[${nickname}] Sincronização completa iniciada...`, type: 'info' });
    } else {
      since = new Date(lastSale.getTime() - 24 * 60 * 60 * 1000);
      sendEvent(clientId, { progress: 20, message: `[${nickname}] Buscando novidades desde a última sincronização...`, type: 'info' });
    }

    const orders = await fetchOrdersSince(account, since, partnerId, partnerKey, (count) => {
      sendEvent(clientId, { progress: Math.min(60, 20 + Math.floor(count / 10)), message: `[${nickname}] Lendo pedidos... ${count}`, type: 'info' });
    });

    if (orders.length === 0) {
      sendEvent(clientId, { progress: 100, message: `[${nickname}] Nenhum pedido novo encontrado.`, type: 'success', newSalesCount: 0 });
      return;
    }

    sendEvent(clientId, { progress: 65, message: `[${nickname}] Calculando custos e salvando ${orders.length} pedido(s)...`, type: 'info' });

    await fetchCostBySku(orders.map((o) => firstSkuOfOrder(o)).filter(Boolean), targetUid);

    let saved = 0;
    for (let i = 0; i < orders.length; i++) {
      try {
        const row = orderToRow(orders[i], account, nickname);
        row.uid = targetUid;
        await upsertRow(row);
        saved += 1;
      } catch (err) {
        console.warn(`[shopee-sync] erro ao salvar pedido ${orders[i]?.order_sn}:`, err.message);
      }
      if (i % 25 === 0 || i === orders.length - 1) {
        const pct = 65 + Math.floor(((i + 1) / orders.length) * 30);
        sendEvent(clientId, { progress: Math.min(95, pct), message: `[${nickname}] Salvando... ${i + 1}/${orders.length}`, type: 'info' });
      }
    }

    sendEvent(clientId, {
      progress: 100,
      message: `[${nickname}] Sincronização concluída. ${saved} pedido(s) salvos.`,
      type: 'success',
      newSalesCount: saved,
    });
  } catch (error) {
    console.error('[shopee-sync] erro:', error);
    sendEvent(clientId, { progress: 100, message: error.message || 'Erro na sincronização Shopee.', type: 'error' });
  }
});

router.get('/last-sync/:shopId', authenticateToken, async (req, res) => {
  try {
    const { shopId } = req.params;
    let targetUid = req.query.clientUid || req.user.uid;

    if (req.user.role === 'master' && !req.query.clientUid) {
      const owner = await db.query('SELECT uid FROM public.shopee_accounts WHERE shop_id = $1 LIMIT 1', [shopId]);
      if (owner.rowCount > 0) targetUid = owner.rows[0].uid;
    }

    const lastSyncRes = await db.query(
      'SELECT MAX(updated_at) AS last_sale FROM public.shopee_sales WHERE uid = $1 AND shop_id = $2',
      [targetUid, shopId]
    );
    const lastSync = lastSyncRes.rows[0]?.last_sale;
    res.json({ lastSync: lastSync ? lastSync.toISOString() : null, shopId, message: lastSync ? 'Última sincronização encontrada' : 'Nunca sincronizada' });
  } catch (error) {
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

/* -------------------------------- Vendas -------------------------------- */

router.get('/all', authenticateToken, requireMaster, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;
    const search = (req.query.search || '').trim();
    const account = (req.query.account || '').trim();

    const conditions = [];
    const params = [];
    let paramIdx = 1;

    if (search) {
      conditions.push(`(
        s.product_title ILIKE $${paramIdx}
        OR s.sku ILIKE $${paramIdx}
        OR s.account_nickname ILIKE $${paramIdx}
        OR u.name ILIKE $${paramIdx}
        OR s.order_sn ILIKE $${paramIdx}
      )`);
      params.push(`%${search}%`);
      paramIdx++;
    }
    if (account) {
      conditions.push(`(s.shop_id::text = $${paramIdx} OR s.account_nickname ILIKE $${paramIdx + 1})`);
      params.push(account, `%${account}%`);
      paramIdx += 2;
    }
    conditions.push(`COALESCE(u.active, true) = true`);

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const countResult = await db.query(
      `SELECT COUNT(*) as total FROM public.shopee_sales s LEFT JOIN public.users u ON s.uid = u.uid ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].total, 10);

    const dataResult = await db.query(
      `SELECT s.order_sn, s.sku, s.uid, s.shop_id, s.account_nickname, s.sale_date,
         s.product_title, s.quantity, s.unit_price, s.total_amount, s.platform_fee,
         s.freight, s.net_revenue, s.order_status, s.buyer_username, s.recipient_name,
         s.tracking_number, s.shipping_carrier, s.ship_by_date, s.shipping_status,
         s.raw_api_data, s.updated_at, s.processed_at, u.name as user_nickname,
         EXISTS (SELECT 1 FROM public.skus sk WHERE sk.user_id = s.uid AND UPPER(TRIM(sk.sku)) = UPPER(TRIM(s.sku)) AND sk.ativo = true) as is_sku_mapped,
         (SELECT sk.descricao FROM public.skus sk
            WHERE sk.user_id = s.uid AND UPPER(TRIM(sk.sku)) = UPPER(TRIM(s.sku))
              AND sk.descricao IS NOT NULL AND TRIM(sk.descricao) <> ''
            ORDER BY sk.ativo DESC LIMIT 1) AS sku_descricao
       FROM public.shopee_sales s
       LEFT JOIN public.users u ON s.uid = u.uid
       ${whereClause}
       ORDER BY s.sale_date DESC
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1};`,
      [...params, limit, offset]
    );

    res.json({ data: dataResult.rows, total, page, limit, totalPages: Math.ceil(total / limit) || 1 });
  } catch (error) {
    console.error('Erro ao buscar vendas Shopee (master):', error);
    res.status(500).json({ error: 'Erro interno ao buscar vendas Shopee.' });
  }
});

router.get('/user/:uid', authenticateToken, requireMaster, async (req, res) => {
  const { uid } = req.params;
  if (!uid) return res.status(400).json({ error: 'O UID do usuário é obrigatório.' });
  try {
    const { rows } = await db.query(
      `SELECT order_sn, sku, uid, shop_id, account_nickname, sale_date, product_title,
         quantity, unit_price, total_amount, platform_fee, freight, net_revenue,
         order_status, buyer_username, recipient_name, tracking_number, shipping_carrier,
         ship_by_date, shipping_status, raw_api_data, updated_at, processed_at
       FROM public.shopee_sales WHERE uid = $1 ORDER BY sale_date DESC LIMIT 250;`,
      [uid]
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Erro interno ao buscar vendas.' });
  }
});

router.get('/my-sales', authenticateToken, async (req, res) => {
  const { uid } = req.user;
  try {
    const { rows } = await db.query(
      `SELECT order_sn, sku, uid, shop_id, account_nickname, sale_date, product_title,
         quantity, unit_price, total_amount, platform_fee, freight, net_revenue,
         order_status, buyer_username, recipient_name, tracking_number, shipping_carrier,
         ship_by_date, shipping_status, raw_api_data, updated_at, processed_at
       FROM public.shopee_sales WHERE uid = $1 ORDER BY sale_date DESC LIMIT 250;`,
      [uid]
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Erro interno ao buscar vendas.' });
  }
});

/** Abatimento de estoque para pedidos Shopee — mesmo fluxo de /sales/process. */
router.post('/process', authenticateToken, requireMaster, async (req, res) => {
  const { salesToProcess } = req.body;
  if (!Array.isArray(salesToProcess) || salesToProcess.length === 0) {
    return res.status(400).json({ error: 'Nenhuma venda para processar.' });
  }

  const sanitized = salesToProcess.map((s) => ({
    orderSn: s.orderSn || s.id,
    sku: String(s.sku || '').trim(),
    uid: s.uid,
    quantity: Number(s.quantity || 0),
  }));

  const results = { success: [], failed: [] };
  const client = await db.pool.connect();

  try {
    for (const sale of sanitized) {
      try {
        if (!sale.orderSn || !sale.sku || !sale.uid || !sale.quantity) {
          throw new Error('Dados da venda incompletos (orderSn, sku, uid, quantity).');
        }

        await client.query('BEGIN');

        const skuR = await client.query(
          `SELECT id, quantidade, is_kit FROM public.skus
            WHERE UPPER(TRIM(sku)) = UPPER(TRIM($1)) AND user_id = $2 FOR UPDATE;`,
          [sale.sku, sale.uid]
        );
        if (skuR.rowCount === 0) throw new Error(`SKU '${sale.sku}' não encontrado.`);
        const stock = skuR.rows[0];

        if (stock.is_kit) {
          const kitComponents = await client.query(
            'SELECT child_sku_id, quantity_per_kit FROM public.sku_kit_components WHERE kit_sku_id = $1',
            [stock.id]
          );
          if (kitComponents.rows.length === 0) throw new Error(`Kit '${sale.sku}' não possui componentes configurados.`);

          for (const component of kitComponents.rows) {
            const childSku = await client.query('SELECT id, sku, quantidade FROM public.skus WHERE id = $1 FOR UPDATE', [component.child_sku_id]);
            if (childSku.rows.length === 0) throw new Error(`SKU filho não encontrado para o kit '${sale.sku}'.`);
            const required = component.quantity_per_kit * sale.quantity;
            if (childSku.rows[0].quantidade < required) {
              throw new Error(`Estoque insuficiente do SKU filho ${childSku.rows[0].sku}. Disponível: ${childSku.rows[0].quantidade}, Necessário: ${required}`);
            }
          }
          for (const component of kitComponents.rows) {
            const required = component.quantity_per_kit * sale.quantity;
            await client.query('UPDATE public.skus SET quantidade = quantidade - $1, updated_at = NOW() WHERE id = $2;', [required, component.child_sku_id]);
            await client.query(
              `INSERT INTO public.stock_movements (sku_id, user_id, movement_type, quantity_change, reason, related_sale_id)
               VALUES ($1, $2, 'saida', $3, $4, $5)`,
              [component.child_sku_id, sale.uid, required, `Saída por Kit (Shopee): Venda em Lote - Pedido ${sale.orderSn}`, null]
            );
          }
          await client.query(
            `INSERT INTO public.stock_movements (sku_id, user_id, movement_type, quantity_change, reason, related_sale_id)
             VALUES ($1, $2, 'saida', $3, $4, $5)`,
            [stock.id, sale.uid, sale.quantity, `Saída por Venda Shopee em Lote - Pedido ${sale.orderSn}`, null]
          );
        } else {
          if (Number(stock.quantidade) < Number(sale.quantity)) throw new Error(`Estoque insuficiente para SKU '${sale.sku}'.`);
          await client.query('UPDATE public.skus SET quantidade = quantidade - $1, updated_at = NOW() WHERE id = $2', [sale.quantity, stock.id]);
          await client.query(
            `INSERT INTO public.stock_movements (sku_id, user_id, movement_type, quantity_change, reason, related_sale_id)
             VALUES ($1, $2, 'saida', $3, $4, $5)`,
            [stock.id, sale.uid, sale.quantity, `Saída por Venda Shopee em Lote - Pedido ${sale.orderSn}`, null]
          );
        }

        const upd = await client.query(
          `UPDATE public.shopee_sales SET processed_at = COALESCE(processed_at, NOW()), updated_at = NOW()
            WHERE order_sn = $1 AND sku = $2 AND uid = $3 RETURNING order_sn;`,
          [sale.orderSn, sale.sku, sale.uid]
        );
        if (upd.rowCount === 0) throw new Error('Venda não pode ser atualizada.');

        await client.query('COMMIT');
        results.success.push({ orderSn: sale.orderSn, sku: sale.sku });
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
        results.failed.push({ orderSn: sale.orderSn, sku: sale.sku, reason: e.message });
      }
    }
    return res.json({ message: 'Processamento concluído.', ...results });
  } catch (error) {
    console.error('Erro crítico no processamento em lote (Shopee):', error);
    return res.status(500).json({ error: 'Erro crítico no processamento em lote.' });
  } finally {
    client.release();
  }
});

/** Atualiza o status de expedição de uma venda Shopee (equivalente a /sales/status). */
router.put('/status', authenticateToken, async (req, res) => {
  const { orderSn, sku, uid, shippingStatus } = req.body;
  if (!orderSn || !sku || !uid || !shippingStatus) {
    return res.status(400).json({ error: 'orderSn, sku, uid e shippingStatus são obrigatórios.' });
  }
  try {
    const { rowCount } = await db.query(
      'UPDATE public.shopee_sales SET shipping_status = $1, updated_at = NOW() WHERE order_sn = $2 AND sku = $3 AND uid = $4',
      [shippingStatus, orderSn, sku, uid]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Venda não encontrada.' });
    res.json({ message: 'Status atualizado com sucesso.' });
  } catch (error) {
    res.status(500).json({ error: 'Erro interno ao atualizar status.' });
  }
});

module.exports = router;
