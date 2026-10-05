// utils/tiktokErrors.js
//
// Normalizador ÚNICO dos erros da integração TikTok Shop.
//
// Problema que resolve: a API do TikTok devolve `message` em INGLÊS, e esse
// texto chegava cru ao usuário (resposta HTTP, SSE da sincronização e colunas
// last_error), com várias falhas classificadas errado (ex.: qualquer erro não
// repetível virava "reconectar a loja"). Aqui todo erro vira um objeto estável:
//
//   { errorCode, userMessage, providerCode, providerMessage, requestId,
//     retryable, category, httpStatus }
//
// Contrato:
//   - `userMessage` é SEMPRE PT-BR, curto e acionável. É montado só de textos
//     fixos deste arquivo (ou de `error.userMessage`, que o nosso próprio código
//     escreve em PT-BR). Nunca interpola texto do provedor.
//   - `providerMessage` é o texto cru do TikTok, APENAS para log interno: passa
//     por sanitizeProviderText (sem segredos nem query string, até 300
//     caracteres) e NUNCA deve ser devolvido ao usuário.
//   - `httpStatus` é o status sugerido para a NOSSA resposta, não o do TikTok.
//     Autorização do TikTok vira 409 e não 401/403: na nossa API esses dois
//     significam sessão CyberDock inválida (authenticateToken) e o frontend
//     manda o usuário para o login.
//   - `category`: auth | rate_limit | not_found | validation | permission |
//     provider | network | timeout | unknown. Falha de configuração do próprio
//     servidor usa `unknown` com errorCode TIKTOK_SERVER_CONFIG.
//
// Códigos do TikTok Shop mapeados (Partner Center e FAQ oficiais; o que não
// está aqui cai na categoria do HTTP):
//   105xxx (ex.: 105001) .. token/autorização expirados ou inválidos -> auth
//   105005 ............... app sem o pacote de escopo da API -> permission
//   106xxx ............... assinatura/timestamp do NOSSO app (chega como HTTP
//                          401) -> validation/TIKTOK_SIGNATURE_INVALID. Não é
//                          auth: a loja não tem o que reconectar.
//   36004001 ............. "rt has expired" (refresh token vencido) -> auth
//   36004003 ............. "invalid client_key" (credencial do app) -> validation
//   36009002 ............. throttling, o mesmo sinal do HTTP 429 -> rate_limit
//   36009004 ............. genérico e reutilizado: a doc manda decidir pela
//                          MENSAGEM (sign ausente, header do token inválido...)
//
// Este módulo não importa o cliente (o cliente é que importa este), então a
// detecção de TikTokApiError é por duck typing (`error.name`).

const REDACTED = '[redigido]';
const PROVIDER_MESSAGE_MAX = 300;

const ERROR_CATEGORIES = Object.freeze([
  'auth',
  'rate_limit',
  'not_found',
  'validation',
  'permission',
  'provider',
  'network',
  'timeout',
  'unknown',
]);
const CATEGORY_SET = new Set(ERROR_CATEGORIES);

/** Padrão de cada categoria: código estável, status da nossa resposta e texto. */
const CATEGORY_DEFAULTS = {
  auth: {
    errorCode: 'TIKTOK_AUTH_EXPIRED',
    httpStatus: 409,
    retryable: false,
    message: 'A autorização do TikTok expirou ou foi revogada. Reconecte a conta.',
  },
  rate_limit: {
    errorCode: 'TIKTOK_RATE_LIMITED',
    httpStatus: 429,
    retryable: true,
    message: 'O TikTok limitou as consultas por agora. Aguarde alguns instantes e tente novamente.',
  },
  not_found: {
    errorCode: 'TIKTOK_NOT_FOUND',
    httpStatus: 404,
    retryable: false,
    message: 'O TikTok não encontrou o item solicitado. Sincronize as vendas e tente novamente.',
  },
  validation: {
    errorCode: 'TIKTOK_INVALID_REQUEST',
    httpStatus: 422,
    retryable: false,
    message: 'O TikTok recusou a solicitação. Sincronize as vendas e tente novamente; se persistir, contate o suporte.',
  },
  permission: {
    errorCode: 'TIKTOK_PERMISSION_DENIED',
    httpStatus: 409,
    retryable: false,
    message: 'O TikTok não liberou esta permissão ao aplicativo. Reconecte a conta e aceite todas as permissões solicitadas.',
  },
  provider: {
    errorCode: 'TIKTOK_PROVIDER_ERROR',
    httpStatus: 502,
    retryable: true,
    message: 'O TikTok está instável no momento. Tente novamente em alguns minutos.',
  },
  network: {
    errorCode: 'TIKTOK_NETWORK_ERROR',
    httpStatus: 503,
    retryable: true,
    message: 'Não foi possível conectar ao TikTok. Verifique a conexão e tente novamente.',
  },
  timeout: {
    errorCode: 'TIKTOK_TIMEOUT',
    httpStatus: 503,
    retryable: true,
    message: 'O TikTok demorou demais para responder. Tente novamente em instantes.',
  },
  unknown: {
    errorCode: 'TIKTOK_UNKNOWN_ERROR',
    httpStatus: 500,
    retryable: false,
    message: 'Não foi possível concluir a operação com o TikTok. Tente novamente; se persistir, contate o suporte.',
  },
};

