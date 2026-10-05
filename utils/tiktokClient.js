// utils/tiktokClient.js
//
// Cliente da TikTok Shop Open API (versão 202309), no mesmo papel do
// utils/shopeeClient.js. Portado de v2/src/lib/tiktok.ts para CommonJS e
// node-fetch, com três ajustes deliberados em relação àquela versão:
//
//   1. timestamp e sign são gerados de novo A CADA tentativa. A tolerância do
//      TikTok é de 5 minutos, e um backoff longo com assinatura antiga vira
//      "signature is invalid" sem relação com o algoritmo;
//   2. erro de assinatura (106xxx) NUNCA dispara renovação de token. Ele também
//      chega como HTTP 401, e confundir os dois só gastava um refresh;
//   3. a renovação do token é serializada por autorização (advisory lock), e
//      grava o par novo em TODAS as lojas que dividem a mesma autorização.
//
// Hosts (trocar um pelo outro é erro silencioso):
//   - auth.tiktok-shops.com          -> SÓ os endpoints de token (sem assinatura)
//   - open-api.tiktokglobalshop.com  -> todo o resto (assinado)
//   - services.tiktokshop.com        -> tela de autorização do vendedor
//
// Credenciais: TIKTOK_APP_KEY, TIKTOK_APP_SECRET e TIKTOK_SERVICE_ID. Nunca
// registrar tokens, secrets ou shop_cipher em log.

const crypto = require('crypto');
const fetch = require('node-fetch');
const db = require('./postgres');
const {
  normalizeTikTokError,
  isAuthFailure,
  sanitizeProviderText,
  describeTikTokError,
  toLastErrorText,
} = require('./tiktokErrors');

const TIKTOK_AUTH_HOST = 'https://auth.tiktok-shops.com';
const TIKTOK_API_HOST = 'https://open-api.tiktokglobalshop.com';
// Mercado "Rest of World", que inclui o Brasil. Lojas dos EUA usam outro host.
const TIKTOK_SELLER_AUTHORIZE_URL = 'https://services.tiktokshop.com/open/authorize';

function readIntEnv(name, fallback, min, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  const value = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(max, Math.max(min, value));
}

const TIKTOK_HTTP_TIMEOUT_MS = readIntEnv('TIKTOK_HTTP_TIMEOUT_MS', 30000, 1000, 120000);
const TIKTOK_HTTP_RETRIES = readIntEnv('TIKTOK_HTTP_RETRIES', 4, 0, 6);
const BACKOFF_CAP_MS = 60000;

/** Renova quando falta menos que isto para o access token expirar. */
const TOKEN_REFRESH_MARGIN_MS = 30 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getTikTokCredentials() {
  return {
    appKey: process.env.TIKTOK_APP_KEY || '',
    appSecret: process.env.TIKTOK_APP_SECRET || '',
    serviceId: process.env.TIKTOK_SERVICE_ID || '',
  };
}

/** Lista das variáveis que faltam, para a tela dizer exatamente o que configurar. */
function missingTikTokCredentials() {
  const { appKey, appSecret, serviceId } = getTikTokCredentials();
  const missing = [];
  if (!appKey) missing.push('TIKTOK_APP_KEY');
  if (!appSecret) missing.push('TIKTOK_APP_SECRET');
  if (!serviceId) missing.push('TIKTOK_SERVICE_ID');
  return missing;
}

/**
 * Erro de chamada à API, já com o código de negócio quando existe.
 *
 * `retryable` cobre throttling (HTTP 429 ou código 36009002, que a doc trata
 * como o MESMO sinal), 5xx, timeout e falha de rede. Erro funcional não é
 * repetido: repetir não muda a resposta e só gasta cota da loja.
 *
 * `.message` é SEMPRE a mensagem PT-BR normalizada (utils/tiktokErrors.js) e
 * pode ir para a tela. O texto cru do provedor (inglês) não entra nela: o
 * primeiro argumento, ou `providerMessage` quando informado, vira a propriedade
 * `providerMessage`, já sanitizada (sem segredos nem query string), SÓ para log.
 * `category`, `errorCode` e `userMessage` servem para o chamador forçar a
 * classificação de falhas que não vieram do envelope do TikTok (rede, timeout).
 */
