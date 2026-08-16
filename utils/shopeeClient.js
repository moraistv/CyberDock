// utils/shopeeClient.js
//
// Cliente para a Shopee Open Platform API v2.
// Portado de v2/src/lib/shopee.ts (Next.js/Prisma) para CommonJS puro,
// usando node-fetch (já usado em todo o backend) em vez de fetch nativo.
//
// Diferença de autenticação em relação ao Mercado Livre (OAuth Bearer):
//   - App parceiro: partner_id + partner_key
//   - Toda chamada exige um `sign` HMAC-SHA256:
//       partner_id + path + timestamp [+ access_token + shop_id]
//   - Cada LOJA (shop_id) tem seu próprio access_token/refresh_token.
//
// Host: https://partner.shopeemobile.com

const crypto = require('crypto');
const fetch = require('node-fetch');
const db = require('./postgres');

const SHOPEE_HOST = 'https://partner.shopeemobile.com';

function readIntEnv(name, fallback, min, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  const value = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(max, Math.max(min, value));
}

const SHOPEE_HTTP_TIMEOUT_MS = readIntEnv('SHOPEE_HTTP_TIMEOUT_MS', 30000, 1000, 120000);
const SHOPEE_HTTP_RETRIES = readIntEnv('SHOPEE_HTTP_RETRIES', 2, 0, 5);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Todas as chamadas à Shopee passam por aqui. Nenhuma requisição pode ficar
 * pendurada indefinidamente; timeout, 429 e 5xx são repetidos com backoff e
 * jitter. Erros funcionais 4xx não são repetidos.
 */
async function fetchShopee(url, options = {}, operation = 'requisição', maxRetries = SHOPEE_HTTP_RETRIES, deadlineAt = Infinity) {
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      const deadlineError = new Error(`Shopee ${operation}: prazo total da sincronização excedido.`);
      deadlineError.code = 'SHOPEE_JOB_TIMEOUT';
      throw deadlineError;
    }

    const attemptTimeoutMs = Math.min(SHOPEE_HTTP_TIMEOUT_MS, remainingMs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);

    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const text = await response.text();
      let payload = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          const malformed = new Error(`Shopee ${operation}: resposta JSON inválida (HTTP ${response.status}).`);
          malformed.retryable = response.status === 429 || response.status >= 500;
          throw malformed;
        }
      }

      if (!response.ok) {
        const detail = payload?.message || payload?.error || response.statusText;
        const httpError = new Error(`Shopee ${operation}: HTTP ${response.status}${detail ? ` - ${detail}` : ''}`);
        httpError.status = response.status;
        httpError.retryable = response.status === 429 || response.status >= 500;
        throw httpError;
      }

      // A Shopee também sinaliza indisponibilidade/limite em payload HTTP 200.
      const apiCode = String(payload?.error || '').toLowerCase();
      if (apiCode && /(system|internal|busy|timeout|too_many|rate_limit)/.test(apiCode)) {
        const transient = new Error(`Shopee ${operation}: ${payload.message || payload.error}`);
        transient.code = 'SHOPEE_TRANSIENT_API_ERROR';
        transient.shopeeCode = payload.error;
        transient.retryable = true;
        throw transient;
      }

      if (payload === null) {
        const empty = new Error(`Shopee ${operation}: resposta vazia.`);
        empty.code = 'SHOPEE_INVALID_RESPONSE';
        empty.retryable = true;
        throw empty;
      }
      return payload;
    } catch (error) {
      const timedOut = error?.name === 'AbortError';
      if (timedOut) {
        lastError = new Error(`Shopee ${operation}: tempo limite de ${Math.ceil(attemptTimeoutMs / 1000)}s excedido.`);
        lastError.code = Date.now() >= deadlineAt ? 'SHOPEE_JOB_TIMEOUT' : 'SHOPEE_TIMEOUT';
        lastError.retryable = Date.now() < deadlineAt;
      } else {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (lastError.retryable === undefined) lastError.retryable = !lastError.status;
      }
    } finally {
      clearTimeout(timer);
    }

    if (!lastError.retryable || attempt >= maxRetries) break;
    const backoff = Math.min(8000, 750 * (2 ** attempt)) + Math.floor(Math.random() * 350);
    if (Date.now() + backoff >= deadlineAt) break;
    await sleep(backoff);
  }

  throw lastError;
}

function assertShopeeSuccess(payload, operation) {
  if (payload?.error) {
    const error = new Error(`Shopee ${operation}: ${payload.message || payload.error}`);
    error.code = 'SHOPEE_API_ERROR';
    error.shopeeCode = payload.error;
    throw error;
  }
  return payload;
}

