// routes/ml.js
/* eslint-disable camelcase */
const express = require('express');
const fetch = require('node-fetch'); // v2.x (web streams no v3 mudam o pipe)
const crypto = require('crypto');
const zlib = require('zlib');
const db = require('../utils/postgres');
const { authenticateToken } = require('../utils/authMiddleware');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

const router = express.Router();

/* ---------- Helpers de análise do PDF da etiqueta ---------- */

// Decodifica o(s) content stream(s) de uma página do pdf-lib para texto (latin1).
// Tenta inflar (Flate); se falhar, usa cru. Retorna string vazia em erro.
function decodePdfPageContent(page) {
  try {
    const decodeOne = (stream) => {
      const raw = stream && stream.contents;
      if (!raw) return '';
      try { return zlib.inflateSync(Buffer.from(raw)).toString('latin1'); }
      catch (e) { return Buffer.from(raw).toString('latin1'); }
    };
    const c = page.node.Contents();
    if (!c) return '';
    if (c.constructor && c.constructor.name === 'PDFArray') {
      let out = '';
      for (let i = 0; i < c.size(); i++) out += decodeOne(c.lookup(i)) + '\n';
      return out;
    }
    return decodeOne(c);
  } catch (e) {
    return '';
  }
}

// É uma página de "declaração de conteúdo" / lista de separação do ML?
// Marcador sem acentos (confiável): "Despache a sua venda".
function isDeclaracaoConteudoContent(content) {
  const lc = (content || '').toLowerCase();
  // "quanto antes" cobre singular ("Despache a sua venda o quanto antes")
  // e plural ("Despache as suas vendas o quanto antes"). Nunca aparece numa
  // etiqueta de envio. Mantemos outros marcadores como reforço.
  return lc.includes('quanto antes')
    || lc.includes('despache a sua venda')
    || lc.includes('despache as suas venda')
    || lc.includes('declaracao de conteudo');
}

