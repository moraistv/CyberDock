/**
 * Adaptador HTTP do Asaas.
 *
 * Este arquivo é a ÚNICA parte do sistema que sabe que o Asaas existe. Nenhuma
 * rota o usa ainda: ele entra primeiro, isolado e desligado, para que a decisão
 * de ligar seja de configuração e não de código.
 *
 * Três regras que valem para qualquer coisa que mova dinheiro:
 *
 * 1. NENHUM segredo aqui. A chave vem de ASAAS_API_KEY e nada mais. Sem
 *    fallback embutido, sem valor de exemplo — o projeto já tem o caso do
 *    ML_CLIENT_SECRET escrito no código e versionado, e chave de cobrança dá
 *    acesso a movimentar dinheiro de verdade.
 *
 * 2. DESLIGADO por padrão. Sem chave configurada, `isEnabled()` é falso e
 *    qualquer chamada falha com uma mensagem clara, em vez de bater na API sem
 *    credencial e receber 401 no meio de um faturamento.
 *
 * 3. SANDBOX por padrão. Produção exige ASAAS_ENV=production explícito. O
 *    contrário — cair em produção por esquecimento — é o erro caro.
 *
 * Autenticação: a API do Asaas usa o header `access_token`, e NÃO
 * `Authorization: Bearer`. Documentação: https://docs.asaas.com/docs/autenticação-1
 */
const fetch = require('node-fetch');

const AMBIENTES = {
  sandbox: 'https://api-sandbox.asaas.com/v3',
  production: 'https://api.asaas.com/v3',
};

/** `production` só quando dito com essas letras. Qualquer outra coisa é sandbox. */
function ambiente() {
  return String(process.env.ASAAS_ENV || '').toLowerCase() === 'production'
    ? 'production'
    : 'sandbox';
}

function baseUrl() {
  return process.env.ASAAS_BASE_URL || AMBIENTES[ambiente()];
}

function apiKey() {
  return (process.env.ASAAS_API_KEY || '').trim();
}

/** Integração utilizável? Sem chave, nada é tentado. */
function isEnabled() {
  return apiKey().length > 0;
}

/** Diagnóstico para o painel, sem NUNCA devolver a chave. */
function describe() {
  const chave = apiKey();
  return {
    enabled: chave.length > 0,
    environment: ambiente(),
    baseUrl: baseUrl(),
    // Só o suficiente para conferir que é a chave certa, sem expor o segredo.
    apiKeyPreview: chave ? `...${chave.slice(-4)}` : null,
    webhookTokenConfigured: Boolean((process.env.ASAAS_WEBHOOK_TOKEN || '').trim()),
  };
}

class AsaasError extends Error {
  constructor(message, { status = null, code = null, errors = null, path = null } = {}) {
    super(message);
    this.name = 'AsaasError';
    this.status = status;
    this.code = code;
    this.errors = errors;
    this.path = path;
  }
}

/**
 * Uma chamada à API.
 *
 * O Asaas devolve erro em `errors: [{ code, description }]`. Traduzo para uma
 * exceção com a descrição do provedor, porque "erro 400" sem o motivo obriga a
 * abrir o log do container para descobrir o que faltou no cadastro.
 *
 * Timeout explícito: sem ele, uma chamada pendurada segura a requisição da tela
 * até o limite do servidor.
 */