/** Falha que não veio do TikTok (banco, bug nosso): não cita o TikTok. */
const INTERNAL_UNKNOWN_MESSAGE = 'Não foi possível concluir a operação. Tente novamente; se persistir, contate o suporte.';

/** Códigos próprios, com texto e status específicos. */
const SPECIAL_CODES = {
  TIKTOK_SIGNATURE_INVALID: {
    category: 'validation',
    httpStatus: 502,
    message: 'O TikTok recusou a assinatura das chamadas do aplicativo. Avise o suporte.',
  },
  TIKTOK_APP_CREDENTIALS_INVALID: {
    category: 'validation',
    httpStatus: 502,
    message: 'O TikTok recusou as credenciais do aplicativo. Avise o suporte.',
  },
  TIKTOK_SERVER_CONFIG: {
    category: 'unknown',
    httpStatus: 503,
    message: 'A integração com o TikTok não está configurada no servidor. Avise o suporte.',
  },
  TIKTOK_JOB_TIMEOUT: {
    category: 'timeout',
    httpStatus: 503,
    message: 'A sincronização com o TikTok excedeu o tempo limite. Tente novamente: ela continua do último ponto salvo.',
  },
  TIKTOK_INVALID_RESPONSE: {
    category: 'provider',
    httpStatus: 502,
    message: 'O TikTok devolveu uma resposta inesperada. Tente novamente em alguns minutos.',
  },
  TIKTOK_ACCOUNT_INACTIVE: {
    category: 'permission',
    httpStatus: 409,
    message: 'A conta de vendedor ainda não pode autorizar o aplicativo (cadastro em análise ou região não suportada). Conclua o cadastro no TikTok Shop e tente de novo.',
  },
};

/** Ajuste fino do texto conforme a operação (`{ operation }` do chamador). */
const OAUTH_REFUSED_MESSAGE = 'O TikTok recusou o código de autorização. Ele vale uma única vez: clique em Conectar TikTok e autorize novamente.';
const OPERATION_MESSAGES = {
  etiqueta: {
    validation: 'O TikTok recusou a etiqueta deste pedido. Confira o envio no Seller Center e tente novamente.',
    not_found: 'O TikTok não encontrou o pacote deste pedido. Sincronize as vendas e tente novamente.',
  },
  oauth: {
    auth: OAUTH_REFUSED_MESSAGE,
    validation: OAUTH_REFUSED_MESSAGE,
    not_found: OAUTH_REFUSED_MESSAGE,
  },
};

/* ----------------------------- Sanitização ----------------------------- */