function getShopeePartnerCredentials() {
  return {
    partnerId: process.env.SHOPEE_PARTNER_ID || '',
    partnerKey: process.env.SHOPEE_PARTNER_KEY || '',
  };
}

/** URL de autorização: o dono da loja faz login na Shopee e autoriza o app. */
function getShopeeAuthUrl(partnerId, partnerKey, redirectUrl) {
  const path = '/api/v2/shop/auth_partner';
  const timestamp = Math.floor(Date.now() / 1000);
  const baseString = `${partnerId}${path}${timestamp}`;
  const sign = crypto.createHmac('sha256', partnerKey).update(baseString).digest('hex');

  const url = new URL(`${SHOPEE_HOST}${path}`);
  url.searchParams.append('partner_id', partnerId);
  url.searchParams.append('timestamp', timestamp.toString());
  url.searchParams.append('sign', sign);
  url.searchParams.append('redirect', redirectUrl);
  return url.toString();
}

/** Assinatura para chamadas de API escopadas a uma loja (shop-scoped). */
function generateShopeeSign(partnerId, partnerKey, path, accessToken, shopId, timestamp) {
  const baseString = `${partnerId}${path}${timestamp}${accessToken}${shopId}`;
  return crypto.createHmac('sha256', partnerKey).update(baseString).digest('hex');
}

/** Troca o `code` do OAuth (callback) pelos tokens da loja. */
async function exchangeShopeeCode(code, shopId, partnerId, partnerKey) {
  const path = '/api/v2/auth/token/get';
  const ts = Math.floor(Date.now() / 1000);
  const baseString = `${partnerId}${path}${ts}`;
  const sign = crypto.createHmac('sha256', partnerKey).update(baseString).digest('hex');

  const url = `${SHOPEE_HOST}${path}?partner_id=${partnerId}&timestamp=${ts}&sign=${sign}`;
  const body = { code, shop_id: Number(shopId), partner_id: Number(partnerId) };

  const payload = assertShopeeSuccess(
    await fetchShopee(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 'obter token', 0),
    'obter token'
  );
  return {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    expire_in: payload.expire_in,
    shop_id: String(payload.shop_id ?? shopId),
    merchant_id: payload.merchant_id ? String(payload.merchant_id) : null,
  };
}

/** Renova o access_token de uma loja e persiste no banco. */
async function refreshShopeeToken(account, partnerId, partnerKey) {
  const path = '/api/v2/auth/access_token/get';
  const timestamp = Math.floor(Date.now() / 1000);
  const baseString = `${partnerId}${path}${timestamp}`;
  const sign = crypto.createHmac('sha256', partnerKey).update(baseString).digest('hex');

  const url = `${SHOPEE_HOST}${path}?partner_id=${partnerId}&timestamp=${timestamp}&sign=${sign}`;
  const body = {
    refresh_token: account.refreshToken,
    partner_id: Number(partnerId),
    shop_id: Number(account.shopId),
  };

  const data = assertShopeeSuccess(
    await fetchShopee(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 'renovar token', 0, account.deadlineAt || Infinity),
    'refresh token'
  );

  const expiresAt = new Date(Date.now() + (data.expire_in - 300) * 1000); // 5 min de margem
  await db.query(
    `UPDATE public.shopee_accounts
        SET access_token = $1, refresh_token = $2, expires_at = $3, status = 'active', updated_at = NOW()
      WHERE uid = $4 AND shop_id = $5`,
    [data.access_token, data.refresh_token, expiresAt, account.uid, account.shopId]
  );

  return { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: expiresAt };
}