class TikTokApiError extends Error {
  constructor(message, {
    httpStatus = null,
    code = null,
    retryAfterMs = null,
    requestId = null,
    retryable = false,
    providerMessage = null,
    category = null,
    errorCode = null,
    userMessage = null,
    operation = null,
  } = {}) {
    const normalized = normalizeTikTokError({
      name: 'TikTokApiError',
      httpStatus,
      code,
      requestId,
      retryable,
      category,
      errorCode,
      userMessage,
      providerMessage: providerMessage ?? message ?? '',
    }, { operation });
    super(normalized.userMessage);
    this.name = 'TikTokApiError';
    this.httpStatus = httpStatus;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
    this.requestId = normalized.requestId;
    this.retryable = normalized.retryable;
    this.providerMessage = normalized.providerMessage;
    this.category = normalized.category;
    this.errorCode = normalized.errorCode;
    this.userMessage = normalized.userMessage;
  }

  get isRateLimited() {
    return this.httpStatus === 429 || this.code === 36009002;
  }

  /** Assinatura ou timestamp recusados. Problema nosso, não do token. */
  get isSignatureError() {
    return this.code !== null && this.code >= 106000 && this.code < 107000;
  }

  /**
   * Token inválido ou expirado: vale renovar UMA vez e repetir.
   *
   * A família 105xxx é a de autorização do token. HTTP 401 sem código de
   * assinatura também conta, porque a doc devolve 401 para token vencido.
   */
  get isInvalidToken() {
    // Falta de escopo (105005) está na família 105xxx, mas renovar o token não resolve.
    if (this.isSignatureError || this.category === 'permission') return false;
    if (this.code !== null && this.code >= 105000 && this.code < 106000) return true;
    return this.httpStatus === 401;
  }
}

/**
 * Assinatura HMAC-SHA256 de uma chamada.
 *
 * A ordem é a da documentação oficial e NENHUM passo é opcional:
 *   1. query sem `sign` e sem `access_token`;
 *   2. chaves em ordem alfabética;
 *   3. concatena `{chave}{valor}` (sem '=' e sem '&');
 *   4. prefixa o PATH do endpoint;
 *   5. anexa o corpo CRU quando não é multipart/form-data;
 *   6. envolve tudo com o app_secret nas duas pontas;
 *   7. HMAC-SHA256 usando o app_secret também como chave, em hexadecimal.
 *
 * `body` tem de ser exatamente a string enviada na rede: serializar o JSON
 * duas vezes muda bytes e invalida a assinatura.
 */
function signTikTokRequest({ path, query, body, appSecret }) {
  const base = Object.keys(query)
    .filter((key) => key !== 'sign' && key !== 'access_token')
    .sort()
    .map((key) => `${key}${query[key]}`)
    .join('');

  let signString = `${path}${base}`;
  if (body) signString += body;
  signString = `${appSecret}${signString}${appSecret}`;

  return crypto.createHmac('sha256', appSecret).update(signString).digest('hex');
}

/** URL da tela de consentimento. O `state` volta no retorno e amarra a tentativa. */
function buildTikTokAuthorizeUrl(state) {
  const { serviceId } = getTikTokCredentials();
  const url = new URL(TIKTOK_SELLER_AUTHORIZE_URL);
  url.searchParams.set('service_id', serviceId);
  url.searchParams.set('state', state);
  return url.toString();
}