const SECRET_KEYS = '(?:x-tts-access-token|access[_-]?token|refresh[_-]?token|app[_-]?secret|client[_-]?secret|app[_-]?key|client[_-]?key|shop[_-]?cipher|auth[_-]?code|authorization|password|secret|signature|sign|token)';
const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>()[\]{}\\^`|,;]+/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
// `chave=valor`, `chave: valor` e `"chave":"valor"`. O par INTEIRO (nome e
// valor) é removido, para nem o nome da chave sobrar no texto.
const SECRET_PAIR_PATTERN = new RegExp(
  `(?<![\\w-])["']?${SECRET_KEYS}["']?\\s*[=:]\\s*(?:"[^"]*"|'[^']*'|[^\\s&,;"'})\\]]*)`,
  'gi'
);
const SECRET_NAME_PATTERN = /(?<![\w-])(?:x-tts-access-token|access[_-]?token|refresh[_-]?token|app[_-]?secret|client[_-]?secret|shop[_-]?cipher)(?![\w-])/gi;
const LONG_TOKEN_PATTERN = /(?<![\w-])[A-Za-z0-9_-]{40,}(?![\w-])/g;

/** URL sem query string nem fragmento: a query carrega sign, app_secret e tokens. */
function stripUrlQuery(match) {
  const [withoutQuery] = match.split(/[?#]/);
  try {
    const url = new URL(withoutQuery);
    return `${url.origin}${url.pathname}`;
  } catch {
    return withoutQuery;
  }
}

/**
 * Deixa um texto do provedor (ou de uma falha de rede) seguro para LOG.
 *
 * Remove query string de URLs, pares chave/valor sensíveis (access_token,
 * refresh_token, app_secret, sign...), Bearer, nomes de credencial soltos e
 * qualquer sequência opaca longa; colapsa espaços e trunca. O resultado é só
 * para log interno, nunca para o usuário.
 */
function sanitizeProviderText(value, maxLength = PROVIDER_MESSAGE_MAX) {
  let text = '';
  if (typeof value === 'string') text = value;
  else if (typeof value === 'number' || typeof value === 'boolean') text = String(value);
  if (!text) return '';

  text = text
    .replace(URL_PATTERN, stripUrlQuery)
    .replace(BEARER_PATTERN, REDACTED)
    .replace(SECRET_PAIR_PATTERN, REDACTED)
    .replace(SECRET_NAME_PATTERN, REDACTED)
    .replace(LONG_TOKEN_PATTERN, REDACTED)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

/* ----------------------------- Classificação ----------------------------- */

const SIGNATURE_TEXT = /\b(?:missing\s+credentials|signature|sign\s+(?:is\s+)?(?:invalid|missing|error))\b/i;
const APP_CREDENTIALS_TEXT = /\b(?:client[\s_-]?key|app[\s_-]?key|app[\s_-]?secret|client[\s_-]?secret)\b/i;
const ACCOUNT_INACTIVE_TEXT = /\b(?:auth\s+state\s+is\s+inactive|onboarding\s+review|region\s+restriction)\b/i;
const PERMISSION_TEXT = /\b(?:scopes?|permissions?|auth\s*pkg|not\s+allowed\s+to\s+authori[sz]e|no\s+access|access\s+denied)\b/i;
// `page token` (paginação) não é credencial: fica de fora para não virar "reconectar".
const TOKEN_WORDS = /\b(?:x-tts-access-token|access[\s_-]?token|refresh[\s_-]?token|rt|(?<!page[\s_-]?)token|credentials?|authori[sz]ation|auth[\s_-]?code)\b/i;
const TOKEN_BAD_STATE = /\b(?:expired?|invalid|revoked|incorrect|unauthori[sz]ed|not\s+(?:exist|found|valid|match))\b/i;
const RATE_LIMIT_TEXT = /\b(?:rate[\s-]?limit(?:ed|ing)?|too\s+many\s+requests|throttl\w*|request\s+frequency|qps)\b/i;
const NOT_FOUND_TEXT = /\b(?:not\s+found|not\s+exist|does\s+not\s+exist|doesn'?t\s+exist|no\s+such|cannot\s+be\s+found)\b/i;

const NETWORK_SYSTEM_TYPES = new Set(['system', 'max-size', 'invalid-json']);
const TIMEOUT_TYPES = new Set(['aborted', 'request-timeout', 'body-timeout']);
const TIMEOUT_SYSTEM_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNABORTED']);

function toFiniteInt(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^\d{1,10}$/.test(value.trim())) return Number(value.trim());
  return null;
}

function cleanRequestId(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 100);
  return cleaned || null;
}

function classifyByCode(code) {
  if (code === null) return null;
  if (code === 36009002) return { category: 'rate_limit' };
  if (code === 105005) return { category: 'permission' };
  if (code >= 105000 && code < 106000) return { category: 'auth' };
  if (code >= 106000 && code < 107000) return { category: 'validation', errorCode: 'TIKTOK_SIGNATURE_INVALID' };
  if (code === 36004001) return { category: 'auth' };
  if (code === 36004003) return { category: 'validation', errorCode: 'TIKTOK_APP_CREDENTIALS_INVALID' };
  return null;
}

/** Texto cru do provedor, só para DECIDIR a categoria (nunca sai daqui). */
function classifyByText(text) {
  if (!text) return null;
  if (SIGNATURE_TEXT.test(text)) return { category: 'validation', errorCode: 'TIKTOK_SIGNATURE_INVALID' };
  if (APP_CREDENTIALS_TEXT.test(text)) return { category: 'validation', errorCode: 'TIKTOK_APP_CREDENTIALS_INVALID' };
  if (ACCOUNT_INACTIVE_TEXT.test(text)) return { category: 'permission', errorCode: 'TIKTOK_ACCOUNT_INACTIVE' };
  if (PERMISSION_TEXT.test(text)) return { category: 'permission' };
  if (TOKEN_WORDS.test(text) && TOKEN_BAD_STATE.test(text)) return { category: 'auth' };
  if (RATE_LIMIT_TEXT.test(text)) return { category: 'rate_limit' };
  if (NOT_FOUND_TEXT.test(text)) return { category: 'not_found' };
  return null;
}

function classifyByHttp(status) {
  if (status === null) return null;
  if (status === 429) return { category: 'rate_limit' };
  if (status === 408) return { category: 'timeout' };
  if (status >= 500) return { category: 'provider' };
  if (status === 401 || status === 403) return { category: 'auth' };
  if (status === 404) return { category: 'not_found' };
  if (status >= 400) return { category: 'validation' };
  return null;
}

/** Fatos do erro, lidos sem confiar no formato (Error, objeto, string ou nada). */
function readFacts(error) {
  const facts = {
    isTikTokApiError: false,
    httpStatus: null,
    providerCode: null,
    systemCode: null,
    requestId: null,
    explicitRetryable: false,
    rawMessage: '',
    category: null,
    errorCode: null,
    curatedMessage: null,
    timedOut: false,
    networkFailure: false,
  };

  if (typeof error === 'string') {
    facts.rawMessage = error;
    return facts;
  }
  if (error === null || typeof error !== 'object') return facts;

  facts.isTikTokApiError = error.name === 'TikTokApiError';
  facts.httpStatus = toFiniteInt(error.httpStatus ?? error.status ?? error.statusCode ?? error.response?.status);

  // `code` do TikTok é número; string (ECONNRESET, 23505 do pg, TIKTOK_...) é código de sistema.
  if (typeof error.code === 'number' && Number.isFinite(error.code)) facts.providerCode = Math.trunc(error.code);
  else if (typeof error.code === 'string') facts.systemCode = error.code;
  if (facts.providerCode === null) facts.providerCode = toFiniteInt(error.providerCode);
  if (!facts.systemCode && typeof error.cause?.code === 'string') facts.systemCode = error.cause.code;

  facts.requestId = cleanRequestId(error.requestId ?? error.request_id);
  facts.explicitRetryable = error.retryable === true;
  facts.category = CATEGORY_SET.has(error.category) ? error.category : null;
  facts.errorCode = typeof error.errorCode === 'string' && error.errorCode ? error.errorCode : null;

  // Em TikTokApiError o `.message` já é a userMessage; o texto do provedor fica em providerMessage.
  if (typeof error.providerMessage === 'string') facts.rawMessage = error.providerMessage;
  else if (!facts.isTikTokApiError && typeof error.message === 'string') facts.rawMessage = error.message;

  if (typeof error.userMessage === 'string' && error.userMessage.trim()) {
    facts.curatedMessage = error.userMessage.trim();
  }

  // Falhas de transporte do node-fetch / AbortController. Erro de banco (pg) não entra aqui.
  const fetchShaped = error.name === 'FetchError' || error.name === 'AbortError'
    || TIMEOUT_TYPES.has(error.type) || NETWORK_SYSTEM_TYPES.has(error.type);
  facts.timedOut = fetchShaped && (error.name === 'AbortError'
    || TIMEOUT_TYPES.has(error.type)
    || TIMEOUT_SYSTEM_CODES.has(facts.systemCode));
  facts.networkFailure = fetchShaped && !facts.timedOut;

  return facts;
}

function classify(facts) {
  // 1) marcação explícita de quem criou o erro (cliente TikTok e código próprio)
  if (facts.category) return { category: facts.category, errorCode: facts.errorCode };
  if (facts.errorCode && SPECIAL_CODES[facts.errorCode]) {
    return { category: SPECIAL_CODES[facts.errorCode].category, errorCode: facts.errorCode };
  }
  if (facts.systemCode && SPECIAL_CODES[facts.systemCode]) {
    return { category: SPECIAL_CODES[facts.systemCode].category, errorCode: facts.systemCode };
  }

  // 2) transporte
  if (facts.timedOut) return { category: 'timeout' };
  if (facts.networkFailure) return { category: 'network' };

  // 3) código de negócio do TikTok, depois HTTP transitório (429/5xx), depois o texto
  //    do provedor (36009004 e afins) e por fim o restante do HTTP.
  const byCode = classifyByCode(facts.providerCode);
  if (byCode) return byCode;

  const byHttp = classifyByHttp(facts.httpStatus);
  if (byHttp && (byHttp.category === 'rate_limit' || byHttp.category === 'provider' || byHttp.category === 'timeout')) {
    return byHttp;
  }

  const byText = classifyByText(facts.rawMessage);
  if (byText) return byText;

  return byHttp || { category: 'unknown' };
}

/**
 * Converte qualquer falha da integração no formato padronizado.
 *
 * Aceita TikTokApiError, Error comum, objeto com os mesmos campos, string ou
 * nada. `operation` ajusta só o texto (`'etiqueta'`, `'oauth'`); o resto é
 * ignorado.
 */
function normalizeTikTokError(error, options) {
  const operation = options && typeof options === 'object' ? options.operation : undefined;
  const facts = readFacts(error);
  const { category, errorCode: classifiedCode } = classify(facts);
  const defaults = CATEGORY_DEFAULTS[category];
  const errorCode = classifiedCode || defaults.errorCode;
  const special = SPECIAL_CODES[errorCode] || null;
  const providerShaped = facts.isTikTokApiError || facts.httpStatus !== null || facts.providerCode !== null;

  let userMessage = facts.curatedMessage
    || special?.message
    || OPERATION_MESSAGES[operation]?.[category]
    || null;
  if (!userMessage) {
    userMessage = category === 'unknown' && !providerShaped ? INTERNAL_UNKNOWN_MESSAGE : defaults.message;
  }

  let httpStatus = special?.httpStatus || defaults.httpStatus;
  if (!special && category === 'unknown' && providerShaped) httpStatus = 502;

  return {
    errorCode,
    userMessage,
    providerCode: facts.providerCode,
    providerMessage: sanitizeProviderText(facts.rawMessage) || null,
    requestId: facts.requestId,
    retryable: defaults.retryable || facts.explicitRetryable,
    category,
    httpStatus,
  };
}

/** Falha de autorização: só isto justifica pedir que o vendedor reconecte a conta. */
function isAuthFailure(normalized) {
  const category = normalized && typeof normalized === 'object' && CATEGORY_SET.has(normalized.category)
    ? normalized.category
    : normalizeTikTokError(normalized).category;
  return category === 'auth';
}

/** Uma linha para o log do servidor: classificação, códigos e o texto cru já sanitizado. */
function describeTikTokError(error, options) {
  const normalized = normalizeTikTokError(error, options);
  const providerHttp = error && typeof error === 'object'
    ? toFiniteInt(error.httpStatus ?? error.status ?? error.statusCode)
    : null;
  const parts = [`categoria=${normalized.category}`, `codigo=${normalized.errorCode}`];
  if (providerHttp !== null) parts.push(`http_tiktok=${providerHttp}`);
  if (normalized.providerCode !== null) parts.push(`tiktok_code=${normalized.providerCode}`);
  if (normalized.requestId) parts.push(`request_id=${normalized.requestId}`);
  if (normalized.providerMessage) parts.push(`detalhe="${normalized.providerMessage}"`);
  return parts.join(' ');
}

/**
 * Texto para as colunas last_error: a mensagem em PT-BR mais, para o suporte,
 * o código e o request_id do TikTok (sem nada do texto cru em inglês).
 */
function toLastErrorText(normalized) {
  const refs = [];
  if (normalized.providerCode !== null && normalized.providerCode !== undefined) {
    refs.push(`código TikTok ${normalized.providerCode}`);
  }
  if (normalized.requestId) refs.push(`ref. ${normalized.requestId}`);
  const suffix = refs.length > 0 ? ` (${refs.join('; ')})` : '';
  return `${normalized.userMessage}${suffix}`.slice(0, 1000);
}

module.exports = {
  ERROR_CATEGORIES,
  normalizeTikTokError,
  isAuthFailure,
  sanitizeProviderText,
  describeTikTokError,
  toLastErrorText,
};