/** Nome de exibição da loja. */
async function getShopeeShopName(shopId, accessToken, partnerId, partnerKey) {
  try {
    const path = '/api/v2/shop/get_shop_info';
    const ts = Math.floor(Date.now() / 1000);
    const sign = generateShopeeSign(partnerId, partnerKey, path, accessToken, shopId, ts);
    const url = `${SHOPEE_HOST}${path}?partner_id=${partnerId}&timestamp=${ts}&access_token=${accessToken}&shop_id=${shopId}&sign=${sign}`;
    const data = assertShopeeSuccess(await fetchShopee(url, {}, 'consultar loja'), 'getShopInfo');
    return data?.shop_name ?? data?.response?.shop_name ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Endpoints de pedidos
// ---------------------------------------------------------------------------

async function getShopeeOrderList(p) {
  const path = '/api/v2/order/get_order_list';
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = generateShopeeSign(p.partnerId, p.partnerKey, path, p.accessToken, p.shopId, timestamp);

  const url = new URL(`${SHOPEE_HOST}${path}`);
  url.searchParams.append('partner_id', p.partnerId);
  url.searchParams.append('timestamp', timestamp.toString());
  url.searchParams.append('access_token', p.accessToken);
  url.searchParams.append('shop_id', p.shopId);
  url.searchParams.append('sign', sign);
  url.searchParams.append('time_range_field', p.timeRangeField || 'create_time');
  url.searchParams.append('time_from', p.createTimeFrom.toString());
  url.searchParams.append('time_to', p.createTimeTo.toString());
  url.searchParams.append('page_size', p.pageSize.toString());
  if (p.cursor) url.searchParams.append('cursor', p.cursor);

  const data = assertShopeeSuccess(
    await fetchShopee(url.toString(), {}, 'listar pedidos', SHOPEE_HTTP_RETRIES, p.deadlineAt || Infinity),
    'getOrderList'
  );
  if (!data.response || !Array.isArray(data.response.order_list) || typeof data.response.more !== 'boolean') {
    const error = new Error('Shopee getOrderList: formato de resposta inválido.');
    error.code = 'SHOPEE_INVALID_RESPONSE';
    throw error;
  }
  if (data.response.more && !data.response.next_cursor) {
    const error = new Error('Shopee getOrderList: paginação incompleta (next_cursor ausente).');
    error.code = 'SHOPEE_INVALID_RESPONSE';
    throw error;
  }
  return data.response;
}

async function getShopeeOrderDetail(p) {
  const path = '/api/v2/order/get_order_detail';
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = generateShopeeSign(p.partnerId, p.partnerKey, path, p.accessToken, p.shopId, timestamp);

  const url = new URL(`${SHOPEE_HOST}${path}`);
  url.searchParams.append('partner_id', p.partnerId);
  url.searchParams.append('timestamp', timestamp.toString());
  url.searchParams.append('access_token', p.accessToken);
  url.searchParams.append('shop_id', p.shopId);
  url.searchParams.append('sign', sign);
  url.searchParams.append('order_sn_list', p.orderSnList);
  url.searchParams.append(
    'response_optional_fields',
    p.responseOptionalFields ||
      'buyer_user_id,buyer_username,recipient_address,estimated_shipping_fee,actual_shipping_fee,item_list,total_amount,package_list,shipping_carrier,create_time,order_status,ship_by_date,days_to_ship'
  );

  const data = assertShopeeSuccess(
    await fetchShopee(url.toString(), {}, 'detalhar pedidos', SHOPEE_HTTP_RETRIES, p.deadlineAt || Infinity),
    'getOrderDetail'
  );
  if (!data.response || !Array.isArray(data.response.order_list)) {
    const error = new Error('Shopee getOrderDetail: formato de resposta inválido.');
    error.code = 'SHOPEE_INVALID_RESPONSE';
    throw error;
  }
  return data.response;
}

async function getShopeeEscrowDetail(p) {
  const path = '/api/v2/payment/get_escrow_detail';
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = generateShopeeSign(p.partnerId, p.partnerKey, path, p.accessToken, p.shopId, timestamp);

  const url = new URL(`${SHOPEE_HOST}${path}`);
  url.searchParams.append('partner_id', p.partnerId);
  url.searchParams.append('timestamp', timestamp.toString());
  url.searchParams.append('access_token', p.accessToken);
  url.searchParams.append('shop_id', p.shopId);
  url.searchParams.append('sign', sign);
  url.searchParams.append('order_sn', p.orderSn);

  const data = assertShopeeSuccess(
    await fetchShopee(url.toString(), {}, 'consultar financeiro', SHOPEE_HTTP_RETRIES, p.deadlineAt || Infinity),
    'getEscrowDetail'
  );
  if (!data.response || typeof data.response !== 'object') {
    const error = new Error('Shopee getEscrowDetail: formato de resposta inválido.');
    error.code = 'SHOPEE_INVALID_RESPONSE';
    throw error;
  }
  return data.response;
}

module.exports = {
  getShopeePartnerCredentials,
  getShopeeAuthUrl,
  generateShopeeSign,
  exchangeShopeeCode,
  refreshShopeeToken,
  getShopeeShopName,
  getShopeeOrderList,
  getShopeeOrderDetail,
  getShopeeEscrowDetail,
};
