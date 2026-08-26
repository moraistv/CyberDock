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
const {
  authenticateToken,
  getBearerToken,
  requireMaster,
  requireOwnerOrMaster,
  verifyAccessToken,
} = require('../utils/authMiddleware');
const { stampLabelLines, buildItemLines } = require('../utils/labelStamp');
const {
  getShopeePartnerCredentials,
  getShopeeAuthUrl,
  exchangeShopeeCode,
  refreshShopeeToken,
  getShopeeShopName,
  getShopeeOrderList,
  getShopeeOrderDetail,
  getShopeeEscrowDetail,
  getShopeeShippingParameter,
  createShopeeShippingDocument,
  getShopeeShippingDocumentResult,
  downloadShopeeShippingDocument,
} = require('../utils/shopeeClient');
const { calculateShopeeFinancials, SHOPEE_FINANCIAL_RULE_VERSION } = require('../utils/shopeeFinance');

const router = express.Router();

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://cyberdock.com.br';

// A Shopee valida o DOMÍNIO do redirect contra o "Redirect URL Domain"
// cadastrado no console do parceiro. Nexus e ContaZoom usam uma URL fixa e
// limpa; o CyberDock mantém o mesmo contrato e conclui no frontend porque o
// domínio cadastrado é cyberdock.com.br, não api.cyberdock.com.br.
//
// Como o CyberDock é multiusuário, uma tentativa opaca e de uso único fica no
// PostgreSQL. O navegador guarda apenas o valor aleatório durante a ida à
// Shopee; nenhum UID viaja na URL e nenhuma instância depende de memória local.
const REDIRECT_URI = process.env.SHOPEE_REDIRECT_URI || `${FRONTEND_URL}/shopee/callback`;
const SHOPEE_OAUTH_ATTEMPT_TTL_MS = 20 * 60 * 1000;

function createShopeeOAuthState() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashShopeeOAuthState(state) {
  return crypto.createHash('sha256').update(state).digest('hex');
}

/* Cookie da tentativa OAuth.
 *
 * Guardar o identificador apenas no armazenamento da aba não bastou: o retorno
 * da Shopee pode cair em outra aba (ou em contexto onde o armazenamento está
 * indisponível), e aí a aba que iniciou a conexão não participa mais do fluxo —
 * a conclusão simplesmente não acontecia. O cookie é HttpOnly, vale para o
 * domínio pai (frontend e API) e serve só para o backend reencontrar a
 * tentativa; a autoridade continua sendo a linha no PostgreSQL.
 */
const SHOPEE_OAUTH_COOKIE = 'cyberdock_shopee_oauth';

function defaultShopeeCookieDomain() {
  try {
    const host = new URL(FRONTEND_URL).hostname;
    if (!host || host === 'localhost' || /^[\d.]+$/.test(host)) return '';
    const parts = host.split('.');
    return parts.length >= 2 ? `.${parts.slice(-3).join('.')}` : '';
  } catch {
    return '';
  }
}

const SHOPEE_COOKIE_DOMAIN = process.env.SHOPEE_COOKIE_DOMAIN || defaultShopeeCookieDomain();

function shopeeCookieAttributes(maxAgeSeconds) {
  const parts = ['Path=/', `Max-Age=${maxAgeSeconds}`, 'HttpOnly', 'SameSite=Lax'];
  // Navegador descarta cookie Secure em http; em produção os dois domínios são
  // https, então Secure só sai fora do desenvolvimento local.
  if (!/^http:\/\/localhost/i.test(FRONTEND_URL)) parts.push('Secure');
  if (SHOPEE_COOKIE_DOMAIN) parts.push(`Domain=${SHOPEE_COOKIE_DOMAIN}`);
  return parts.join('; ');
}

function setShopeeOAuthCookie(res, oauthState) {
  const ttl = Math.floor(SHOPEE_OAUTH_ATTEMPT_TTL_MS / 1000);
  res.append('Set-Cookie', `${SHOPEE_OAUTH_COOKIE}=${oauthState}; ${shopeeCookieAttributes(ttl)}`);
}

function clearShopeeOAuthCookie(res) {
  res.append('Set-Cookie', `${SHOPEE_OAUTH_COOKIE}=; ${shopeeCookieAttributes(0)}`);
}

function readShopeeOAuthCookie(req) {
  const header = req.headers?.cookie;
  if (!header) return null;
  for (const chunk of header.split(';')) {
    const [name, ...rest] = chunk.trim().split('=');
    if (name === SHOPEE_OAUTH_COOKIE) return rest.join('=') || null;
  }
  return null;
}

function isValidShopeeOAuthState(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

/* --------------------------- SSE (mesmo padrão de /sales) --------------------------- */
const clients = {};
const pendingEvents = {};
const finalizedJobs = new Map();
const PENDING_TTL_MS = 5 * 60 * 1000;

const queueEvent = (clientId, data) => {
  if (!pendingEvents[clientId]) {
    pendingEvents[clientId] = { events: [], timer: null };
    pendingEvents[clientId].timer = setTimeout(() => {
      delete pendingEvents[clientId];
    }, PENDING_TTL_MS);
  }
  pendingEvents[clientId].events.push(data);
};

const sendEvent = (clientId, data) => {
  if (finalizedJobs.has(clientId)) return;
  const client = clients[clientId];
  if (client && !client.res.writableEnded) {
    client.res.write(`data: ${JSON.stringify(data)}\n\n`);
    return;
  }
  queueEvent(clientId, data);
};

/** Publica exatamente um evento terminal e encerra o SSE quando conectado. */
const finalizeJob = (clientId, data) => {
  if (finalizedJobs.has(clientId)) return false;
  const terminal = { ...data, progress: 100 };
  const expiry = setTimeout(() => finalizedJobs.delete(clientId), PENDING_TTL_MS);
  finalizedJobs.set(clientId, { terminal, expiry });

  const client = clients[clientId];
  if (client && !client.res.writableEnded) {
    client.res.write(`data: ${JSON.stringify(terminal)}\n\n`);
    clearInterval(client.heartbeat);
    clearInterval(client.jobMonitor);
    client.res.end();
    delete clients[clientId];
  } else {
    queueEvent(clientId, terminal);
  }
  return true;
};

router.get('/sync-status/:clientId', (req, res) => {
  const { clientId } = req.params;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    Connection: 'keep-alive',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  });
  res.write(': ok\n\n');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const heartbeat = setInterval(() => {
    if (res.writableEnded) return clearInterval(heartbeat);
    try { res.write(': ping\n\n'); } catch { clearInterval(heartbeat); }
  }, 15000);

  clients[clientId] = { res, heartbeat, jobMonitor: null };

  // POST e EventSource podem cair em instâncias diferentes. O estado terminal
  // persistido no banco permite que qualquer instância conclua este SSE.
  let monitorBusy = false;
  const jobMonitor = setInterval(async () => {
    if (monitorBusy || res.writableEnded || finalizedJobs.has(clientId)) return;
    monitorBusy = true;
    try {
      const result = await db.query(
        `SELECT status, result, error
           FROM public.shopee_sync_jobs
          WHERE client_id = $1 AND expires_at > NOW()`,
        [clientId]
      );
      const state = result.rows[0];
      if (state?.status === 'success' || state?.status === 'error') {
        const fallback = {
          type: state.status === 'success' ? 'success' : 'error',
          message: state.error || 'Sincronização Shopee finalizada.',
        };
        finalizeJob(clientId, state.result || fallback);
      }
    } catch (error) {
      console.warn('[shopee-sync] falha ao consultar estado do job SSE:', error.message);
    } finally {
      monitorBusy = false;
    }
  }, 2000);
  if (clients[clientId]?.res === res) clients[clientId].jobMonitor = jobMonitor;

  const buffered = pendingEvents[clientId];
  if (buffered) {
    if (buffered.timer) clearTimeout(buffered.timer);
    let hasTerminal = false;
    for (const event of buffered.events) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.progress === 100) hasTerminal = true;
    }
    delete pendingEvents[clientId];
    if (hasTerminal) {
      clearInterval(heartbeat);
      clearInterval(jobMonitor);
      res.end();
      delete clients[clientId];
    }
  } else if (finalizedJobs.has(clientId)) {
    const finalized = finalizedJobs.get(clientId);
    res.write(`data: ${JSON.stringify(finalized.terminal)}\n\n`);
    clearInterval(heartbeat);
    clearInterval(jobMonitor);
    res.end();
    delete clients[clientId];
  } else {
    sendEvent(clientId, { progress: 5, message: 'Conexão estabelecida. Aguardando início...', type: 'info' });
  }

  req.on('close', () => {
    clearInterval(heartbeat);
    clearInterval(jobMonitor);
    if (clients[clientId]?.res === res) delete clients[clientId];
  });
});

/* ------------------------------- OAuth: Auth ------------------------------- */
// Compatibilidade temporária com versões antigas do frontend. Esse fluxo ainda
// depende do JWT no retorno; o frontend atual usa POST /auth abaixo.
router.get('/auth', (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).send('UID do usuário é obrigatório.');

  const { partnerId, partnerKey } = getShopeePartnerCredentials();
  if (!partnerId || !partnerKey) {
    return res.status(500).json({ error: 'Credenciais Shopee ausentes (SHOPEE_PARTNER_ID / SHOPEE_PARTNER_KEY).' });
  }

  console.warn(`[Shopee Auth] Fluxo legado iniciado para UID ${uid}; atualize o frontend.`);
  const authUrl = getShopeeAuthUrl(partnerId, partnerKey, REDIRECT_URI);
  res.redirect(authUrl);
});

/**
 * Inicia o OAuth a partir de uma chamada autenticada. O UID vem do JWT, nunca
 * da query string. A tentativa fica no PostgreSQL e a Shopee recebe exatamente
 * o mesmo redirect limpo usado pelos projetos que já funcionam.
 */
router.post('/auth', authenticateToken, async (req, res) => {
  const { partnerId, partnerKey } = getShopeePartnerCredentials();
  if (!partnerId || !partnerKey) {
    return res.status(500).json({ error: 'Credenciais Shopee ausentes (SHOPEE_PARTNER_ID / SHOPEE_PARTNER_KEY).' });
  }

  try {
    const oauthState = createShopeeOAuthState();
    const stateHash = hashShopeeOAuthState(oauthState);
    const expiresAt = new Date(Date.now() + SHOPEE_OAUTH_ATTEMPT_TTL_MS);

    // Limpeza limitada a tentativas antigas; a linha recém-criada é a
    // autoridade compartilhada por todas as instâncias do backend.
    await db.query(
      `DELETE FROM public.shopee_oauth_attempts
        WHERE expires_at < NOW() - INTERVAL '1 day'`
    );
    await db.query(
      `INSERT INTO public.shopee_oauth_attempts (state_hash, uid, expires_at)
       VALUES ($1, $2, $3)`,
      [stateHash, req.user.uid, expiresAt]
    );

    const authUrl = getShopeeAuthUrl(partnerId, partnerKey, REDIRECT_URI);
    res.set('Cache-Control', 'no-store');
    // O cookie acompanha a tentativa para o caso de o retorno da Shopee não
    // voltar para a mesma aba.
    setShopeeOAuthCookie(res, oauthState);
    console.log(`[Shopee Auth] Autorização autenticada iniciada para UID ${req.user.uid}.`);
    return res.json({
      authUrl,
      oauthState,
      expiresInSeconds: Math.floor(SHOPEE_OAUTH_ATTEMPT_TTL_MS / 1000),
    });
  } catch (error) {
    console.error('[Shopee Auth] Não foi possível iniciar a autorização:', error);
    return res.status(500).json({ error: 'Não foi possível iniciar a autorização Shopee.' });
  }
});