async function request(method, path, { body = null, query = null, timeoutMs = 20000 } = {}) {
  if (!isEnabled()) {
    throw new AsaasError(
      'Integração de cobrança não configurada: defina ASAAS_API_KEY no ambiente.',
      { code: 'not_configured', path }
    );
  }

  const url = new URL(`${baseUrl()}${path}`);
  if (query) {
    for (const [chave, valor] of Object.entries(query)) {
      if (valor !== undefined && valor !== null && valor !== '') {
        url.searchParams.set(chave, String(valor));
      }
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let resposta;
  try {
    resposta = await fetch(url.toString(), {
      method,
      headers: {
        access_token: apiKey(),
        'Content-Type': 'application/json',
        Accept: 'application/json',
        // Ajuda o suporte do Asaas a identificar a origem das chamadas.
        'User-Agent': 'CyberDock/1.0',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (error) {
    const abortou = error.name === 'AbortError';
    throw new AsaasError(
      abortou
        ? `Tempo esgotado na chamada ao Asaas (${timeoutMs} ms).`
        : `Falha de rede na chamada ao Asaas: ${error.message}`,
      { code: abortou ? 'timeout' : 'network_error', path }
    );
  } finally {
    clearTimeout(timer);
  }

  const texto = await resposta.text();
  let dados = null;
  if (texto) {
    try { dados = JSON.parse(texto); } catch { dados = { raw: texto }; }
  }

  if (!resposta.ok) {
    const primeiro = Array.isArray(dados?.errors) ? dados.errors[0] : null;
    throw new AsaasError(
      primeiro?.description || `Asaas respondeu ${resposta.status} em ${path}.`,
      {
        status: resposta.status,
        code: primeiro?.code || null,
        errors: dados?.errors || null,
        path,
      }
    );
  }

  return dados;
}

/* --------------------------------- Clientes --------------------------------
 *
 * O Asaas ACEITA criar cadastro duplicado, então a checagem prévia é
 * responsabilidade nossa. `externalReference` recebe o uid do CyberDock, o que
 * permite achar o cadastro pelo nosso identificador em vez de depender de
 * comparar nome ou documento.
 */

/** Procura pelo nosso identificador. Devolve o primeiro, ou null. */
async function findCustomerByExternalReference(uid) {
  const dados = await request('GET', '/customers', {
    query: { externalReference: uid, limit: 1 },
  });
  return dados?.data?.[0] || null;
}

/** Procura pelo documento, que é o critério de duplicidade do provedor. */
async function findCustomerByCpfCnpj(cpfCnpj) {
  const dados = await request('GET', '/customers', {
    query: { cpfCnpj, limit: 1 },
  });
  return dados?.data?.[0] || null;
}

/* Endereço do pagador.
 *
 * Obrigatório para BOLETO: sem CEP e número o provedor recusa a emissão. PIX e
 * cartão passam sem. Enviado como `undefined` quando não existe, para não
 * sobrescrever com vazio um endereço que já esteja lá. */
function camposDeEndereco({ postalCode, address, addressNumber, addressComplement, province }) {
  return {
    postalCode: postalCode || undefined,
    address: address || undefined,
    addressNumber: addressNumber || undefined,
    complement: addressComplement || undefined,
    province: province || undefined,
  };
}

async function createCustomer({
  uid, name, cpfCnpj, email, phone, notificationDisabled,
  postalCode, address, addressNumber, addressComplement, province,
}) {
  return request('POST', '/customers', {
    body: {
      name,
      cpfCnpj,
      email: email || undefined,
      mobilePhone: phone || undefined,
      externalReference: uid,
      notificationDisabled: notificationDisabled === true,
      ...camposDeEndereco({ postalCode, address, addressNumber, addressComplement, province }),
    },
  });
}

async function updateCustomer(customerId, {
  name, cpfCnpj, email, phone,
  postalCode, address, addressNumber, addressComplement, province,
}) {
  return request('POST', `/customers/${encodeURIComponent(customerId)}`, {
    body: {
      name,
      cpfCnpj,
      email: email || undefined,
      mobilePhone: phone || undefined,
      ...camposDeEndereco({ postalCode, address, addressNumber, addressComplement, province }),
    },
  });
}

/* -------------------------------- Cobranças --------------------------------
 *
 * Uma cobrança por competência, não assinatura: a fatura do CyberDock é
 * variável (armazenamento + expedições do mês + avulsos) e assinatura no Asaas
 * gera recorrência de valor fixo.
 *
 * `billingType: 'UNDEFINED'` deixa o pagador escolher entre os meios ativos na
 * conta, o que evita manter um fluxo por meio de pagamento.
 *
 * `externalReference` guarda a chave da fatura local, e é por ele que o webhook
 * encontra a competência sem precisar de tabela de tradução.
 */

/** Chave estável da fatura, usada nos dois sentidos. */
function invoiceReference(uid, period) {
  return `cyberdock:invoice:${uid}:${period}`;
}

/** Cobrança já emitida para esta competência? Evita cobrar duas vezes. */
async function findPaymentByInvoice(uid, period) {
  const dados = await request('GET', '/payments', {
    query: { externalReference: invoiceReference(uid, period), limit: 1 },
  });
  return dados?.data?.[0] || null;
}

async function createPayment({
  customerId, value, dueDate, description, uid, period,
  billingType = 'UNDEFINED', fine = null, interest = null,
}) {
  return request('POST', '/payments', {
    body: {
      customer: customerId,
      billingType,
      value,
      dueDate,
      description,
      externalReference: invoiceReference(uid, period),
      // Só vão quando configurados: enviar zero pode desligar a regra da conta.
      fine: fine ? { value: fine } : undefined,
      interest: interest ? { value: interest } : undefined,
    },
  });
}

async function getPayment(paymentId) {
  return request('GET', `/payments/${encodeURIComponent(paymentId)}`);
}

/**
 * Altera uma cobrança já emitida.
 *
 * Escopo estreito de propósito: só vencimento e descrição. Mudar o VALOR aqui
 * criaria divergência silenciosa com o total congelado da competência — para
 * valor diferente, o caminho é cancelar e emitir de novo, que deixa rastro nos
 * dois lados.
 *
 * O Asaas exige `billingType` e `value` no corpo desta chamada mesmo quando não
 * mudam, então quem chama precisa passar os valores atuais.
 */
async function updatePayment(paymentId, { value, dueDate, description, billingType }) {
  return request('POST', `/payments/${encodeURIComponent(paymentId)}`, {
    body: {
      billingType: billingType || 'UNDEFINED',
      value,
      dueDate,
      description: description || undefined,
    },
  });
}

/** Cancelamento é o caminho para competência reaberta ou emitida por engano. */
async function deletePayment(paymentId) {
  return request('DELETE', `/payments/${encodeURIComponent(paymentId)}`);
}

/**
 * Confere a credencial sem criar nada.
 *
 * Uma listagem com limite 1 é a chamada mais barata que prova quatro coisas de
 * uma vez: chave presente, chave válida, ambiente certo e rede alcançável.
 */
async function ping() {
  const inicio = Date.now();
  await request('GET', '/customers', { query: { limit: 1 }, timeoutMs: 10000 });
  return { ok: true, environment: ambiente(), elapsedMs: Date.now() - inicio };
}

/**
 * O POST do webhook veio mesmo do Asaas?
 *
 * A verificação é por token compartilhado: nós definimos `authToken` ao cadastrar
 * o webhook e o Asaas o devolve em todo evento. Sem `ASAAS_WEBHOOK_TOKEN`
 * configurado esta função recusa TUDO — endpoint de baixa de pagamento aberto
 * seria um convite a marcar fatura como paga de fora.
 *
 * Comparação de tamanho fixo para não vazar o token pelo tempo de resposta.
 */
function isValidWebhookToken(recebido) {
  const esperado = (process.env.ASAAS_WEBHOOK_TOKEN || '').trim();
  if (!esperado) return false;

  const a = Buffer.from(String(recebido || ''));
  const b = Buffer.from(esperado);
  if (a.length !== b.length) return false;

  let diferenca = 0;
  for (let i = 0; i < a.length; i += 1) diferenca |= a[i] ^ b[i];
  return diferenca === 0;
}

module.exports = {
  AsaasError,
  isEnabled,
  describe,
  ping,
  request,
  invoiceReference,
  findCustomerByExternalReference,
  findCustomerByCpfCnpj,
  createCustomer,
  updateCustomer,
  findPaymentByInvoice,
  createPayment,
  getPayment,
  updatePayment,
  deletePayment,
  isValidWebhookToken,
};
