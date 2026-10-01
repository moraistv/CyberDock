// router/tiktok.js
//
// Integração TikTok Shop (Open API 202309), no mesmo padrão de router/shopee.js:
//   - OAuth por AUTORIZAÇÃO: um consentimento pode liberar várias lojas, e cada
//     uma é gravada em public.tiktok_accounts com o próprio shop_cipher.
//   - Sincronização incremental por update_time, com progresso via SSE e
//     estado durável (lock, lease e job) no PostgreSQL, seguro entre instâncias.
//   - Etiqueta: a CyberDock só IMPRIME a etiqueta do TikTok. Organizar o envio
//     (coleta ou postagem) continua sendo feito pelo vendedor no Seller Center.
//   - Abatimento de estoque idêntico ao da Shopee (public.skus/stock_movements).
//
// Sem financeiro: não consulta extrato nem statements. Os valores gravados são
// os que já vêm no próprio pedido.
//
// Diferenças do TikTok em relação à Shopee:
//   - O retorno do OAuth devolve `code` e `state`, mas não traz shop_id: as
//     lojas vêm de /authorization/202309/shops, junto do shop_cipher.
//   - Cada line_item do pedido é UMA unidade; a quantidade é a contagem.
//   - Fulfillment by TikTok é como o FULL do ML: a expedição não é nossa.

const express = require('express');
const crypto = require('crypto');
const { PDFDocument } = require('pdf-lib');
const db = require('../utils/postgres');
const {
  authenticateToken,
  getBearerToken,
  requireMaster,
  requireOwnerOrMaster,
  verifyAccessToken,
} = require('../utils/authMiddleware');
const { stampLabelLines, buildItemLines } = require('../utils/labelStamp');
const {
  TikTokApiError,
  missingTikTokCredentials,
  buildTikTokAuthorizeUrl,
  exchangeTikTokAuthCode,
  getTikTokAuthorizedShops,
  ensureTikTokAccessToken,
  withTikTokTokenRetry,
  searchTikTokOrders,
  getTikTokPackageDetail,
  getTikTokPackageShippingDocument,
  downloadTikTokDocument,
} = require('../utils/tiktokClient');

const router = express.Router();

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://cyberdock.com.br';
const TIKTOK_OAUTH_ATTEMPT_TTL_MS = 20 * 60 * 1000;

/* ------------------------------ Utilidades ------------------------------ */

function configInt(name, fallback, min, max) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  const value = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(max, Math.max(min, value));
}

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

function epochSeconds(date) {
  return Math.floor(date.getTime() / 1000);
}

function roundCurrency(value) {
  const rounded = Math.round((value + Number.EPSILON) * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** Id de loja ou pedido do TikTok: numérico e longo, sempre tratado como texto. */
function isValidTikTokId(value) {
  return typeof value === 'string' && /^[\w-]{1,64}$/.test(value);
}

/** Resposta padrão quando faltam as credenciais do app no servidor. */
function credentialsMissingResponse(res) {
  const missing = missingTikTokCredentials();
  return res.status(503).json({
    error: `A integração TikTok Shop não está configurada no servidor. Falta definir: ${missing.join(', ')}.`,
    missing,
  });
}

/* --------------------------- Tentativa de OAuth --------------------------- *
 *
 * Mesmo desenho da Shopee: a tentativa opaca e de uso único fica no
 * PostgreSQL, e o navegador só carrega o valor aleatório. Aqui o valor vai no
 * próprio `state` do TikTok, que volta no retorno — o cookie HttpOnly no
 * domínio pai é a segunda via, para o caso de o retorno cair em outra aba.
 */
const TIKTOK_OAUTH_COOKIE = 'cyberdock_tiktok_oauth';

function createTikTokOAuthState() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashTikTokOAuthState(state) {
  return crypto.createHash('sha256').update(state).digest('hex');
}

function isValidTikTokOAuthState(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function defaultCookieDomain() {
  try {
    const host = new URL(FRONTEND_URL).hostname;
    if (!host || host === 'localhost' || /^[\d.]+$/.test(host)) return '';
    const parts = host.split('.');
    return parts.length >= 2 ? `.${parts.slice(-3).join('.')}` : '';
  } catch {
    return '';
  }
}

const TIKTOK_COOKIE_DOMAIN = process.env.TIKTOK_COOKIE_DOMAIN
  || process.env.SHOPEE_COOKIE_DOMAIN
  || defaultCookieDomain();

function tiktokCookieAttributes(maxAgeSeconds) {
  const parts = ['Path=/', `Max-Age=${maxAgeSeconds}`, 'HttpOnly', 'SameSite=Lax'];
  if (!/^http:\/\/localhost/i.test(FRONTEND_URL)) parts.push('Secure');
  if (TIKTOK_COOKIE_DOMAIN) parts.push(`Domain=${TIKTOK_COOKIE_DOMAIN}`);
  return parts.join('; ');
}

function setTikTokOAuthCookie(res, oauthState) {
  const ttl = Math.floor(TIKTOK_OAUTH_ATTEMPT_TTL_MS / 1000);
  res.append('Set-Cookie', `${TIKTOK_OAUTH_COOKIE}=${oauthState}; ${tiktokCookieAttributes(ttl)}`);
}

function clearTikTokOAuthCookie(res) {
  res.append('Set-Cookie', `${TIKTOK_OAUTH_COOKIE}=; ${tiktokCookieAttributes(0)}`);
}

function readTikTokOAuthCookie(req) {
  const header = req.headers?.cookie;
  if (!header) return null;
  for (const chunk of header.split(';')) {
    const [name, ...rest] = chunk.trim().split('=');
    if (name === TIKTOK_OAUTH_COOKIE) return rest.join('=') || null;
  }
  return null;
}

/* ----------------------- SSE autenticado e isolado ----------------------- */
const clients = {};
const pendingEvents = {};
const finalizedJobs = new Map();
const PENDING_TTL_MS = 5 * 60 * 1000;
const MAX_SSE_PER_REQUESTER = configInt('TIKTOK_SSE_MAX_PER_USER', 10, 1, 50);
const MAX_SSE_GLOBAL = configInt('TIKTOK_SSE_MAX_GLOBAL', 500, 10, 2000);

function isValidSyncClientId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{12,100}$/.test(value);
}

/** Namespace opaco: o mesmo clientId em dois JWTs nunca compartilha memória. */
function syncStreamKey(requesterUid, clientId) {
  return crypto.createHash('sha256')
    .update(`${requesterUid}\u0000${clientId}`)
    .digest('base64url');
}

/** EventSource não envia Authorization; aceita o mesmo JWT somente em ?token=. */
function authenticateTikTokSse(req, res, next) {
  const token = getBearerToken(req) || String(req.query.token || '');
  if (!token) return res.status(401).json({ error: 'Token de acesso requerido' });
  try {
    const user = verifyAccessToken(token);
    if (!user?.uid) return res.status(403).json({ error: 'Token sem usuário válido.' });
    req.user = user;
    return next();
  } catch {
    return res.status(403).json({ error: 'Token inválido ou expirado' });
  }
}

const queueEvent = (streamKey, data) => {
  if (!pendingEvents[streamKey]) {
    pendingEvents[streamKey] = { events: [], timer: null };
    pendingEvents[streamKey].timer = setTimeout(() => {
      delete pendingEvents[streamKey];
    }, PENDING_TTL_MS);
  }
  pendingEvents[streamKey].events.push(data);
};

const sendEvent = (streamKey, data) => {
  if (finalizedJobs.has(streamKey)) return;
  const client = clients[streamKey];
  if (client && !client.res.writableEnded) {
    client.res.write(`data: ${JSON.stringify(data)}\n\n`);
    return;
  }
  queueEvent(streamKey, data);
};

/** Publica exatamente um evento terminal e encerra o SSE quando conectado. */
const finalizeJob = (streamKey, data) => {
  if (finalizedJobs.has(streamKey)) return false;
  const terminal = { ...data, progress: 100 };
  const expiry = setTimeout(() => finalizedJobs.delete(streamKey), PENDING_TTL_MS);
  finalizedJobs.set(streamKey, { terminal, expiry });

  const client = clients[streamKey];
  if (client && !client.res.writableEnded) {
    client.res.write(`data: ${JSON.stringify(terminal)}\n\n`);
    clearInterval(client.heartbeat);
    clearInterval(client.jobMonitor);
    client.res.end();
    delete clients[streamKey];
  } else {
    queueEvent(streamKey, terminal);
  }
  return true;
};

router.get('/sync-status/:clientId', authenticateTikTokSse, (req, res) => {
  const clientId = String(req.params.clientId || '').trim();
  const requesterUid = String(req.user.uid);
  if (!isValidSyncClientId(clientId)) {
    return res.status(400).json({ error: 'clientId inválido.' });
  }

  const streamKey = syncStreamKey(requesterUid, clientId);
  const previous = clients[streamKey];
  const requesterConnections = Object.values(clients)
    .filter((client) => client.requesterUid === requesterUid).length;
  if (!previous && requesterConnections >= MAX_SSE_PER_REQUESTER) {
    return res.status(429).json({ error: 'Limite de sincronizações simultâneas atingido.' });
  }
  if (!previous && Object.keys(clients).length >= MAX_SSE_GLOBAL) {
    return res.status(503).json({ error: 'Servidor de sincronização temporariamente ocupado.' });
  }

  // Reconexão do mesmo JWT/clientId substitui o stream antigo sem vazá-lo.
  if (previous) {
    clearInterval(previous.heartbeat);
    clearInterval(previous.jobMonitor);
    if (!previous.res.writableEnded) previous.res.end();
    delete clients[streamKey];
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    Connection: 'keep-alive',
    'Cache-Control': 'no-cache, no-store',
    'X-Accel-Buffering': 'no',
  });
  res.write(': ok\n\n');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const heartbeat = setInterval(() => {
    if (res.writableEnded) return clearInterval(heartbeat);
    try { res.write(': ping\n\n'); } catch { clearInterval(heartbeat); }
  }, 15000);

  clients[streamKey] = { res, heartbeat, jobMonitor: null, requesterUid };

  // POST e EventSource podem cair em instâncias diferentes. O estado terminal
  // persistido no banco é lido somente pelo usuário que iniciou o job.
  let monitorBusy = false;
  const jobMonitor = setInterval(async () => {
    if (monitorBusy || res.writableEnded || finalizedJobs.has(streamKey)) return;
    monitorBusy = true;
    try {
      const result = await db.query(
        `SELECT status, result, error
           FROM public.tiktok_sync_jobs
          WHERE client_id = $1 AND requester_uid = $2 AND expires_at > NOW()`,
        [clientId, requesterUid]
      );
      const state = result.rows[0];
      if (state?.status === 'success' || state?.status === 'error') {
        const fallback = {
          type: state.status === 'success' ? 'success' : 'error',
          message: state.error || 'Sincronização TikTok Shop finalizada.',
        };
        finalizeJob(streamKey, state.result || fallback);
      }
    } catch (error) {
      console.warn('[tiktok-sync] falha ao consultar estado do job SSE:', error.message);
    } finally {
      monitorBusy = false;
    }
  }, 2000);
  if (clients[streamKey]?.res === res) clients[streamKey].jobMonitor = jobMonitor;

  const buffered = pendingEvents[streamKey];
  if (buffered) {
    if (buffered.timer) clearTimeout(buffered.timer);
    let hasTerminal = false;
    for (const event of buffered.events) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.progress === 100) hasTerminal = true;
    }
    delete pendingEvents[streamKey];
    if (hasTerminal) {
      clearInterval(heartbeat);
      clearInterval(jobMonitor);
      res.end();
      delete clients[streamKey];
    }
  } else if (finalizedJobs.has(streamKey)) {
    const finalized = finalizedJobs.get(streamKey);
    res.write(`data: ${JSON.stringify(finalized.terminal)}\n\n`);
    clearInterval(heartbeat);
    clearInterval(jobMonitor);
    res.end();
    delete clients[streamKey];
  } else {
    sendEvent(streamKey, { progress: 5, message: 'Conexão estabelecida. Aguardando início...', type: 'info' });
  }

  req.on('close', () => {
    clearInterval(heartbeat);
    clearInterval(jobMonitor);
    if (clients[streamKey]?.res === res) delete clients[streamKey];
  });
});

/* ------------------------------- OAuth: início ------------------------------- */

/**
 * Inicia o OAuth a partir de uma chamada autenticada. O UID vem do JWT, nunca
 * da query string. O `state` enviado ao TikTok é a própria tentativa.
 */