/* ----------------------------- OAuth: Conclusão ---------------------------- */
async function releaseShopeeOAuthClaim(attempt, requestId) {
  if (!attempt) return;
  try {
    await db.query(
      `UPDATE public.shopee_oauth_attempts
          SET claim_id = NULL, claimed_at = NULL
        WHERE state_hash = $1
          AND claim_id = $2
          AND consumed_at IS NULL`,
      [attempt.stateHash, attempt.claimId]
    );
  } catch (error) {
    console.error(`[Shopee Connect ${requestId}] Falha ao liberar claim OAuth:`, error);
  }
}

/**
 * Reivindica a tentativa opaca com lease. `consumed_at` só é preenchido na
 * mesma transação que grava a conta; falha anterior libera o claim e crash do
 * processo fica recuperável depois de cinco minutos.
 */
async function resolveShopeeConnectIdentity(req, res, next) {
  const requestId = crypto.randomUUID();
  // A tentativa chega pelo corpo (aba que iniciou o OAuth) ou pelo cookie, que
  // continua valendo quando o retorno da Shopee cai em outra aba.
  const stateFromBody = req.body?.oauthState;
  const oauthState = stateFromBody || readShopeeOAuthCookie(req);
  const bearerToken = getBearerToken(req);
  const normalizedShopId = String(req.body?.shopId || '').trim();
  let sessionUser = null;
  let sessionError = null;

  /* Log de entrada incondicional.
   *
   * Sem ele, uma chamada recusada já na validação não deixava rastro algum: o
   * servidor só registrava "[Shopee Auth]" e a conclusão ficava invisível,
   * impossível de distinguir de "o navegador nunca chamou". */
  console.log(
    `[Shopee Connect ${requestId}] Recebido: shop=${normalizedShopId || 'ausente'} ` +
    `tentativa=${oauthState ? (stateFromBody ? 'corpo' : 'cookie') : 'nenhuma'} ` +
    `jwt=${bearerToken ? 'presente' : 'ausente'}.`
  );

  // Valida tudo que vem da Shopee antes de reivindicar a tentativa.
  if (
    typeof req.body?.code !== 'string' ||
    !req.body.code.trim() ||
    !/^\d+$/.test(normalizedShopId) ||
    !Number.isSafeInteger(Number(normalizedShopId))
  ) {
    console.warn(`[Shopee Connect ${requestId}] code/shopId ausentes ou inválidos.`);
    return res.status(400).json({
      error: 'Parâmetros code e shopId são obrigatórios e devem ser válidos.',
      requestId,
    });
  }

  if (bearerToken) {
    try {
      sessionUser = verifyAccessToken(bearerToken);
    } catch (error) {
      sessionError = error;
    }
  }

  if (oauthState) {
    if (!isValidShopeeOAuthState(oauthState)) {
      console.warn(`[Shopee Connect ${requestId}] Tentativa OAuth malformada.`);
      return res.status(400).json({
        error: 'A tentativa de conexão Shopee é inválida. Inicie novamente.',
        requestId,
      });
    }

    const stateHash = hashShopeeOAuthState(oauthState);
    const claimId = crypto.randomUUID();
    try {
      const params = sessionUser ? [stateHash, claimId, sessionUser.uid] : [stateHash, claimId];
      const ownerCondition = sessionUser ? 'AND uid = $3' : '';
      const { rows } = await db.query(
        `UPDATE public.shopee_oauth_attempts
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
          `SELECT uid, shop_id, claimed_at, consumed_at, expires_at
             FROM public.shopee_oauth_attempts
            WHERE state_hash = $1`,
          [stateHash]
        );
        const attempt = probe.rows[0];

        if (attempt && sessionUser && attempt.uid !== sessionUser.uid) {
          console.warn(`[Shopee Connect ${requestId}] Sessão e tentativa pertencem a usuários diferentes.`);
          return res.status(403).json({
            error: 'A autorização foi iniciada por outro usuário. Entre na conta correta e tente novamente.',
            requestId,
          });
        }

        // Resposta perdida depois do COMMIT: devolve o resultado já persistido
        // sem tentar reutilizar o code de uso único.
        if (attempt?.consumed_at && String(attempt.shop_id || '') === normalizedShopId) {
          const accountResult = await db.query(
            `SELECT shop_id, shop_name, status, connected_at, updated_at
               FROM public.shopee_accounts
              WHERE uid = $1 AND shop_id = $2`,
            [attempt.uid, normalizedShopId]
          );
          if (accountResult.rows[0]) {
            req.user = sessionUser || { uid: attempt.uid };
            req.shopeeCompletedAccount = accountResult.rows[0];
            req.shopeeConnectAuth = 'completed-attempt';
            req.shopeeSessionValid = Boolean(sessionUser);
            req.shopeeRequestId = requestId;
            return next();
          }
        }

        const claimIsActive = attempt?.claimed_at &&
          new Date(attempt.claimed_at).getTime() > Date.now() - 5 * 60 * 1000;
        if (claimIsActive && !attempt?.consumed_at) {
          return res.status(409).json({
            error: 'Esta conexão Shopee ainda está sendo concluída. Aguarde alguns segundos.',
            requestId,
          });
        }

        console.warn(`[Shopee Connect ${requestId}] Tentativa expirada, concluída sem conta ou inexistente.`);
        return res.status(400).json({
          error: 'A tentativa de conexão Shopee expirou. Inicie novamente.',
          requestId,
        });
      }

      req.user = sessionUser || { uid: rows[0].uid };
      req.shopeeOAuthAttempt = { stateHash, claimId };
      req.shopeeConnectAuth = 'database-attempt';
      req.shopeeSessionValid = Boolean(sessionUser);
      req.shopeeRequestId = requestId;
      return next();
    } catch (error) {
      console.error(`[Shopee Connect ${requestId}] Falha ao reivindicar tentativa OAuth:`, error);
      return res.status(500).json({
        error: 'Não foi possível validar a tentativa de conexão Shopee.',
        requestId,
      });
    }
  }

  if (!bearerToken) {
    console.warn(`[Shopee Connect ${requestId}] Chegou sem tentativa e sem credencial.`);
    return res.status(401).json({
      error: 'A sessão da conexão Shopee expirou. Entre novamente e refaça a conexão.',
      requestId,
    });
  }

  if (!sessionUser) {
    console.warn(`[Shopee Connect ${requestId}] JWT legado recusado: ${sessionError?.message || 'inválido'}.`);
    return res.status(403).json({ error: 'Token inválido ou expirado', requestId });
  }

  req.user = sessionUser;
  req.shopeeConnectAuth = 'legacy-jwt';
  req.shopeeSessionValid = true;
  req.shopeeRequestId = requestId;
  return next();
}

function shopeeConnectResponse(account, req, res, replayed = false) {
  const label = account.shop_name || account.shop_id;
  return res.json({
    message: `Loja Shopee ${label} conectada com sucesso!`,
    shopId: account.shop_id,
    shopName: account.shop_name,
    ownerUid: req.user.uid,
    sessionValid: req.shopeeSessionValid,
    replayed,
    requestId: req.shopeeRequestId,
  });
}

/**
 * Troca o código pela credencial da loja e grava a conta.
 *
 * Fica fora do handler porque dois caminhos concluem a mesma conexão: o POST
 * feito pelo frontend e o retorno tratado direto no backend, usado quando o
 * navegador não consegue concluir sozinho. Os erros carregam a fase para o
 * chamador escolher entre "tente de novo" e "refaça a autorização".
 */
async function persistShopeeAccount({ uid, code, shopId, attempt, requestId }) {
  const { partnerId, partnerKey } = getShopeePartnerCredentials();
  if (!partnerId || !partnerKey) {
    const configError = new Error('Credenciais Shopee ausentes no servidor.');
    configError.code = 'SHOPEE_SERVER_CONFIG';
    configError.phase = 'configuration';
    throw configError;
  }

  let phase = 'token_exchange';
  try {
    const tokens = await exchangeShopeeCode(code, shopId, partnerId, partnerKey);
    const expiresIn = Number(tokens.expire_in);
    if (!tokens.access_token || !tokens.refresh_token || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new Error('Shopee obter token: resposta incompleta; conecte a loja novamente.');
    }
    console.log(`[Shopee Connect ${requestId}] Token recebido para shop=${tokens.shop_id}.`);

    /* A mesma loja já vinculada a outro usuário.
     *
     * A Shopee emite tokens por loja: autorizar de novo invalida o token de
     * quem tinha antes, e a sincronização do outro usuário passa a falhar sem
     * explicação. Não bloqueamos aqui para não impedir uma troca legítima de
     * responsável, mas o registro deixa o caso visível no servidor. */
    try {
      const { rows } = await db.query(
        `SELECT uid FROM public.shopee_accounts WHERE shop_id = $1 AND uid <> $2`,
        [String(tokens.shop_id), uid]
      );
      if (rows.length) {
        console.warn(
          `[Shopee Connect ${requestId}] Loja ${tokens.shop_id} já estava vinculada a ` +
          `${rows.map((r) => r.uid).join(', ')}; o token anterior deixa de valer.`
        );
      }
    } catch (error) {
      console.warn(`[Shopee Connect ${requestId}] Não foi possível checar vínculo anterior:`, error.message);
    }

    const expiresAt = new Date(Date.now() + Math.max(30, expiresIn - 60) * 1000);
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
        updated_at   = NOW()
      RETURNING uid, shop_id, shop_name, status, connected_at, updated_at;
    `;
    const upsertParams = [
      uid,
      String(tokens.shop_id),
      shopName,
      tokens.merchant_id,
      tokens.access_token,
      tokens.refresh_token,
      expiresAt,
    ];

    phase = 'persistence';
    let account;
    if (attempt) {
      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');
        const accountResult = await client.query(upsertQuery, upsertParams);
        account = accountResult.rows[0];
        if (!account || account.uid !== uid) {
          throw new Error('A conta Shopee não foi confirmada depois da gravação.');
        }

        const completion = await client.query(
          `UPDATE public.shopee_oauth_attempts
              SET consumed_at = NOW(), shop_id = $3,
                  claim_id = NULL, claimed_at = NULL
            WHERE state_hash = $1
              AND claim_id = $2
              AND consumed_at IS NULL
          RETURNING state_hash`,
          [attempt.stateHash, attempt.claimId, String(tokens.shop_id)]
        );
        if (completion.rowCount !== 1) {
          throw new Error('A tentativa OAuth perdeu sua reserva antes da conclusão.');
        }
        await client.query('COMMIT');
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* conexão já encerrada */ }
        throw error;
      } finally {
        client.release();
      }
    } else {
      const accountResult = await db.query(upsertQuery, upsertParams);
      account = accountResult.rows[0];
      if (!account || account.uid !== uid) {
        throw new Error('A conta Shopee não foi confirmada depois da gravação.');
      }
    }

    return account;
  } catch (error) {
    if (!error.phase) error.phase = phase;
    throw error;
  }
}

