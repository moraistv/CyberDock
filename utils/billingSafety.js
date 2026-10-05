// utils/billingSafety.js
//
// Garantias que envolvem banco + Asaas e precisam valer em TODAS as instâncias
// do backend. Botão desabilitado no navegador não protege duas abas, retry de
// rede nem dois containers; o advisory lock do PostgreSQL protege.

const db = require('./postgres');
const asaas = require('./asaasClient');

const DEFAULT_LOCK_TIMEOUT_MS = 8000;
const DEFAULT_LOCK_RETRY_MS = 40;

/* Teto de sessões de lock simultâneas POR PROCESSO.
 *
 * Cada lock segura uma conexão do pool durante toda a operação (que inclui
 * chamadas HTTP ao Asaas, até ~20 s cada). Sem teto, cliques repetidos durante
 * uma lentidão do provedor consumiriam o pool inteiro (15 conexões) e o resto
 * do sistema ficaria sem banco. Acima do teto a resposta é imediata e segura:
 * `billing_busy`, sem tocar em nada. */
const MAX_LOCK_SESSIONS = 5;
let activeLockSessions = 0;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function busyError(message) {
  return new asaas.AsaasError(message, { status: 409, code: 'billing_busy' });
}

/**
 * Executa uma operação financeira sob lock distribuído no PostgreSQL.
 *
 * O lock é da SESSÃO e a conexão fica reservada até o finally. Se o processo
 * morrer, o PostgreSQL solta a sessão e o lock automaticamente. A chave passa
 * por hashtextextended no próprio banco para não depender de Number do JS.
 *
 * `pg_try_advisory_lock` mantém a espera limitada. Um lock bloqueante podia
 * prender a requisição indefinidamente se outra operação ficasse lenta; agora o
 * chamador recebe `billing_busy` e pode tentar novamente sem duplicar cobrança.
 *
 * Lock de sessão NÃO é solto por COMMIT/ROLLBACK: o callback pode abrir e
 * fechar transações no `client` à vontade, e o lock continua valendo até o
 * finally. É isso que permite serializar "ler fatura -> chamar o Asaas ->
 * gravar" sem manter transação aberta durante a chamada de rede.
 */
async function withBillingLock(scope, identity, work, {
  timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  retryMs = DEFAULT_LOCK_RETRY_MS,
} = {}) {
  if (!scope || identity === undefined || identity === null || typeof work !== 'function') {
    throw new TypeError('withBillingLock exige scope, identity e callback.');
  }

  if (activeLockSessions >= MAX_LOCK_SESSIONS) {
    throw busyError('Há operações de cobrança demais em andamento. Aguarde alguns segundos e tente de novo.');
  }
  activeLockSessions += 1;

  let client;
  try {
    client = await db.pool.connect();
  } catch (error) {
    activeLockSessions -= 1;
    throw error;
  }

  const lockName = `cyberdock:billing:${scope}:${identity}`;
  const timeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) >= 0
    ? Number(timeoutMs)
    : DEFAULT_LOCK_TIMEOUT_MS;
  const retry = Number.isFinite(Number(retryMs)) && Number(retryMs) > 0
    ? Number(retryMs)
    : DEFAULT_LOCK_RETRY_MS;
  const deadline = Date.now() + timeout;
  let locked = false;
  let destroyConnection = false;

  try {
    do {
      const result = await client.query(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
        [lockName]
      );
      locked = result.rows[0]?.locked === true;
      if (locked) break;

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await wait(Math.min(retry, remaining));
    } while (!locked);

    if (!locked) {
      throw busyError('Outra operação desta cobrança ainda está em andamento. Tente novamente em instantes.');
    }

    return await work(client);
  } finally {
    /* Transação esquecida aberta (ou abortada) no callback travaria o unlock
     * e devolveria ao pool uma conexão suja. ROLLBACK sem transação é inócuo. */
    await client.query('ROLLBACK').catch(() => { destroyConnection = true; });

    if (locked) {
      try {
        const released = await client.query(
          'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked',
          [lockName]
        );
        if (released.rows[0]?.unlocked !== true) destroyConnection = true;
      } catch (error) {
        destroyConnection = true;
        console.error(`[Cobrança] Falha ao liberar lock ${scope}:`, error.message);
      }
    }

    /* Se o unlock não ficou comprovado, a conexão é DESTRUÍDA em vez de voltar
     * ao pool: o lock é da sessão e morre junto com ela. Devolver a conexão com
     * lock pendurado deixaria a cobrança travada até reiniciar o processo. */
    activeLockSessions -= 1;
    client.release(destroyConnection);
  }
}

/** Aceita somente a referência exata gerada por invoiceReference(). */
function parseInvoiceReference(reference) {
  if (typeof reference !== 'string') return null;
  const match = /^cyberdock:invoice:([^:\u0000-\u001f\u007f]{1,255}):(\d{4}-(?:0[1-9]|1[0-2]))$/.exec(reference);
  return match ? { uid: match[1], period: match[2] } : null;
}