function parseRetryAfterMs(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function backoffMs(attempt, retryAfterMs) {
  const generated = Math.min(1000 * (2 ** attempt) + Math.floor(Math.random() * 500), BACKOFF_CAP_MS);
  const requested = Math.min(retryAfterMs || 0, BACKOFF_CAP_MS);
  return Math.max(generated, requested);
}

/**
 * Uma requisição HTTP com timeout e leitura do envelope `{code, message, data}`.
 * Devolve `data` em sucesso e lança TikTokApiError em qualquer falha.
 */
async function fetchEnvelope(url, init, operation, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let response;
    let text;
    try {
      response = await fetch(url, { ...init, signal: controller.signal });
      // O corpo também pode estourar o timeout (AbortError) ou cair no meio da leitura.
      text = await response.text();
    } catch (error) {
      const timedOut = error?.name === 'AbortError' || error?.type === 'aborted' || error?.type === 'body-timeout';
      // error.message do node-fetch traz a URL COMPLETA (sign, app_secret, tokens na
      // query): vai só para providerMessage, que sanitiza. Nunca para o .message.
      const reason = timedOut ? `tempo limite de ${Math.ceil(timeoutMs / 1000)}s excedido` : 'falha de rede';
      throw new TikTokApiError(reason, {
        retryable: true,
        category: timedOut ? 'timeout' : 'network',
        providerMessage: `${reason}: ${error?.message || error?.code || 'sem detalhe'}`,
        operation,
      });
    }

    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        // Corpo que não é JSON (página de gateway/WAF): o HTTP 401/403 dele não é falha
        // do token do vendedor, então a categoria é forçada em vez de inferida pelo status.
        throw new TikTokApiError(`resposta JSON inválida (HTTP ${response.status})`, {
          httpStatus: response.status,
          retryable: response.status === 429 || response.status >= 500,
          category: response.status === 429 ? 'rate_limit' : 'provider',
          errorCode: response.status === 429 ? null : 'TIKTOK_INVALID_RESPONSE',
          operation,
        });
      }
    }

    const code = typeof payload?.code === 'number' ? payload.code : null;
    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
    const requestId = typeof payload?.request_id === 'string' ? payload.request_id : null;

    if (!response.ok || (code !== null && code !== 0)) {
      // `payload.message` é o texto em inglês do TikTok: só providerMessage (log).
      throw new TikTokApiError(`HTTP ${response.status} código ${code ?? '-'}`, {
        httpStatus: response.status,
        code,
        retryAfterMs,
        requestId,
        retryable: response.status === 429 || response.status >= 500 || code === 36009002,
        providerMessage: typeof payload?.message === 'string' && payload.message
          ? payload.message
          : null,
        operation,
      });
    }

    if (payload === null) {
      throw new TikTokApiError('resposta vazia', {
        httpStatus: response.status,
        retryable: true,
        category: 'provider',
        errorCode: 'TIKTOK_INVALID_RESPONSE',
        operation,
      });
    }

    return payload.data ?? {};
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Chamada assinada à Open API.
 *
 * Centraliza assinatura, envelope, timeout e retry: nenhum endpoint monta isso
 * à mão. `deadlineAt` é o prazo total do job, para nenhuma espera de backoff
 * empurrar a sincronização além do limite.
 */
async function tiktokApiCall({
  path,
  method = 'GET',
  accessToken,
  shopCipher = null,
  query = {},
  body,
  operation = path,
  maxRetries = TIKTOK_HTTP_RETRIES,
  deadlineAt = Infinity,
}) {
  const { appKey, appSecret } = getTikTokCredentials();
  if (!appKey || !appSecret) {
    throw new TikTokApiError('credenciais do aplicativo ausentes no servidor', {
      retryable: false,
      category: 'unknown',
      errorCode: 'TIKTOK_SERVER_CONFIG',
      operation,
    });
  }

  // Serializa UMA vez: a mesma string é assinada e enviada em todas as tentativas.
  const bodyString = body ? JSON.stringify(body) : undefined;
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      const deadlineError = new TikTokApiError(`prazo total da sincronização excedido em ${operation}`, {
        category: 'timeout',
        errorCode: 'TIKTOK_JOB_TIMEOUT',
        operation,
      });
      deadlineError.code = 'TIKTOK_JOB_TIMEOUT';
      throw deadlineError;
    }

    // Assinatura nova a cada tentativa (tolerância de 5 minutos no timestamp).
    const signedQuery = {
      app_key: appKey,
      timestamp: Math.floor(Date.now() / 1000).toString(),
    };
    if (shopCipher) signedQuery.shop_cipher = shopCipher;
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') signedQuery[key] = String(value);
    }
    signedQuery.sign = signTikTokRequest({ path, query: signedQuery, body: bodyString, appSecret });

    const url = new URL(`${TIKTOK_API_HOST}${path}`);
    for (const [key, value] of Object.entries(signedQuery)) url.searchParams.set(key, value);

    try {
      return await fetchEnvelope(
        url.toString(),
        {
          method,
          headers: {
            'x-tts-access-token': accessToken,
            'content-type': 'application/json',
          },
          body: bodyString,
        },
        operation,
        Math.min(TIKTOK_HTTP_TIMEOUT_MS, remainingMs)
      );
    } catch (error) {
      lastError = error;
      if (!error.retryable || attempt >= maxRetries) break;
      const wait = backoffMs(attempt, error.retryAfterMs);
      if (Date.now() + wait >= deadlineAt) break;
      if (error.isRateLimited) {
        console.warn(`[tiktok] limite de requisições em ${operation}; aguardando ${Math.round(wait)}ms.`);
      }
      await sleep(wait);
    }
  }

  throw lastError;
}

