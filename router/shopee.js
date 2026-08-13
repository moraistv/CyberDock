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

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://cyberdock.com.br';

// A Shopee valida o DOMÍNIO do redirect contra o "Redirect URL Domain"
// cadastrado no console do parceiro. O console da CyberDock declara
// cyberdock.com.br (domínio do frontend), não api.cyberdock.com.br, então o
// retorno da autorização precisa cair no FRONTEND. A página recebe `code` e
// `shop_id` e chama POST /api/shopee/connect para concluir a troca de tokens.
//
// Efeito colateral positivo: o vínculo com o usuário passa a vir do JWT no
// momento do connect, em vez de um mapa de `state` em memória — que se perdia
// a cada restart do servidor e quebraria com mais de uma instância.
const REDIRECT_URI = process.env.SHOPEE_REDIRECT_URI || `${FRONTEND_URL}/shopee/callback`;

/* --------------------------- SSE (mesmo padrão de /sales) --------------------------- */
const clients = {};
const pendingEvents = {};
/* Guarda os eventos enquanto ninguém está conectado.
 *
 * 60s era curto demais: se o SSE caía e a reconexão passava desse tempo, o
 * evento de progresso 100 era descartado e a loja ficava "sincronizando" para
 * sempre na tela. 5 minutos cobrem uma reconexão real sem acumular memória
 * (a chave é apagada assim que o cliente reconecta e consome a fila).
 */