// Calcula a caixa (bounding box) da etiqueta a partir dos retângulos "re"
// desenhados no content stream. Retorna {minX,minY,maxX,maxY} ou null.
function getLabelBoxFromContent(content) {
  if (!content) return null;
  const re = /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+re\b/g;
  let m, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, count = 0;
  while ((m = re.exec(content))) {
    const x = parseFloat(m[1]); const y = parseFloat(m[2]);
    const w = parseFloat(m[3]); const h = parseFloat(m[4]);
    if ([x, y, w, h].some((n) => Number.isNaN(n))) continue;
    const x2 = x + w; const y2 = y + h;
    minX = Math.min(minX, x, x2); minY = Math.min(minY, y, y2);
    maxX = Math.max(maxX, x, x2); maxY = Math.max(maxY, y, y2);
    count++;
  }
  if (!count || !isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

/**
 * >>> CONFIGURAÇÕES DO MERCADO LIVRE <<<
 * IMPORTANTE: As URLs de redirect devem estar cadastradas no painel de desenvolvedores:
 * https://developers.mercadolivre.com.br/devcenter
 *
 * URLs permitidas (cadastrar TODAS no painel do ML):
 * - http://localhost:3001/api/ml/callback (desenvolvimento)
 * - https://cyberdock-backend.onrender.com/api/ml/callback (produção)
 * - https://SEU-NGROK-URL/api/ml/callback (ngrok - atualizar quando mudar)
 */
const REDIRECT_URI = process.env.ML_REDIRECT_URI || 'https://cyberdock-backend.onrender.com/api/ml/callback';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://cyberdock.com.br'; // Sempre usar produção para callbacks do ML
const CLIENT_ID = process.env.ML_CLIENT_ID || '8423050287338772';
const CLIENT_SECRET = process.env.ML_CLIENT_SECRET || 'WWYgt9KH0HtZFH4YzD2yhrOLYHCUST9D';

// Lista de URLs de callback permitidas (para validação)
const ALLOWED_REDIRECT_URIS = [
  'http://localhost:3001/api/ml/callback',
  'https://cyberdock-backend.onrender.com/api/ml/callback',
  // Domínio atual da API em produção. Sem ele o log enche de aviso falso de
  // "URL não permitida" mesmo com o fluxo funcionando normalmente.
  'https://api.cyberdock.com.br/api/ml/callback',
];

const codeVerifiers = new Map(); // state -> { codeVerifier, createdAt }

/* ------------------------- Utils PKCE/STATE ------------------------- */
function base64urlEncode(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function generatePKCE() {
  const verifier = base64urlEncode(crypto.randomBytes(32));
  const challenge = base64urlEncode(crypto.createHash('sha256').update(verifier).digest());
  return { codeVerifier: verifier, codeChallenge: challenge };
}

function makeState(payload) {
  const nonce = base64urlEncode(crypto.randomBytes(16));
  return base64urlEncode(JSON.stringify({ ...payload, nonce }));
}

function parseState(stateB64) {
  try {
    const json = Buffer.from(stateB64, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function getRedirectUri() {
  return REDIRECT_URI;
}

/* Limpa verifiers antigos a cada 5 minutos (TTL 15 min) */
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of codeVerifiers.entries()) {
    if (now - v.createdAt > 15 * 60 * 1000) codeVerifiers.delete(k);
  }
}, 5 * 60 * 1000);

/* --------------------------- OAuth: Auth ---------------------------- */
router.get('/auth', (req, res) => {
  const { uid, client_id, redirect_uri } = req.query;
  if (!uid) return res.status(400).send('UID do usuário é obrigatório.');

  const { codeVerifier, codeChallenge } = generatePKCE();
  const state = makeState({ uid });
  codeVerifiers.set(state, { codeVerifier, createdAt: Date.now() });

  const finalClientId = client_id || CLIENT_ID;
  const finalRedirectUri = redirect_uri || getRedirectUri();

  // Validar se a URL de redirect está na lista permitida
  if (!ALLOWED_REDIRECT_URIS.includes(finalRedirectUri)) {
    console.warn(`[ML Auth] URL de redirect não está na lista permitida: ${finalRedirectUri}`);
    console.warn('[ML Auth] Certifique-se de que esta URL está cadastrada no painel do Mercado Livre');
  }

  console.log(`[ML Auth] Iniciando autenticação para UID: ${uid}`);
  console.log(`[ML Auth] Redirect URI: ${finalRedirectUri}`);

  const authUrl =
    'https://auth.mercadolibre.com/authorization' +
    `?response_type=code` +
    `&client_id=${finalClientId}` +
    `&redirect_uri=${encodeURIComponent(finalRedirectUri)}` +
    `&state=${state}` +
    `&code_challenge=${codeChallenge}` +
    `&code_challenge_method=S256`;

  res.redirect(authUrl);
});

/* --------------------------- OAuth: Callback ------------------------ */
router.get('/callback', async (req, res) => {
  const { code, state } = req.query;

  if (!code || !state) {
    return res.redirect(
      `${FRONTEND_URL}/contas?error=${encodeURIComponent('Autorização falhou. Código ou estado ausentes.')}`
    );
  }

  const verifierObj = codeVerifiers.get(state);
  if (!verifierObj) {
    return res.redirect(
      `${FRONTEND_URL}/contas?error=${encodeURIComponent('Falha de segurança. Verificador de estado inválido.')}`
    );
  }
  codeVerifiers.delete(state);

  const redirectUri = getRedirectUri();
  console.log(`[ML Callback] Processando callback com redirect_uri: ${redirectUri}`);

  try {
    const tokenResponse = await fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
        code_verifier: verifierObj.codeVerifier,
      }),
    });

    if (!tokenResponse.ok) {
      const errorBody = await tokenResponse.json().catch(() => ({}));
      console.error('[ML Callback] Erro ao obter token:', {
        status: tokenResponse.status,
        statusText: tokenResponse.statusText,
        errorBody,
        redirectUri,
      });

      // Mensagem de erro mais detalhada
      let errorMessage = errorBody.message || 'Falha ao obter token de acesso.';
      if (tokenResponse.status === 400 && errorBody.error === 'invalid_grant') {
        errorMessage = 'Erro de autenticação. Verifique se a URL de callback está cadastrada no painel do Mercado Livre.';
      }

      throw new Error(errorMessage);
    }

    const tokenData = await tokenResponse.json();

    const userResponse = await fetch('https://api.mercadolibre.com/users/me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    if (!userResponse.ok) {
      throw new Error(`Não foi possível identificar o usuário ML (${userResponse.status}).`);
    }
    const userData = await userResponse.json();

    const decoded = parseState(state);
    if (!decoded?.uid) throw new Error('State inválido.');

    const upsertQuery = `
      INSERT INTO public.ml_accounts (
        uid, user_id, nickname, access_token, refresh_token,
        expires_in, status, connected_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, 'active', NOW(), NOW())
      ON CONFLICT (uid, user_id) DO UPDATE SET
        access_token = EXCLUDED.access_token,
        refresh_token = EXCLUDED.refresh_token,
        expires_in   = EXCLUDED.expires_in,
        status       = 'active',
        updated_at   = NOW();
    `;

    await db.query(upsertQuery, [
      decoded.uid,
      userData.id,
      userData.nickname,
      tokenData.access_token,
      tokenData.refresh_token,
      tokenData.expires_in,
    ]);

    res.redirect(
      `${FRONTEND_URL}/contas?success=${encodeURIComponent(`Conta ${userData.nickname} conectada com sucesso!`)}`
    );
  } catch (error) {
    res.redirect(
      `${FRONTEND_URL}/contas?error=${encodeURIComponent(error.message || 'Erro desconhecido durante a conexão.')}`
    );
  }
});

