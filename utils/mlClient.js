// utils/mlClient.js
// Cliente central para a API do Mercado Livre.
// Objetivos:
//  - Timeout por requisição (nunca deixar uma chamada travar o job).
//  - Backoff exponencial com jitter para 429 / 5xx / erros de rede.
//  - Respeitar Retry-After quando presente.
//  - Limitador GLOBAL de concorrência compartilhado por TODAS as contas/jobs
//    do processo, para nunca estourar o rate limit do ML mesmo com várias
//    contas sincronizando em paralelo.
//  - Concorrência adaptativa: cai quando o ML devolve 429 e se recupera
//    lentamente quando as chamadas voltam a ter sucesso.

const fetch = require('node-fetch');

const HARD_MAX = parseInt(process.env.ML_MAX_CONCURRENCY || '48', 10); // teto absoluto
const MIN_LIMIT = parseInt(process.env.ML_MIN_CONCURRENCY || '4', 10); // piso quando em 429
const INITIAL_LIMIT = Math.min(
  HARD_MAX,
  Math.max(MIN_LIMIT, parseInt(process.env.ML_INITIAL_CONCURRENCY || '24', 10))
);
const RECOVER_INTERVAL_MS = parseInt(process.env.ML_RECOVER_INTERVAL_MS || '1000', 10);
const RECOVER_SUCCESS_COUNT = parseInt(process.env.ML_RECOVER_SUCCESS_COUNT || '12', 10);
const DEFAULT_TIMEOUT = parseInt(process.env.ML_TIMEOUT_MS || '15000', 10);
const MAX_RETRIES = parseInt(process.env.ML_MAX_RETRIES || '4', 10);

// Estado do limitador global (por processo).
let currentLimit = INITIAL_LIMIT; // limite dinâmico atual
let active = 0;                // requisições em voo
const queue = [];              // resolvers aguardando vaga
let lastRecoverAt = Date.now();
let successfulSinceRecovery = 0;
let total429 = 0;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Recupera 1 slot de concorrência a cada X ms de saúde (sem 429).
function recordSuccess() {
  successfulSinceRecovery++;
  const now = Date.now();
  if (
    currentLimit < HARD_MAX &&
    successfulSinceRecovery >= RECOVER_SUCCESS_COUNT &&
    now - lastRecoverAt >= RECOVER_INTERVAL_MS
  ) {
    currentLimit = Math.min(HARD_MAX, currentLimit + 1);
    lastRecoverAt = now;
    successfulSinceRecovery = 0;
  }
}

// Reduz a concorrência quando o ML sinaliza excesso (429).
function throttleDown() {
  currentLimit = Math.max(MIN_LIMIT, Math.floor(currentLimit / 2));
  lastRecoverAt = Date.now();
  successfulSinceRecovery = 0;
  total429++;
}

function acquire() {
  return new Promise((resolve) => {
    const grant = () => {
      active++;
      resolve();
    };
    if (active < currentLimit) {
      grant();
    } else {
      queue.push(grant);
    }
  });
}

function release() {
  active = Math.max(0, active - 1);
  // Libera o próximo respeitando o limite atual (que pode ter mudado).
  while (queue.length > 0 && active < currentLimit) {
    const grant = queue.shift();
    grant();
  }
}

function isRetryableStatus(status) {
  return status === 429 || status === 408 || (status >= 500 && status <= 599);
}

function backoffDelay(attempt, retryAfterHeader) {
  // Retry-After em segundos, se presente.
  if (retryAfterHeader) {
    const secs = parseInt(retryAfterHeader, 10);
    if (!isNaN(secs) && secs > 0) return Math.min(secs * 1000, 30000);
  }
  // Exponencial 1s,2s,4s,8s,16s (teto 30s) com jitter total.
  const base = Math.min(30000, 1000 * Math.pow(2, attempt));
  return Math.floor(Math.random() * base);
}

/**
 * Executa uma requisição ao ML com timeout, limiter global e retry resiliente.
 * Retorna o objeto Response do node-fetch (mesma interface do fetch normal).
 * Só faz retry de 429/408/5xx e erros de rede; 4xx funcionais retornam direto.
 */
async function mlFetch(url, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT, retries = MAX_RETRIES, ...fetchOpts } = options;

  let attempt = 0;
  let lastErr = null;

  while (attempt <= retries) {
    await acquire();
    let retryDelay = null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, { ...fetchOpts, signal: controller.signal });
        clearTimeout(timer);

        if (res.status === 429) {
          throttleDown();
        } else if (res.ok) {
          recordSuccess();
        }

        if (isRetryableStatus(res.status) && attempt < retries) {
          retryDelay = backoffDelay(attempt, res.headers.get('retry-after'));
          attempt++;
        } else {
          return res; // sucesso ou 4xx funcional (não deve repetir)
        }
      } catch (err) {
        clearTimeout(timer);
        lastErr = err;
        if (attempt < retries) {
          retryDelay = backoffDelay(attempt, null);
          attempt++;
        } else {
          throw lastErr;
        }
      }
    } finally {
      // Backoff nunca deve segurar uma vaga global. A tentativa seguinte entra
      // novamente na fila, preservando fairness entre contas.
      release();
    }

    if (retryDelay !== null) await sleep(retryDelay);
  }

  if (lastErr) throw lastErr;
  throw new Error('mlFetch: falha inesperada sem resposta.');
}

// Helper: mlFetch + json, retornando null em corpo inválido.
async function mlFetchJson(url, options = {}) {
  const res = await mlFetch(url, options);
  if (!res.ok) return { ok: false, status: res.status, data: null, res };
  try {
    const data = await res.json();
    return { ok: true, status: res.status, data, res };
  } catch {
    return { ok: false, status: res.status, data: null, res };
  }
}

function getLimiterStats() {
  return {
    currentLimit,
    active,
    queued: queue.length,
    hardMax: HARD_MAX,
    initialLimit: INITIAL_LIMIT,
    successfulSinceRecovery,
    total429
  };
}

module.exports = { mlFetch, mlFetchJson, getLimiterStats };