/* ------------------------------- Tokens ------------------------------- */

function toFiniteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * `access_token_expire_in` / `refresh_token_expire_in` chegam como EPOCH
 * absoluto em segundos. Valor pequeno é tratado como duração, para a conta não
 * quebrar se a API mudar o formato. Desconta 5 minutos de margem.
 */
function resolveExpiry(value, marginSeconds = 300) {
  const raw = toFiniteNumber(value);
  if (raw === null || raw <= 0) return null;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const epoch = raw > nowSeconds ? raw : nowSeconds + raw;
  return new Date(Math.max(0, epoch - marginSeconds) * 1000);
}

/** Endpoints de token: não são assinados e recebem o app_secret na query. */
async function tokenCall(path, params, operation) {
  const { appKey, appSecret } = getTikTokCredentials();
  if (!appKey || !appSecret) {
    throw new TikTokApiError('credenciais do aplicativo ausentes no servidor', {
      category: 'unknown',
      errorCode: 'TIKTOK_SERVER_CONFIG',
      operation,
    });
  }

  const url = new URL(`${TIKTOK_AUTH_HOST}${path}`);
  url.searchParams.set('app_key', appKey);
  url.searchParams.set('app_secret', appSecret);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  // Sem retry: o auth_code é de uso único, e uma resposta perdida depois de o
  // TikTok consumir o código faria a repetição falhar com outro erro.
  const data = await fetchEnvelope(url.toString(), { method: 'GET' }, operation, TIKTOK_HTTP_TIMEOUT_MS);

  const accessToken = nonEmptyString(data.access_token);
  const refreshToken = nonEmptyString(data.refresh_token);
  if (!accessToken || !refreshToken) {
    throw new TikTokApiError('resposta sem os tokens de acesso', {
      category: 'provider',
      errorCode: 'TIKTOK_INVALID_RESPONSE',
      operation,
    });
  }

  return {
    accessToken,
    refreshToken,
    accessExpiresAt: resolveExpiry(data.access_token_expire_in) || new Date(Date.now() + 3600 * 1000),
    refreshExpiresAt: resolveExpiry(data.refresh_token_expire_in),
    openId: nonEmptyString(data.open_id),
    sellerName: nonEmptyString(data.seller_name),
    sellerBaseRegion: nonEmptyString(data.seller_base_region),
  };
}

/** Troca o código do retorno pelos tokens do vendedor. */
function exchangeTikTokAuthCode(authCode) {
  return tokenCall('/api/v2/token/get', {
    auth_code: authCode,
    grant_type: 'authorized_code',
  }, 'obter token');
}

/** Renova o access token a partir do refresh token (sem persistir). */
function refreshTikTokAccessToken(refreshToken) {
  return tokenCall('/api/v2/token/refresh', {
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  }, 'renovar token');
}

/** Falha que não desconecta a conta: o chamador pode tentar de novo depois. */
function markRetryable(error) {
  if (error && typeof error === 'object') error.retryable = true;
  return error;
}

/**
 * Registra o último erro (PT-BR) nos cursores de sincronização da loja e das
 * irmãs que dividem a mesma autorização. tiktok_accounts não tem coluna
 * last_error; o cursor é o que o /last-sync já expõe. Melhor esforço: uma falha
 * aqui vira só aviso e nunca mascara o erro original.
 */
