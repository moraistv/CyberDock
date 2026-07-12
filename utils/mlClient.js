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

const HARD_MAX = parseInt(process.env.ML_MAX_CONCURRENCY || '24', 10); // teto absoluto
const MIN_LIMIT = parseInt(process.env.ML_MIN_CONCURRENCY || '4', 10); // piso quando em 429
const DEFAULT_TIMEOUT = parseInt(process.env.ML_TIMEOUT_MS || '15000', 10);
const MAX_RETRIES = parseInt(process.env.ML_MAX_RETRIES || '4', 10);

// Estado do limitador global (por processo).
let currentLimit = HARD_MAX;   // limite dinâmico atual
let active = 0;                // requisições em voo
const queue = [];              // resolvers aguardando vaga
let lastRecoverAt = Date.now();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Recupera 1 slot de concorrência a cada X ms de saúde (sem 429).
function tryRecover() {
  const now = Date.now();
  if (currentLimit < HARD_MAX && now - lastRecoverAt > 5000) {
    currentLimit = Math.min(HARD_MAX, currentLimit + 1);
    lastRecoverAt = now;
  }
}

// Reduz a concorrência quando o ML sinaliza excesso (429).
function throttleDown() {
  currentLimit = Math.max(MIN_LIMIT, Math.floor(currentLimit / 2));
  lastRecoverAt = Date.now();
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
  tryRecover();
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

  await acquire();
  try {
    let attempt = 0;
    let lastErr = null;

    while (attempt <= retries) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, { ...fetchOpts, signal: controller.signal });
        clearTimeout(timer);

        if (res.status === 429) {
          throttleDown();
        }

        if (isRetryableStatus(res.status) && attempt < retries) {
          const delay = backoffDelay(attempt, res.headers.get('retry-after'));
          attempt++;
          await sleep(delay);
          continue;
        }

        return res; // sucesso ou 4xx funcional (não deve repetir)
      } catch (err) {
        clearTimeout(timer);
        lastErr = err;
        if (attempt < retries) {
          const delay = backoffDelay(attempt, null);
          attempt++;
          await sleep(delay);
          continue;
        }
        throw lastErr;
      }
    }
    if (lastErr) throw lastErr;
    // teoricamente inalcançável
    throw new Error('mlFetch: falha inesperada sem resposta.');
  } finally {
    release();
  }
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
  return { currentLimit, active, queued: queue.length, hardMax: HARD_MAX };
}

module.exports = { mlFetch, mlFetchJson, getLimiterStats };