router.post('/connect', resolveShopeeConnectIdentity, async (req, res) => {
  const { code, shopId } = req.body;
  const { uid } = req.user;
  const requestId = req.shopeeRequestId;
  const normalizedShopId = String(shopId || '').trim();

  console.log(
    `[Shopee Connect ${requestId}] Início: uid=${uid} shop=${normalizedShopId} ` +
    `auth=${req.shopeeConnectAuth}.`
  );

  if (req.shopeeCompletedAccount) {
    clearShopeeOAuthCookie(res);
    console.log(`[Shopee Connect ${requestId}] Resultado já persistido; resposta idempotente.`);
    return shopeeConnectResponse(req.shopeeCompletedAccount, req, res, true);
  }

  try {
    const account = await persistShopeeAccount({
      uid,
      code,
      shopId: normalizedShopId,
      attempt: req.shopeeOAuthAttempt,
      requestId,
    });
    clearShopeeOAuthCookie(res);
    console.log(`[Shopee Connect ${requestId}] Persistido: loja=${account.shop_name || account.shop_id} uid=${uid}.`);
    return shopeeConnectResponse(account, req, res);
  } catch (error) {
    await releaseShopeeOAuthClaim(req.shopeeOAuthAttempt, requestId);
    const phase = error.phase || 'unknown';
    console.error(`[Shopee Connect ${requestId}] Erro na fase ${phase}:`, error);

    const persistenceFailed = phase === 'persistence';
    const configurationFailed = error?.code === 'SHOPEE_SERVER_CONFIG';
    const status = persistenceFailed || configurationFailed ? 500 : 400;
    return res.status(status).json({
      error: persistenceFailed
        ? 'A Shopee autorizou a loja, mas o CyberDock não conseguiu gravá-la. Inicie uma nova conexão.'
        : configurationFailed
          ? 'A conexão Shopee não está configurada corretamente no servidor.'
          : (error.message || 'Erro ao conectar loja Shopee.'),
      restartRequired: persistenceFailed || phase === 'token_exchange',
      requestId,
    });
  }
});

/**
 * Conclusão da autorização direto no backend.
 *
 * Existe porque a etapa que grava a conta não pode depender de o navegador
 * executar a página de retorno: se a aba mudar, o armazenamento estiver
 * bloqueado ou o pacote do frontend estiver desatualizado, a loja era
 * autorizada na Shopee e nunca aparecia no sistema. Aqui a identidade vem da
 * tentativa (query ou cookie), então basta uma navegação comum do navegador.
 */
router.get('/callback', async (req, res) => {
  const requestId = crypto.randomUUID();
  const code = String(req.query.code || '').trim();
  const shopId = String(req.query.shop_id || req.query.shopid || '').trim();
  const contas = `${FRONTEND_URL}/contas`;
  const failure = (message) => res.redirect(`${contas}?error=${encodeURIComponent(message)}`);
  const success = (label) =>
    res.redirect(`${contas}?success=${encodeURIComponent(`Loja Shopee ${label} conectada com sucesso!`)}`);

  const oauthState = String(req.query.state || '').trim() || readShopeeOAuthCookie(req);
  console.log(
    `[Shopee Callback ${requestId}] Retorno: shop=${shopId || 'ausente'} ` +
    `tentativa=${oauthState ? 'presente' : 'nenhuma'}.`
  );

  if (!code || !/^\d+$/.test(shopId)) {
    return failure('Autorização Shopee falhou: code ou shop_id ausente.');
  }

  // Sem tentativa não há como saber de quem é a loja. O retorno então segue
  // para o frontend, que ainda pode concluir usando a sessão aberta.
  if (!isValidShopeeOAuthState(oauthState)) {
    const frontendCallback = new URL(`${FRONTEND_URL}/shopee/callback`);
    frontendCallback.searchParams.set('code', code);
    frontendCallback.searchParams.set('shop_id', shopId);
    // Marca de que o backend já tentou: evita os dois lados se empurrarem o
    // mesmo retorno indefinidamente.
    frontendCallback.searchParams.set('handoff', '1');
    return res.redirect(frontendCallback.toString());
  }

  const stateHash = hashShopeeOAuthState(oauthState);
  const claimId = crypto.randomUUID();
  let attempt = null;
  try {
    const { rows } = await db.query(
      `UPDATE public.shopee_oauth_attempts
          SET claim_id = $2, claimed_at = NOW()
        WHERE state_hash = $1
          AND consumed_at IS NULL
          AND expires_at > NOW()
          AND (claim_id IS NULL OR claimed_at < NOW() - INTERVAL '5 minutes')
      RETURNING uid`,
      [stateHash, claimId]
    );

    if (!rows[0]) {
      // Recarregar a página de retorno não pode reaproveitar o code, então a
      // resposta vem do que já está gravado.
      const probe = await db.query(
        `SELECT a.consumed_at, a.shop_id, c.shop_name, (c.uid IS NOT NULL) AS has_account
           FROM public.shopee_oauth_attempts a
           LEFT JOIN public.shopee_accounts c
             ON c.uid = a.uid AND c.shop_id = $2
          WHERE a.state_hash = $1`,
        [stateHash, shopId]
      );
      const done = probe.rows[0];
      clearShopeeOAuthCookie(res);
      if (done?.consumed_at && done.has_account && String(done.shop_id || '') === shopId) {
        console.log(`[Shopee Callback ${requestId}] Conexão já concluída; resposta idempotente.`);
        return success(done.shop_name || shopId);
      }
      console.warn(`[Shopee Callback ${requestId}] Tentativa expirada, em uso ou concluída sem conta.`);
      return failure('A tentativa de conexão Shopee expirou. Clique em Conectar loja e autorize novamente.');
    }

    attempt = { stateHash, claimId };
    const uid = rows[0].uid;
    const account = await persistShopeeAccount({ uid, code, shopId, attempt, requestId });
    clearShopeeOAuthCookie(res);
    console.log(`[Shopee Callback ${requestId}] Persistido: loja=${account.shop_name || account.shop_id} uid=${uid}.`);
    return success(account.shop_name || account.shop_id);
  } catch (error) {
    await releaseShopeeOAuthClaim(attempt, requestId);
    const phase = error.phase || 'unknown';
    console.error(`[Shopee Callback ${requestId}] Erro na fase ${phase}:`, error);
    clearShopeeOAuthCookie(res);
    return failure(
      phase === 'persistence'
        ? 'A Shopee autorizou a loja, mas o CyberDock não conseguiu gravá-la. Inicie uma nova conexão.'
        : 'Não foi possível concluir a conexão com a Shopee. Tente novamente.'
    );
  }
});

/* -------------------------------- Contas -------------------------------- */
async function listShopeeAccounts(uid, res) {
  try {
    const { rows } = await db.query(
      `SELECT shop_id, shop_name, status, connected_at, expires_at
         FROM public.shopee_accounts
        WHERE uid = $1
        ORDER BY connected_at DESC, shop_id`,
      [uid]
    );
    return res.json(rows);
  } catch (error) {
    console.error(`[Shopee Contas] Erro ao listar contas do UID ${uid}:`, error);
    return res.status(500).json({ error: 'Erro interno do servidor.' });
  }
}

// Autoatendimento: o backend deriva o dono diretamente do JWT.
router.get('/contas', authenticateToken, async (req, res) => {
  return listShopeeAccounts(req.user.uid, res);
});