router.post('/auth', authenticateToken, async (req, res) => {
  if (missingTikTokCredentials().length) return credentialsMissingResponse(res);

  try {
    const oauthState = createTikTokOAuthState();
    const stateHash = hashTikTokOAuthState(oauthState);
    const expiresAt = new Date(Date.now() + TIKTOK_OAUTH_ATTEMPT_TTL_MS);

    await db.query(
      `DELETE FROM public.tiktok_oauth_attempts
        WHERE expires_at < NOW() - INTERVAL '1 day'`
    );
    await db.query(
      `INSERT INTO public.tiktok_oauth_attempts (state_hash, uid, expires_at)
       VALUES ($1, $2, $3)`,
      [stateHash, req.user.uid, expiresAt]
    );

    const authUrl = buildTikTokAuthorizeUrl(oauthState);
    res.set('Cache-Control', 'no-store');
    setTikTokOAuthCookie(res, oauthState);
    console.log(`[TikTok Auth] Autorização iniciada para UID ${req.user.uid}.`);
    return res.json({
      authUrl,
      oauthState,
      expiresInSeconds: Math.floor(TIKTOK_OAUTH_ATTEMPT_TTL_MS / 1000),
    });
  } catch (error) {
    console.error('[TikTok Auth] Não foi possível iniciar a autorização:', error);
    return res.status(500).json({ error: 'Não foi possível iniciar a autorização do TikTok Shop.' });
  }
});

/* ------------------------------ OAuth: conclusão ------------------------------ */

async function releaseTikTokOAuthClaim(attempt, requestId) {
  if (!attempt) return;
  try {
    await db.query(
      `UPDATE public.tiktok_oauth_attempts
          SET claim_id = NULL, claimed_at = NULL
        WHERE state_hash = $1
          AND claim_id = $2
          AND consumed_at IS NULL`,
      [attempt.stateHash, attempt.claimId]
    );
  } catch (error) {
    console.error(`[TikTok Connect ${requestId}] Falha ao liberar a reserva da tentativa:`, error);
  }
}

/** Contas gravadas por uma tentativa já concluída, para resposta idempotente. */
async function loadCompletedAttemptAccounts(uid, shopIds) {
  if (!Array.isArray(shopIds) || shopIds.length === 0) return [];
  const { rows } = await db.query(
    `SELECT shop_id, shop_name, region, status, connected_at, updated_at
       FROM public.tiktok_accounts
      WHERE uid = $1 AND shop_id = ANY($2::text[])
      ORDER BY shop_name NULLS LAST, shop_id`,
    [uid, shopIds]
  );
  return rows;
}

/**
 * Identifica o dono da conexão pela tentativa (corpo, `state` ou cookie).
 *
 * Diferente da Shopee, NÃO existe caminho só com JWT: a tentativa é o que
 * amarra o retorno do TikTok ao pedido de autorização feito aqui, e sem ela um
 * código de outra pessoa poderia ser vinculado à conta de quem estiver logado.
 */
async function resolveTikTokConnectIdentity(req, res, next) {
  const requestId = crypto.randomUUID();
  const stateFromBody = req.body?.oauthState || req.body?.state;
  const oauthState = stateFromBody || readTikTokOAuthCookie(req);
  const bearerToken = getBearerToken(req);
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  let sessionUser = null;

  console.log(
    `[TikTok Connect ${requestId}] Recebido: ` +
    `tentativa=${oauthState ? (stateFromBody ? 'corpo' : 'cookie') : 'nenhuma'} ` +
    `jwt=${bearerToken ? 'presente' : 'ausente'}.`
  );

  if (!code) {
    return res.status(400).json({ error: 'O TikTok Shop não devolveu o código de autorização.', requestId });
  }

  if (bearerToken) {
    try {
      sessionUser = verifyAccessToken(bearerToken);
    } catch {
      sessionUser = null;
    }
  }

  if (!isValidTikTokOAuthState(oauthState)) {
    console.warn(`[TikTok Connect ${requestId}] Tentativa ausente ou malformada.`);
    return res.status(400).json({
      error: 'A tentativa de conexão com o TikTok Shop não foi encontrada. Clique em Conectar TikTok e autorize novamente.',
      restartRequired: true,
      requestId,
    });
  }

  const stateHash = hashTikTokOAuthState(oauthState);
  const claimId = crypto.randomUUID();
  try {
    const params = sessionUser ? [stateHash, claimId, sessionUser.uid] : [stateHash, claimId];
    const ownerCondition = sessionUser ? 'AND uid = $3' : '';
    const { rows } = await db.query(
      `UPDATE public.tiktok_oauth_attempts
          SET claim_id = $2, claimed_at = NOW()
        WHERE state_hash = $1
          AND consumed_at IS NULL
          AND expires_at > NOW()
          AND (claim_id IS NULL OR claimed_at < NOW() - INTERVAL '5 minutes')
          ${ownerCondition}
      RETURNING uid`,
      params
    );

    if (!rows[0]) {
      const probe = await db.query(
        `SELECT uid, shop_ids, claimed_at, consumed_at
           FROM public.tiktok_oauth_attempts
          WHERE state_hash = $1`,
        [stateHash]
      );
      const attempt = probe.rows[0];

      if (attempt && sessionUser && attempt.uid !== sessionUser.uid) {
        return res.status(403).json({
          error: 'A autorização foi iniciada por outro usuário. Entre na conta correta e tente novamente.',
          requestId,
        });
      }

      // Resposta perdida depois do COMMIT: devolve o que já está gravado, sem
      // tentar reutilizar o código, que é de uso único.
      if (attempt?.consumed_at) {
        const accounts = await loadCompletedAttemptAccounts(attempt.uid, attempt.shop_ids);
        if (accounts.length > 0) {
          req.user = sessionUser || { uid: attempt.uid };
          req.tiktokCompletedAccounts = accounts;
          req.tiktokSessionValid = Boolean(sessionUser);
          req.tiktokRequestId = requestId;
          return next();
        }
      }

      const claimIsActive = attempt?.claimed_at
        && new Date(attempt.claimed_at).getTime() > Date.now() - 5 * 60 * 1000;
      if (claimIsActive && !attempt?.consumed_at) {
        return res.status(409).json({
          error: 'Esta conexão com o TikTok Shop ainda está sendo concluída. Aguarde alguns segundos.',
          requestId,
        });
      }

      return res.status(400).json({
        error: 'A tentativa de conexão com o TikTok Shop expirou. Clique em Conectar TikTok e autorize novamente.',
        restartRequired: true,
        requestId,
      });
    }

    req.user = sessionUser || { uid: rows[0].uid };
    req.tiktokOAuthAttempt = { stateHash, claimId };
    req.tiktokSessionValid = Boolean(sessionUser);
    req.tiktokRequestId = requestId;
    return next();
  } catch (error) {
    console.error(`[TikTok Connect ${requestId}] Falha ao reivindicar a tentativa:`, error);
    return res.status(500).json({
      error: 'Não foi possível validar a tentativa de conexão com o TikTok Shop.',
      requestId,
    });
  }
}

const ACCOUNT_UPSERT_QUERY = `
  INSERT INTO public.tiktok_accounts (
    uid, shop_id, shop_name, shop_code, shop_cipher, region, seller_name, open_id,
    access_token, refresh_token, expires_at, refresh_expires_at,
    status, connected_at, updated_at
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'active', NOW(), NOW())
  ON CONFLICT (uid, shop_id) DO UPDATE SET
    shop_name          = EXCLUDED.shop_name,
    shop_code          = EXCLUDED.shop_code,
    shop_cipher        = EXCLUDED.shop_cipher,
    region             = EXCLUDED.region,
    seller_name        = EXCLUDED.seller_name,
    open_id            = EXCLUDED.open_id,
    access_token       = EXCLUDED.access_token,
    refresh_token      = EXCLUDED.refresh_token,
    expires_at         = EXCLUDED.expires_at,
    refresh_expires_at = EXCLUDED.refresh_expires_at,
    status             = 'active',
    updated_at         = NOW()
  RETURNING uid, shop_id, shop_name, region, status, connected_at, updated_at;
`;

/**
 * Troca o código pelos tokens, descobre as lojas e grava todas.
 *
 * Os erros carregam a fase para o chamador escolher entre "tente de novo" e
 * "refaça a autorização".
 */