/**
 * Converte decimal monetário em centavos sem arredondar frações escondidas.
 *
 * Aceita "123.4500" (zeros à direita não escondem nada), mas recusa "123.456":
 * frações com valor real não viram centavos por aproximação.
 */
function moneyCents(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value).trim());
  if (!match) return null;

  const decimals = match[3] || '';
  if (decimals.length > 2 && /[1-9]/.test(decimals.slice(2))) return null;

  const whole = Number(match[2]);
  const fraction = Number(decimals.slice(0, 2).padEnd(2, '0'));
  if (!Number.isSafeInteger(whole) || !Number.isSafeInteger(fraction)) return null;

  const cents = (whole * 100) + fraction;
  if (!Number.isSafeInteger(cents)) return null;
  return match[1] ? -cents : cents;
}

function paymentCustomerId(payment) {
  if (typeof payment?.customer === 'string') return payment.customer;
  return payment?.customer?.id || null;
}

/**
 * Impede adotar/sincronizar/aplicar uma cobrança que pertence a outra fatura.
 *
 * Conferir somente o status é perigoso: uma cobrança de R$ 1,00, de outro
 * cliente ou de outra competência poderia dar baixa na fatura local inteira.
 *
 * Identidade (id, referência externa, cliente) é SEMPRE conferida. O valor é
 * conferido por padrão, e `checkValue: false` existe para cancelar/alterar
 * vencimento: nesses casos o valor divergente é justamente o motivo de mexer na
 * cobrança, e exigir igualdade impediria a correção.
 *
 * Valor: aceita `value` igual ao total da fatura OU `originalValue` igual. O
 * Asaas pode devolver em `value` o total pago com juros e multa (o valor
 * original fica em `originalValue`), e recusar esse pagamento deixaria o
 * cliente que pagou aparecendo como devedor.
 */
function assertPaymentMatchesInvoice(payment, invoice, { checkValue = true } = {}) {
  const expectedReference = asaas.invoiceReference(invoice.uid, invoice.period);
  const expectedCustomer = String(invoice.asaas_customer_id || '');
  const expectedPaymentId = String(invoice.asaas_payment_id || '');
  const expectedCents = moneyCents(invoice.total_amount);
  const actualReference = String(payment?.externalReference || '');
  const parsedReference = parseInvoiceReference(actualReference);
  const actualCustomer = String(paymentCustomerId(payment) || '');
  const actualPaymentId = String(payment?.id || '');
  const actualCents = moneyCents(payment?.value);
  const originalCents = payment?.originalValue === undefined || payment?.originalValue === null
    ? null
    : moneyCents(payment.originalValue);
  const mismatches = [];

  if (!actualPaymentId) mismatches.push('identificador ausente');
  if (expectedPaymentId && actualPaymentId !== expectedPaymentId) mismatches.push('identificador diferente');
  if (!parsedReference || actualReference !== expectedReference) mismatches.push('referência externa diferente');
  if (!expectedCustomer || actualCustomer !== expectedCustomer) mismatches.push('cliente diferente');
  if (checkValue) {
    const valueMatches = expectedCents !== null
      && (actualCents === expectedCents || originalCents === expectedCents);
    if (!valueMatches) mismatches.push('valor diferente');
  }

  if (mismatches.length) {
    throw new asaas.AsaasError(
      `A cobrança ${actualPaymentId || '(sem id)'} do Asaas não corresponde a esta fatura `
      + `(${mismatches.join(', ')}). Nada foi alterado. Confira a cobrança no painel do Asaas.`,
      { status: 409, code: 'payment_mismatch', path: `/payments/${actualPaymentId}` }
    );
  }

  return payment;
}

/** Valida data civil de verdade: 2026-02-31 não passa. */
function isValidIsoDate(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

/**
 * "Hoje" como o Asaas enxerga: data civil de Brasília.
 *
 * `toISOString()` é UTC e vira o dia às 21h de Brasília; depois disso um
 * vencimento igual a hoje seria recusado aqui como "no passado" enquanto o
 * provedor o aceitaria.
 */
function hojeNoBrasil(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

const BILLING_TYPES = new Set(['UNDEFINED', 'BOLETO', 'CREDIT_CARD', 'PIX']);

/** Normaliza antes de consultar a allowlist; nenhum outro valor chega ao Asaas. */
function normalizeBillingType(value) {
  const normalized = String(value || 'UNDEFINED').trim().toUpperCase();
  return BILLING_TYPES.has(normalized) ? normalized : null;
}

module.exports = {
  withBillingLock,
  parseInvoiceReference,
  moneyCents,
  assertPaymentMatchesInvoice,
  isValidIsoDate,
  hojeNoBrasil,
  normalizeBillingType,
};