async function recordAccountLastError(executor, account, openId, failure) {
  try {
    await executor.query(
      `UPDATE public.tiktok_sync_cursors
          SET last_error = $4, updated_at = NOW()
        WHERE uid = $1
          AND shop_id IN (
            SELECT shop_id
              FROM public.tiktok_accounts
             WHERE uid = $1 AND (shop_id = $2 OR ($3::text IS NOT NULL AND open_id = $3))
          )`,
      [account.uid, account.shopId, openId, toLastErrorText(failure)]
    );
  } catch (writeError) {
    console.warn(`[tiktok] não foi possível registrar o último erro da loja ${account.shopId}: ${writeError.code || 'falha no banco'}`);
  }
}

/**
 * Garante um access token válido para a conta, renovando e PERSISTINDO quando
 * necessário. `account` é mutado para o restante do job usar o token novo.
 *
 * Uma autorização do TikTok pode cobrir várias lojas, e todas compartilham o
 * mesmo par de tokens. Por isso:
 *   - a renovação é serializada por autorização com advisory lock, para duas
 *     sincronizações simultâneas não renovarem o mesmo refresh token;
 *   - dentro do lock a linha é relida: se outra execução já renovou, o token
 *     novo é reaproveitado sem nova chamada;
 *   - o par novo é gravado em todas as linhas da mesma autorização (open_id) ou
 *     que ainda guardam o refresh token anterior. O TikTok pode rotacionar o
 *     refresh token, e a loja irmã com o valor antigo cairia na próxima vez.
 */
async function ensureTikTokAccessToken(account, { force = false } = {}) {
  const expiresAt = account.expiresAt ? new Date(account.expiresAt).getTime() : 0;
  if (!force && expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS) {
    return account.accessToken;
  }

  const lockKey = `tiktok_token:${account.uid}:${account.openId || account.shopId}`;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey]);

    const current = await client.query(
      `SELECT access_token, refresh_token, expires_at, open_id
         FROM public.tiktok_accounts
        WHERE uid = $1 AND shop_id = $2`,
      [account.uid, account.shopId]
    );
    const row = current.rows[0];
    if (!row) {
      throw new TikTokApiError('loja não encontrada para renovar o token', {
        category: 'not_found',
        errorCode: 'TIKTOK_ACCOUNT_NOT_FOUND',
        userMessage: 'A loja TikTok Shop não foi encontrada no CyberDock. Atualize a página e, se persistir, reconecte a conta.',
        operation: 'renovar token',
      });
    }

    const storedExpiry = row.expires_at ? new Date(row.expires_at).getTime() : 0;
    const renewedElsewhere = row.access_token !== account.accessToken
      && storedExpiry - Date.now() > TOKEN_REFRESH_MARGIN_MS;
    if (renewedElsewhere || (!force && storedExpiry - Date.now() > TOKEN_REFRESH_MARGIN_MS)) {
      await client.query('COMMIT');
      account.accessToken = row.access_token;
      account.refreshToken = row.refresh_token;
      account.expiresAt = row.expires_at;
      return account.accessToken;
    }

    let refreshed;
    try {
      refreshed = await refreshTikTokAccessToken(row.refresh_token);
    } catch (error) {
      // Só a recusa da AUTORIZAÇÃO (refresh token inválido, vencido ou revogado) exige
      // que o vendedor autorize de novo. Rede, 5xx, limite de requisições, validação e
      // configuração do servidor NÃO desconectam a conta: a próxima tentativa pode dar
      // certo. Antes, qualquer erro não repetível virava 'reconnect_needed'.
      const failure = normalizeTikTokError(error, { operation: 'renovar token' });
      const needsReconnect = isAuthFailure(failure);
      if (needsReconnect) {
        await client.query(
          `UPDATE public.tiktok_accounts
              SET status = 'reconnect_needed', updated_at = NOW()
            WHERE uid = $1 AND (shop_id = $2 OR ($3::text IS NOT NULL AND open_id = $3))`,
          [account.uid, account.shopId, row.open_id]
        );
      }
      await client.query('COMMIT');
      console.warn(
        `[tiktok] renovação do token da loja ${account.shopId} falhou ` +
        `(${needsReconnect ? 'reconexão necessária' : 'conta mantida'}): ` +
        describeTikTokError(error, { operation: 'renovar token' })
      );
      // Fora da transação (já encerrada): melhor esforço, nunca mascara o erro original.
      await recordAccountLastError(client, account, row.open_id, failure);
      throw needsReconnect ? error : markRetryable(error);
    }

    await client.query(
      `UPDATE public.tiktok_accounts
          SET access_token = $3,
              refresh_token = $4,
              expires_at = $5,
              refresh_expires_at = COALESCE($6, refresh_expires_at),
              open_id = COALESCE(open_id, $7),
              status = 'active',
              updated_at = NOW()
        WHERE uid = $1
          AND (
            shop_id = $2
            OR ($8::text IS NOT NULL AND open_id = $8)
            OR refresh_token = $9
          )`,
      [
        account.uid,
        account.shopId,
        refreshed.accessToken,
        refreshed.refreshToken,
        refreshed.accessExpiresAt,
        refreshed.refreshExpiresAt,
        refreshed.openId,
        row.open_id || refreshed.openId,
        row.refresh_token,
      ]
    );
    await client.query('COMMIT');

    account.accessToken = refreshed.accessToken;
    account.refreshToken = refreshed.refreshToken;
    account.expiresAt = refreshed.accessExpiresAt;
    console.log(`[tiktok] token renovado para a loja ${account.shopId}.`);
    return account.accessToken;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* transação já encerrada */ }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Executa uma operação de loja e, se o token for recusado, renova UMA vez e
 * repete. Espelha o withTokenRetry da Shopee.
 */