async function persistTikTokAccounts({ uid, code, attempt, requestId }) {
  if (missingTikTokCredentials().length) {
    const configError = new Error('Credenciais TikTok Shop ausentes no servidor.');
    configError.code = 'TIKTOK_SERVER_CONFIG';
    configError.phase = 'configuration';
    throw configError;
  }

  let phase = 'token_exchange';
  try {
    const tokens = await exchangeTikTokAuthCode(code);
    console.log(`[TikTok Connect ${requestId}] Token recebido.`);

    phase = 'shop_discovery';
    const shops = await getTikTokAuthorizedShops(tokens.accessToken);
    if (shops.length === 0) {
      const empty = new Error('A autorização do TikTok Shop não liberou nenhuma loja para o CyberDock.');
      empty.userMessage = empty.message;
      throw empty;
    }
    const withoutCipher = shops.filter((shop) => !shop.cipher).map((shop) => shop.shopId);
    if (withoutCipher.length) {
      const invalid = new Error(`O TikTok Shop não retornou shop_cipher para: ${withoutCipher.join(', ')}.`);
      invalid.code = 'TIKTOK_SHOP_CIPHER_MISSING';
      invalid.phase = 'shop_discovery';
      invalid.userMessage = 'O TikTok Shop não liberou os identificadores necessários para sincronizar a loja. Confira os escopos do app e autorize novamente.';
      invalid.restartRequired = true;
      throw invalid;
    }

    const shopIds = shops.map((shop) => shop.shopId);

    phase = 'persistence';
    const client = await db.pool.connect();
    const accounts = [];
    try {
      await client.query('BEGIN');
      // Ordenação fixa evita deadlock se uma autorização com várias lojas
      // disputar outra autorização ao mesmo tempo.
      const orderedShops = [...shops].sort((a, b) => String(a.shopId).localeCompare(String(b.shopId)));
      for (const shop of orderedShops) {
        // Lock transacional por shop_id + índice UNIQUE: nem duas instâncias
        // conseguem cadastrar a mesma loja para tenants diferentes.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`tiktok-shop-owner:${shop.shopId}`]);
        const owner = await client.query(
          'SELECT uid FROM public.tiktok_accounts WHERE shop_id = $1 AND uid <> $2 FOR UPDATE',
          [shop.shopId, uid]
        );
        if (owner.rowCount > 0) {
          const conflict = new Error(`A loja ${shop.shopId} já pertence a outro usuário da CyberDock.`);
          conflict.code = 'TIKTOK_SHOP_ALREADY_OWNED';
          conflict.phase = 'ownership';
          conflict.httpStatus = 409;
          conflict.restartRequired = true;
          conflict.userMessage = 'Esta loja TikTok Shop já está conectada a outro usuário da CyberDock. Desconecte-a do usuário atual antes de transferir a loja.';
          throw conflict;
        }

        const result = await client.query(ACCOUNT_UPSERT_QUERY, [
          uid,
          shop.shopId,
          truncate(shop.name || '', 255) || null,
          truncate(shop.code || '', 64) || null,
          shop.cipher,
          truncate(shop.region || tokens.sellerBaseRegion || '', 16) || null,
          truncate(tokens.sellerName || '', 255) || null,
          truncate(tokens.openId || '', 255) || null,
          tokens.accessToken,
          tokens.refreshToken,
          tokens.accessExpiresAt,
          tokens.refreshExpiresAt,
        ]);
        const account = result.rows[0];
        if (!account || account.uid !== uid) {
          throw new Error('A loja TikTok Shop não foi confirmada depois da gravação.');
        }
        accounts.push(account);
      }

      if (attempt) {
        const completion = await client.query(
          `UPDATE public.tiktok_oauth_attempts
              SET consumed_at = NOW(), shop_ids = $3::text[],
                  claim_id = NULL, claimed_at = NULL
            WHERE state_hash = $1
              AND claim_id = $2
              AND consumed_at IS NULL
          RETURNING state_hash`,
          [attempt.stateHash, attempt.claimId, shopIds]
        );
        if (completion.rowCount !== 1) {
          throw new Error('A tentativa de conexão perdeu a reserva antes da conclusão.');
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* conexão já encerrada */ }
      // O índice UNIQUE é a última barreira caso uma escrita externa não use o
      // advisory lock. Converte a violação em mensagem operacional, sem vazar SQL.
      if (error?.code === '23505' && String(error?.constraint || '').includes('tiktok_accounts_shop_owner')) {
        error.phase = 'ownership';
        error.httpStatus = 409;
        error.restartRequired = true;
        error.userMessage = 'Esta loja TikTok Shop já está conectada a outro usuário da CyberDock. Desconecte-a do usuário atual antes de transferir a loja.';
      }
      throw error;
    } finally {
      client.release();
    }

    return accounts;
  } catch (error) {
    if (!error.phase) error.phase = phase;
    throw error;
  }
}

function tiktokConnectResponse(accounts, req, res, replayed = false) {
  const names = accounts.map((account) => account.shop_name || account.shop_id);
  const message = names.length > 1
    ? `Lojas TikTok Shop ${names.join(', ')} conectadas com sucesso!`
    : `Loja TikTok Shop ${names[0]} conectada com sucesso!`;
  return res.json({
    message,
    shops: accounts.map((account) => ({
      shopId: String(account.shop_id),
      shopName: account.shop_name,
      region: account.region || null,
    })),
    shopId: String(accounts[0].shop_id),
    shopName: accounts[0].shop_name,
    ownerUid: req.user.uid,
    sessionValid: req.tiktokSessionValid,
    replayed,
    requestId: req.tiktokRequestId,
  });
}

function connectFailureMessage(error) {
  if (error?.code === 'TIKTOK_SERVER_CONFIG') return 'A integração TikTok Shop não está configurada corretamente no servidor.';
  if (error?.phase === 'persistence') return 'O TikTok Shop autorizou a loja, mas o CyberDock não conseguiu gravá-la. Inicie uma nova conexão.';
  if (error?.userMessage) return error.userMessage;
  if (error?.phase === 'token_exchange') return 'O TikTok Shop recusou o código de autorização. Ele vale uma única vez: clique em Conectar TikTok e autorize novamente.';
  if (error instanceof TikTokApiError && error.isSignatureError) return 'O TikTok Shop recusou a assinatura da chamada. Confira TIKTOK_APP_KEY e TIKTOK_APP_SECRET no servidor.';
  return 'Não foi possível concluir a conexão com o TikTok Shop. Tente novamente.';
}

router.post('/connect', resolveTikTokConnectIdentity, async (req, res) => {
  const { uid } = req.user;
  const requestId = req.tiktokRequestId;

  if (req.tiktokCompletedAccounts) {
    clearTikTokOAuthCookie(res);
    console.log(`[TikTok Connect ${requestId}] Conexão já concluída; resposta idempotente.`);
    return tiktokConnectResponse(req.tiktokCompletedAccounts, req, res, true);
  }

  try {
    const accounts = await persistTikTokAccounts({
      uid,
      code: req.body.code.trim(),
      attempt: req.tiktokOAuthAttempt,
      requestId,
    });
    clearTikTokOAuthCookie(res);
    console.log(`[TikTok Connect ${requestId}] Persistido: ${accounts.length} loja(s) para UID ${uid}.`);
    return tiktokConnectResponse(accounts, req, res);
  } catch (error) {
    await releaseTikTokOAuthClaim(req.tiktokOAuthAttempt, requestId);
    const phase = error.phase || 'unknown';
    console.error(`[TikTok Connect ${requestId}] Erro na fase ${phase}:`, error.message);

    const serverSide = phase === 'persistence' || error?.code === 'TIKTOK_SERVER_CONFIG';
    const status = error?.httpStatus || (serverSide ? 500 : 400);
    return res.status(status).json({
      error: connectFailureMessage(error),
      restartRequired: Boolean(error?.restartRequired || phase !== 'configuration'),
      requestId,
    });
  }
});

/**
 * Conclusão direto no backend, para quando a URL de retorno cadastrada no app
 * do TikTok aponta para a API. A identidade vem do `state` (ou do cookie), então
 * basta uma navegação comum do navegador.
 */
router.get('/callback', async (req, res) => {
  const requestId = crypto.randomUUID();
  const code = String(req.query.code || req.query.auth_code || '').trim();
  const contas = `${FRONTEND_URL}/contas`;
  const failure = (message) => res.redirect(`${contas}?error=${encodeURIComponent(message)}`);
  const success = (message) => res.redirect(`${contas}?success=${encodeURIComponent(message)}`);

  const oauthState = String(req.query.state || '').trim() || readTikTokOAuthCookie(req);
  console.log(`[TikTok Callback ${requestId}] Retorno: tentativa=${oauthState ? 'presente' : 'nenhuma'}.`);

  if (!code) {
    return failure('Autorização do TikTok Shop falhou: o código de autorização não foi devolvido.');
  }

  // Sem tentativa no retorno, o frontend ainda pode concluir com a tentativa
  // que guardou ao iniciar a conexão.
  if (!isValidTikTokOAuthState(oauthState)) {
    const frontendCallback = new URL(`${FRONTEND_URL}/tiktok/callback`);
    frontendCallback.searchParams.set('code', code);
    frontendCallback.searchParams.set('handoff', '1');
    return res.redirect(frontendCallback.toString());
  }

  const stateHash = hashTikTokOAuthState(oauthState);
  const claimId = crypto.randomUUID();
  let attempt = null;
  try {
    const { rows } = await db.query(
      `UPDATE public.tiktok_oauth_attempts
          SET claim_id = $2, claimed_at = NOW()
        WHERE state_hash = $1
          AND consumed_at IS NULL
          AND expires_at > NOW()
          AND (claim_id IS NULL OR claimed_at < NOW() - INTERVAL '5 minutes')
      RETURNING uid`,
      [stateHash, claimId]
    );

    if (!rows[0]) {
      const probe = await db.query(
        `SELECT uid, shop_ids, consumed_at FROM public.tiktok_oauth_attempts WHERE state_hash = $1`,
        [stateHash]
      );
      const done = probe.rows[0];
      clearTikTokOAuthCookie(res);
      if (done?.consumed_at) {
        const accounts = await loadCompletedAttemptAccounts(done.uid, done.shop_ids);
        if (accounts.length > 0) {
          const names = accounts.map((account) => account.shop_name || account.shop_id).join(', ');
          return success(`TikTok Shop conectado: ${names}.`);
        }
      }
      return failure('A tentativa de conexão com o TikTok Shop expirou. Clique em Conectar TikTok e autorize novamente.');
    }

    attempt = { stateHash, claimId };
    const uid = rows[0].uid;
    const accounts = await persistTikTokAccounts({ uid, code, attempt, requestId });
    clearTikTokOAuthCookie(res);
    const names = accounts.map((account) => account.shop_name || account.shop_id).join(', ');
    console.log(`[TikTok Callback ${requestId}] Persistido: ${accounts.length} loja(s) para UID ${uid}.`);
    return success(`TikTok Shop conectado: ${names}.`);
  } catch (error) {
    await releaseTikTokOAuthClaim(attempt, requestId);
    console.error(`[TikTok Callback ${requestId}] Erro na fase ${error.phase || 'unknown'}:`, error.message);
    clearTikTokOAuthCookie(res);
    return failure(connectFailureMessage(error));
  }
});

/* --------------------------------- Contas --------------------------------- */

async function listTikTokAccounts(uid, res) {
  try {
    // Tokens e shop_cipher nunca saem daqui: a tela só precisa saber se existem.
    const { rows } = await db.query(
      `SELECT shop_id, shop_name, region, status, connected_at, expires_at, refresh_expires_at,
              (shop_cipher IS NOT NULL AND shop_cipher <> '') AS has_shop_cipher
         FROM public.tiktok_accounts
        WHERE uid = $1
        ORDER BY connected_at DESC, shop_id`,
      [uid]
    );
    return res.json(rows);
  } catch (error) {
    console.error(`[TikTok Contas] Erro ao listar lojas do UID ${uid}:`, error);
    return res.status(500).json({ error: 'Erro interno do servidor.' });
  }
}

router.get('/contas', authenticateToken, async (req, res) => listTikTokAccounts(req.user.uid, res));

router.get('/contas/:uid', authenticateToken, requireOwnerOrMaster, async (req, res) => (
  listTikTokAccounts(req.params.uid, res)
));

/**
 * Todas as lojas TikTok sincronizáveis (visão master), para o "Sincronizar
 * Tudo". Loja marcada para reconexão fica de fora: sem nova autorização do
 * vendedor, cada tentativa só repetiria o mesmo erro.
 */
router.get('/all-accounts', authenticateToken, requireMaster, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT ta.shop_id, ta.shop_name, ta.uid, u.name AS user_name
        FROM public.tiktok_accounts ta
        LEFT JOIN public.users u ON ta.uid = u.uid
       WHERE COALESCE(ta.status, 'active') <> 'reconnect_needed'
         AND NULLIF(ta.shop_cipher, '') IS NOT NULL
         AND COALESCE(u.active, true) = true
       ORDER BY u.name NULLS LAST, ta.shop_name
    `);
    res.json(rows);
  } catch (error) {
    console.error('Erro ao listar todas as lojas TikTok Shop:', error);
    res.status(500).json({ error: 'Erro interno ao listar as lojas TikTok Shop.' });
  }
});

router.delete('/contas/:shopId', authenticateToken, async (req, res) => {
  const { shopId } = req.params;
  const { uid } = req.user;
  if (!isValidTikTokId(shopId) || !uid) return res.status(400).json({ error: 'Parâmetros inválidos para exclusão.' });

  try {
    const result = await db.query('DELETE FROM public.tiktok_accounts WHERE shop_id = $1 AND uid = $2', [shopId, uid]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Loja não encontrada ou não pertence a este usuário.' });
    res.status(204).send();
  } catch (error) {
    console.error(`Erro ao excluir loja TikTok Shop ${shopId}:`, error);
    res.status(500).json({ error: 'Erro interno ao excluir a loja.' });
  }
});

/**
 * Excluir loja de OUTRO usuário (master). Apaga a conta; cursor e jobs vão
 * junto por CASCADE. As vendas em public.tiktok_sales ficam: são histórico.
 */
router.delete('/contas/:uid/:shopId', authenticateToken, requireMaster, async (req, res) => {
  const { uid, shopId } = req.params;
  if (!uid || !isValidTikTokId(shopId)) {
    return res.status(400).json({ error: 'Informe o usuário e a loja TikTok Shop a excluir.' });
  }

  try {
    const { rows } = await db.query(
      `DELETE FROM public.tiktok_accounts
        WHERE shop_id = $1 AND uid = $2
        RETURNING shop_id, shop_name, uid`,
      [shopId, uid]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Loja não encontrada para este usuário.' });

    const removed = rows[0];
    console.log(
      `[TikTok] Loja ${removed.shop_id} (${removed.shop_name || 'sem nome'}) do usuário ${uid} ` +
      `excluída pelo master ${req.user.uid}.`
    );
    res.json({
      message: 'Loja TikTok Shop desconectada.',
      account: { shopId: String(removed.shop_id), shopName: removed.shop_name, uid: removed.uid },
    });
  } catch (error) {
    console.error(`Erro ao excluir loja TikTok Shop ${shopId} do usuário ${uid}:`, error);
    res.status(500).json({ error: 'Erro interno ao excluir a loja.' });
  }
});

/* -------------------------------- Etiquetas -------------------------------- *
 *
 * O TikTok só emite etiqueta para pedidos com frete do próprio TikTok
 * (shipping_type TIKTOK), e só depois que o vendedor organiza o envio (coleta
 * ou postagem) no Seller Center — é isso que gera o rastreio. A CyberDock não
 * organiza envio: ela imprime a etiqueta que o TikTok já liberou, com o bloco de
 * conferência (SKU e quantidade) estampado, como na Shopee.
 */

const TIKTOK_AWAITING_SHIPMENT_REASON = 'O TikTok Shop ainda não gerou o código de rastreio deste pedido. '
  + 'A etiqueta só é liberada depois que o envio é organizado (coleta ou postagem) no Seller Center do TikTok Shop. '
  + 'Organize o envio e sincronize as vendas para atualizar aqui.';

/** Texto em português para a recusa do TikTok, sem inglês cru como mensagem. */
function tiktokLabelMessage(error, fallback) {
  if (error instanceof TikTokApiError) {
    if (error.isSignatureError) {
      return 'O TikTok Shop recusou a assinatura da chamada. Confira TIKTOK_APP_KEY e TIKTOK_APP_SECRET no servidor.';
    }
    if (error.isInvalidToken) {
      return 'A autorização desta loja no TikTok Shop expirou ou foi revogada. Reconecte a loja em Contas.';
    }
    if (error.isRateLimited) {
      return 'O TikTok Shop limitou as chamadas desta loja agora. Tente novamente em alguns segundos.';
    }
    const detail = [error.message, error.code ? `código ${error.code}` : null].filter(Boolean).join(' · ');
    return `O TikTok Shop recusou a etiqueta deste pedido. Resposta do TikTok: ${detail}`;
  }
  return fallback || 'Não foi possível obter a etiqueta no TikTok Shop agora.';
}

function readLabelQuery(req) {
  // Só o master pode imprimir em nome de outro dono; para os demais vale o UID do token.
  const requestedOwner = String(req.query.ownerUid || req.query.owner_uid || '').trim();
  const ownerUid = req.user.role === 'master' && requestedOwner ? requestedOwner : req.user.uid;
  return {
    ownerUid,
    orderId: String(req.query.orderId || req.query.order_id || req.query.orderSn || '').trim(),
    shopId: String(req.query.shopId || req.query.shop_id || '').trim(),
  };
}

/** Conta da loja com token utilizável. */
async function loadTikTokAccountForLabel(uid, shopId) {
  const { rows } = await db.query(
    `SELECT uid, shop_id, shop_name, shop_cipher, open_id, access_token, refresh_token, expires_at
       FROM public.tiktok_accounts
      WHERE uid = $1 AND shop_id = $2`,
    [uid, String(shopId)]
  );
  if (!rows[0]) return { error: 'account_not_found' };
  if (missingTikTokCredentials().length) return { error: 'server_config' };
  if (!rows[0].shop_cipher) return { error: 'missing_cipher' };

  const row = rows[0];
  return {
    account: {
      uid: row.uid,
      shopId: String(row.shop_id),
      shopName: row.shop_name,
      shopCipher: row.shop_cipher,
      openId: row.open_id,
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      expiresAt: row.expires_at,
    },
  };
}

function accountLoadFailure(error) {
  if (error === 'account_not_found') return { status: 404, reason: 'Loja TikTok Shop não conectada nesta conta.' };
  if (error === 'server_config') return { status: 500, reason: 'A integração TikTok Shop não está configurada no servidor.' };
  return { status: 409, reason: 'Esta loja foi gravada sem o shop_cipher do TikTok. Reconecte a loja em Contas.' };
}

/** Linhas gravadas do pedido, com os dados de envio que decidem a etiqueta. */
async function findTikTokOrderForLabel(uid, shopId, orderId) {
  const { rows } = await db.query(
    `SELECT sku, quantity, order_status, shipping_type, fulfillment_type,
            package_ids, tracking_number, raw_api_data->'line_items' AS line_items
       FROM public.tiktok_sales
      WHERE uid = $1 AND shop_id = $2 AND order_id = $3
      ORDER BY sku`,
    [uid, String(shopId), String(orderId)]
  );
  if (rows.length === 0) return null;

  const first = rows[0];
  const packageIds = Array.from(new Set(rows.flatMap((row) => row.package_ids || []).filter(Boolean)));
  return {
    items: rows.map((row) => ({ sku: row.sku, quantity: row.quantity })),
    orderStatus: String(first.order_status || '').toUpperCase(),
    shippingType: String(first.shipping_type || '').toUpperCase(),
    fulfillmentType: String(first.fulfillment_type || '').toUpperCase(),
    trackingNumber: first.tracking_number || null,
    packageIds,
    lineItems: Array.isArray(first.line_items) ? first.line_items : [],
  };
}

/** Impedimentos que o próprio pedido já revela, sem gastar chamada à API. */
function labelBlockReason(order) {
  if (order.fulfillmentType === 'FULFILLMENT_BY_TIKTOK') {
    return { status: 'not_applicable', reason: 'Pedido Fulfillment by TikTok: a expedição e a etiqueta são do próprio TikTok Shop.' };
  }
  if (order.shippingType === 'SELLER') {
    return {
      status: 'not_applicable',
      reason: 'Este pedido usa envio próprio do vendedor: o TikTok Shop não emite etiqueta para ele. '
        + 'A etiqueta sai da transportadora contratada pelo vendedor.',
    };
  }
  if (order.orderStatus === 'CANCELLED') {
    return { status: 'blocked', reason: 'Pedido cancelado no TikTok Shop: não há etiqueta para imprimir.' };
  }
  if (order.orderStatus === 'UNPAID') {
    return { status: 'blocked', reason: 'O pedido ainda não foi pago no TikTok Shop.' };
  }
  if (order.orderStatus === 'ON_HOLD') {
    return {
      status: 'blocked',
      reason: 'O pedido está no período de retenção do TikTok Shop, em que o comprador ainda pode cancelar. '
        + 'A etiqueta é liberada quando ele passar para Aguardando envio.',
    };
  }
  if (order.packageIds.length === 0) {
    return {
      status: 'awaiting_shipment',
      awaitingShipment: true,
      reason: 'O TikTok Shop ainda não criou o pacote deste pedido. Sincronize as vendas e tente novamente.',
    };
  }
  return null;
}

/**
 * SKU e quantidade de UM pacote, para o bloco de conferência.
 *
 * Pedido dividido em pacotes leva só os itens daquele pacote na etiqueta. Cada
 * line_item é uma unidade, então a quantidade é a contagem por SKU. Em pedido
 * multipacote sem vínculo confiável item→pacote, devolve vazio: a etiqueta
 * oficial continua válida, mas não estampamos todos os itens no volume errado.
 */
function itemsForPackage(order, packageId, packageCount) {
  if (packageCount > 1) {
    const counts = new Map();
    for (const lineItem of order.lineItems) {
      if (String(lineItem?.package_id || '') !== String(packageId)) continue;
      if (String(lineItem?.display_status || '').toUpperCase() === 'CANCELLED') continue;
      const sku = String(lineItem?.seller_sku || lineItem?.sku_id || '').trim();
      if (!sku) continue;
      const quantity = Math.max(1, Math.trunc(toFiniteNumber(lineItem?.quantity) || 1));
      counts.set(sku, (counts.get(sku) || 0) + quantity);
    }
    return Array.from(counts.entries()).map(([sku, quantity]) => ({ sku, quantity }));
  }
  return order.items;
}

/** Situação atual do pacote no TikTok, com o rastreio vigente. */
async function readPackageState(account, packageId) {
  const detail = await withTikTokTokenRetry(account, (accessToken) => getTikTokPackageDetail({
    accessToken, shopCipher: account.shopCipher, packageId,
  }));
  return {
    packageId: String(packageId),
    trackingNumber: truncate(String(detail?.tracking_number || ''), 255) || null,
    packageStatus: truncate(String(detail?.package_status || ''), 60) || null,
  };
}

/**
 * Diagnóstico antes de imprimir: diz se a etiqueta pode sair e, quando não
 * pode, por quê — em português, para a tela mostrar direto ao operador.
 */
router.get('/label-info', authenticateToken, async (req, res) => {
  const { ownerUid, orderId, shopId } = readLabelQuery(req);
  if (!isValidTikTokId(orderId) || !isValidTikTokId(shopId)) {
    return res.status(400).json({ error: 'Informe orderId e shopId válidos.' });
  }

  try {
    const loaded = await loadTikTokAccountForLabel(ownerUid, shopId);
    if (loaded.error) {
      const failure = accountLoadFailure(loaded.error);
      return res.status(failure.status).json({ canPrint: false, status: 'blocked', reason: failure.reason });
    }
    const { account } = loaded;

    const order = await findTikTokOrderForLabel(ownerUid, shopId, orderId);
    if (!order) {
      return res.status(404).json({
        canPrint: false,
        status: 'blocked',
        reason: 'Pedido TikTok Shop não encontrado no CyberDock. Sincronize as vendas desta loja.',
      });
    }

    const block = labelBlockReason(order);
    if (block) {
      return res.json({ canPrint: false, requiresInvoice: false, code: null, ...block });
    }

    const states = [];
    for (const packageId of order.packageIds.slice(0, 10)) {
      states.push(await readPackageState(account, packageId));
    }

    if (states.some((state) => !state.trackingNumber)) {
      return res.json({
        canPrint: false,
        requiresInvoice: false,
        awaitingShipment: true,
        status: 'awaiting_shipment',
        code: null,
        reason: TIKTOK_AWAITING_SHIPMENT_REASON,
      });
    }

    return res.json({
      canPrint: true,
      status: 'ready',
      trackingNumber: states[0]?.trackingNumber || order.trackingNumber,
      packages: states.length,
      reason: states.length > 1
        ? `Etiquetas prontas para baixar (${states.length} pacotes).`
        : 'Etiqueta pronta para baixar.',
    });
  } catch (error) {
    console.error(`[TikTok Label] Falha ao checar a etiqueta do pedido ${orderId}:`, error.message);
    const fromApi = error instanceof TikTokApiError;
    return res.status(fromApi ? 200 : 500).json({
      canPrint: false,
      status: 'blocked',
      code: fromApi ? error.code : null,
      reason: tiktokLabelMessage(error, 'Não foi possível checar a etiqueta no TikTok Shop agora.'),
    });
  }
});

function looksLikePdf(buffer, contentType) {
  if (/pdf/i.test(contentType || '')) return true;
  return Buffer.isBuffer(buffer) && buffer.slice(0, 5).toString('latin1') === '%PDF-';
}

/** Junta as etiquetas de vários pacotes num único PDF, na ordem dos pacotes. */
async function mergePdfBuffers(buffers) {
  if (buffers.length === 1) return buffers[0];
  const merged = await PDFDocument.create();
  for (const buffer of buffers) {
    const source = await PDFDocument.load(buffer);
    const pages = await merged.copyPages(source, source.getPageIndices());
    pages.forEach((page) => merged.addPage(page));
  }
  return Buffer.from(await merged.save());
}

/** Baixa a etiqueta de todos os pacotes do pedido, com o SKU estampado. */
router.get('/download-label', authenticateToken, async (req, res) => {
  const { ownerUid, orderId, shopId } = readLabelQuery(req);
  if (!isValidTikTokId(orderId) || !isValidTikTokId(shopId)) {
    return res.status(400).json({ error: 'Informe orderId e shopId válidos.' });
  }

  const fail = (status, message, extra = {}) => res.status(status).json({
    error: message,
    code: null,
    requiresInvoice: false,
    ...extra,
  });

  try {
    const loaded = await loadTikTokAccountForLabel(ownerUid, shopId);
    if (loaded.error) {
      const failure = accountLoadFailure(loaded.error);
      return fail(failure.status, failure.reason);
    }
    const { account } = loaded;

    const order = await findTikTokOrderForLabel(ownerUid, shopId, orderId);
    if (!order) return fail(404, 'Pedido TikTok Shop não encontrado no CyberDock. Sincronize as vendas desta loja.');

    const block = labelBlockReason(order);
    if (block) return fail(409, block.reason, { awaitingShipment: Boolean(block.awaitingShipment) });

    const packageIds = order.packageIds.slice(0, 10);
    const documents = [];

    for (const packageId of packageIds) {
      let document;
      try {
        document = await withTikTokTokenRetry(account, (accessToken) => getTikTokPackageShippingDocument({
          accessToken, shopCipher: account.shopCipher, packageId,
        }));
      } catch (error) {
        if (!(error instanceof TikTokApiError)) throw error;
        /* Recusa com o pacote ainda sem rastreio é o caso comum: o envio não
         * foi organizado no Seller Center. Vale a mensagem que diz o que fazer,
         * não o texto cru da API. */
        const state = await readPackageState(account, packageId).catch(() => null);
        if (state && !state.trackingNumber) {
          return fail(409, TIKTOK_AWAITING_SHIPMENT_REASON, { awaitingShipment: true });
        }
        console.warn(`[TikTok Label] Pedido ${orderId}, pacote ${packageId}: ${error.message}`);
        return fail(409, tiktokLabelMessage(error), { code: error.code || null });
      }

      if (!document.docUrl) {
        return fail(409, 'O TikTok Shop não devolveu o documento da etiqueta deste pacote. Tente novamente em alguns minutos.');
      }

      const download = await downloadTikTokDocument(document.docUrl);
      if (!download.ok) {
        console.warn(`[TikTok Label] Download recusado no pedido ${orderId}: ${download.message}`);
        return fail(409, `Não foi possível baixar a etiqueta do TikTok Shop: ${download.message}`);
      }
      documents.push({ packageId, ...download });
    }

    /* SKU estampado na etiqueta, como na Shopee e no Mercado Livre.
     *
     * Nada aqui é impeditivo: sem itens gravados, ou se o PDF não puder ser
     * reescrito, a etiqueta original segue do mesmo jeito. */
    const allPdf = documents.every((doc) => looksLikePdf(doc.buffer, doc.contentType));
    const buffers = [];
    for (const doc of documents) {
      let buffer = doc.buffer;
      if (allPdf) {
        try {
          const packageItems = itemsForPackage(order, doc.packageId, documents.length);
          if (documents.length > 1 && packageItems.length === 0) {
            console.warn(`[TikTok Label] Pacote ${doc.packageId} do pedido ${orderId} sem vínculo item→pacote; etiqueta mantida sem estampa CyberDock.`);
          }
          const lines = buildItemLines(packageItems);
          if (lines.length > 0) buffer = await stampLabelLines(buffer, lines);
        } catch (stampError) {
          console.error(`[TikTok Label] Falha ao estampar o SKU no pedido ${orderId}:`, stampError.message);
        }
      }
      buffers.push(buffer);
    }

    let labelBuffer = buffers[0];
    let contentType = documents[0].contentType || 'application/pdf';
    if (allPdf) {
      try {
        labelBuffer = await mergePdfBuffers(buffers);
        contentType = 'application/pdf';
      } catch (mergeError) {
        console.error(`[TikTok Label] Falha ao juntar as etiquetas do pedido ${orderId}:`, mergeError.message);
        return fail(500, 'Não foi possível juntar as etiquetas dos pacotes deste pedido.');
      }
    } else if (documents.length > 1) {
      return fail(409, 'O TikTok Shop devolveu as etiquetas deste pedido em um formato que não pode ser juntado. Imprima pelo Seller Center.');
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="tiktok-etiqueta-${orderId}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(labelBuffer);
  } catch (error) {
    console.error(`[TikTok Label] Falha ao baixar a etiqueta do pedido ${orderId}:`, error.message);
    const fromApi = error instanceof TikTokApiError;
    return fail(fromApi ? 409 : 500, tiktokLabelMessage(error), { code: fromApi ? error.code : null });
  }
});

/* ------------------------------ Helpers de sync ------------------------------ */

const TIKTOK_JOB_TIMEOUT_MS = configInt('TIKTOK_JOB_TIMEOUT_MS', 900000, 60000, 3600000);
/** Largura de cada janela de update_time. Recortar dá checkpoint e resiliência. */
const WINDOW_DAYS = configInt('TIKTOK_WINDOW_DAYS', 15, 1, 30);
/** Cinto de segurança contra page_token em loop. */
const MAX_PAGES_PER_WINDOW = 500;
/** Página máxima aceita pelo endpoint de pedidos. */
const PAGE_SIZE = 100;

/* Concorrência do abatimento de estoque em lote, igual à da Shopee. */
const PROCESS_CONCURRENCY = configInt('SALES_PROCESS_CONCURRENCY', 4, 1, 8);
const LOCK_CONFLICT_CODES = new Set([
  '40P01', // deadlock_detected
  '40001', // serialization_failure
  '55P03', // lock_not_available
]);

/** Executa `mapper` sobre `items` com no máximo `limit` em voo. */
async function mapWithConcurrency(items, limit, mapper) {
  const out = new Array(items.length);
  let index = 0;

  const worker = async () => {
    for (;;) {
      const current = index++;
      if (current >= items.length) return;
      try {
        out[current] = await mapper(items[current], current);
      } catch {
        out[current] = null;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function assertJobDeadline(deadlineAt, phase) {
  if (Date.now() >= deadlineAt) {
    const error = new Error(`Sincronização TikTok Shop excedeu o limite durante ${phase}. Tente novamente; o próximo ciclo continua do último checkpoint.`);
    error.code = 'TIKTOK_JOB_TIMEOUT';
    throw error;
  }
}

function orderIdOf(order) {
  const id = order?.id;
  return id === undefined || id === null ? '' : String(id);
}

/**
 * Uma janela de update_time completa, seguindo o `next_page_token` até o fim.
 * Deduplica por id: a sobreposição do watermark repete pedidos de propósito.
 */
async function fetchWindowOrders(account, from, to, deadlineAt) {
  const byId = new Map();
  const seenTokens = new Set();
  let pageToken = null;

  for (let page = 0; page < MAX_PAGES_PER_WINDOW; page += 1) {
    assertJobDeadline(deadlineAt, 'listagem de pedidos');
    const result = await withTikTokTokenRetry(account, (accessToken) => searchTikTokOrders({
      accessToken,
      shopCipher: account.shopCipher,
      updateTimeGe: epochSeconds(from),
      updateTimeLt: epochSeconds(to),
      pageSize: PAGE_SIZE,
      pageToken,
      deadlineAt,
    }));

    for (const order of result.orders) {
      const id = orderIdOf(order);
      if (id) byId.set(id, order);
    }

    if (!result.nextPageToken) return Array.from(byId.values());
    if (seenTokens.has(result.nextPageToken)) {
      throw new Error('O TikTok Shop repetiu o page_token da listagem; sincronização interrompida para evitar loop infinito.');
    }
    seenTokens.add(result.nextPageToken);
    pageToken = result.nextPageToken;
  }

  throw new Error(`A janela de pedidos passou de ${MAX_PAGES_PER_WINDOW} páginas; o checkpoint não será avançado.`);
}

function isCancelledLineItem(lineItem) {
  return String(lineItem?.display_status || '').toUpperCase() === 'CANCELLED';
}

/** SKU do item: o seller_sku é o código que o cliente cadastrou no armazém. */
function skuOfLineItem(lineItem, orderId) {
  const raw = lineItem?.seller_sku || lineItem?.sku_id || lineItem?.product_id;
  if (raw) return truncate(String(raw).trim(), 255) || truncate(String(orderId), 255);
  return truncate(String(orderId), 255);
}

/** Na versão 202309 cada line_item é UMA unidade. `quantity` vale se existir. */
function quantityOfLineItem(lineItem) {
  const value = toFiniteNumber(lineItem?.quantity);
  return value && value > 0 ? Math.trunc(value) : 1;
}

function unitValueOfLineItem(lineItem) {
  return toFiniteNumber(lineItem?.sale_price) ?? toFiniteNumber(lineItem?.original_price) ?? 0;
}

/** Prazo de despacho do pedido. `0` é "não se aplica" e vira NULL. */
function shipByDateOf(order) {
  const candidates = [order.rts_sla_time, order.shipping_due_time, order.collection_due_time];
  for (const value of candidates) {
    const epoch = toFiniteNumber(value);
    if (epoch && epoch > 0) return new Date(epoch * 1000);
  }
  return null;
}

/**
 * Mapeia um pedido para uma linha por SKU. A chave de tiktok_sales é
 * (order_id, sku, uid), então line_items do mesmo SKU são somados.
 *
 * Item cancelado sozinho não entra na quantidade a separar. Se o pedido
 * inteiro foi cancelado, as linhas continuam existindo com o status do pedido.
 */
function orderToRows(order, account, nickname) {
  const orderId = orderIdOf(order);
  const createTime = toFiniteNumber(order.create_time);
  // A coluna é TIMESTAMP WITH TIME ZONE: grava o instante real, sem "-3h".
  const saleDate = createTime && createTime > 0 ? new Date(createTime * 1000) : null;
  const lineItems = Array.isArray(order.line_items) ? order.line_items : [];
  const activeItems = lineItems.filter((item) => !isCancelledLineItem(item));
  const items = activeItems.length > 0 ? activeItems : lineItems;

  const grouped = new Map();
  for (const item of items.length > 0 ? items : [{}]) {
    const sku = skuOfLineItem(item, orderId);
    const key = sku.toUpperCase().trim();
    const quantity = quantityOfLineItem(item);
    const current = grouped.get(key) || {
      sku,
      quantity: 0,
      value: 0,
      title: truncate(item?.product_name || item?.sku_name || '', 500) || 'Pedido',
      item,
      lineItemIds: [],
    };
    current.quantity += quantity;
    current.value += Math.max(0, unitValueOfLineItem(item) * quantity);
    if (item?.id) current.lineItemIds.push(String(item.id));
    grouped.set(key, current);
  }

  const packageIds = Array.from(new Set([
    ...(Array.isArray(order.packages) ? order.packages.map((pkg) => pkg?.id) : []),
    ...lineItems.map((item) => item?.package_id),
  ].filter((id) => id !== undefined && id !== null && String(id).trim() !== '').map(String)));

  const firstItem = rec(items[0]);
  const recipient = rec(order.recipient_address);
  const recipientName = truncate(
    recipient.name || [recipient.first_name, recipient.last_name].filter(Boolean).join(' '),
    255
  ) || null;
  const trackingNumber = truncate(String(order.tracking_number || firstItem.tracking_number || ''), 255) || null;
  const carrier = truncate(String(firstItem.shipping_provider_name || order.shipping_provider || ''), 100) || null;
  const shippingType = truncate(String(order.shipping_type || ''), 20).toUpperCase() || null;
  const fulfillmentType = truncate(String(order.fulfillment_type || ''), 40).toUpperCase() || null;
  // FULL é o nome que o resto do sistema já usa para "a expedição é do marketplace".
  const shippingMode = fulfillmentType === 'FULFILLMENT_BY_TIKTOK'
    ? 'FULL'
    : (carrier || (shippingType === 'SELLER' ? 'Envio próprio' : 'TikTok'));
  const orderStatus = truncate(String(order.status || order.order_status || ''), 50).toUpperCase() || 'DESCONHECIDO';

  return Array.from(grouped.values()).map((group) => ({
    orderId,
    sku: group.sku,
    uid: account.uid,
    shopId: account.shopId,
    accountNickname: nickname,
    saleDate,
    productTitle: group.title,
    quantity: group.quantity,
    unitPrice: roundCurrency(group.value / Math.max(1, group.quantity)),
    totalAmount: roundCurrency(group.value),
    orderStatus,
    buyerUsername: truncate(String(order.buyer_nickname || ''), 255) || null,
    recipientName,
    trackingNumber,
    shippingCarrier: carrier,
    shippingMode,
    shippingType,
    fulfillmentType,
    packageIds,
    shipByDate: shipByDateOf(order),
    rawApiData: {
      ...order,
      synced_item: {
        ...rec(group.item),
        synced_line_item_ids: group.lineItemIds,
        synced_quantity: group.quantity,
      },
    },
  }));
}

const UPSERT_QUERY = `
  INSERT INTO public.tiktok_sales AS t (
    order_id, sku, uid, shop_id, account_nickname, sale_date, product_title,
    quantity, unit_price, total_amount, order_status, buyer_username, recipient_name,
    tracking_number, shipping_carrier, shipping_mode, shipping_type, fulfillment_type,
    package_ids, ship_by_date, raw_api_data, updated_at
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
            $19::text[], $20, $21::jsonb, NOW())
  ON CONFLICT (order_id, sku, uid) DO UPDATE SET
    account_nickname = EXCLUDED.account_nickname,
    sale_date        = EXCLUDED.sale_date,
    product_title    = CASE WHEN t.processed_at IS NULL THEN EXCLUDED.product_title ELSE t.product_title END,
    quantity         = CASE WHEN t.processed_at IS NULL THEN EXCLUDED.quantity ELSE t.quantity END,
    unit_price       = CASE WHEN t.processed_at IS NULL THEN EXCLUDED.unit_price ELSE t.unit_price END,
    total_amount     = CASE WHEN t.processed_at IS NULL THEN EXCLUDED.total_amount ELSE t.total_amount END,
    order_status     = EXCLUDED.order_status,
    buyer_username   = EXCLUDED.buyer_username,
    recipient_name   = EXCLUDED.recipient_name,
    tracking_number  = EXCLUDED.tracking_number,
    shipping_carrier = EXCLUDED.shipping_carrier,
    shipping_mode    = EXCLUDED.shipping_mode,
    shipping_type    = EXCLUDED.shipping_type,
    fulfillment_type = EXCLUDED.fulfillment_type,
    package_ids      = EXCLUDED.package_ids,
    ship_by_date     = EXCLUDED.ship_by_date,
    raw_api_data     = EXCLUDED.raw_api_data,
    updated_at       = NOW()
  /* Só conta como "atualizada" quando algum valor gravado realmente muda, pelo
   * mesmo motivo documentado na Shopee: sem isto toda linha recebia
   * updated_at=NOW() e voltava como atualizada sem mudança remota. */
  WHERE ROW(
          t.account_nickname, t.sale_date, t.order_status, t.buyer_username,
          t.recipient_name, t.tracking_number, t.shipping_carrier, t.shipping_mode,
          t.shipping_type, t.fulfillment_type, t.package_ids, t.ship_by_date, t.raw_api_data,
          CASE WHEN t.processed_at IS NULL THEN t.product_title END,
          CASE WHEN t.processed_at IS NULL THEN t.quantity END,
          CASE WHEN t.processed_at IS NULL THEN t.unit_price END,
          CASE WHEN t.processed_at IS NULL THEN t.total_amount END
        ) IS DISTINCT FROM ROW(
          EXCLUDED.account_nickname, EXCLUDED.sale_date, EXCLUDED.order_status, EXCLUDED.buyer_username,
          EXCLUDED.recipient_name, EXCLUDED.tracking_number, EXCLUDED.shipping_carrier, EXCLUDED.shipping_mode,
          EXCLUDED.shipping_type, EXCLUDED.fulfillment_type, EXCLUDED.package_ids, EXCLUDED.ship_by_date,
          EXCLUDED.raw_api_data,
          CASE WHEN t.processed_at IS NULL THEN EXCLUDED.product_title END,
          CASE WHEN t.processed_at IS NULL THEN EXCLUDED.quantity END,
          CASE WHEN t.processed_at IS NULL THEN EXCLUDED.unit_price END,
          CASE WHEN t.processed_at IS NULL THEN EXCLUDED.total_amount END
        )
  RETURNING (xmax = 0) AS inserted;
`;

async function upsertRow(row, executor) {
  const result = await executor.query(UPSERT_QUERY, [
    row.orderId,
    row.sku,
    row.uid,
    row.shopId,
    row.accountNickname,
    row.saleDate,
    row.productTitle,
    row.quantity,
    row.unitPrice,
    row.totalAmount,
    row.orderStatus,
    row.buyerUsername,
    row.recipientName,
    row.trackingNumber,
    row.shippingCarrier,
    row.shippingMode,
    row.shippingType,
    row.fulfillmentType,
    row.packageIds,
    row.shipByDate,
    JSON.stringify(row.rawApiData),
  ]);
  if (result.rowCount === 0) return 'skipped';
  return result.rows[0].inserted ? 'inserted' : 'updated';
}

/**
 * Remove SKU que saiu do pedido (item cancelado ou trocado) enquanto nada dele
 * foi processado. Sem isto a fila de separação continuaria pedindo um item que
 * o comprador já não vai receber.
 */
async function deleteStaleRows(orderId, uid, skus, executor) {
  const result = await executor.query(
    `DELETE FROM public.tiktok_sales
      WHERE uid = $1 AND order_id = $2
        AND processed_at IS NULL
        AND NOT (sku = ANY($3::text[]))`,
    [uid, orderId, skus]
  );
  return result.rowCount;
}

/**
 * Pedido com estoque já baixado nunca ganha nem perde linha de SKU. Só os
 * metadados operacionais são atualizados, em TODAS as linhas do pedido, e cada
 * linha mantém o próprio item sincronizado no payload.
 */
async function updateOrderMetadata(orderId, uid, row, executor) {
  const result = await executor.query(
    `UPDATE public.tiktok_sales t
        SET account_nickname = $3,
            order_status = $4,
            buyer_username = $5,
            recipient_name = $6,
            tracking_number = $7,
            shipping_carrier = $8,
            shipping_mode = $9,
            shipping_type = $10,
            fulfillment_type = $11,
            package_ids = $12::text[],
            ship_by_date = $13,
            raw_api_data = jsonb_set($14::jsonb, '{synced_item}',
                                     COALESCE(t.raw_api_data->'synced_item', 'null'::jsonb), TRUE),
            updated_at = NOW()
      WHERE t.order_id = $1
        AND t.uid = $2
        AND ROW(
          t.account_nickname, t.order_status, t.buyer_username, t.recipient_name,
          t.tracking_number, t.shipping_carrier, t.shipping_mode, t.shipping_type,
          t.fulfillment_type, t.package_ids, t.ship_by_date, t.raw_api_data
        ) IS DISTINCT FROM ROW(
          $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::text[], $13,
          jsonb_set($14::jsonb, '{synced_item}',
                    COALESCE(t.raw_api_data->'synced_item', 'null'::jsonb), TRUE)
        )`,
    [
      orderId,
      uid,
      row.accountNickname,
      row.orderStatus,
      row.buyerUsername,
      row.recipientName,
      row.trackingNumber,
      row.shippingCarrier,
      row.shippingMode,
      row.shippingType,
      row.fulfillmentType,
      row.packageIds,
      row.shipByDate,
      JSON.stringify(row.rawApiData),
    ]
  );
  return result.rowCount;
}

/* --------------------------- Sincronização (SSE) --------------------------- */
router.post('/sync-account', authenticateToken, async (req, res) => {
  const { shopId, clientId: rawClientId, force, clientUid } = req.body || {};
  const requesterUid = String(req.user.uid || '');
  const clientId = String(rawClientId || '').trim();
  const streamKey = syncStreamKey(requesterUid, clientId);
  let targetUid = clientUid || requesterUid;
  let nickname = String(shopId || 'TikTok Shop');
  let lockAcquired = false;
  let leaseLost = false;
  let leaseTimer = null;
  const startedAt = Date.now();
  const deadlineAt = startedAt + TIKTOK_JOB_TIMEOUT_MS;

  if (!shopId || !clientId) return res.status(400).json({ error: 'shopId e clientId são obrigatórios.' });
  if (!isValidSyncClientId(clientId)) return res.status(400).json({ error: 'clientId inválido.' });
  const normalizedShopId = String(shopId).trim();
  if (!isValidTikTokId(normalizedShopId)) return res.status(400).json({ error: 'shopId inválido.' });

  try {
    let accRes;
    if (req.user.role === 'master' && clientUid) {
      accRes = await db.query('SELECT * FROM public.tiktok_accounts WHERE shop_id = $1 AND uid = $2', [normalizedShopId, clientUid]);
    } else if (req.user.role === 'master') {
      accRes = await db.query('SELECT * FROM public.tiktok_accounts WHERE shop_id = $1 LIMIT 1', [normalizedShopId]);
    } else {
      accRes = await db.query('SELECT * FROM public.tiktok_accounts WHERE shop_id = $1 AND uid = $2', [normalizedShopId, req.user.uid]);
    }
    if (accRes.rowCount === 0) {
      finalizeJob(streamKey, { message: 'Loja TikTok Shop não encontrada.', type: 'error' });
      return res.status(404).json({ error: 'Loja TikTok Shop não encontrada.' });
    }

    const accRow = accRes.rows[0];
    targetUid = accRow.uid;
    nickname = accRow.shop_name || String(accRow.shop_id);

    if (missingTikTokCredentials().length) {
      const message = `[${nickname}] A integração TikTok Shop não está configurada no servidor.`;
      finalizeJob(streamKey, { message, type: 'error' });
      return res.status(503).json({ error: message, missing: missingTikTokCredentials() });
    }

    // Limpa IDs vencidos antes da verificação idempotente; client_id é global
    // e jamais pode ser reaproveitado por outro solicitante enquanto existir.
    await db.query('DELETE FROM public.tiktok_sync_jobs WHERE expires_at < NOW()');

    // POST idempotente por clientId: um 202 perdido pode ser repetido. A linha
    // é lida pelo id global e depois conferida contra solicitante, dono e loja.
    const existingJob = await db.query(
      `SELECT requester_uid, uid, shop_id, status, result, error
         FROM public.tiktok_sync_jobs
        WHERE client_id = $1 AND expires_at > NOW()`,
      [clientId]
    );
    if (existingJob.rowCount > 0) {
      const job = existingJob.rows[0];
      if (job.requester_uid !== requesterUid
          || job.uid !== targetUid
          || String(job.shop_id) !== normalizedShopId) {
        const message = 'clientId já utilizado por outra sincronização.';
        finalizeJob(streamKey, { message, type: 'error' });
        return res.status(409).json({ error: message });
      }
      if (job.status === 'success' || job.status === 'error') {
        finalizeJob(streamKey, job.result || { type: job.status, message: job.error || 'Sincronização finalizada.' });
      }
      return res.status(job.status === 'running' ? 202 : 200).json({
        message: 'Job TikTok Shop já registrado.',
        status: job.status,
        ...(job.result || {}),
      });
    }

    // Clique repetido logo depois de um sucesso não vale uma varredura nova.
    if (!force) {
      const cooldownSeconds = configInt('TIKTOK_SYNC_COOLDOWN_SECONDS', 60, 0, 3600);
      if (cooldownSeconds > 0) {
        const recent = await db.query(
          `SELECT last_result,
                  EXTRACT(EPOCH FROM (NOW() - last_success_at))::int AS age_seconds
             FROM public.tiktok_sync_cursors
            WHERE uid = $1 AND shop_id = $2
              AND status = 'success'
              AND last_success_at > NOW() - ($3::int * interval '1 second')`,
          [targetUid, normalizedShopId, cooldownSeconds]
        );
        if (recent.rowCount > 0) {
          const age = recent.rows[0].age_seconds ?? 0;
          const payload = {
            ...(recent.rows[0].last_result || {}),
            message: `[${nickname}] Já estava atualizada (sincronizada há ${age}s).`,
            type: 'success',
            newSalesCount: 0,
            updatedCount: 0,
            skippedCount: 0,
            fromCooldown: true,
          };
          const durable = await db.query(
            `INSERT INTO public.tiktok_sync_jobs
               (client_id, requester_uid, uid, shop_id, status, result, error, updated_at)
             VALUES ($1, $2, $3, $4, 'success', $5::jsonb, NULL, NOW())
             ON CONFLICT (client_id) DO UPDATE SET
               status = 'success', result = EXCLUDED.result, error = NULL, updated_at = NOW()
             WHERE public.tiktok_sync_jobs.requester_uid = EXCLUDED.requester_uid
               AND public.tiktok_sync_jobs.uid = EXCLUDED.uid
               AND public.tiktok_sync_jobs.shop_id = EXCLUDED.shop_id
             RETURNING client_id`,
            [clientId, requesterUid, targetUid, normalizedShopId, JSON.stringify(payload)]
          );
          if (durable.rowCount !== 1) {
            const message = 'clientId já utilizado por outra sincronização.';
            finalizeJob(streamKey, { message, type: 'error' });
            return res.status(409).json({ error: message });
          }
          finalizeJob(streamKey, payload);
          return res.status(200).json({ status: 'success', ...payload });
        }
      }
    }

    // Lock durável: funciona entre instâncias e expira se o processo cair.
    const lockDurationMs = TIKTOK_JOB_TIMEOUT_MS + 2 * 60 * 1000;
    const lockResult = await db.query(
      `INSERT INTO public.tiktok_sync_cursors
         (uid, shop_id, status, job_id, last_attempt_at, locked_until, updated_at)
       VALUES ($1, $2, 'running', $3, NOW(), NOW() + ($4::int * interval '1 millisecond'), NOW())
       ON CONFLICT (uid, shop_id) DO UPDATE SET
         status = 'running', job_id = EXCLUDED.job_id,
         last_attempt_at = NOW(), locked_until = EXCLUDED.locked_until,
         last_error = NULL, last_result = NULL, updated_at = NOW()
       WHERE public.tiktok_sync_cursors.status <> 'running'
          OR public.tiktok_sync_cursors.locked_until IS NULL
          OR public.tiktok_sync_cursors.locked_until < NOW()
       RETURNING *`,
      [targetUid, normalizedShopId, clientId, lockDurationMs]
    );

    if (lockResult.rowCount === 0) {
      const owner = await db.query(
        'SELECT job_id FROM public.tiktok_sync_cursors WHERE uid = $1 AND shop_id = $2',
        [targetUid, normalizedShopId]
      );
      if (owner.rows[0]?.job_id === clientId) {
        return res.status(202).json({ message: 'Sincronização TikTok Shop já iniciada.', status: 'running' });
      }
      const message = `[${nickname}] Já existe uma sincronização TikTok Shop em andamento.`;
      finalizeJob(streamKey, { message, type: 'error', alreadyRunning: true });
      return res.status(409).json({ error: message, alreadyRunning: true });
    }
    lockAcquired = true;
    const cursorState = lockResult.rows[0];

    await db.query(
      `INSERT INTO public.tiktok_sync_jobs (client_id, requester_uid, uid, shop_id, status)
       VALUES ($1, $2, $3, $4, 'running')`,
      [clientId, requesterUid, targetUid, normalizedShopId]
    );

    leaseTimer = setInterval(async () => {
      try {
        const renewed = await db.query(
          `UPDATE public.tiktok_sync_cursors
              SET locked_until = NOW() + ($1::int * interval '1 millisecond'), updated_at = NOW()
            WHERE uid = $2 AND shop_id = $3 AND job_id = $4 AND status = 'running'
          RETURNING job_id`,
          [lockDurationMs, targetUid, normalizedShopId, clientId]
        );
        if (renewed.rowCount !== 1) leaseLost = true;
      } catch (error) {
        console.warn(`[tiktok-sync] ${nickname}: falha ao renovar lease:`, error.message);
      }
    }, 30000);

    const ensureLease = () => {
      if (leaseLost) throw new Error('A sincronização perdeu o lock da loja e foi interrompida com segurança.');
    };

    res.status(202).json({ message: 'Sincronização TikTok Shop iniciada. Acompanhe status.' });
    sendEvent(streamKey, { progress: 10, message: `[${nickname}] Preparando sincronização...`, type: 'info' });

    if (!accRow.shop_cipher) {
      throw new Error(`[${nickname}] Loja sem shop_cipher gravado. Reconecte a loja TikTok Shop em Contas.`);
    }

    const account = {
      uid: accRow.uid,
      shopId: String(accRow.shop_id),
      shopName: accRow.shop_name,
      shopCipher: accRow.shop_cipher,
      openId: accRow.open_id,
      accessToken: accRow.access_token,
      refreshToken: accRow.refresh_token,
      expiresAt: accRow.expires_at,
    };

    const expiresAt = accRow.expires_at ? new Date(accRow.expires_at).getTime() : 0;
    if (expiresAt - Date.now() < 30 * 60 * 1000) {
      assertJobDeadline(deadlineAt, 'renovação do token');
      sendEvent(streamKey, { progress: 15, message: `[${nickname}] Renovando token...`, type: 'info' });
      await ensureTikTokAccessToken(account);
    }

    /* Janela de busca.
     *
     * Primeira carga e "forçar" olham o período inteiro de lookback. Depois,
     * cada execução recomeça do watermark menos uma sobreposição curta: a doc
     * avisa que o update_time devolvido pode cair fora da janela pedida, porque
     * o pedido muda durante a varredura. De tempo em tempo uma execução volta
     * 24h, como rede de segurança — a mesma regra da Shopee. */
    const lookbackDays = configInt('TIKTOK_LOOKBACK_DAYS', 120, 1, 365);
    const oldestUseful = new Date(Date.now() - lookbackDays * 86400000);
    const upperBound = new Date(Math.floor(Date.now() / 1000) * 1000);
    const watermark = cursorState.update_time_scanned_through
      ? new Date(cursorState.update_time_scanned_through)
      : null;

    let since;
    let mode;
    let isDeepSweep = false;
    if (force || !watermark) {
      since = oldestUseful;
      mode = watermark ? 'force' : 'initial';
    } else {
      const overlapMinutes = configInt('TIKTOK_OVERLAP_MINUTES', 15, 1, 1440);
      const deepSweepHours = configInt('TIKTOK_DEEP_SWEEP_HOURS', 12, 1, 168);
      const baseline = cursorState.last_deep_sweep_at
        || cursorState.last_success_at
        || cursorState.initial_backfill_completed_at;
      isDeepSweep = !baseline || (Date.now() - new Date(baseline).getTime()) > deepSweepHours * 3600000;
      const overlapMs = isDeepSweep ? 86400000 : overlapMinutes * 60000;
      since = new Date(Math.max(oldestUseful.getTime(), watermark.getTime() - overlapMs));
      mode = 'incremental';
    }

    console.log(`[tiktok-sync] ${nickname}: ${mode} update_time ${since.toISOString()} -> ${upperBound.toISOString()}`);
    sendEvent(streamKey, {
      progress: 20,
      message: mode === 'incremental'
        ? `[${nickname}] Buscando pedidos novos e atualizados...`
        : `[${nickname}] Sincronização completa iniciada...`,
      type: 'info',
    });

    let insertedItems = 0;
    let updatedItems = 0;
    let skippedItems = 0;
    let removedItems = 0;
    let savedOrders = 0;
    let ignoredUnpaid = 0;
    let windowsDone = 0;
    let totalOrders = 0;

    const saveWindow = async (orders, windowEnd) => {
      ensureLease();
      // Pedido sem pagamento ainda não é venda e não pode entrar na separação.
      const payable = orders.filter((order) => {
        const status = String(order.status || order.order_status || '').toUpperCase();
        if (status === 'UNPAID') {
          ignoredUnpaid += 1;
          return false;
        }
        return true;
      });

      if (payable.length > 0) {
        assertJobDeadline(deadlineAt, 'gravação dos pedidos');
        const ids = payable.map(orderIdOf);
        const processedResult = await db.query(
          `SELECT order_id
             FROM public.tiktok_sales
            WHERE uid = $1 AND shop_id = $2 AND order_id = ANY($3::text[])
            GROUP BY order_id
           HAVING bool_or(processed_at IS NOT NULL)`,
          [targetUid, normalizedShopId, ids]
        );
        const processedOrders = new Set(processedResult.rows.map((row) => String(row.order_id)));

        const SAVE_CONCURRENCY = configInt('TIKTOK_SAVE_CONCURRENCY', 3, 1, 8);
        let saveIndex = 0;
        let aborted = false;

        const saveWorker = async () => {
          while (saveIndex < payable.length) {
            if (aborted) return;
            const order = payable[saveIndex++];
            try {
              ensureLease();
              assertJobDeadline(deadlineAt, 'gravação dos pedidos');

              const orderId = orderIdOf(order);
              const rows = orderToRows(order, account, nickname);
              for (const row of rows) row.uid = targetUid;

              // Transação por pedido: um pedido multi-SKU nunca fica pela metade.
              const orderClient = await db.pool.connect();
              try {
                await orderClient.query('BEGIN');
                if (processedOrders.has(orderId)) {
                  const affected = await updateOrderMetadata(orderId, targetUid, rows[0], orderClient);
                  if (affected > 0) updatedItems += affected;
                  else skippedItems += rows.length;
                } else {
                  for (const row of rows) {
                    const outcome = await upsertRow(row, orderClient);
                    if (outcome === 'inserted') insertedItems += 1;
                    else if (outcome === 'updated') updatedItems += 1;
                    else skippedItems += 1;
                  }
                  removedItems += await deleteStaleRows(orderId, targetUid, rows.map((row) => row.sku), orderClient);
                }
                await orderClient.query('COMMIT');
              } catch (orderError) {
                try { await orderClient.query('ROLLBACK'); } catch { /* já encerrada */ }
                throw orderError;
              } finally {
                orderClient.release();
              }
              savedOrders += 1;
            } catch (error) {
              aborted = true;
              throw error;
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(SAVE_CONCURRENCY, payable.length) }, () => saveWorker()));
      }

      // Checkpoint: a janela foi listada e gravada por completo. As janelas vão
      // em ordem crescente de update_time, então nunca sobra buraco para trás.
      const checkpoint = await db.query(
        `UPDATE public.tiktok_sync_cursors
            SET update_time_scanned_through = GREATEST(COALESCE(update_time_scanned_through, $1), $1),
                updated_at = NOW()
          WHERE uid = $2 AND shop_id = $3 AND job_id = $4 AND status = 'running'
        RETURNING job_id`,
        [windowEnd, targetUid, normalizedShopId, clientId]
      );
      if (checkpoint.rowCount !== 1) {
        leaseLost = true;
        ensureLease();
      }
    };

    let windowStart = since;
    while (windowStart < upperBound) {
      assertJobDeadline(deadlineAt, 'varredura das janelas');
      const windowEnd = new Date(Math.min(windowStart.getTime() + WINDOW_DAYS * 86400000, upperBound.getTime()));
      const orders = await fetchWindowOrders(account, windowStart, windowEnd, deadlineAt);
      totalOrders += orders.length;
      await saveWindow(orders, windowEnd);
      windowsDone += 1;

      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      console.log(`[tiktok-sync] ${nickname}: janela ${windowsDone} ok, ${orders.length} pedido(s), até ${windowEnd.toISOString()}, ${elapsed}s`);
      sendEvent(streamKey, {
        progress: Math.min(95, 20 + windowsDone * 8),
        message: `[${nickname}] ${windowsDone} janela(s) concluída(s), ${totalOrders} pedido(s) verificados...`,
        type: 'info',
        newSalesCount: insertedItems,
        updatedCount: updatedItems,
        skippedCount: skippedItems,
      });

      // `update_time_lt` é exclusivo: a próxima janela começa exatamente aqui.
      windowStart = windowEnd;
    }

    ensureLease();
    assertJobDeadline(deadlineAt, 'finalização');

    const terminalPayload = {
      message: totalOrders === 0
        ? `[${nickname}] Sincronização concluída; nenhum pedido novo ou atualizado.`
        : `[${nickname}] Concluída: ${savedOrders} pedido(s), ${insertedItems} item(ns) novo(s) e ${updatedItems} atualizado(s).`,
      type: 'success',
      newSalesCount: insertedItems,
      updatedCount: updatedItems,
      skippedCount: skippedItems,
      removedCount: removedItems,
    };

    // Watermark e resultado terminal na mesma transação. O UPDATE ... RETURNING
    // é o fencing: sem a posse do job não existe sucesso.
    clearInterval(leaseTimer);
    leaseTimer = null;
    const finishClient = await db.pool.connect();
    try {
      await finishClient.query('BEGIN');
      const cursorUpdate = await finishClient.query(
        `UPDATE public.tiktok_sync_cursors
            SET update_time_scanned_through = GREATEST(
                  COALESCE(update_time_scanned_through, TIMESTAMPTZ '-infinity'),
                  $1::timestamptz
                ),
                initial_backfill_completed_at = CASE
                  WHEN $2 = 'initial' THEN COALESCE(initial_backfill_completed_at, NOW())
                  ELSE initial_backfill_completed_at
                END,
                last_deep_sweep_at = CASE
                  WHEN $3::boolean THEN NOW() ELSE last_deep_sweep_at
                END,
                last_success_at = NOW(), status = 'success', last_error = NULL,
                last_result = $4::jsonb, locked_until = NULL, updated_at = NOW()
          WHERE uid = $5 AND shop_id = $6 AND job_id = $7 AND status = 'running'
        RETURNING job_id`,
        [upperBound, mode, isDeepSweep || mode !== 'incremental', JSON.stringify(terminalPayload),
          targetUid, normalizedShopId, clientId]
      );
      if (cursorUpdate.rowCount !== 1) throw new Error('A sincronização perdeu a posse do lock antes da conclusão.');

      const jobUpdate = await finishClient.query(
        `UPDATE public.tiktok_sync_jobs
            SET status = 'success', result = $1::jsonb, error = NULL, updated_at = NOW()
          WHERE client_id = $2 AND requester_uid = $3 AND uid = $4 AND shop_id = $5
            AND status = 'running'
        RETURNING client_id`,
        [JSON.stringify(terminalPayload), clientId, requesterUid, targetUid, normalizedShopId]
      );
      if (jobUpdate.rowCount !== 1) throw new Error('O estado terminal do job TikTok Shop não pôde ser persistido.');
      await finishClient.query('COMMIT');
    } catch (finishError) {
      try { await finishClient.query('ROLLBACK'); } catch { /* já encerrada */ }
      throw finishError;
    } finally {
      finishClient.release();
    }
    lockAcquired = false;

    const durationSeconds = Math.round((Date.now() - startedAt) / 1000);
    console.log(
      `[tiktok-sync] ${nickname}: concluído em ${durationSeconds}s; pedidos=${savedOrders}, ` +
      `novos=${insertedItems}, atualizados=${updatedItems}, sem mudança=${skippedItems}, ` +
      `removidos=${removedItems}, sem pagamento ignorados=${ignoredUnpaid}`
    );
    finalizeJob(streamKey, terminalPayload);
  } catch (error) {
    console.error(`[tiktok-sync] ${nickname} falhou após ${Date.now() - startedAt}ms:`, error.message);
    const userMessage = error instanceof TikTokApiError && error.isInvalidToken
      ? `[${nickname}] A autorização desta loja no TikTok Shop expirou ou foi revogada. Reconecte a loja em Contas.`
      : (error.message || 'Erro na sincronização TikTok Shop.');
    const errorPayload = { message: userMessage, type: 'error' };
    clearInterval(leaseTimer);
    leaseTimer = null;
    try {
      if (lockAcquired) {
        await db.query(
          `UPDATE public.tiktok_sync_cursors
              SET status = 'error', last_error = $1, last_result = $2::jsonb,
                  locked_until = NULL, updated_at = NOW()
            WHERE uid = $3 AND shop_id = $4 AND job_id = $5`,
          [String(error.message || error).slice(0, 2000), JSON.stringify(errorPayload), targetUid, normalizedShopId, clientId]
        );
      }
      await db.query(
        `UPDATE public.tiktok_sync_jobs
            SET status = 'error', result = $1::jsonb, error = $2, updated_at = NOW()
          WHERE client_id = $3 AND requester_uid = $4 AND uid = $5 AND shop_id = $6
            AND status = 'running'`,
        [JSON.stringify(errorPayload), String(error.message || error).slice(0, 2000),
          clientId, requesterUid, targetUid, normalizedShopId]
      );
    } catch (stateError) {
      console.error('[tiktok-sync] falha ao persistir estado do job:', stateError.message);
    }
    finalizeJob(streamKey, errorPayload);
    if (!res.headersSent) res.status(500).json({ error: userMessage });
  }
});

router.get('/last-sync/:shopId', authenticateToken, async (req, res) => {
  try {
    const { shopId } = req.params;
    let targetUid = req.user.uid;
    // Só o master consulta a loja de outro dono.
    if (req.user.role === 'master') {
      if (req.query.clientUid) {
        targetUid = String(req.query.clientUid);
      } else {
        const owner = await db.query('SELECT uid FROM public.tiktok_accounts WHERE shop_id = $1 LIMIT 1', [shopId]);
        if (owner.rowCount > 0) targetUid = owner.rows[0].uid;
      }
    }

    const lastSyncRes = await db.query(
      `SELECT last_success_at, update_time_scanned_through, status, last_error
         FROM public.tiktok_sync_cursors
        WHERE uid = $1 AND shop_id = $2`,
      [targetUid, shopId]
    );
    const cursor = lastSyncRes.rows[0] || null;
    const lastSync = cursor?.last_success_at || null;
    res.json({
      lastSync: lastSync ? new Date(lastSync).toISOString() : null,
      scannedThrough: cursor?.update_time_scanned_through
        ? new Date(cursor.update_time_scanned_through).toISOString()
        : null,
      status: cursor?.status || 'never',
      lastError: cursor?.last_error || null,
      shopId,
      message: lastSync ? 'Última sincronização encontrada' : 'Nunca sincronizada',
    });
  } catch (error) {
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

/* --------------------------------- Vendas --------------------------------- */

const SALE_COLUMNS = `order_id, sku, uid, shop_id, account_nickname, sale_date, product_title,
  quantity, unit_price, total_amount, order_status, buyer_username, recipient_name,
  tracking_number, shipping_carrier, shipping_mode, shipping_type, fulfillment_type,
  package_ids, ship_by_date, shipping_status, raw_api_data, updated_at, processed_at`;

router.get('/all', authenticateToken, requireMaster, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = (page - 1) * limit;
    const search = String(req.query.search || '').trim();
    const account = String(req.query.account || '').trim();

    const conditions = [];
    const params = [];
    let paramIdx = 1;

    if (search) {
      conditions.push(`(
        s.product_title ILIKE $${paramIdx}
        OR s.sku ILIKE $${paramIdx}
        OR s.account_nickname ILIKE $${paramIdx}
        OR u.name ILIKE $${paramIdx}
        OR s.order_id ILIKE $${paramIdx}
      )`);
      params.push(`%${search}%`);
      paramIdx++;
    }
    if (account) {
      conditions.push(`(s.shop_id = $${paramIdx} OR s.account_nickname ILIKE $${paramIdx + 1})`);
      params.push(account, `%${account}%`);
      paramIdx += 2;
    }
    conditions.push('COALESCE(u.active, true) = true');
    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const countResult = await db.query(
      `SELECT COUNT(*) AS total FROM public.tiktok_sales s LEFT JOIN public.users u ON s.uid = u.uid ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].total, 10);

    const dataResult = await db.query(
      `SELECT s.order_id, s.sku, s.uid, s.shop_id, s.account_nickname, s.sale_date,
              s.product_title, s.quantity, s.unit_price, s.total_amount, s.order_status,
              s.buyer_username, s.recipient_name, s.tracking_number, s.shipping_carrier,
              s.shipping_mode, s.shipping_type, s.fulfillment_type, s.package_ids,
              s.ship_by_date, s.shipping_status, s.raw_api_data, s.updated_at, s.processed_at,
              u.name AS user_nickname,
              EXISTS (SELECT 1 FROM public.skus sk WHERE sk.user_id = s.uid AND UPPER(TRIM(sk.sku)) = UPPER(TRIM(s.sku)) AND sk.ativo = true) AS is_sku_mapped
         FROM public.tiktok_sales s
         LEFT JOIN public.users u ON s.uid = u.uid
         ${whereClause}
        ORDER BY s.sale_date DESC NULLS LAST
        LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, limit, offset]
    );

    res.json({ data: dataResult.rows, total, page, limit, totalPages: Math.ceil(total / limit) || 1 });
  } catch (error) {
    console.error('Erro ao buscar vendas TikTok Shop (master):', error);
    res.status(500).json({ error: 'Erro interno ao buscar vendas TikTok Shop.' });
  }
});

router.get('/user/:uid', authenticateToken, requireMaster, async (req, res) => {
  const { uid } = req.params;
  if (!uid) return res.status(400).json({ error: 'O UID do usuário é obrigatório.' });
  try {
    const { rows } = await db.query(
      `SELECT ${SALE_COLUMNS} FROM public.tiktok_sales WHERE uid = $1 ORDER BY sale_date DESC NULLS LAST LIMIT 250`,
      [uid]
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Erro interno ao buscar vendas.' });
  }
});

router.get('/my-sales', authenticateToken, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT ${SALE_COLUMNS} FROM public.tiktok_sales WHERE uid = $1 ORDER BY sale_date DESC NULLS LAST LIMIT 250`,
      [req.user.uid]
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Erro interno ao buscar vendas.' });
  }
});