/* ---------------------- Refresh Token (manual) ---------------------- */
router.post('/refresh-token', async (req, res) => {
  const { uid, user_id } = req.body;
  try {
    const { rows } = await db.query(
      'SELECT refresh_token FROM public.ml_accounts WHERE uid = $1 AND user_id = $2',
      [uid, user_id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Conta não encontrada.' });
    const refreshToken = rows[0].refresh_token;

    const response = await fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: refreshToken,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      await db.query(
        "UPDATE public.ml_accounts SET status = 'error', updated_at = NOW() WHERE uid = $1 AND user_id = $2",
        [uid, user_id]
      );
      throw new Error(errorBody.message || 'Falha ao atualizar token.');
    }

    const data = await response.json();
    await db.query(
      "UPDATE public.ml_accounts SET access_token = $1, refresh_token = $2, expires_in = $3, status = 'active', updated_at = NOW() WHERE uid = $4 AND user_id = $5",
      [data.access_token, data.refresh_token, data.expires_in, uid, user_id]
    );

    res.json({ message: 'Token atualizado com sucesso!' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* ----------------------- Obter contas TODAS (Master) ----------------------- */
router.get('/all-accounts', authenticateToken, async (req, res) => {
  // Importante: verificar role master
  try {
    const { rows: userRows } = await db.query('SELECT role FROM public.users WHERE uid = $1', [req.user.uid]);
    if (userRows.length === 0 || userRows[0].role !== 'master') {
      return res.status(403).json({ error: 'Acesso negado.' });
    }
    
    const { rows } = await db.query(`
      SELECT m.uid, m.user_id, m.nickname, m.status, m.expires_in, m.connected_at
      FROM public.ml_accounts m
      JOIN public.users u ON m.uid = u.uid
      WHERE m.status = 'active'
      ORDER BY m.updated_at DESC
    `);
    
    res.json(rows);
  } catch (error) {
   res.status(500).json({ error: 'Erro ao buscar contas globais.' });
  }
});

/* -------------------- Lista de Contas p/ Usuário ----------------- */
router.get('/contas/:uid', authenticateToken, async (req, res) => {
  const { uid } = req.params;
  try {
    const { rows } = await db.query(
      'SELECT user_id, nickname, status, connected_at, expires_in, access_token, refresh_token FROM public.ml_accounts WHERE uid = $1',
      [uid]
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

/* -------------------- Obter access_token (seguro) ------------------- */
router.get('/access-token/:mlUserId', authenticateToken, async (req, res) => {
  const { mlUserId } = req.params;
  const { uid, role } = req.user;
  if (!mlUserId) return res.status(400).json({ error: 'ID do usuário ML é obrigatório.' });

  try {
    const params = [];
    let query = 'SELECT access_token FROM public.ml_accounts WHERE user_id = $1 AND status = $2';
    params.push(mlUserId, 'active');

    if (role !== 'master') {
      query += ' AND uid = $3';
      params.push(uid);
    }

    const { rows } = await db.query(query, params);
    if (rows.length === 0) return res.status(404).json({ error: 'Token de acesso não encontrado ou conta inativa.' });

    res.json({ access_token: rows[0].access_token });
  } catch (error) {
    console.error('Erro ao obter token de acesso:', error);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

/* -------------------- Image Proxy (Bypass 403) ---------------------- */
// Público (sem auth) porque <img src=> não envia JWT. Protegido por whitelist de domínio.
router.get('/img-proxy', async (req, res) => {
  const imageUrl = req.query.url;
  if (!imageUrl) return res.status(400).send('URL da imagem é obrigatória.');

  // Segurança: whitelist de domínios de imagem dos marketplaces suportados.
  // Sem isso o endpoint viraria um proxy aberto (SSRF).
  const ALLOWED_IMAGE_HOSTS = [
    'mlstatic.com',      // Mercado Livre
    'susercontent.com',  // Shopee (CDN de imagens)
    'shopee.com.br',     // Shopee
  ];
  try {
    const parsed = new URL(imageUrl);
    const allowed = ALLOWED_IMAGE_HOSTS.some(
      (host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`)
    );
    if (!allowed) {
      return res.status(403).send('Domínio não permitido.');
    }
  } catch {
    return res.status(400).send('URL inválida.');
  }

  try {
    const safeUrl = String(imageUrl).replace(/^http:\/\//i, 'https://');

    // O Referer precisa combinar com a origem da imagem: os CDNs bloqueiam
    // hotlink quando o Referer é de outro domínio.
    const isShopee = /(?:^|\.)(?:susercontent\.com|shopee\.com\.br)$/i.test(new URL(safeUrl).hostname);
    const referer = isShopee ? 'https://shopee.com.br/' : 'https://www.mercadolivre.com.br/';

    const imgResponse = await fetch(safeUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
        'Referer': referer,
      },
    });

    if (!imgResponse.ok) {
      return res.status(imgResponse.status).send('Imagem não encontrada');
    }

    const contentType = imgResponse.headers.get('content-type') || 'image/jpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=604800'); // cache 7 dias
    res.setHeader('Access-Control-Allow-Origin', '*');

    imgResponse.body.pipe(res);
  } catch (error) {
    res.status(500).send('Erro ao buscar imagem');
  }
});

/* --------------------------- Helpers ML API ------------------------- */
async function getAccountTokens({ seller_id, uid, role }) {
  // Seleciona conta conforme permissão
  const params = [];
  let q = 'SELECT access_token, refresh_token FROM public.ml_accounts WHERE user_id = $1';
  params.push(seller_id);

  if (role !== 'master') {
    q += ' AND uid = $2';
    params.push(uid);
  }

  const { rows } = await db.query(q, params);
  if (rows.length === 0) {
    const msg = 'Conta do Mercado Livre não encontrada ou você não tem permissão para acessá-la.';
    const err = new Error(msg);
    err.status = 404;
    throw err;
  }

  return { accessToken: rows[0].access_token, refreshToken: rows[0].refresh_token };
}

async function refreshIfNeeded({ seller_id, uid, role, reason }) {
  // Efeito colateral: atualiza banco ao renovar
  const params = [];
  let q = 'SELECT refresh_token FROM public.ml_accounts WHERE user_id = $1';
  params.push(seller_id);
  if (role !== 'master') {
    q += ' AND uid = $2';
    params.push(uid);
  }

  const { rows } = await db.query(q, params);
  if (rows.length === 0) return null;

  const refresh_token = rows[0].refresh_token;
  const resp = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token,
    }),
  });

  if (!resp.ok) {
    await db.query(
      "UPDATE public.ml_accounts SET status = 'error', updated_at = NOW() WHERE user_id = $1" + (role !== 'master' ? ' AND uid = $2' : ''),
      role !== 'master' ? [seller_id, uid] : [seller_id]
    );
    return null;
  }

  const data = await resp.json();
  await db.query(
    "UPDATE public.ml_accounts SET access_token = $1, refresh_token = $2, expires_in = $3, status = 'active', updated_at = NOW() WHERE user_id = $4" +
      (role !== 'master' ? ' AND uid = $5' : ''),
    role !== 'master'
      ? [data.access_token, data.refresh_token, data.expires_in, seller_id, uid]
      : [data.access_token, data.refresh_token, data.expires_in, seller_id]
  );

  console.log(`[OAUTH] Token renovado (${reason || 'auto'}) para seller_id=${seller_id}`);
  return { accessToken: data.access_token, refreshToken: data.refresh_token };
}

/** Faz fetch ao ML com bearer e tenta renovar token 1x se 401/invalid_token */
async function fetchMLWithAutoRefresh(url, { method = 'GET', headers = {}, body, seller_id, uid, role, accept }, tokenPair) {
  let { accessToken } = tokenPair;
  const buildHeaders = (tkn) => ({
    Authorization: `Bearer ${tkn}`,
    ...(accept ? { Accept: accept } : {}),
    ...headers,
  });

  let resp = await fetch(url, { method, headers: buildHeaders(accessToken), body });
  if (resp.status === 401 || resp.status === 400) {
    // tenta ler mensagem
    let errMsg = '';
    try {
      const j = await resp.json();
      errMsg = j.message || '';
      if (!errMsg && j.error) errMsg = j.error;
    } catch {}

    // somente renova se parecer token inválido
    if (resp.status === 401 || /invalid_token|expired|invalid_grant/i.test(errMsg)) {
      const refreshed = await refreshIfNeeded({ seller_id, uid, role, reason: 'auto-fetch' });
      if (refreshed?.accessToken) {
        accessToken = refreshed.accessToken;
        resp = await fetch(url, { method, headers: buildHeaders(accessToken), body });
      }
    }
  }
  return resp;
}

/* -------------------- Verificar status de 1 shipment ----------------- */
router.get('/check-shipment-status', authenticateToken, async (req, res) => {
  const { shipment_id, seller_id } = req.query;
  const { uid, role } = req.user;

  if (!shipment_id || !seller_id) {
    return res.status(400).json({ error: 'Parâmetros shipment_id e seller_id são obrigatórios.' });
  }

  try {
    const tokens = await getAccountTokens({ seller_id, uid, role });

    const url = `https://api.mercadolibre.com/shipments/${shipment_id}`;
    const resp = await fetchMLWithAutoRefresh(url, { seller_id, uid, role }, tokens);

    if (!resp.ok) {
      return res.status(resp.status).json({
        status: null,
        id: shipment_id,
        available: false,
        error: `Erro ${resp.status}`,
      });
    }

    const shipmentData = await resp.json();
    return res.json({
      status: shipmentData.status,
      id: shipmentData.id,
      available: true,
    });
  } catch (error) {
    console.error('Erro ao verificar status do shipment:', error);
    res.status(error.status || 500).json({
      error: 'Erro interno do servidor',
      message: 'Erro interno do servidor ao verificar status do shipment.',
      details: { shipmentId: shipment_id, error: error.message },
    });
  }
});

/* ---------------- Verificar status de múltiplos shipments ------------ */
router.post('/check-multiple-shipments', authenticateToken, async (req, res) => {
  const { shipments, seller_id } = req.body;
  const { uid, role } = req.user;

  if (!shipments || !Array.isArray(shipments) || !seller_id) {
    return res.status(400).json({ error: 'Parâmetros shipments (array) e seller_id são obrigatórios.' });
  }

  try {
    const tokens = await getAccountTokens({ seller_id, uid, role });

    const results = {};
    const batchSize = 8;
    for (let i = 0; i < shipments.length; i += batchSize) {
      const batch = shipments.slice(i, i + batchSize);
      const promises = batch.map(async (shipmentId) => {
        const url = `https://api.mercadolibre.com/shipments/${shipmentId}`;
        try {
          const resp = await fetchMLWithAutoRefresh(url, { seller_id, uid, role }, tokens);
          if (!resp.ok) {
            results[shipmentId] = { status: null, id: shipmentId, available: false, error: `Erro ${resp.status}` };
          } else {
            const data = await resp.json();
            results[shipmentId] = { status: data.status, id: data.id, available: true };
          }
        } catch (e) {
          results[shipmentId] = { status: null, id: shipmentId, available: false, error: e.message };
        }
      });
      await Promise.all(promises);
      if (i + batchSize < shipments.length) await new Promise((r) => setTimeout(r, 120));
    }

    res.json(results);
  } catch (error) {
    console.error('Erro ao verificar múltiplos shipments:', error);
    res.status(error.status || 500).json({
      error: 'Erro interno do servidor',
      message: 'Erro interno do servidor ao verificar status dos shipments.',
      details: { shipments, error: error.message },
    });
  }
});

/* ------------------------- Download de etiqueta ---------------------- */
router.get('/download-label', authenticateToken, async (req, res) => {
  const { shipment_ids, response_type = 'pdf', seller_id } = req.query;
  const { uid, role } = req.user;

  if (!shipment_ids || !seller_id) {
    return res.status(400).json({ error: 'Parâmetros shipment_ids e seller_id são obrigatórios.' });
  }
  const type = String(response_type).toLowerCase(); // 'pdf' | 'zpl' | 'zpl2'
  const isPDF = type === 'pdf';
  const acceptHeader = isPDF ? 'application/pdf' : 'application/zpl';

  // Normaliza lista (aceita "123" ou "123,456")
  const ids = String(shipment_ids)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.split('.')[0]); // remove possíveis .0

  try {
    const tokens = await getAccountTokens({ seller_id, uid, role });

    // 1) Verifica status de cada shipment e bloqueia apenas os claramente impossíveis
    const nonPrintableStatuses = new Set(['shipped', 'delivered', 'cancelled', 'canceled']);
    
    // Tradutor humano de erros
    const getHumanError = (status) => {
      const s = (status || '').toLowerCase();
      if (s === 'shipped') return 'já foi despachado';
      if (s === 'delivered') return 'já foi entregue';
      if (s === 'cancelled' || s === 'canceled') return 'foi cancelado';
      return 'não está liberado';
    };

    const statusChecks = await Promise.all(
      ids.map(async (id) => {
        const url = `https://api.mercadolibre.com/shipments/${id}`;
        const r = await fetchMLWithAutoRefresh(url, { seller_id, uid, role }, tokens);
        if (!r.ok) return { id, status: null, logistic_type: null, printable: true };
        const d = await r.json();
        return { id, status: d.status, logistic_type: d.logistic_type || null, printable: !nonPrintableStatuses.has((d.status || '').toLowerCase()) };
      })
    );

    // Mapa de logistic_type por shipment ID para ajustar posição na etiqueta
    const logisticMap = {};
    statusChecks.forEach(sc => {
      logisticMap[String(sc.id)] = sc.logistic_type;
    });

    const notPrintable = statusChecks.filter((s) => !s.printable);
    const printableIds = statusChecks.filter((s) => s.printable).map((s) => String(s.id));

    // Comportamento tolerante em LOTE ("one bad apple" não derruba os demais):
    // - Se é um único envio e ele não imprime -> erro (comportamento antigo).
    // - Se é lote e NENHUM imprime -> erro.
    // - Se é lote e alguns imprimem -> segue apenas com os imprimíveis (pula os ruins).
    if (printableIds.length === 0) {
      const details = notPrintable.map((x) => `Envio ${x.id} (${getHumanError(x.status)})`).join(', ');
      return res.status(400).json({
        error: 'Etiqueta Indisponível',
        message: `Não é possível imprimir: ${details}.`,
        details: { shipmentIdsTried: ids, blockedByStatus: notPrintable },
      });
    }

    // A partir daqui usamos apenas os imprimíveis.
    const skippedIds = notPrintable.map((x) => ({ id: String(x.id), status: x.status, reason: getHumanError(x.status) }));
    ids.length = 0;
    ids.push(...printableIds);

    // 2) Buscar SKU e Cliente no DB para enriquecer a etiqueta
    let salesInfo = [];
    try {
      const dbRes = await db.query(`
        SELECT 
          s.raw_api_data->'shipping'->>'id' as shipping_id, 
          s.sku,
          s.quantity,
          u.name as user_name 
        FROM public.sales s 
        JOIN public.users u ON s.uid = u.uid 
        WHERE s.raw_api_data->'shipping'->>'id' = ANY($1)
      `, [ids]);
      salesInfo = dbRes.rows;
    } catch (err) {
      console.error('Erro ao buscar dados de vendas para etiqueta:', err);
    }
    
    // Agrupa por ENVIO: um shipment pode ter VÁRIOS itens (SKUs) diferentes no
    // MESMO pacote/etiqueta (comprador leva 2 produtos distintos). Antes o map
    // sobrescrevia e sobrava só 1 SKU — agora acumulamos a lista de itens.
    const infoMap = {};
    salesInfo.forEach(r => {
      const key = String(r.shipping_id);
      if (!infoMap[key]) infoMap[key] = { user_name: r.user_name, items: [] };
      if (r.sku) infoMap[key].items.push({ sku: r.sku, quantity: r.quantity });
      if (!infoMap[key].user_name && r.user_name) infoMap[key].user_name = r.user_name;
    });

    // Linhas de texto da etiqueta: uma por item (Qtd | SKU) + a linha do Cliente.
    // Assim, com 2+ itens, os SKUs saem um embaixo do outro.
    const buildLabelLines = (items, userName) => {
      const lines = (items || []).map(
        (it) => `Qtd: ${it.quantity ?? 'N/A'} | SKU: ${it.sku || 'N/A'}`,
      );
      if (lines.length === 0) lines.push('Qtd: N/A | SKU: N/A');
      lines.push(`Cliente: ${userName || 'N/A'}`);
      return lines;
    };

    const enrichPdf = async (pdfBuffer, items, userName, logisticType) => {
      try {
        const srcDoc = await PDFDocument.load(pdfBuffer);
        const srcPages = srcDoc.getPages();
        if (srcPages.length === 0) return pdfBuffer;

        // 1) REMOVER páginas de "declaração de conteúdo" (o cliente quer só a
        //    etiqueta). Detecta pelo texto. Monta a lista de páginas a MANTER.
        //    Nunca remove tudo — se todas forem declaração, mantém o original.
        const keepIdx = [];
        for (let i = 0; i < srcPages.length; i++) {
          if (!isDeclaracaoConteudoContent(decodePdfPageContent(srcPages[i]))) keepIdx.push(i);
        }

        let pdfDoc;
        if (keepIdx.length > 0 && keepIdx.length < srcPages.length) {
          // Copia só as páginas de etiqueta para um doc novo e limpo.
          pdfDoc = await PDFDocument.create();
          const copied = await pdfDoc.copyPages(srcDoc, keepIdx);
          copied.forEach((p) => pdfDoc.addPage(p));
        } else {
          // Nada a remover (ou tudo é declaração -> mantém tudo por segurança).
          pdfDoc = srcDoc;
        }
        const pages = pdfDoc.getPages();

        // Se não há nada pra escrever, devolve já sem a declaração.
        const hasItems = Array.isArray(items) && items.length > 0;
        if (!hasItems && !userName) return Buffer.from(await pdfDoc.save());

        const lines = buildLabelLines(items, userName);
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

        // Escreve o texto em TODAS as páginas restantes (todas são etiqueta).
        // Para cada uma, tenta ancorar DENTRO da caixa da etiqueta (retângulos
        // "re"); se não achar caixa, usa fallback pela página inteira.
        for (let pi = 0; pi < pages.length; pi++) {
          const page = pages[pi];
          const { width, height } = page.getSize();
          // Recalcula o conteúdo caso os índices tenham mudado após remoção.
          const content = decodePdfPageContent(page);
          const box = getLabelBoxFromContent(content);

          const usableBox = box && (box.maxX - box.minX) > 40 && (box.maxY - box.minY) > 40
            && (box.maxX - box.minX) < width && (box.maxY - box.minY) <= height;

          // Âncora base (canto inferior) + largura disponível, conforme caixa/fallback.
          let baseY, maxWidth, fallbackX;
          if (usableBox) {
            maxWidth = (box.maxX - box.minX) - 8;
            baseY = box.minY + 6; // base do bloco, dentro do quadro
            fallbackX = null;
          } else {
            const margin = 16;
            const lt = (logisticType || '').toLowerCase();
            const desired = lt === 'self_service' ? 26 : (height - 295);
            baseY = Math.min(height - 20, Math.max(20, desired));
            maxWidth = width - margin * 2;
            fallbackX = margin;
          }

          // Fonte que faz a MAIOR linha caber na largura disponível.
          let fontSize = 8;
          const widest = () => lines.reduce((m, l) => Math.max(m, font.widthOfTextAtSize(l, fontSize)), 0);
          while (fontSize > 4 && widest() > maxWidth) fontSize -= 0.5;

          const lineHeight = fontSize + 2;
          const n = lines.length;
          // Empilha de cima pra baixo: 1ª linha no topo, "Cliente" embaixo.
          for (let li = 0; li < n; li++) {
            const line = lines[li];
            const textWidth = font.widthOfTextAtSize(line, fontSize);
            const y = baseY + (n - 1 - li) * lineHeight;
            const x = usableBox
              ? box.minX + Math.max(0, ((box.maxX - box.minX) - textWidth) / 2)
              : Math.max(fallbackX, (width - textWidth) / 2);
            page.drawText(line, { x, y, size: fontSize, font, color: rgb(0, 0, 0) });
          }
        }

        const bytes = await pdfDoc.save();
        return Buffer.from(bytes);
      } catch (err) {
        console.error('Erro ao enriquecer PDF:', err);
        return pdfBuffer;
      }
    };

    const enrichZpl = (zplString, items, userName) => {
      const hasItems = Array.isArray(items) && items.length > 0;
      if (!hasItems && !userName) return zplString;
      const lines = buildLabelLines(items, userName);
      // Adiciona uma mini etiqueta ZPL no fim, com uma linha por item (Y incremental).
      // Concatenar depois da principal evita estragar a formatação nativa.
      let y = 50;
      let fd = '';
      for (const ln of lines) {
        fd += `^FO50,${y}^A0N,30,30^FD${ln}^FS`;
        y += 35;
      }
      const extraTag = `^XA${fd}^XZ\n`;
      return zplString + '\n' + extraTag;
    };

    let lastErrorDetails = null;

    // Função para baixar uma única etiqueta
    const downloadSingle = async (id) => {
      const url1 = `https://api.mercadolibre.com/shipments/${id}/labels?response_type=${type}`;
      const resp1 = await fetchMLWithAutoRefresh(url1, { seller_id, uid, role, accept: acceptHeader }, tokens);
      if (resp1.ok && resp1.headers.get('content-type')?.includes(isPDF ? 'pdf' : 'zpl')) return resp1;
      if (!resp1.ok) lastErrorDetails = await resp1.json().catch(() => null);

      const url2 = `https://api.mercadolibre.com/shipment_labels?shipment_ids=${id}&response_type=${type}`;
      const resp2 = await fetchMLWithAutoRefresh(url2, { seller_id, uid, role, accept: acceptHeader }, tokens);
      if (resp2.ok && resp2.headers.get('content-type')?.includes(isPDF ? 'pdf' : 'zpl')) return resp2;
      if (!resp2.ok && !lastErrorDetails) lastErrorDetails = await resp2.json().catch(() => null);

      const url3 = `https://api.mercadolibre.com/shipment_labels?shipment_ids=${id}&response_type=${type}&access_token=${tokens.accessToken}`;
      const resp3 = await fetch(url3, { headers: { Accept: acceptHeader } });
      if (resp3.ok && resp3.headers.get('content-type')?.includes(isPDF ? 'pdf' : 'zpl')) return resp3;
      
      return null;
    };

    // Baixa, enriquece e junta todas
    const buffers = [];
    let hasError = false;

    for (const id of ids) {
      const resp = await downloadSingle(id);
      if (!resp) {
        hasError = true;
        break;
      }
      
      const ab = await resp.arrayBuffer();
      let buf = Buffer.from(ab);
      const info = infoMap[id] || {};

      if (isPDF) {
        const logisticType = logisticMap[id] || null;
        buf = await enrichPdf(buf, info.items, info.user_name, logisticType);
      } else {
        const zplStr = enrichZpl(buf.toString('utf-8'), info.items, info.user_name);
        buf = Buffer.from(zplStr, 'utf-8');
      }
      buffers.push(buf);
    }

    if (hasError || buffers.length === 0) {
      return res.status(400).json({
        error: lastErrorDetails?.message || 'Etiqueta não disponível',
        message: 'Não foi possível obter a etiqueta no momento. Verifique se os envios estão aptos ou tente novamente em instantes.',
        details: { shipmentIdsTried: ids, mlError: lastErrorDetails || 'Sem detalhes' },
      });
    }

    // Mesclar os resultados
    let finalBuffer;
    if (isPDF) {
      if (buffers.length === 1) {
        finalBuffer = buffers[0];
      } else {
        const mergedPdf = await PDFDocument.create();
        for (const buf of buffers) {
          try {
            const doc = await PDFDocument.load(buf);
            const copiedPages = await mergedPdf.copyPages(doc, doc.getPageIndices());
            copiedPages.forEach((page) => mergedPdf.addPage(page));
          } catch (err) {
            console.error('Erro ao mesclar PDF:', err);
          }
        }
        finalBuffer = Buffer.from(await mergedPdf.save());
      }
    } else {
      finalBuffer = Buffer.concat(buffers);
    }

    const ct = isPDF ? 'application/pdf' : 'application/zpl';
    const cd = `attachment; filename="etiqueta-${ids.length === 1 ? ids[0] : 'lote'}.${isPDF ? 'pdf' : 'zpl'}"`;

    res.setHeader('Content-Type', ct);
    res.setHeader('Content-Disposition', cd);
    res.setHeader('Content-Length', String(finalBuffer.length));
    // Informa ao frontend quantos/quais envios foram pulados por não serem imprimíveis.
    if (skippedIds.length > 0) {
      res.setHeader('X-Labels-Skipped', String(skippedIds.length));
      res.setHeader('Access-Control-Expose-Headers', 'X-Labels-Skipped, X-Labels-Printed');
    }
    res.setHeader('X-Labels-Printed', String(buffers.length));
    return res.status(200).end(finalBuffer);
  } catch (error) {
    console.error('Erro no servidor ao baixar etiqueta:', error);
    res.status(error.status || 500).json({
      error: 'Erro interno do servidor',
      message: 'Erro interno do servidor ao processar a solicitação da etiqueta.',
      details: { shipmentIds: shipment_ids, error: error.message },
    });
  }
});

/* -------------------------- Excluir conta --------------------------- */
router.delete('/contas/:mlUserId', authenticateToken, async (req, res) => {
  const { mlUserId } = req.params;
  const { uid } = req.user;

  if (!mlUserId || !uid) {
    return res.status(400).json({ error: 'Parâmetros inválidos para exclusão.' });
  }

  try {
    const result = await db.query('DELETE FROM public.ml_accounts WHERE user_id = $1 AND uid = $2', [mlUserId, uid]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Conta não encontrada ou não pertence a este usuário.' });
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: 'Erro interno ao excluir a conta.' });
  }
});

/* ----------------------- Verificar configuração --------------------- */
router.get('/config-check', (req, res) => {
  const config = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    redirectUri: REDIRECT_URI,
    frontendUrl: FRONTEND_URL,
    clientId: CLIENT_ID,  // Mostrar para debug (remover em produção se necessário)
    clientIdConfigured: !!CLIENT_ID,
    clientSecretConfigured: !!CLIENT_SECRET,
    allowedRedirectUris: ALLOWED_REDIRECT_URIS,
    warnings: [],
    instructions: [],
  };

  // Verificações
  if (!CLIENT_ID || !CLIENT_SECRET) {
    config.status = 'error';
    config.warnings.push('Client ID ou Client Secret não configurados');
  }

  if (!ALLOWED_REDIRECT_URIS.includes(REDIRECT_URI)) {
    config.warnings.push(`REDIRECT_URI (${REDIRECT_URI}) não está na lista de URLs permitidas.`);
    config.instructions.push('Adicione esta URL no painel do Mercado Livre em: https://developers.mercadolivre.com.br/devcenter');
  }

  // Verificar se está usando localhost em produção
  if (process.env.NODE_ENV === 'production' && REDIRECT_URI.includes('localhost')) {
    config.status = 'error';
    config.warnings.push('URL de callback aponta para localhost em ambiente de produção!');
  }

  // Instruções para resolver erro 403
  config.instructions.push('1. Acesse: https://developers.mercadolivre.com.br/devcenter');
  config.instructions.push('2. Selecione sua aplicação (Client ID: ' + CLIENT_ID + ')');
  config.instructions.push('3. Vá em "Editar" > "Configurações"');
  config.instructions.push('4. Em "Redirect URIs", adicione: ' + REDIRECT_URI);
  config.instructions.push('5. Em "Allowed Domains", adicione: localhost, cyberdock.com.br, cyberdock-backend.onrender.com');
  config.instructions.push('6. Salve e aguarde alguns minutos');

  res.json(config);
});

/* ----------------------- Teste de conexão --------------------------- */
router.get('/test', (req, res) => {
  res.json({
    message: 'Mercado Livre router está funcionando!',
    timestamp: new Date().toISOString(),
    redirectUri: REDIRECT_URI,
    environment: process.env.NODE_ENV || 'development',
  });
});

module.exports = router;