async function withTikTokTokenRetry(account, run) {
  const token = await ensureTikTokAccessToken(account);
  try {
    return await run(token);
  } catch (error) {
    if (!(error instanceof TikTokApiError) || !error.isInvalidToken) throw error;
    const fresh = await ensureTikTokAccessToken(account, { force: true });
    return run(fresh);
  }
}

/* ------------------------------ Endpoints ------------------------------ */

/**
 * Lojas que este token acessa, com o `shop_cipher` de cada uma.
 *
 * É também o menor teste possível da assinatura: não leva shop_cipher nem
 * corpo. Se responder, o HMAC está certo.
 */
async function getTikTokAuthorizedShops(accessToken) {
  const data = await tiktokApiCall({
    path: '/authorization/202309/shops',
    accessToken,
    operation: 'listar lojas autorizadas',
    maxRetries: 2,
  });
  const shops = Array.isArray(data.shops) ? data.shops : [];
  return shops
    .map((shop) => ({
      shopId: shop?.id !== undefined && shop?.id !== null ? String(shop.id) : '',
      cipher: nonEmptyString(shop?.cipher),
      name: nonEmptyString(shop?.name),
      region: nonEmptyString(shop?.region),
      sellerType: nonEmptyString(shop?.seller_type),
      code: nonEmptyString(shop?.code),
    }))
    .filter((shop) => shop.shopId);
}

/**
 * Pedidos por JANELA DE ATUALIZAÇÃO.
 *
 * É POST: o filtro vai no corpo, que entra na assinatura. A paginação é por
 * `page_token` opaco. `update_time` (e não create_time) é o que permite o sync
 * incremental: pedido antigo que mudou de status volta na janela.
 */
async function searchTikTokOrders({
  accessToken, shopCipher, updateTimeGe, updateTimeLt, pageSize = 100, pageToken = null, deadlineAt = Infinity,
}) {
  const data = await tiktokApiCall({
    path: '/order/202309/orders/search',
    method: 'POST',
    accessToken,
    shopCipher,
    query: {
      page_size: Math.min(100, Math.max(1, pageSize)),
      sort_field: 'update_time',
      sort_order: 'ASC',
      page_token: pageToken || undefined,
    },
    body: {
      update_time_ge: updateTimeGe,
      update_time_lt: updateTimeLt,
    },
    operation: 'listar pedidos',
    deadlineAt,
  });

  return {
    orders: Array.isArray(data.orders) ? data.orders : [],
    nextPageToken: nonEmptyString(data.next_page_token),
    totalCount: toFiniteNumber(data.total_count),
  };
}