/** Abatimento de estoque para pedidos TikTok — mesmo fluxo seguro da Shopee. */
router.post('/process', authenticateToken, requireMaster, async (req, res) => {
  const { salesToProcess } = req.body || {};
  const MAX_PROCESS_BATCH = 500;

  if (!Array.isArray(salesToProcess) || salesToProcess.length === 0) {
    return res.status(400).json({ error: 'Nenhuma venda para processar.' });
  }
  if (salesToProcess.length > MAX_PROCESS_BATCH) {
    return res.status(400).json({ error: `O lote excede o limite de ${MAX_PROCESS_BATCH} vendas.` });
  }

  // A quantidade enviada pelo navegador é ignorada: vale a linha bloqueada no banco.
  const sanitized = salesToProcess.map((sale) => ({
    orderId: String(sale?.orderId || sale?.order_id || sale?.id || '').trim(),
    sku: String(sale?.sku || '').trim(),
    uid: String(sale?.uid || '').trim(),
  }));

  const results = { success: [], failed: [] };

  /** Processa UM pedido, na própria conexão e na própria transação. */
  const runOne = async (requestedSale) => {
    if (!requestedSale.orderId || !requestedSale.sku || !requestedSale.uid) {
      throw new Error('Dados da venda incompletos (orderId, sku e uid).');
    }

    const client = await db.pool.connect();
    try {
      try {
        await client.query('BEGIN');

        // O lock da venda vem antes do estoque: requisições concorrentes para o
        // mesmo item ficam serializadas e só uma faz a baixa.
        const saleResult = await client.query(
          `SELECT order_id, sku, uid, quantity, processed_at
             FROM public.tiktok_sales
            WHERE order_id = $1
              AND UPPER(TRIM(sku)) = UPPER(TRIM($2))
              AND uid = $3
            FOR UPDATE`,
          [requestedSale.orderId, requestedSale.sku, requestedSale.uid]
        );
        if (saleResult.rowCount === 0) throw new Error('Venda TikTok Shop não encontrada.');
        if (saleResult.rowCount > 1) throw new Error(`A venda possui SKU duplicado normalizado: '${requestedSale.sku}'.`);

        const sale = saleResult.rows[0];
        if (sale.processed_at) {
          await client.query('COMMIT');
          return { orderId: sale.order_id, sku: sale.sku, alreadyProcessed: true };
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
              [component.child_sku_id, sale.uid, required, `Saída por Kit (TikTok Shop) - Pedido ${sale.order_id}`, sale.order_id]
            );
          }

          // O movimento do kit registra a quantidade comercial; o estoque físico
          // sai dos componentes acima.
          await client.query(
            `INSERT INTO public.stock_movements
               (sku_id, user_id, movement_type, quantity_change, reason, related_sale_id, external_sale_id)
             VALUES ($1, $2, 'saida', $3, $4, NULL, $5)`,
            [stock.id, sale.uid, quantity, `Saída por Venda TikTok Shop - Pedido ${sale.order_id}`, sale.order_id]
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
            [stock.id, sale.uid, quantity, `Saída por Venda TikTok Shop - Pedido ${sale.order_id}`, sale.order_id]
          );
        }

        const updateResult = await client.query(
          `UPDATE public.tiktok_sales
              SET processed_at = NOW(), updated_at = NOW()
            WHERE order_id = $1
              AND UPPER(TRIM(sku)) = UPPER(TRIM($2))
              AND uid = $3
              AND processed_at IS NULL
          RETURNING order_id, sku, processed_at`,
          [sale.order_id, sale.sku, sale.uid]
        );
        if (updateResult.rowCount !== 1) throw new Error('Venda não pôde ser marcada como processada.');

        await client.query('COMMIT');
        return { orderId: sale.order_id, sku: sale.sku, alreadyProcessed: false };
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* transação já encerrada */ }
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

    // Disputa de lock entre pedidos do mesmo lote não é erro do operador:
    // esses casos voltam em série, onde não há disputa.
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
        orderId: outcome?.sale?.orderId ?? null,
        sku: outcome?.sale?.sku ?? null,
        reason: outcome?.error?.message || 'Falha inesperada ao processar a venda.',
      });
    }

    for (const sale of contended) {
      try {
        results.success.push(await runOne(sale));
      } catch (error) {
        results.failed.push({ orderId: sale.orderId, sku: sale.sku, reason: error.message });
      }
    }

    return res.json({ message: 'Processamento concluído.', ...results });
  } catch (error) {
    console.error('Erro crítico no processamento em lote (TikTok Shop):', error);
    return res.status(500).json({ error: 'Erro crítico no processamento em lote.' });
  }
});