const PENDING_TTL_MS = 5 * 60 * 1000;

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
    // Sem isto o nginx/proxy BUFFERIZA o stream: os eventos não chegam ao
    // navegador na hora e a conexão parece morta.
    'X-Accel-Buffering': 'no',
  });
  // Preenchimento inicial: alguns proxies só liberam a resposta após um bloco.
  res.write(': ok\n\n');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  /* Heartbeat.
   *
   * Uma carga completa de loja percorre janelas de 15 dias com chamadas de
   * lista, detalhe e escrow. Entre duas janelas o stream pode ficar em silêncio
   * por muito tempo, e proxy/balanceador encerra conexão ociosa — no navegador
   * isso virava "A conexão com o servidor foi perdida durante a sincronização
   * Shopee", mesmo com o trabalho seguindo normalmente no servidor.
   */
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 15000);

  clients[clientId] = { res, heartbeat };

  const buffered = pendingEvents[clientId];
  if (buffered) {
    if (buffered.timer) clearTimeout(buffered.timer);
    for (const ev of buffered.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    delete pendingEvents[clientId];
  } else {
    sendEvent(clientId, { progress: 5, message: 'Conexão estabelecida. Aguardando início...', type: 'info' });
  }

  req.on('close', () => {
    clearInterval(heartbeat);
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

  // Sem `state` na URL: a Shopee acrescenta ?code=..&shop_id=.. ao redirect, e
  // um query string já existente tornaria a montagem ambígua. A identidade do
  // usuário é resolvida no /connect, pelo JWT.
  console.log(`[Shopee Auth] Iniciando autenticação para UID: ${uid}`);
  console.log(`[Shopee Auth] Redirect: ${REDIRECT_URI}`);
  const authUrl = getShopeeAuthUrl(partnerId, partnerKey, REDIRECT_URI);
  res.redirect(authUrl);
});

/* ----------------------------- OAuth: Conclusão ---------------------------- */
/**
 * Conclui a conexão da loja. Chamado pelo FRONTEND (página /shopee/callback)
 * com o `code` e o `shop_id` que a Shopee devolveu, autenticado por JWT.
 */
router.post('/connect', authenticateToken, async (req, res) => {
  const { code, shopId } = req.body;
  const { uid } = req.user;

  if (!code || !shopId) {
    return res.status(400).json({ error: 'Parâmetros code e shopId são obrigatórios.' });
  }

  try {
    const { partnerId, partnerKey } = getShopeePartnerCredentials();
    if (!partnerId || !partnerKey) {
      return res.status(500).json({ error: 'Credenciais Shopee ausentes no servidor.' });
    }

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

    const label = shopName || tokens.shop_id;
    console.log(`[Shopee Connect] Loja ${label} conectada para UID ${uid}`);
    res.json({ message: `Loja Shopee ${label} conectada com sucesso!`, shopId: tokens.shop_id, shopName });
  } catch (error) {
    console.error('[Shopee Connect] Erro:', error);
    res.status(400).json({ error: error.message || 'Erro ao conectar loja Shopee.' });
  }
});

/**
 * Callback direto no backend. Mantido para o caso de o console da Shopee ser
 * configurado com o domínio da API; o fluxo padrão hoje passa pelo frontend.
 */
router.get('/callback', async (req, res) => {
  const { code, shop_id } = req.query;
  const shopId = shop_id || req.query.shopid;
  const target = `${FRONTEND_URL}/shopee/callback`;
  if (!code || !shopId) {
    return res.redirect(`${FRONTEND_URL}/contas?error=${encodeURIComponent('Autorização Shopee falhou: code ou shop_id ausente.')}`);
  }
  // Repassa para a página do frontend, que tem a sessão para concluir.
  res.redirect(`${target}?code=${encodeURIComponent(code)}&shop_id=${encodeURIComponent(shopId)}`);
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

/**
 * Todas as lojas Shopee ativas do sistema (visão master).
 *
 * Equivalente ao /ml/all-accounts: o "Sincronizar Tudo" do painel admin
 * precisa varrer os DOIS canais. Sem esta rota, o botão global sincronizava
 * apenas Mercado Livre e as vendas Shopee só entravam quando o próprio
 * cliente sincronizava na tela dele.
 *
 * Traz o `uid` do dono porque a sincronização master roda em nome do cliente
 * (clientUid), e apenas lojas de usuários ativos, para não gastar chamadas de
 * API com conta desativada.
 */
router.get('/all-accounts', authenticateToken, requireMaster, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT sa.shop_id, sa.shop_name, sa.uid, u.name AS user_name
        FROM public.shopee_accounts sa
        LEFT JOIN public.users u ON sa.uid = u.uid
       WHERE sa.status = 'active'
         AND COALESCE(u.active, true) = true
       ORDER BY u.name NULLS LAST, sa.shop_name
    `);
    res.json(rows);
  } catch (error) {
    console.error('Erro ao listar todas as lojas Shopee:', error);
    res.status(500).json({ error: 'Erro interno ao listar as lojas Shopee.' });
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

/**
 * create_time da Shopee (epoch UTC) → instante real.
 *
 * ATENÇÃO ao histórico: antes daqui saía um "wall clock de São Paulo",
 * subtraindo 3h antes de gravar. Isso vem do projeto V2, onde a coluna
 * data_venda é `timestamp WITHOUT time zone` — lá o valor ingênuo é exibido e
 * filtrado direto, sem conversão.
 *
 * Aqui a coluna é `TIMESTAMP WITH TIME ZONE`, que guarda instante absoluto.
 * Subtrair 3h antes de gravar fazia o Postgres armazenar um instante 3h no
 * passado e o navegador aplicar o fuso DE NOVO: a venda aparecia 3h mais cedo
 * e, entre 00:00 e 02:59, caía no dia anterior (D-1).
 *
 * Os filtros desta base (`T00:00:00-03:00`) e o Dashboard
 * (`AT TIME ZONE 'America/Sao_Paulo'`) já tratam a coluna como instante real,
 * então o instante verdadeiro é a convenção correta — e é o que `ship_by_date`
 * sempre usou.
 */
function toSaleInstant(epochSecondsUtc) {
  return new Date(epochSecondsUtc * 1000);
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
async function fetchWindowOrders(account, from, to, partnerId, partnerKey, timeRangeField = 'create_time') {
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
          timeRangeField,
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
async function fetchOrdersSince(account, since, partnerId, partnerKey, onProgress, timeRangeField = 'create_time') {
  const all = [];
  const MAX_ORDERS_PER_SHOP = 10000;
  const now = new Date();
  let windowStart = since;
  while (windowStart < now && all.length < MAX_ORDERS_PER_SHOP) {
    const windowEnd = new Date(Math.min(windowStart.getTime() + MAX_WINDOW_DAYS * 86400000, now.getTime()));
    const orders = await fetchWindowOrders(account, windowStart, windowEnd, partnerId, partnerKey, timeRangeField);
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

/** SKU normalizado de um item Shopee. */
function skuOfItem(item, orderSn) {
  const skuRaw = item?.item_sku || item?.model_sku || item?.variation_sku;
  if (skuRaw) return truncate(String(skuRaw).trim(), 255);

  // Pedidos sem SKU cadastrado ainda precisam de uma chave estável por item,
  // sem colapsar todos os produtos do pedido na mesma linha.
  const fallback = [item?.item_id, item?.model_id].filter(Boolean).join('-');
  return truncate(fallback || String(orderSn), 255);
}

function quantityOfItem(item) {
  const value =
    toFiniteNumber(item?.model_quantity_purchased) ??
    toFiniteNumber(item?.quantity_purchased) ??
    toFiniteNumber(item?.quantity) ??
    1;
  return Math.max(1, Math.trunc(value));
}

function unitValueOfItem(item, fallback = 0) {
  return (
    toFiniteNumber(item?.model_discounted_price) ??
    toFiniteNumber(item?.discounted_price) ??
    toFiniteNumber(item?.model_original_price) ??
    toFiniteNumber(item?.original_price) ??
    toFiniteNumber(item?.price) ??
    fallback
  );
}

/**
 * Mapeia um pedido para uma linha por SKU. A chave de shopee_sales já é
 * (order_sn, sku, uid), então itens repetidos do mesmo SKU são agrupados.
 * Valores financeiros do pedido são rateados proporcionalmente, preservando
 * exatamente os totais na soma das linhas (o resíduo fica na última linha).
 */
function orderToRows(order, account, nickname) {
  const orderSn = String(order.order_sn);
  const dataVenda = toSaleInstant(toFiniteNumber(order.create_time) ?? 0);
  const itemList = Array.isArray(order.item_list) && order.item_list.length
    ? order.item_list
    : [{}];
  const fin = calculateShopeeFinancials(order);
  const grouped = new Map();

  for (const item of itemList) {
    const sku = skuOfItem(item, orderSn);
    const key = sku.toUpperCase().trim();
    const quantity = quantityOfItem(item);
    const unitValue = unitValueOfItem(item, fin.unitPrice || 0);
    const current = grouped.get(key) || {
      sku,
      quantity: 0,
      baseValue: 0,
      title: truncate(item?.item_name || item?.model_name, 500) || 'Pedido',
      item,
    };
    current.quantity += quantity;
    current.baseValue += Math.max(0, unitValue * quantity);
    grouped.set(key, current);
  }

  const groups = Array.from(grouped.values());
  const totalBase = groups.reduce((sum, group) => sum + group.baseValue, 0);
  const totalQuantity = groups.reduce((sum, group) => sum + group.quantity, 0) || 1;
  const allocated = { totalAmount: 0, platformFee: 0, freight: 0, netRevenue: 0 };

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

  const allocate = (total, key, weight, isLast) => {
    if (total === null || total === undefined) return null;
    const value = isLast
      ? roundCurrency(total - allocated[key])
      : roundCurrency(total * weight);
    allocated[key] = roundCurrency(allocated[key] + value);
    return value;
  };

  return groups.map((group, index) => {
    const isLast = index === groups.length - 1;
    const weight = totalBase > 0
      ? group.baseValue / totalBase
      : group.quantity / totalQuantity;
    const totalAmount = allocate(fin.effectiveProductSubtotal, 'totalAmount', weight, isLast) || 0;
    const platformFee = allocate(fin.platformFee, 'platformFee', weight, isLast);
    const freight = allocate(fin.freight, 'freight', weight, isLast) || 0;
    const netRevenue = allocate(fin.netRevenue, 'netRevenue', weight, isLast) || 0;

    return {
      orderSn,
      sku: group.sku,
      uid: account.uid,
      shopId: account.shopId,
      accountNickname: nickname,
      saleDate: dataVenda,
      productTitle: group.title,
      quantity: group.quantity,
      unitPrice: roundCurrency(totalAmount / group.quantity),
      totalAmount,
      platformFee,
      freight,
      netRevenue,
      orderStatus: String(order.order_status || 'DESCONHECIDO'),
      buyerUsername: comprador,
      recipientName,
      trackingNumber,
      shippingCarrier,
      shipByDate,
      rawApiData: {
        ...order,
        synced_item: group.item,
        paymentDetails: paymentDetailsExtended,
        shipmentDetails: shipmentDetailsExtended,
      },
    };
  });
}

const UPSERT_QUERY = `
  INSERT INTO public.shopee_sales (
    order_sn, sku, uid, shop_id, account_nickname, sale_date, product_title,
    quantity, unit_price, total_amount, platform_fee, freight, net_revenue,
    order_status, buyer_username, recipient_name, tracking_number,
    shipping_carrier, ship_by_date, raw_api_data, updated_at
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,NOW())
  ON CONFLICT (order_sn, sku, uid) DO UPDATE SET
    account_nickname = EXCLUDED.account_nickname,
    sale_date        = EXCLUDED.sale_date,
    product_title    = CASE WHEN public.shopee_sales.processed_at IS NULL THEN EXCLUDED.product_title ELSE public.shopee_sales.product_title END,
    quantity         = CASE WHEN public.shopee_sales.processed_at IS NULL THEN EXCLUDED.quantity ELSE public.shopee_sales.quantity END,
    unit_price       = CASE WHEN public.shopee_sales.processed_at IS NULL THEN EXCLUDED.unit_price ELSE public.shopee_sales.unit_price END,
    total_amount     = CASE WHEN public.shopee_sales.processed_at IS NULL THEN EXCLUDED.total_amount ELSE public.shopee_sales.total_amount END,
    platform_fee     = CASE WHEN public.shopee_sales.processed_at IS NULL THEN EXCLUDED.platform_fee ELSE public.shopee_sales.platform_fee END,
    freight          = CASE WHEN public.shopee_sales.processed_at IS NULL THEN EXCLUDED.freight ELSE public.shopee_sales.freight END,
    net_revenue      = CASE WHEN public.shopee_sales.processed_at IS NULL THEN EXCLUDED.net_revenue ELSE public.shopee_sales.net_revenue END,
    order_status     = EXCLUDED.order_status,
    buyer_username   = EXCLUDED.buyer_username,
    recipient_name   = EXCLUDED.recipient_name,
    tracking_number  = EXCLUDED.tracking_number,
    shipping_carrier = EXCLUDED.shipping_carrier,
    ship_by_date     = EXCLUDED.ship_by_date,
    raw_api_data     = EXCLUDED.raw_api_data,
    updated_at       = NOW()
  WHERE public.shopee_sales.processed_at IS NULL
     OR public.shopee_sales.order_status IS DISTINCT FROM EXCLUDED.order_status
  RETURNING (xmax = 0) AS inserted;
`;

async function upsertRow(row) {
  const result = await db.query(UPSERT_QUERY, [
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

  if (result.rowCount === 0) return 'skipped';
  return result.rows[0].inserted ? 'inserted' : 'updated';
}

/**
 * Pedidos antigos que já baixaram estoque nunca recebem novas linhas de SKU.
 * Atualizamos apenas metadados operacionais das linhas existentes e mantemos o
 * item originalmente associado a cada linha no payload.
 */
async function updateProcessedOrder(orderSn, uid, row) {
  const result = await db.query(
    `UPDATE public.shopee_sales
        SET account_nickname = $3,
            order_status = $4,
            buyer_username = $5,
            recipient_name = $6,
            tracking_number = $7,
            shipping_carrier = $8,
            ship_by_date = $9,
            raw_api_data = jsonb_set(
              $10::jsonb,
              '{synced_item}',
              COALESCE(
                public.shopee_sales.raw_api_data->'synced_item',
                public.shopee_sales.raw_api_data->'item_list'->0,
                'null'::jsonb
              ),
              TRUE
            ),
            updated_at = NOW()
      WHERE order_sn = $1
        AND uid = $2
        AND processed_at IS NOT NULL`,
    [
      orderSn,
      uid,
      row.accountNickname,
      row.orderStatus,
      row.buyerUsername,
      row.recipientName,
      row.trackingNumber,
      row.shippingCarrier,
      row.shipByDate,
      JSON.stringify(row.rawApiData),
    ]
  );
  return result.rowCount;
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

    // Primeira sincronização percorre pedidos por data de criação. As próximas
    // usam update_time remoto a partir do instante da última gravação local,
    // com 24h de sobreposição para absorver atrasos e diferenças de relógio.
    const lastRes = await db.query(
      `SELECT
         MAX(updated_at) AS last_sync,
         MIN(sale_date) FILTER (
           WHERE CASE
                   WHEN jsonb_typeof(raw_api_data->'item_list') = 'array'
                   THEN jsonb_array_length(raw_api_data->'item_list') > 1
                   ELSE FALSE
                 END
             AND NOT (raw_api_data ? 'synced_item')
         ) AS legacy_since
       FROM public.shopee_sales
       WHERE uid = $1 AND shop_id = $2`,
      [targetUid, shopId]
    );
    const lastSync = lastRes.rows[0]?.last_sync ? new Date(lastRes.rows[0].last_sync) : null;
    const legacySince = lastRes.rows[0]?.legacy_since ? new Date(lastRes.rows[0].legacy_since) : null;
    let since;
    let timeRangeField;
    if (force || !lastSync || legacySince) {
      since = legacySince
        ? new Date(legacySince.getTime() - 24 * 60 * 60 * 1000)
        : new Date('2024-01-01T00:00:00.000Z');
      timeRangeField = 'create_time';
      const message = legacySince
        ? `[${nickname}] Atualizando pedidos antigos com múltiplos itens...`
        : `[${nickname}] Sincronização completa iniciada...`;
      sendEvent(clientId, { progress: 20, message, type: 'info' });
    } else {
      since = new Date(lastSync.getTime() - 24 * 60 * 60 * 1000);
      timeRangeField = 'update_time';
      sendEvent(clientId, { progress: 20, message: `[${nickname}] Buscando pedidos novos e atualizados...`, type: 'info' });
    }

    const orders = await fetchOrdersSince(account, since, partnerId, partnerKey, (count) => {
      sendEvent(clientId, { progress: Math.min(60, 20 + Math.floor(count / 10)), message: `[${nickname}] Lendo pedidos... ${count}`, type: 'info' });
    }, timeRangeField);

    if (orders.length === 0) {
      sendEvent(clientId, {
        progress: 100,
        message: `[${nickname}] Nenhum pedido novo encontrado.`,
        type: 'success',
        newSalesCount: 0,
        updatedCount: 0,
        skippedCount: 0,
      });
      return;
    }

    sendEvent(clientId, { progress: 65, message: `[${nickname}] Calculando custos e salvando ${orders.length} pedido(s)...`, type: 'info' });

    // Consulta única evita N+1 e, principalmente, impede que a nova expansão
    // multi-item crie linhas não processadas em pedidos históricos cujo estoque
    // já foi abatido quando existia apenas a primeira linha.
    const orderSns = [...new Set(orders.map((order) => String(order.order_sn)).filter(Boolean))];
    const processedResult = await db.query(
      `SELECT DISTINCT order_sn
         FROM public.shopee_sales
        WHERE uid = $1
          AND shop_id = $2
          AND processed_at IS NOT NULL
          AND order_sn = ANY($3::text[])`,
      [targetUid, shopId, orderSns]
    );
    const historicallyProcessed = new Set(processedResult.rows.map((row) => String(row.order_sn)));

    let insertedItems = 0;
    let updatedItems = 0;
    let skippedItems = 0;
    let savedOrders = 0;

    for (let i = 0; i < orders.length; i++) {
      try {
        const rows = orderToRows(orders[i], account, nickname);
        for (const row of rows) row.uid = targetUid;

        if (historicallyProcessed.has(String(orders[i].order_sn))) {
          // Nunca insere os SKUs recém-descobertos desse pedido. Só refresca
          // status, rastreio e payload das linhas que já existem.
          const affected = await updateProcessedOrder(String(orders[i].order_sn), targetUid, rows[0]);
          updatedItems += affected;
          skippedItems += Math.max(0, rows.length - affected);
        } else {
          for (const row of rows) {
            const outcome = await upsertRow(row);
            if (outcome === 'inserted') insertedItems += 1;
            else if (outcome === 'updated') updatedItems += 1;
            else skippedItems += 1;
          }
        }
        savedOrders += 1;
      } catch (err) {
        console.warn(`[shopee-sync] erro ao salvar pedido ${orders[i]?.order_sn}:`, err.message);
        skippedItems += 1;
      }

      if (i % 25 === 0 || i === orders.length - 1) {
        const pct = 65 + Math.floor(((i + 1) / orders.length) * 30);
        sendEvent(clientId, {
          progress: Math.min(95, pct),
          message: `[${nickname}] Salvando... ${i + 1}/${orders.length}`,
          type: 'info',
          newSalesCount: insertedItems,
          updatedCount: updatedItems,
          skippedCount: skippedItems,
        });
      }
    }

    sendEvent(clientId, {
      progress: 100,
      message: `[${nickname}] Sincronização concluída. ${savedOrders} pedido(s), ${insertedItems} item(ns) novo(s) e ${updatedItems} atualizado(s).`,
      type: 'success',
      newSalesCount: insertedItems,
      updatedCount: updatedItems,
      skippedCount: skippedItems,
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

/** Abatimento de estoque para pedidos Shopee — mesmo fluxo seguro de /sales/process. */
router.post('/process', authenticateToken, requireMaster, async (req, res) => {
  const { salesToProcess } = req.body;
  const MAX_PROCESS_BATCH = 500;

  if (!Array.isArray(salesToProcess) || salesToProcess.length === 0) {
    return res.status(400).json({ error: 'Nenhuma venda para processar.' });
  }
  if (salesToProcess.length > MAX_PROCESS_BATCH) {
    return res.status(400).json({ error: `O lote excede o limite de ${MAX_PROCESS_BATCH} vendas.` });
  }

  // Quantidade enviada pelo navegador é deliberadamente ignorada. A fonte
  // autoritativa é a linha bloqueada em public.shopee_sales.
  const sanitized = salesToProcess.map((sale) => ({
    orderSn: String(sale.orderSn || sale.id || '').trim(),
    sku: String(sale.sku || '').trim(),
    uid: String(sale.uid || '').trim(),
  }));

  const results = { success: [], failed: [] };
  const client = await db.pool.connect();

  try {
    for (const requestedSale of sanitized) {
      try {
        if (!requestedSale.orderSn || !requestedSale.sku || !requestedSale.uid) {
          throw new Error('Dados da venda incompletos (orderSn, sku e uid).');
        }

        await client.query('BEGIN');

        // O lock da venda vem antes do estoque. Duas requisições concorrentes
        // para o mesmo item ficam serializadas e só uma delas efetua a baixa.
        const saleResult = await client.query(
          `SELECT order_sn, sku, uid, quantity, processed_at
             FROM public.shopee_sales
            WHERE order_sn = $1
              AND UPPER(TRIM(sku)) = UPPER(TRIM($2))
              AND uid = $3
            FOR UPDATE`,
          [requestedSale.orderSn, requestedSale.sku, requestedSale.uid]
        );
        if (saleResult.rowCount === 0) throw new Error('Venda Shopee não encontrada.');
        if (saleResult.rowCount > 1) throw new Error(`A venda possui SKU duplicado normalizado: '${requestedSale.sku}'.`);

        const sale = saleResult.rows[0];
        if (sale.processed_at) {
          await client.query('COMMIT');
          results.success.push({
            orderSn: sale.order_sn,
            sku: sale.sku,
            alreadyProcessed: true,
          });
          continue;
        }

        const quantity = Number(sale.quantity);
        if (!Number.isInteger(quantity) || quantity <= 0) {
          throw new Error(`Quantidade inválida registrada para o SKU '${sale.sku}'.`);
        }

        const skuResult = await client.query(
          `SELECT id, sku, quantidade, is_kit
             FROM public.skus
            WHERE UPPER(TRIM(sku)) = UPPER(TRIM($1))
              AND user_id = $2
              AND ativo = TRUE
            ORDER BY id
            LIMIT 2
            FOR UPDATE`,
          [sale.sku, sale.uid]
        );
        if (skuResult.rowCount === 0) throw new Error(`SKU ativo '${sale.sku}' não encontrado no armazenamento.`);
        if (skuResult.rowCount > 1) throw new Error(`Há mais de um SKU ativo normalizado como '${sale.sku}'.`);
        const stock = skuResult.rows[0];

        if (stock.is_kit) {
          const componentsResult = await client.query(
            `SELECT kc.child_sku_id, kc.quantity_per_kit,
                    child.sku, child.quantidade, child.ativo
               FROM public.sku_kit_components kc
               JOIN public.skus child ON child.id = kc.child_sku_id
              WHERE kc.kit_sku_id = $1
              ORDER BY child.id
              FOR UPDATE OF child`,
            [stock.id]
          );
          if (componentsResult.rowCount === 0) {
            throw new Error(`Kit '${sale.sku}' não possui componentes configurados.`);
          }

          for (const component of componentsResult.rows) {
            if (!component.ativo) throw new Error(`SKU filho '${component.sku}' está inativo.`);
            const required = Number(component.quantity_per_kit) * quantity;
            if (Number(component.quantidade) < required) {
              throw new Error(`Estoque insuficiente do SKU filho ${component.sku}. Disponível: ${component.quantidade}, necessário: ${required}.`);
            }
          }

          for (const component of componentsResult.rows) {
            const required = Number(component.quantity_per_kit) * quantity;
            await client.query(
              'UPDATE public.skus SET quantidade = quantidade - $1, updated_at = NOW() WHERE id = $2',
              [required, component.child_sku_id]
            );
            await client.query(
              `INSERT INTO public.stock_movements
                 (sku_id, user_id, movement_type, quantity_change, reason, related_sale_id, external_sale_id)
               VALUES ($1, $2, 'saida', $3, $4, NULL, $5)`,
              [component.child_sku_id, sale.uid, required, `Saída por Kit (Shopee) - Pedido ${sale.order_sn}`, sale.order_sn]
            );
          }

          // O movimento do kit registra a quantidade comercial processada; o
          // estoque físico é abatido exclusivamente dos componentes acima.
          await client.query(
            `INSERT INTO public.stock_movements
               (sku_id, user_id, movement_type, quantity_change, reason, related_sale_id, external_sale_id)
             VALUES ($1, $2, 'saida', $3, $4, NULL, $5)`,
            [stock.id, sale.uid, quantity, `Saída por Venda Shopee - Pedido ${sale.order_sn}`, sale.order_sn]
          );
        } else {
          if (Number(stock.quantidade) < quantity) {
            throw new Error(`Estoque insuficiente para SKU '${sale.sku}'. Disponível: ${stock.quantidade}, necessário: ${quantity}.`);
          }
          await client.query(
            'UPDATE public.skus SET quantidade = quantidade - $1, updated_at = NOW() WHERE id = $2',
            [quantity, stock.id]
          );
          await client.query(
            `INSERT INTO public.stock_movements
               (sku_id, user_id, movement_type, quantity_change, reason, related_sale_id, external_sale_id)
             VALUES ($1, $2, 'saida', $3, $4, NULL, $5)`,
            [stock.id, sale.uid, quantity, `Saída por Venda Shopee - Pedido ${sale.order_sn}`, sale.order_sn]
          );
        }

        const updateResult = await client.query(
          `UPDATE public.shopee_sales
              SET processed_at = NOW(), updated_at = NOW()
            WHERE order_sn = $1
              AND UPPER(TRIM(sku)) = UPPER(TRIM($2))
              AND uid = $3
              AND processed_at IS NULL
          RETURNING order_sn, sku, processed_at`,
          [sale.order_sn, sale.sku, sale.uid]
        );
        if (updateResult.rowCount !== 1) throw new Error('Venda não pôde ser marcada como processada.');

        await client.query('COMMIT');
        results.success.push({ orderSn: sale.order_sn, sku: sale.sku, alreadyProcessed: false });
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* transação já encerrada */ }
        results.failed.push({
          orderSn: requestedSale.orderSn,
          sku: requestedSale.sku,
          reason: error.message,
        });
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