/** Detalhe de até 50 pedidos por chamada. */
async function getTikTokOrderDetails({ accessToken, shopCipher, orderIds, deadlineAt = Infinity }) {
  const ids = (orderIds || []).map(String).filter(Boolean).slice(0, 50);
  if (ids.length === 0) return [];
  const data = await tiktokApiCall({
    path: '/order/202309/orders',
    accessToken,
    shopCipher,
    query: { ids: ids.join(',') },
    operation: 'detalhar pedidos',
    deadlineAt,
  });
  return Array.isArray(data.orders) ? data.orders : [];
}

/** Pacote: rastreio, transportadora e situação atual. */
async function getTikTokPackageDetail({ accessToken, shopCipher, packageId }) {
  return tiktokApiCall({
    path: `/fulfillment/202309/packages/${encodeURIComponent(String(packageId))}`,
    accessToken,
    shopCipher,
    operation: 'consultar pacote',
    maxRetries: 2,
  });
}

/**
 * URL do documento de envio do pacote (etiqueta).
 *
 * Só existe para pedidos com frete do TikTok (shipping_type TIKTOK). PDF é o
 * formato que permite estampar SKU e quantidade, como na Shopee.
 */
async function getTikTokPackageShippingDocument({
  accessToken, shopCipher, packageId,
  documentType = 'SHIPPING_LABEL', documentSize = 'A6', documentFormat = 'PDF',
}) {
  const data = await tiktokApiCall({
    path: `/fulfillment/202309/packages/${encodeURIComponent(String(packageId))}/shipping_documents`,
    accessToken,
    shopCipher,
    query: {
      document_type: documentType,
      document_size: documentSize,
      document_format: documentFormat,
    },
    operation: 'obter etiqueta',
    maxRetries: 2,
  });
  return {
    docUrl: nonEmptyString(data.doc_url),
    trackingNumber: nonEmptyString(data.tracking_number),
  };
}

/**
 * Baixa o arquivo do documento. A URL já vem assinada pelo TikTok e expira,
 * então não passa pela assinatura da Open API.
 */
async function downloadTikTokDocument(docUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIKTOK_HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(docUrl, { signal: controller.signal });
    if (!response.ok) {
      return { ok: false, message: `HTTP ${response.status} ao baixar o documento.` };
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) return { ok: false, message: 'O TikTok devolveu um arquivo vazio.' };
    const contentType = String(response.headers.get('content-type') || 'application/pdf').toLowerCase();
    return { ok: true, buffer, contentType };
  } catch (error) {
    const timedOut = error?.name === 'AbortError' || error?.type === 'aborted' || error?.type === 'body-timeout';
    return {
      ok: false,
      message: timedOut
        ? 'Tempo limite ao baixar a etiqueta do TikTok Shop.'
        : 'Falha de rede ao baixar a etiqueta do TikTok Shop.',
      // error.message do node-fetch traz a URL assinada do documento: só sanitizado, só para log.
      providerMessage: sanitizeProviderText(error?.message || error?.code || '') || null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/* --------------------------- Status de pedido --------------------------- */

/** Fila de expedição: aguardando despacho ou coleta. */
const TIKTOK_SHIPPING_QUEUE_STATUS = new Set(['AWAITING_SHIPMENT', 'AWAITING_COLLECTION', 'PARTIALLY_SHIPPING']);
/** Ainda não pode ser expedido: sem pagamento ou em período de retenção. */
const TIKTOK_NOT_READY_STATUS = new Set(['UNPAID', 'ON_HOLD']);

module.exports = {
  TikTokApiError,
  TIKTOK_SHIPPING_QUEUE_STATUS,
  TIKTOK_NOT_READY_STATUS,
  getTikTokCredentials,
  missingTikTokCredentials,
  signTikTokRequest,
  buildTikTokAuthorizeUrl,
  tiktokApiCall,
  resolveExpiry,
  exchangeTikTokAuthCode,
  refreshTikTokAccessToken,
  ensureTikTokAccessToken,
  withTikTokTokenRetry,
  getTikTokAuthorizedShops,
  searchTikTokOrders,
  getTikTokOrderDetails,
  getTikTokPackageDetail,
  getTikTokPackageShippingDocument,
  downloadTikTokDocument,
};
