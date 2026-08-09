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

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await resp.json().catch(() => null);
  if (!resp.ok || payload?.error) {
    throw new Error(`Erro ao obter token Shopee: ${JSON.stringify(payload)}`);
  }
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

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (data.error) {
    throw new Error(`Shopee refresh error: ${data.message || data.error}`);
  }

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
    const res = await fetch(url);
    const data = await res.json();
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
  url.searchParams.append('time_range_field', 'create_time');
  url.searchParams.append('time_from', p.createTimeFrom.toString());
  url.searchParams.append('time_to', p.createTimeTo.toString());
  url.searchParams.append('page_size', p.pageSize.toString());
  if (p.cursor) url.searchParams.append('cursor', p.cursor);

  const response = await fetch(url.toString());
  const data = await response.json();
  if (data.error) throw new Error(`Shopee getOrderList error: ${data.message || data.error}`);
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

  const response = await fetch(url.toString());
  const data = await response.json();
  if (data.error) throw new Error(`Shopee getOrderDetail error: ${data.message || data.error}`);
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

  const response = await fetch(url.toString());
  const data = await response.json();
  if (data.error) throw new Error(`Shopee getEscrowDetail error: ${data.message || data.error}`);
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