/**
 * Status de expedição de uma venda TikTok (equivalente a /shopee/status).
 *
 * Usuário comum só altera as próprias vendas; o master altera de qualquer dono.
 */
router.put('/status', authenticateToken, async (req, res) => {
  const body = req.body || {};
  const orderId = String(body.orderId || body.order_id || body.orderSn || '').trim();
  const sku = String(body.sku || '').trim();
  const uid = String(body.uid || '').trim();
  const shippingStatus = String(body.shippingStatus || '').trim();
  if (!orderId || !sku || !uid || !shippingStatus) {
    return res.status(400).json({ error: 'orderId, sku, uid e shippingStatus são obrigatórios.' });
  }
  if (req.user.role !== 'master' && uid !== req.user.uid) {
    return res.status(403).json({ error: 'Acesso negado. Você só pode alterar as suas próprias vendas.' });
  }
  try {
    const { rowCount } = await db.query(
      `UPDATE public.tiktok_sales
          SET shipping_status = $1, updated_at = NOW()
        WHERE order_id = $2 AND sku = $3 AND uid = $4`,
      [shippingStatus.slice(0, 100), orderId, sku, uid]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Venda não encontrada.' });
    res.json({ message: 'Status atualizado com sucesso.' });
  } catch (error) {
    res.status(500).json({ error: 'Erro interno ao atualizar status.' });
  }
});

module.exports = router;