// Compatibilidade para telas administrativas/versões anteriores, agora sem
// permitir que um usuário comum consulte as lojas de outro UID.
router.get('/contas/:uid', authenticateToken, requireOwnerOrMaster, async (req, res) => {
  return listShopeeAccounts(req.params.uid, res);
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

/* --------------- Excluir loja de OUTRO usuário (master) ---------------
 *
 * Mesmo motivo do par no Mercado Livre: a rota acima deriva o dono do token, e
 * por isso o master recebe 404 ao tentar desconectar a loja de um cliente.
 *
 * Apaga a linha da loja. O schema já leva junto, por ON DELETE CASCADE em
 * (uid, shop_id), o cursor de sincronização (shopee_sync_cursors) e o job
 * (shopee_sync_jobs) — são estado de controle. As vendas em
 * public.shopee_sales NÃO têm FK e permanecem: são histórico de faturamento.
 */
router.delete('/contas/:uid/:shopId', authenticateToken, requireMaster, async (req, res) => {
  const { uid, shopId } = req.params;

  if (!uid || !shopId) {
    return res.status(400).json({ error: 'Informe o usuário e a loja a excluir.' });
  }
  if (!/^\d+$/.test(shopId)) {
    return res.status(400).json({ error: 'ID da loja Shopee inválido.' });
  }

  try {
    const { rows } = await db.query(
      `DELETE FROM public.shopee_accounts
        WHERE shop_id = $1 AND uid = $2
        RETURNING shop_id, shop_name, uid`,
      [shopId, uid]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Loja não encontrada para este usuário.' });
    }

    const removida = rows[0];
    console.log(
      `[Shopee] Loja ${removida.shop_id} (${removida.shop_name || 'sem nome'}) do usuário ${uid} `
      + `excluída pelo master ${req.user.uid}.`
    );

    res.json({
      message: 'Loja Shopee desconectada.',
      account: { shopId: String(removida.shop_id), shopName: removida.shop_name, uid: removida.uid },
    });
  } catch (error) {
    console.error(`Erro ao excluir loja Shopee ${shopId} do usuário ${uid}:`, error);
    res.status(500).json({ error: 'Erro interno ao excluir a loja.' });
  }
});

/* ------------------------------- Etiquetas ------------------------------- */

/**
 * Mensagens para os códigos de erro da Shopee.
 *
 * Vêm da própria documentação de Logistics. O caso que o operador mais vê no
 * Brasil é `logistics.lack_of_invoice_data`: a Shopee não libera a etiqueta
 * enquanto a nota fiscal não é enviada (ou enquanto a SEFAZ recusa a que foi
 * enviada). Sem traduzir isso, a tela mostrava só "erro".
 */
const SHOPEE_LABEL_MESSAGES = {
  'logistics.lack_of_invoice_data': 'A Shopee não liberou a etiqueta porque a nota fiscal não foi enviada, ou foi recusada pela SEFAZ. Emita ou corrija a NF e tente novamente.',
  'logistics.order_status_error': 'O status do pedido ainda não permite imprimir a etiqueta.',
  'logistics.package_can_not_print': 'A Shopee ainda não liberou a impressão deste pacote. Normalmente falta agendar o envio (coleta ou postagem) na Shopee, o que é o que gera o código de rastreio da etiqueta.',
  'logistics.tracking_number_invalid': 'O código de rastreio do pedido ainda não é válido para gerar a etiqueta.',
  'logistics.can_not_print_combine_order': 'Este pedido faz parte de um pacote combinado: a etiqueta só sai pelo Seller Center da Shopee.',
  'logistics.can_not_print_jit_order': 'Este canal de envio só permite imprimir pelo Seller Center da Shopee.',
  'logistics.shipping_document_should_print_first': 'A etiqueta ainda está sendo gerada. Tente novamente em alguns segundos.',
  'logistics.download_later': 'A etiqueta ainda está sendo gerada pela Shopee. Tente novamente em alguns segundos.',
  'logistics.package_print_failed': 'A Shopee não conseguiu gerar a etiqueta. Tente novamente em alguns minutos.',
  'logistics.packages_can_not_download_together': 'Estes pacotes não podem ser baixados juntos. Gere um por vez.',
  'logistics.error_booking_order': 'Pedido vinculado a booking: a expedição não é feita pelo vendedor.',
  'logistics.package_number_not_exist': 'Pedido dividido em pacotes: é preciso informar o pacote específico.',
  'logistics.package_number_not_found': 'O pacote informado não existe mais na Shopee.',
  'logistics.order_not_exist': 'A Shopee não encontrou este pedido.',
  'logistics.invalid_address_version': 'O endereço deste pedido precisa ser atualizado na Shopee antes de gerar a etiqueta.',
  'logistics.no_valid_shipping_parameters': 'A Shopee não retornou parâmetros de envio válidos para este pedido.',
  'error_permission': 'O aplicativo CyberDock não tem permissão da Shopee para etiquetas. Solicite o acesso a dados sensíveis no console do parceiro.',
};

const SHOPEE_LABEL_TYPES = {
  pdf: 'NORMAL_AIR_WAYBILL',
  thermal: 'THERMAL_AIR_WAYBILL',
};

const waitBeforeRetry = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* Sem rastreio não existe etiqueta.
 *
 * A documentação é explícita: create_shipping_document "is only available after
 * retrieving the tracking number", e o rastreio só aparece depois que o envio é
 * agendado (coleta ou postagem). Enquanto isso a Shopee recusa com
 * `logistics.package_can_not_print`, que sozinho não diz o que fazer. Avisamos
 * antes de gastar a chamada. */
const SHOPEE_AWAITING_SHIPMENT_REASON = 'A Shopee ainda não gerou o código de rastreio deste pedido. '
  + 'A etiqueta só é liberada depois que o envio é agendado (coleta ou postagem) na Shopee. '
  + 'Agende o envio e sincronize as vendas para atualizar aqui.';

/**
 * Traduz o código da Shopee.
 *
 * Antes o texto original entrava como fallback direto e o operador via inglês
 * cru na tela (por exemplo "Package OFG241271838164384 not eligible for
 * rescheduling"), que não diz o que fazer. Agora o inglês nunca é a mensagem:
 * vira detalhe atrás de uma frase em português, com o código, para o suporte
 * conseguir mapear o caso na próxima vez.
 *
 * Quando não há código, o `fallback` é texto nosso (já em português) e vale
 * como está.
 */
function shopeeLabelMessage(code, fallback) {
  if (!code) return fallback || 'A Shopee não liberou a etiqueta deste pedido.';
  if (SHOPEE_LABEL_MESSAGES[code]) return SHOPEE_LABEL_MESSAGES[code];

  const detail = [fallback, code].filter(Boolean).join(' · ');
  return `A Shopee recusou a etiqueta deste pedido e não informou um motivo traduzido. Resposta da Shopee: ${detail}`;
}

/** Primeiro item do result_list, onde as APIs batch reportam falha por pedido. */
function firstShopeeResult(payload) {
  const list = payload?.response?.result_list;
  return Array.isArray(list) && list[0] ? list[0] : null;
}

/**
 * Conta da loja com token utilizável.
 *
 * Escopada ao UID dono da loja, resolvido por `readLabelQuery`: usuário comum
 * fica preso ao próprio UID do token, só o master pode apontar outro dono.
 */
async function loadShopeeAccountForLabel(uid, shopId) {
  const { rows } = await db.query(
    `SELECT uid, shop_id, shop_name, access_token, refresh_token, expires_at
       FROM public.shopee_accounts
      WHERE uid = $1 AND shop_id = $2`,
    [uid, String(shopId)]
  );
  if (!rows[0]) return { error: 'account_not_found' };

  const { partnerId, partnerKey } = getShopeePartnerCredentials();
  if (!partnerId || !partnerKey) return { error: 'server_config' };

  const row = rows[0];
  const account = {
    uid: row.uid,
    shopId: String(row.shop_id),
    shopName: row.shop_name,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
  };

  const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  if (expiresAt - Date.now() < 10 * 60 * 1000) {
    const refreshed = await refreshShopeeToken(account, partnerId, partnerKey);
    account.accessToken = refreshed.access_token;
    account.refreshToken = refreshed.refresh_token;
  }
  return { account, partnerId, partnerKey };
}

/** Rastreio já sincronizado. create_shipping_document exige ele na maioria dos canais. */
async function findShopeeSaleForLabel(uid, shopId, orderSn) {
  const { rows } = await db.query(
    `SELECT tracking_number, order_status, shipping_status, shipping_carrier
       FROM public.shopee_sales
      WHERE uid = $1 AND shop_id = $2 AND order_sn = $3
      LIMIT 1`,
    [uid, String(shopId), String(orderSn)]
  );
  return rows[0] || null;
}

/**
 * Itens do pedido, para estampar SKU e quantidade na etiqueta.
 *
 * Uma linha por SKU: na Shopee o pedido pode levar produtos diferentes no mesmo
 * pacote, e a etiqueta é o que quem separa tem na mão.
 *
 * `findShopeeSaleForLabel` acima usa LIMIT 1 porque só precisa do rastreio, que
 * é do envio; aqui a lista inteira importa.
 */
async function findShopeeItemsForLabel(uid, shopId, orderSn) {
  const { rows } = await db.query(
    `SELECT sku, quantity
       FROM public.shopee_sales
      WHERE uid = $1 AND shop_id = $2 AND order_sn = $3
      ORDER BY sku`,
    [uid, String(shopId), String(orderSn)]
  );
  return rows;
}

function readLabelQuery(req) {
  /* Dono da loja.
   *
   * O tabelão master lista vendas de todos os clientes, então ele precisa
   * imprimir em nome do dono. Só papel master pode indicar `ownerUid`; para
   * qualquer outro usuário o parâmetro é ignorado e vale o UID do token, o que
   * mantém o isolamento entre contas. */
  const requestedOwner = String(req.query.ownerUid || req.query.owner_uid || '').trim();
  const ownerUid = req.user.role === 'master' && requestedOwner ? requestedOwner : req.user.uid;

  return {
    ownerUid,
    orderSn: String(req.query.orderSn || req.query.order_sn || '').trim(),
    shopId: String(req.query.shopId || req.query.shop_id || '').trim(),
    packageNumber: String(req.query.packageNumber || req.query.package_number || '').trim() || null,
    documentType: SHOPEE_LABEL_TYPES[String(req.query.type || 'pdf').toLowerCase()] || SHOPEE_LABEL_TYPES.pdf,
  };
}

/**
 * Diagnóstico antes de imprimir: diz se a etiqueta pode sair e, quando não pode,
 * por quê — em português, para a tela mostrar direto ao operador.
 */
router.get('/label-info', authenticateToken, async (req, res) => {
  const { ownerUid, orderSn, shopId, packageNumber, documentType } = readLabelQuery(req);
  if (!orderSn || !/^\d+$/.test(shopId)) {
    return res.status(400).json({ error: 'Informe orderSn e shopId válidos.' });
  }

  try {
    const loaded = await loadShopeeAccountForLabel(ownerUid, shopId);
    if (loaded.error === 'account_not_found') {
      return res.status(404).json({ canPrint: false, reason: 'Loja Shopee não conectada nesta conta.' });
    }
    if (loaded.error === 'server_config') {
      return res.status(500).json({ canPrint: false, reason: 'Credenciais Shopee ausentes no servidor.' });
    }
    const { account, partnerId, partnerKey } = loaded;
    const sale = await findShopeeSaleForLabel(ownerUid, shopId, orderSn);

    /* Estado da tarefa de etiqueta vem PRIMEIRO, de propósito.
     *
     * Documento READY encerra a checagem: a etiqueta já existe na Shopee e o
     * download funciona. A Shopee trata a impressão como evento único do envio,
     * então um pedido já expedido por outro sistema faz o get_shipping_parameter
     * recusar — e checar o parâmetro antes negava etiqueta que a Shopee
     * entrega. Foi o que travou os pedidos da CONDROENERGY já expedidos fora do
     * CyberDock. "Ainda não criada" também não é impedimento: o download cria
     * antes de baixar. */
    const result = await withTokenRetry(
      account,
      (accessToken) => getShopeeShippingDocumentResult({
        partnerId, partnerKey, accessToken, shopId: account.shopId, orderSn, packageNumber, documentType,
      }),
      partnerId,
      partnerKey
    );
    const item = firstShopeeResult(result);

    if (item?.status === 'READY') {
      return res.json({
        canPrint: true,
        status: 'ready',
        trackingNumber: sale?.tracking_number || null,
        reason: 'Etiqueta pronta para baixar.',
      });
    }

    // get_shipping_parameter é o que acusa nota fiscal pendente/recusada.
    const parameter = await withTokenRetry(
      account,
      (accessToken) => getShopeeShippingParameter({
        partnerId, partnerKey, accessToken, shopId: account.shopId, orderSn, packageNumber,
      }),
      partnerId,
      partnerKey
    );

    if (parameter?.error) {
      const requiresInvoice = parameter.error === 'logistics.lack_of_invoice_data';
      return res.json({
        canPrint: false,
        requiresInvoice,
        status: requiresInvoice ? 'invoice_pending' : 'blocked',
        code: parameter.error,
        reason: shopeeLabelMessage(parameter.error, parameter.message),
      });
    }

    const failCode = item?.fail_error || (result?.error && result.error !== 'common.batch_api_all_failed' ? result.error : null);

    if (failCode && failCode !== 'logistics.shipping_document_should_print_first') {
      return res.json({
        canPrint: false,
        requiresInvoice: failCode === 'logistics.lack_of_invoice_data',
        status: 'blocked',
        code: failCode,
        reason: shopeeLabelMessage(failCode, item?.fail_message || result?.message),
      });
    }

    // Sem documento pronto, sem rastreio não há etiqueta para criar.
    if (!sale?.tracking_number) {
      return res.json({
        canPrint: false,
        requiresInvoice: false,
        awaitingShipment: true,
        status: 'awaiting_shipment',
        code: null,
        reason: SHOPEE_AWAITING_SHIPMENT_REASON,
      });
    }

    return res.json({
      canPrint: true,
      status: 'pending_creation',
      trackingNumber: sale.tracking_number,
      reason: 'A etiqueta será gerada na hora da impressão.',
    });
  } catch (error) {
    const code = error?.shopeeCode;
    console.error(`[Shopee Label] Falha ao checar etiqueta do pedido ${orderSn}:`, error.message);
    return res.status(code ? 200 : 500).json({
      canPrint: false,
      status: 'blocked',
      code: code || null,
      reason: code
        ? shopeeLabelMessage(code, error.message)
        : 'Não foi possível checar a etiqueta na Shopee agora.',
    });
  }
});

/**
 * Gera (se preciso) e baixa a etiqueta.
 *
 * Segue os três passos exigidos pela Shopee: cria a tarefa, espera virar READY
 * e só então baixa. Enquanto o documento não está pronto a própria API responde
 * `logistics.download_later`, então a espera é curta e limitada.
 */
router.get('/download-label', authenticateToken, async (req, res) => {
  const { ownerUid, orderSn, shopId, packageNumber, documentType } = readLabelQuery(req);
  if (!orderSn || !/^\d+$/.test(shopId)) {
    return res.status(400).json({ error: 'Informe orderSn e shopId válidos.' });
  }

  const fail = (status, code, message, extra = {}) => res.status(status).json({
    error: shopeeLabelMessage(code, message),
    code: code || null,
    requiresInvoice: code === 'logistics.lack_of_invoice_data',
    ...extra,
  });

  try {
    const loaded = await loadShopeeAccountForLabel(ownerUid, shopId);
    if (loaded.error === 'account_not_found') return fail(404, null, 'Loja Shopee não conectada nesta conta.');
    if (loaded.error === 'server_config') return fail(500, null, 'Credenciais Shopee ausentes no servidor.');

    const { account, partnerId, partnerKey } = loaded;
    const sale = await findShopeeSaleForLabel(ownerUid, shopId, orderSn);

    const readDocumentStatus = () => withTokenRetry(
      account,
      (accessToken) => getShopeeShippingDocumentResult({
        partnerId, partnerKey, accessToken, shopId: account.shopId, orderSn, packageNumber, documentType,
      }),
      partnerId,
      partnerKey
    );

    /* Documento já pronto vai direto para o download.
     *
     * A Shopee trata a impressão como evento único do envio: se a etiqueta já
     * saiu (aqui ou em outro sistema), ela recusa criar de novo, mas continua
     * entregando o documento existente. Chamar a criação nesse caso só rendia
     * uma recusa que virava erro na tela. Sem documento pronto, a falta de
     * rastreio é impedimento real: não há o que criar. */
    let documentReady = firstShopeeResult(await readDocumentStatus())?.status === 'READY';

    if (!documentReady && !sale?.tracking_number) {
      console.warn(`[Shopee Label] Pedido ${orderSn} sem rastreio: envio ainda não agendado.`);
      return fail(409, null, SHOPEE_AWAITING_SHIPMENT_REASON, { awaitingShipment: true });
    }

    if (!documentReady) {
      const creation = await withTokenRetry(
        account,
        (accessToken) => createShopeeShippingDocument({
          partnerId, partnerKey, accessToken, shopId: account.shopId,
          orderSn, packageNumber, trackingNumber: sale?.tracking_number || null, documentType,
        }),
        partnerId,
        partnerKey
      );

      const creationItem = firstShopeeResult(creation);
      const creationError = creationItem?.fail_error
        || (creation?.error && creation.error !== 'common.batch_api_all_failed' ? creation.error : null);
      // "já foi criada" não é falha: segue para o download.
      if (creationError && creationError !== 'logistics.shipping_document_should_print_first') {
        /* Recusa na criação ainda pode ter documento do outro lado: a etiqueta
         * pode ter sido gerada entre a checagem e agora, ou por outro operador.
         * Só desistimos depois de confirmar que não existe documento pronto. */
        const creationDetail = creationItem?.fail_message || creation?.message || 'sem detalhe';
        documentReady = firstShopeeResult(await readDocumentStatus())?.status === 'READY';

        if (!documentReady) {
          console.warn(`[Shopee Label] Pedido ${orderSn} recusado na criação: ${creationError} — ${creationDetail}`);
          return fail(409, creationError, creationItem?.fail_message || creation?.message);
        }
        console.warn(`[Shopee Label] Pedido ${orderSn}: criação recusada (${creationError} — ${creationDetail}), `
          + 'mas o documento já existe na Shopee. Baixando o existente.');
      }
    }

    // Espera curta pelo READY. A doc só libera o download nesse estado.
    let ready = documentReady;
    let lastCode = null;
    let lastMessage = null;
    for (let attempt = 0; attempt < 6 && !ready; attempt += 1) {
      if (attempt) await waitBeforeRetry(1500);
      const result = await withTokenRetry(
        account,
        (accessToken) => getShopeeShippingDocumentResult({
          partnerId, partnerKey, accessToken, shopId: account.shopId, orderSn, packageNumber, documentType,
        }),
        partnerId,
        partnerKey
      );
      const item = firstShopeeResult(result);
      lastCode = item?.fail_error || null;
      lastMessage = item?.fail_message || result?.message || null;
      if (item?.status === 'READY') ready = true;
      if (item?.status === 'FAILED') {
        return fail(409, lastCode || 'logistics.package_print_failed', lastMessage);
      }
    }

    if (!ready) {
      return fail(409, lastCode || 'logistics.download_later', lastMessage);
    }

    const download = await withTokenRetry(
      account,
      (accessToken) => downloadShopeeShippingDocument({
        partnerId, partnerKey, accessToken, shopId: account.shopId, orderSn, packageNumber, documentType,
      }),
      partnerId,
      partnerKey
    );

    if (!download.ok) {
      console.warn(`[Shopee Label] Download recusado no pedido ${orderSn}: ${download.error} `
        + `— ${download.message || 'sem detalhe'}`);
      return fail(409, download.error, download.message);
    }

    /* SKU estampado na etiqueta, como já acontece no Mercado Livre.
     *
     * Fica num bloco de fundo branco na base da etiqueta. Não escrevo sobre o
     * QR code nem sobre o código de barras de propósito: texto sobre os módulos
     * do QR pode impedir a leitura no centro de distribuição, e etiqueta que não
     * é lida sai mais caro que SKU pouco destacado.
     *
     * Nada aqui é impeditivo. Sem itens gravados, ou se o PDF não puder ser
     * reescrito, a etiqueta original segue para o cliente do mesmo jeito.
     */
    let labelBuffer = download.buffer;
    const isPdf = /pdf/i.test(download.contentType || 'application/pdf');
    if (isPdf) {
      try {
        const itens = await findShopeeItemsForLabel(ownerUid, account.shopId, orderSn);
        const linhas = buildItemLines(itens);
        if (linhas.length > 0) {
          labelBuffer = await stampLabelLines(labelBuffer, linhas);
        } else {
          console.warn(`[Shopee Label] Pedido ${orderSn} sem SKU gravado: etiqueta sai sem o bloco de conferência.`);
        }
      } catch (stampError) {
        console.error(`[Shopee Label] Falha ao estampar SKU no pedido ${orderSn}:`, stampError.message);
      }
    }

    const suffix = documentType === SHOPEE_LABEL_TYPES.thermal ? 'termica' : 'etiqueta';
    res.setHeader('Content-Type', download.contentType || 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="shopee-${suffix}-${orderSn}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(labelBuffer);
  } catch (error) {
    const code = error?.shopeeCode || null;
    console.error(`[Shopee Label] Falha ao baixar etiqueta do pedido ${orderSn}:`, error.message);
    return fail(code ? 409 : 500, code, error.message);
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

function configInt(name, fallback, min, max) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  const value = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(max, Math.max(min, value));
}

const SHOPEE_JOB_TIMEOUT_MS = configInt('SHOPEE_JOB_TIMEOUT_MS', 900000, 60000, 3600000);

/* Concorrência do abatimento de estoque em lote. Igual à do ML: o pool tem 15
 * conexões e o mesmo banco atende as telas, então 4 é folga, não teto. */
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

/* O escrow da Shopee só é definitivo depois do repasse. Antes disso os valores
 * ainda mudam (comissão, reconciliação de frete) sem necessariamente mexer no
 * update_time do pedido, então reaproveitar seria congelar financeiro errado. */
const TERMINAL_SHOPEE_STATUS = new Set(['COMPLETED', 'CANCELLED']);

function isEscrowSettled(escrow, status) {
  // Pedido cancelado não gera repasse: o financeiro dele já é definitivo.
  // Sem isto, todo cancelado custava 1 consulta de escrow em cada execução.
  if (status === 'CANCELLED') return true;
  if (!escrow || typeof escrow !== 'object') return false;
  const releaseTime = Number(escrow.escrow_release_time || escrow.order_income?.escrow_release_time || 0);
  if (Number.isFinite(releaseTime) && releaseTime > 0) return true;
  const amount = Number(escrow.order_income?.escrow_amount ?? escrow.escrow_amount);
  return Number.isFinite(amount) && amount !== 0;
}

/**
 * Decide se um pedido pode ser reaproveitado sem nova consulta financeira e sem
 * reescrita. `expectedRows` só é informado na gravação, onde já sabemos quantas
 * linhas o pedido gera: sem essa checagem, uma gravação parcial anterior (uma
 * linha de um pedido de 3 SKUs) seria considerada completa para sempre.
 */
function canReuseSavedOrder(previous, order, expectedRows = null) {
  if (!previous || !previous.hasEscrow || !previous.hasSyncedItem) return false;
  if (previous.updateTime === null) return false;
  if (String(previous.updateTime) !== String(order.update_time ?? '')) return false;

  const status = String(order.order_status || '');
  if (String(previous.orderStatus || '') !== status) return false;
  if (!TERMINAL_SHOPEE_STATUS.has(status)) return false;
  if (!isEscrowSettled(previous.escrow, status)) return false;
  if (expectedRows !== null && previous.rowCount !== expectedRows) return false;
  return true;
}

function assertJobDeadline(deadlineAt, phase) {
  if (Date.now() >= deadlineAt) {
    const error = new Error(`Sincronização Shopee excedeu o limite durante ${phase}. Tente novamente; o próximo ciclo continuará do último checkpoint.`);
    error.code = 'SHOPEE_JOB_TIMEOUT';
    throw error;
  }
}

/**
 * Busca + enriquece pedidos de uma janela (list -> detail -> escrow).
 *
 * `resolveSavedState` devolve o que já está gravado para os pedidos da janela.
 * Pedido cujo `update_time` e status não mudaram e que já tem financeiro salvo
 * NÃO gasta nova chamada de escrow — era 1 chamada por pedido e dominava o
 * tempo total (2.370 chamadas para encontrar 9 vendas novas).
 */
async function fetchWindowOrders(account, from, to, partnerId, partnerKey, timeRangeField = 'create_time', deadlineAt = Infinity, resolveSavedState = null) {
  const orderSnList = [];
  const seenCursors = new Set();
  let cursor;
  do {
    assertJobDeadline(deadlineAt, 'listagem de pedidos');
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
          deadlineAt,
        }),
      partnerId,
      partnerKey
    );
    if (list?.order_list) list.order_list.forEach((order) => orderSnList.push(String(order.order_sn)));
    const nextCursor = list?.more ? list.next_cursor : undefined;
    if (nextCursor && seenCursors.has(nextCursor)) throw new Error('A Shopee repetiu o cursor da listagem; sincronização interrompida para evitar loop infinito.');
    if (nextCursor) seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor);

  if (orderSnList.length === 0) {
    return { orders: [], savedState: new Map(), escrowCalls: 0, escrowReused: 0 };
  }

  assertJobDeadline(deadlineAt, 'detalhamento de pedidos');
  const batches = [];
  for (let i = 0; i < orderSnList.length; i += 50) batches.push(orderSnList.slice(i, i + 50));
  const detailResults = await Promise.all(
    batches.map((batch) =>
      withTokenRetry(
        account,
        (accessToken) =>
          getShopeeOrderDetail({ partnerId, partnerKey, accessToken, shopId: account.shopId, orderSnList: batch.join(','), deadlineAt }),
        partnerId,
        partnerKey
      )
    )
  );
  const detailed = detailResults.flatMap((result) => result?.order_list || []);
  if (detailed.length !== orderSnList.length) {
    throw new Error(`A Shopee retornou detalhes incompletos (${detailed.length}/${orderSnList.length}); o cursor não será avançado.`);
  }

  // Estado salvo da janela: define quem ainda precisa de consulta financeira.
  // O Map é devolvido para a gravação reutilizar, evitando repetir a consulta.
  const saved = resolveSavedState ? await resolveSavedState(detailed.map((o) => String(o.order_sn))) : new Map();
  const pendingEscrow = [];
  for (const order of detailed) {
    const previous = saved.get(String(order.order_sn));
    if (canReuseSavedOrder(previous, order)) {
      order.escrow_details = previous.escrow;
    } else {
      pendingEscrow.push(order);
    }
  }

  // Escrow com concorrência limitada. Qualquer falha interrompe a janela:
  // financeiro incompleto nunca pode ser consolidado junto com o watermark.
  const ESCROW_CONCURRENCY = 8;
  let index = 0;
  async function escrowWorker() {
    while (index < pendingEscrow.length) {
      assertJobDeadline(deadlineAt, 'consulta financeira');
      const order = pendingEscrow[index++];
      order.escrow_details = await withTokenRetry(
        account,
        (accessToken) => getShopeeEscrowDetail({ partnerId, partnerKey, accessToken, shopId: account.shopId, orderSn: String(order.order_sn), deadlineAt }),
        partnerId,
        partnerKey
      );
    }
  }
  await Promise.all(Array.from({ length: Math.min(ESCROW_CONCURRENCY, pendingEscrow.length) }, () => escrowWorker()));

  return {
    orders: detailed,
    savedState: saved,
    escrowCalls: pendingEscrow.length,
    escrowReused: detailed.length - pendingEscrow.length,
  };
}

/**
 * Percorre janelas até o limite capturado no início do job.
 *
 * Cada janela é gravada e confirmada por `onWindow` ANTES de seguir para a
 * próxima. Assim uma execução interrompida retoma do último checkpoint em vez
 * de recomeçar os 120 dias, e não acumulamos milhares de pedidos em memória.
 */
async function processWindows({
  account, since, upperBound, partnerId, partnerKey,
  timeRangeField, deadlineAt, resolveSavedState, onWindow,
}) {
  let windowStart = since;
  let windowsDone = 0;
  let totalOrders = 0;

  while (windowStart < upperBound) {
    assertJobDeadline(deadlineAt, 'varredura das janelas');
    const windowEnd = new Date(Math.min(windowStart.getTime() + MAX_WINDOW_DAYS * 86400000, upperBound.getTime()));
    const window = await fetchWindowOrders(
      account, windowStart, windowEnd, partnerId, partnerKey, timeRangeField, deadlineAt, resolveSavedState
    );

    totalOrders += window.orders.length;
    windowsDone += 1;
    await onWindow({
      orders: window.orders,
      savedState: window.savedState,
      windowEnd,
      windowsDone,
      totalOrders,
      escrowCalls: window.escrowCalls,
      escrowReused: window.escrowReused,
    });

    windowStart = new Date(windowEnd.getTime() + 1);
  }

  return { windowsDone, totalOrders };
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
  /* Só chama de "atualizada" quando algum valor que realmente seria gravado
   * mudou. O WHERE antigo aceitava toda linha ainda não processada, portanto
   * TODA linha executava UPDATE, recebia updated_at=NOW() e voltava no
   * RETURNING mesmo quando todos os valores eram idênticos. Era a origem dos
   * "122 atualizadas" sem 122 mudanças remotas. */
  WHERE ROW(
          public.shopee_sales.account_nickname,
          public.shopee_sales.sale_date,
          public.shopee_sales.order_status,
          public.shopee_sales.buyer_username,
          public.shopee_sales.recipient_name,
          public.shopee_sales.tracking_number,
          public.shopee_sales.shipping_carrier,
          public.shopee_sales.ship_by_date,
          public.shopee_sales.raw_api_data,
          CASE WHEN public.shopee_sales.processed_at IS NULL THEN public.shopee_sales.product_title END,
          CASE WHEN public.shopee_sales.processed_at IS NULL THEN public.shopee_sales.quantity END,
          CASE WHEN public.shopee_sales.processed_at IS NULL THEN public.shopee_sales.unit_price END,
          CASE WHEN public.shopee_sales.processed_at IS NULL THEN public.shopee_sales.total_amount END,
          CASE WHEN public.shopee_sales.processed_at IS NULL THEN public.shopee_sales.platform_fee END,
          CASE WHEN public.shopee_sales.processed_at IS NULL THEN public.shopee_sales.freight END,
          CASE WHEN public.shopee_sales.processed_at IS NULL THEN public.shopee_sales.net_revenue END
        ) IS DISTINCT FROM ROW(
          EXCLUDED.account_nickname,
          EXCLUDED.sale_date,
          EXCLUDED.order_status,
          EXCLUDED.buyer_username,
          EXCLUDED.recipient_name,
          EXCLUDED.tracking_number,
          EXCLUDED.shipping_carrier,
          EXCLUDED.ship_by_date,
          EXCLUDED.raw_api_data,
          CASE WHEN public.shopee_sales.processed_at IS NULL THEN EXCLUDED.product_title END,
          CASE WHEN public.shopee_sales.processed_at IS NULL THEN EXCLUDED.quantity END,
          CASE WHEN public.shopee_sales.processed_at IS NULL THEN EXCLUDED.unit_price END,
          CASE WHEN public.shopee_sales.processed_at IS NULL THEN EXCLUDED.total_amount END,
          CASE WHEN public.shopee_sales.processed_at IS NULL THEN EXCLUDED.platform_fee END,
          CASE WHEN public.shopee_sales.processed_at IS NULL THEN EXCLUDED.freight END,
          CASE WHEN public.shopee_sales.processed_at IS NULL THEN EXCLUDED.net_revenue END
        )
  RETURNING (xmax = 0) AS inserted;
`;

async function upsertRow(row, executor = db) {
  const result = await executor.query(UPSERT_QUERY, [
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
async function updateProcessedOrder(orderSn, uid, row, executor = db) {
  const result = await executor.query(
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
        AND processed_at IS NOT NULL
        /* UPDATE só quando os metadados que seriam gravados realmente mudam.
         * Sem este predicado, rowCount era o número de linhas encontradas, não
         * o número de linhas alteradas, e inflava "atualizadas". */
        AND ROW(
          public.shopee_sales.account_nickname,
          public.shopee_sales.order_status,
          public.shopee_sales.buyer_username,
          public.shopee_sales.recipient_name,
          public.shopee_sales.tracking_number,
          public.shopee_sales.shipping_carrier,
          public.shopee_sales.ship_by_date,
          public.shopee_sales.raw_api_data
        ) IS DISTINCT FROM ROW(
          $3, $4, $5, $6, $7, $8, $9,
          jsonb_set(
            $10::jsonb,
            '{synced_item}',
            COALESCE(
              public.shopee_sales.raw_api_data->'synced_item',
              public.shopee_sales.raw_api_data->'item_list'->0,
              'null'::jsonb
            ),
            TRUE
          )
        )`,
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
  let nickname = String(shopId || 'Shopee');
  let lockAcquired = false;
  let leaseLost = false;
  let leaseTimer = null;
  const startedAt = Date.now();
  const deadlineAt = startedAt + SHOPEE_JOB_TIMEOUT_MS;

  if (!shopId || !clientId) return res.status(400).json({ error: 'shopId e clientId são obrigatórios.' });

  try {
    let accRes;
    if (req.user.role === 'master' && clientUid) {
      accRes = await db.query('SELECT * FROM public.shopee_accounts WHERE shop_id = $1 AND uid = $2', [shopId, clientUid]);
    } else if (req.user.role === 'master') {
      accRes = await db.query('SELECT * FROM public.shopee_accounts WHERE shop_id = $1 LIMIT 1', [shopId]);
    } else {
      accRes = await db.query('SELECT * FROM public.shopee_accounts WHERE shop_id = $1 AND uid = $2', [shopId, targetUid]);
    }
    if (accRes.rowCount === 0) {
      finalizeJob(clientId, { message: 'Loja Shopee não encontrada.', type: 'error' });
      return res.status(404).json({ error: 'Loja Shopee não encontrada.' });
    }

    const accRow = accRes.rows[0];
    targetUid = accRow.uid;
    nickname = accRow.shop_name || String(accRow.shop_id);

    /* Clique repetido não vale uma varredura nova.
     *
     * Sincronizar de novo poucos segundos depois de um sucesso não pode
     * encontrar nada: a Shopee não teria tido tempo de mudar nada. Ainda assim,
     * cada clique gastava a rodada completa de chamadas (lista + detalhe +
     * escrow de cada pedido da janela) e o orçamento de rate limit da loja.
     *
     * Dentro da janela de carência a resposta é o resultado da última execução,
     * devolvido na hora. `force` continua ignorando a carência: é justamente o
     * caminho para quem quer varrer de novo agora.
     */
    if (!force) {
      const cooldownSeconds = configInt('SHOPEE_SYNC_COOLDOWN_SECONDS', 60, 0, 3600);
      if (cooldownSeconds > 0) {
        const recent = await db.query(
          `SELECT last_success_at, last_result,
                  EXTRACT(EPOCH FROM (NOW() - last_success_at))::int AS age_seconds
             FROM public.shopee_sync_cursors
            WHERE uid = $1 AND shop_id = $2
              AND status = 'success'
              AND last_success_at > NOW() - ($3::int * interval '1 second')`,
          [targetUid, shopId, cooldownSeconds]
        );

        if (recent.rowCount > 0) {
          const age = recent.rows[0].age_seconds ?? 0;
          console.log(`[shopee-sync] ${nickname}: carência ativa, concluída há ${age}s; nenhuma chamada à Shopee.`);
          const payload = {
            ...(recent.rows[0].last_result || {}),
            message: `[${nickname}] Já estava atualizada (sincronizada há ${age}s).`,
            type: 'success',
            newSalesCount: 0,
            updatedCount: 0,
            skippedCount: 0,
            fromCooldown: true,
          };
          finalizeJob(clientId, payload);
          return res.status(200).json({ message: payload.message, status: 'success', fromCooldown: true });
        }
      }
    }

    // POST idempotente por clientId: uma resposta 202 perdida pode ser repetida
    // sem iniciar outro job ou transformar o próprio job em conflito.
    const existingJob = await db.query(
      `SELECT status, result, error FROM public.shopee_sync_jobs
        WHERE client_id = $1 AND uid = $2 AND shop_id = $3 AND expires_at > NOW()`,
      [clientId, targetUid, shopId]
    );
    if (existingJob.rowCount > 0) {
      const job = existingJob.rows[0];
      if (job.status === 'success' || job.status === 'error') {
        finalizeJob(clientId, job.result || { type: job.status, message: job.error || 'Sincronização finalizada.' });
      }
      return res.status(job.status === 'running' ? 202 : 200).json({ message: 'Job Shopee já registrado.', status: job.status });
    }

    // Lock durável: funciona entre instâncias e expira se o processo cair.
    const lockDurationMs = SHOPEE_JOB_TIMEOUT_MS + 2 * 60 * 1000;
    const lockResult = await db.query(
      `INSERT INTO public.shopee_sync_cursors
         (uid, shop_id, status, job_id, last_attempt_at, locked_until, updated_at)
       VALUES ($1, $2, 'running', $3, NOW(), NOW() + ($4::int * interval '1 millisecond'), NOW())
       ON CONFLICT (uid, shop_id) DO UPDATE SET
         status = 'running', job_id = EXCLUDED.job_id,
         last_attempt_at = NOW(), locked_until = EXCLUDED.locked_until,
         last_error = NULL, last_result = NULL, updated_at = NOW()
       WHERE public.shopee_sync_cursors.status <> 'running'
          OR public.shopee_sync_cursors.locked_until IS NULL
          OR public.shopee_sync_cursors.locked_until < NOW()
       RETURNING *`,
      [targetUid, shopId, clientId, lockDurationMs]
    );

    if (lockResult.rowCount === 0) {
      const owner = await db.query(
        'SELECT job_id FROM public.shopee_sync_cursors WHERE uid = $1 AND shop_id = $2',
        [targetUid, shopId]
      );
      if (owner.rows[0]?.job_id === clientId) {
        return res.status(202).json({ message: 'Sincronização Shopee já iniciada.', status: 'running' });
      }
      const message = `[${nickname}] Já existe uma sincronização Shopee em andamento.`;
      finalizeJob(clientId, { message, type: 'error', alreadyRunning: true });
      return res.status(409).json({ error: message, alreadyRunning: true });
    }
    lockAcquired = true;
    const cursorState = lockResult.rows[0];

    await db.query('DELETE FROM public.shopee_sync_jobs WHERE expires_at < NOW()');
    await db.query(
      `INSERT INTO public.shopee_sync_jobs (client_id, uid, shop_id, status)
       VALUES ($1, $2, $3, 'running')`,
      [clientId, targetUid, shopId]
    );

    leaseTimer = setInterval(async () => {
      try {
        const renewed = await db.query(
          `UPDATE public.shopee_sync_cursors
              SET locked_until = NOW() + ($1::int * interval '1 millisecond'), updated_at = NOW()
            WHERE uid = $2 AND shop_id = $3 AND job_id = $4 AND status = 'running'
          RETURNING job_id`,
          [lockDurationMs, targetUid, shopId, clientId]
        );
        if (renewed.rowCount !== 1) leaseLost = true;
      } catch (error) {
        console.warn(`[shopee-sync] ${nickname}: falha ao renovar lease:`, error.message);
      }
    }, 30000);

    const ensureLease = () => {
      if (leaseLost) throw new Error('A sincronização perdeu o lock da loja e foi interrompida com segurança.');
    };

    res.status(202).json({ message: 'Sincronização Shopee iniciada. Acompanhe status.' });
    sendEvent(clientId, { progress: 10, message: `[${nickname}] Preparando sincronização...`, type: 'info' });

    const account = {
      uid: accRow.uid,
      shopId: String(accRow.shop_id),
      shopName: accRow.shop_name,
      accessToken: accRow.access_token,
      refreshToken: accRow.refresh_token,
      deadlineAt,
    };
    const { partnerId, partnerKey } = getShopeePartnerCredentials();
    if (!partnerId || !partnerKey) throw new Error('Credenciais Shopee não configuradas no servidor.');

    const expiresAt = accRow.expires_at ? new Date(accRow.expires_at).getTime() : 0;
    if (expiresAt - Date.now() < 10 * 60 * 1000) {
      assertJobDeadline(deadlineAt, 'renovação do token');
      sendEvent(clientId, { progress: 15, message: `[${nickname}] Renovando token...`, type: 'info' });
      const refreshed = await refreshShopeeToken(account, partnerId, partnerKey);
      account.accessToken = refreshed.access_token;
      account.refreshToken = refreshed.refresh_token;
    }

    const scanInfo = await db.query(
      `SELECT
         COUNT(*)::int AS sale_count,
         MIN(sale_date) FILTER (
           WHERE CASE
                   WHEN jsonb_typeof(raw_api_data->'item_list') = 'array'
                   THEN jsonb_array_length(raw_api_data->'item_list') > 1
                   ELSE FALSE
                 END
             AND NOT (raw_api_data ? 'synced_item')
             AND NOT COALESCE((raw_api_data->>'legacy_scan_done')::boolean, false)
         ) AS legacy_since
       FROM public.shopee_sales
       WHERE uid = $1 AND shop_id = $2`,
      [targetUid, shopId]
    );

    const saleCount = Number(scanInfo.rows[0]?.sale_count || 0);
    const legacySince = scanInfo.rows[0]?.legacy_since ? new Date(scanInfo.rows[0].legacy_since) : null;
    const watermark = cursorState.update_time_scanned_through
      ? new Date(cursorState.update_time_scanned_through)
      : null;
    const lookbackDays = configInt('SHOPEE_LEGACY_LOOKBACK_DAYS', 120, 1, 365);
    const oldestUseful = new Date(Date.now() - lookbackDays * 86400000);
    const upperBound = new Date(Math.floor(Date.now() / 1000) * 1000);
    let since;
    let timeRangeField;
    let ranLegacyScan = false;
    let checkpointEnabled = true;
    // Marca a execução que fez a varredura profunda periódica, para o carimbo
    // só avançar quando a janela larga realmente foi percorrida.
    let isDeepSweep = false;

    const backfillProgress = cursorState.backfill_scanned_through
      ? new Date(cursorState.backfill_scanned_through)
      : null;
    const backfillPending =
      !cursorState.initial_backfill_completed_at && (saleCount === 0 || backfillProgress !== null);

    if (force || legacySince) {
      ranLegacyScan = Boolean(legacySince);
      checkpointEnabled = false;
      const desired = legacySince ? new Date(legacySince.getTime() - 86400000) : oldestUseful;
      since = desired > oldestUseful ? desired : oldestUseful;
      timeRangeField = 'create_time';
    } else if (backfillPending) {
      // Retoma a carga inicial do último checkpoint em vez de recomeçar.
      since = backfillProgress && backfillProgress > oldestUseful ? backfillProgress : oldestUseful;
      timeRangeField = 'create_time';
    } else if (watermark) {
      /* Sobreposição CURTA, não 24 horas.
       *
       * Era `watermark - 86400000`: toda sincronização incremental relia um dia
       * inteiro de pedidos da loja, buscava o detalhe de cada um e chamava o
       * escrow de cada um. Era isso que fazia um clique repetido custar o mesmo
       * que o primeiro, mesmo sem nada ter mudado — e o que explica dezenas de
       * "atualizados" num intervalo em que nada podia ter acontecido.
       *
       * A sobreposição existe para cobrir corrida de fronteira: um pedido cujo
       * update_time cai exatamente no limite da última janela. Minutos bastam
       * para isso; um dia era margem sem critério.
       *
       * A rede de segurança continua, mas com o preço certo: de tempo em tempo
       * (SHOPEE_DEEP_SWEEP_HOURS) uma execução volta a olhar 24h, para pegar
       * qualquer coisa que a API tenha revelado fora de ordem.
       */
      const overlapMinutes = configInt('SHOPEE_OVERLAP_MINUTES', 15, 1, 1440);
      const deepSweepHours = configInt('SHOPEE_DEEP_SWEEP_HOURS', 12, 1, 168);
      /* Bancos atualizados a partir da versão antiga já varriam 24h em toda
       * execução. `last_success_at` é um fallback defensivo caso a coluna nova
       * ainda esteja nula: o primeiro clique pós-deploy não precisa reler o dia
       * inteiro que a última execução já releu. A migração persiste esse marco. */
      const deepSweepBaseline =
        cursorState.last_deep_sweep_at
        || cursorState.last_success_at
        || cursorState.initial_backfill_completed_at;
      const lastDeepSweep = deepSweepBaseline ? new Date(deepSweepBaseline) : null;
      isDeepSweep = !lastDeepSweep
        || (Date.now() - lastDeepSweep.getTime()) > deepSweepHours * 3600000;

      const overlapMs = isDeepSweep ? 86400000 : overlapMinutes * 60000;
      since = new Date(watermark.getTime() - overlapMs);
      timeRangeField = 'update_time';
    } else if (saleCount > 0) {
      // Primeira execução após esta migration: revisa alterações remotas dos
      // últimos 120 dias, em vez de usar updated_at local como relógio remoto.
      since = oldestUseful;
      timeRangeField = 'update_time';
    } else {
      since = oldestUseful;
      timeRangeField = 'create_time';
    }

    console.log(`[shopee-sync] ${nickname}: ${timeRangeField} ${since.toISOString()} -> ${upperBound.toISOString()}`);
    sendEvent(clientId, {
      progress: 20,
      message: timeRangeField === 'update_time'
        ? `[${nickname}] Buscando pedidos novos e atualizados...`
        : `[${nickname}] Sincronização completa iniciada...`,
      type: 'info',
    });

    /* Grava o avanço de UMA janela já concluída.
     *
     * No backfill por create_time o progresso vai para `backfill_scanned_through`:
     * usar o watermark incremental aqui faria a próxima execução pular pedidos
     * antigos que ainda não foram carregados.
     */
    const saveWindowCheckpoint = async (windowEnd) => {
      // Varredura force/legado começa num ponto arbitrário do passado. Marcar
      // progresso ali abriria um intervalo de create_time nunca varrido, então
      // esses modos continuam confirmando tudo só no fim.
      if (!checkpointEnabled) return;

      const column = timeRangeField === 'create_time' ? 'backfill_scanned_through' : 'update_time_scanned_through';
      const result = await db.query(
        `UPDATE public.shopee_sync_cursors
            SET ${column} = GREATEST(COALESCE(${column}, $1), $1),
                backfill_started_at = CASE
                  WHEN $2 = 'create_time' THEN COALESCE(backfill_started_at, $3)
                  ELSE backfill_started_at
                END,
                updated_at = NOW()
          WHERE uid = $4 AND shop_id = $5 AND job_id = $6 AND status = 'running'
        RETURNING job_id`,
        [windowEnd, timeRangeField, new Date(startedAt), targetUid, shopId, clientId]
      );
      if (result.rowCount !== 1) {
        leaseLost = true;
        ensureLease();
      }
    };

    const finishLegacyScan = async () => {
      if (!ranLegacyScan) return;
      const marked = await db.query(
        `UPDATE public.shopee_sales
            SET raw_api_data = jsonb_set(raw_api_data, '{legacy_scan_done}', 'true'::jsonb, TRUE)
          WHERE uid = $1 AND shop_id = $2
            AND jsonb_typeof(raw_api_data->'item_list') = 'array'
            AND jsonb_array_length(raw_api_data->'item_list') > 1
            AND NOT (raw_api_data ? 'synced_item')
            AND NOT COALESCE((raw_api_data->>'legacy_scan_done')::boolean, false)`,
        [targetUid, shopId]
      );
      if (marked.rowCount > 0) console.log(`[shopee-sync] ${nickname}: ${marked.rowCount} legado(s) marcados como verificados.`);
    };

    let insertedItems = 0;
    let updatedItems = 0;
    let skippedItems = 0;
    let savedOrders = 0;
    let escrowCallsTotal = 0;
    let escrowReusedTotal = 0;

    /** Estado gravado dos pedidos da janela, usado para evitar trabalho inútil. */
    const resolveSavedState = async (orderSns) => {
      const state = new Map();
      if (orderSns.length === 0) return state;
      const { rows } = await db.query(
        `SELECT order_sn,
                COUNT(*)::int                            AS row_count,
                MIN(raw_api_data->>'update_time')        AS update_time,
                MIN(raw_api_data->>'order_status')       AS order_status,
                (array_agg(raw_api_data->'escrow_details'
                           ORDER BY updated_at DESC NULLS LAST))[1] AS escrow,
                bool_and(raw_api_data ? 'synced_item')   AS has_synced_item,
                bool_or(processed_at IS NOT NULL)        AS processed
           FROM public.shopee_sales
          WHERE uid = $1 AND shop_id = $2 AND order_sn = ANY($3::text[])
          GROUP BY order_sn`,
        [targetUid, shopId, orderSns]
      );
      for (const row of rows) {
        const escrow = row.escrow && typeof row.escrow === 'object' ? row.escrow : null;
        state.set(String(row.order_sn), {
          rowCount: row.row_count,
          updateTime: row.update_time,
          orderStatus: row.order_status,
          escrow,
          hasEscrow: Boolean(escrow) && Object.keys(escrow).length > 0,
          hasSyncedItem: row.has_synced_item === true,
          processed: row.processed === true,
        });
      }
      return state;
    };

    const saveWindow = async ({ orders, savedState, windowEnd, windowsDone, totalOrders, escrowCalls, escrowReused }) => {
      ensureLease();
      escrowCallsTotal += escrowCalls;
      escrowReusedTotal += escrowReused;

      if (orders.length > 0) {
        assertJobDeadline(deadlineAt, 'gravação dos pedidos');
        /* Cada worker mantém uma conexão do pool durante a transação do pedido.
         * O pool tem 15 conexões e o botão global sincroniza 2 lojas Shopee com
         * 3 contas ML ao mesmo tempo, então 6 por loja esgotaria o pool e
         * derrubaria requisições da própria tela. 3 deixa folga. */
        const SAVE_CONCURRENCY = configInt('SHOPEE_SAVE_CONCURRENCY', 3, 1, 8);
        let saveIndex = 0;
        let aborted = false;

        const saveWorker = async () => {
          while (saveIndex < orders.length) {
            // Um erro em qualquer worker para todos os demais. Sem isso, os
            // outros seguiriam gravando depois do job já ter falhado.
            if (aborted) return;
            const order = orders[saveIndex++];
            try {
              ensureLease();
              assertJobDeadline(deadlineAt, 'gravação dos pedidos');

              const orderSn = String(order.order_sn);
              const previous = savedState.get(orderSn);
              const rows = orderToRows(order, account, nickname);
              for (const row of rows) row.uid = targetUid;

              // Nada mudou, o financeiro está liquidado e TODAS as linhas do
              // pedido já existem: não reescreve.
              if (canReuseSavedOrder(previous, order, rows.length)) {
                skippedItems += rows.length;
                savedOrders += 1;
                continue;
              }

              // Transação por pedido: um pedido multi-SKU nunca fica com parte
              // das linhas gravadas, o que o faria ser pulado para sempre.
              const orderClient = await db.pool.connect();
              try {
                await orderClient.query('BEGIN');
                if (previous?.processed) {
                  const affected = await updateProcessedOrder(orderSn, targetUid, rows[0], orderClient);
                  updatedItems += affected;
                  skippedItems += Math.max(0, rows.length - affected);
                } else {
                  for (const row of rows) {
                    const outcome = await upsertRow(row, orderClient);
                    if (outcome === 'inserted') insertedItems += 1;
                    else if (outcome === 'updated') updatedItems += 1;
                    else skippedItems += 1;
                  }
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
        await Promise.all(Array.from({ length: Math.min(SAVE_CONCURRENCY, orders.length) }, () => saveWorker()));
      }

      // Checkpoint: a janela foi listada, detalhada e gravada por completo.
      await saveWindowCheckpoint(windowEnd);

      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      console.log(`[shopee-sync] ${nickname}: janela ${windowsDone} ok, ${orders.length} pedido(s), escrow=${escrowCalls} reaproveitado=${escrowReused}, até ${windowEnd.toISOString()}, ${elapsed}s`);
      sendEvent(clientId, {
        progress: Math.min(95, 20 + windowsDone * 8),
        message: `[${nickname}] ${windowsDone} janela(s) concluída(s), ${totalOrders} pedido(s) verificados...`,
        type: 'info',
        newSalesCount: insertedItems,
        updatedCount: updatedItems,
        skippedCount: skippedItems,
      });
    };

    const { totalOrders } = await processWindows({
      account,
      since,
      upperBound,
      partnerId,
      partnerKey,
      timeRangeField,
      deadlineAt,
      resolveSavedState,
      onWindow: saveWindow,
    });

    await finishLegacyScan();
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
    };

    // Watermark e resultado terminal são confirmados na mesma transação. O
    // UPDATE ... RETURNING é o fencing: sem a posse do job não existe sucesso.
    clearInterval(leaseTimer);
    leaseTimer = null;
    const finishClient = await db.pool.connect();
    try {
      await finishClient.query('BEGIN');
      const cursorUpdate = await finishClient.query(
        /* O watermark incremental nunca pode passar do INÍCIO do backfill.
         *
         * Um backfill retomado em vários dias termina com upperBound de hoje;
         * usar esse valor faria o primeiro incremental ignorar tudo que mudou
         * enquanto a carga estava em andamento. */
        `UPDATE public.shopee_sync_cursors
            SET update_time_scanned_through = GREATEST(
                  COALESCE(update_time_scanned_through, TIMESTAMPTZ '-infinity'),
                  LEAST($1::timestamptz, COALESCE(backfill_started_at, $1::timestamptz))
                ),
                initial_backfill_completed_at = CASE
                  WHEN $2 = 'create_time' THEN COALESCE(initial_backfill_completed_at, NOW())
                  ELSE initial_backfill_completed_at
                END,
                last_success_at = NOW(), status = 'success', last_error = NULL,
                backfill_scanned_through = NULL, backfill_started_at = NULL,
                -- Só a execução que percorreu a janela larga reinicia o relógio
                -- da varredura profunda. Uma incremental curta não conta.
                last_deep_sweep_at = CASE
                  WHEN $7::boolean THEN NOW() ELSE last_deep_sweep_at
                END,
                last_result = $3::jsonb, locked_until = NULL, updated_at = NOW()
          WHERE uid = $4 AND shop_id = $5 AND job_id = $6 AND status = 'running'
        RETURNING job_id`,
        [upperBound, timeRangeField, JSON.stringify(terminalPayload), targetUid, shopId, clientId,
          isDeepSweep || timeRangeField === 'create_time']
      );
      if (cursorUpdate.rowCount !== 1) throw new Error('A sincronização perdeu a posse do lock antes da conclusão.');

      const jobUpdate = await finishClient.query(
        `UPDATE public.shopee_sync_jobs
            SET status = 'success', result = $1::jsonb, error = NULL, updated_at = NOW()
          WHERE client_id = $2 AND status = 'running'
        RETURNING client_id`,
        [JSON.stringify(terminalPayload), clientId]
      );
      if (jobUpdate.rowCount !== 1) throw new Error('O estado terminal do job Shopee não pôde ser persistido.');
      await finishClient.query('COMMIT');
    } catch (finishError) {
      await finishClient.query('ROLLBACK');
      throw finishError;
    } finally {
      finishClient.release();
    }
    lockAcquired = false;

    const durationSeconds = Math.round((Date.now() - startedAt) / 1000);
    console.log(`[shopee-sync] ${nickname}: concluído em ${durationSeconds}s; pedidos=${savedOrders}, novos=${insertedItems}, atualizados=${updatedItems}, sem mudança=${skippedItems}, escrow=${escrowCallsTotal}, escrow reaproveitado=${escrowReusedTotal}`);
    finalizeJob(clientId, terminalPayload);
  } catch (error) {
    console.error(`[shopee-sync] ${nickname} falhou após ${Date.now() - startedAt}ms:`, error);
    const errorPayload = { message: error.message || 'Erro na sincronização Shopee.', type: 'error' };
    clearInterval(leaseTimer);
    leaseTimer = null;
    try {
      if (lockAcquired) {
        await db.query(
          `UPDATE public.shopee_sync_cursors
              SET status = 'error', last_error = $1, last_result = $2::jsonb,
                  locked_until = NULL, updated_at = NOW()
            WHERE uid = $3 AND shop_id = $4 AND job_id = $5`,
          [String(error.message || error).slice(0, 2000), JSON.stringify(errorPayload), targetUid, shopId, clientId]
        );
      }
      await db.query(
        `UPDATE public.shopee_sync_jobs
            SET status = 'error', result = $1::jsonb, error = $2, updated_at = NOW()
          WHERE client_id = $3 AND status = 'running'`,
        [JSON.stringify(errorPayload), String(error.message || error).slice(0, 2000), clientId]
      );
    } catch (stateError) {
      console.error('[shopee-sync] falha ao persistir estado do job:', stateError);
    }
    finalizeJob(clientId, errorPayload);
    if (!res.headersSent) res.status(500).json({ error: error.message || 'Erro na sincronização Shopee.' });
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
      `SELECT last_success_at, update_time_scanned_through, status, last_error
         FROM public.shopee_sync_cursors
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

  /** Processa UM pedido, na própria conexão e na própria transação. */
  const runOne = async (requestedSale) => {
    if (!requestedSale.orderSn || !requestedSale.sku || !requestedSale.uid) {
      throw new Error('Dados da venda incompletos (orderSn, sku e uid).');
    }

    const client = await db.pool.connect();
    try {
      try {
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
          return {
            orderSn: sale.order_sn,
            sku: sale.sku,
            alreadyProcessed: true,
          };
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
        return { orderSn: sale.order_sn, sku: sale.sku, alreadyProcessed: false };
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* transação já encerrada */ }
        throw error;
      }
    } finally {
      client.release();
    }
  };

  try {
    /* Antes o lote inteiro rodava em UMA conexão, um pedido depois do outro, e
     * cada pedido faz de 6 a 8 idas ao banco. A concorrência é baixa de
     * propósito: o pool tem 15 conexões e atende as telas ao mesmo tempo. */
    const outcomes = await mapWithConcurrency(sanitized, PROCESS_CONCURRENCY, async (sale) => {
      try {
        return { ok: true, value: await runOne(sale) };
      } catch (error) {
        return { ok: false, sale, error };
      }
    });

    // Dois pedidos do lote podem disputar o mesmo SKU (ou o mesmo filho de kit)
    // e o Postgres aborta uma das transações. Não é erro do operador: é ordem.
    // Esses casos voltam em série, onde não existe disputa.
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
        orderSn: outcome?.sale?.orderSn ?? null,
        sku: outcome?.sale?.sku ?? null,
        reason: outcome?.error?.message || 'Falha inesperada ao processar a venda.',
      });
    }

    for (const sale of contended) {
      try {
        results.success.push(await runOne(sale));
      } catch (error) {
        results.failed.push({ orderSn: sale.orderSn, sku: sale.sku, reason: error.message });
      }
    }

    return res.json({ message: 'Processamento concluído.', ...results });
  } catch (error) {
    console.error('Erro crítico no processamento em lote (Shopee):', error);
    return res.status(500).json({ error: 'Erro crítico no processamento em lote.' });
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
