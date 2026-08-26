/**
 * Regras de cobrança do armazenamento — fonte única.
 *
 * A mesma conta existia em três lugares (router/billing.js, router/storage.js e
 * utils/billingQueryBuilder.js), com resultados diferentes:
 *   - billing.js e storage.js usavam `daysInMonth = 30` fixo, errando fevereiro
 *     e todos os meses de 31 dias;
 *   - storage.js comparava a entrada com o MÊS ATUAL em vez do mês faturado,
 *     mostrando proporcional em meses que já deveriam ser integrais;
 *   - a versão do billingQueryBuilder era a única correta, e nunca é chamada.
 *
 * Aqui a conta é uma só, com os dias reais do mês.
 */

/** Tipos de serviço que representam o armazenamento inicial (1m³). */
const BASE_STORAGE_TYPES = ['base_storage', 'base_storage_50'];
const ADDITIONAL_STORAGE_TYPE = 'additional_storage';
/** Todos os tipos que o faturamento de armazenamento reconhece. */
const STORAGE_TYPES = [...BASE_STORAGE_TYPES, ADDITIONAL_STORAGE_TYPE];

/** Rótulo exibido na fatura para cada tipo de armazenamento. */
const STORAGE_LABELS = {
  base_storage: 'Armazenamento Inicial (1m³)',
  base_storage_50: 'Armazenamento Inicial (1m³) 50% | FULL',
  additional_storage: 'Armazenamento Adicional (m³)',
};

function round(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

/** Dias reais do mês (1-12), sem depender de fuso. */
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Valor do armazenamento inicial no período, com proporcional apenas no mês de
 * entrada do contrato. Sem data de início, cobra integral.
 */
function proportionalStorage({ price, year, month, startDate }) {
  const full = round(price);
  if (!startDate) {
    return { amount: full, isProportional: false, days: null, startDay: null, daysInMonth: daysInMonth(year, month) };
  }

  const start = startDate instanceof Date ? startDate : new Date(startDate);
  if (Number.isNaN(start.getTime())) {
    return { amount: full, isProportional: false, days: null, startDay: null, daysInMonth: daysInMonth(year, month) };
  }

  // A data vem como DATE do Postgres; lê em UTC para o dia não escorregar.
  const startYear = start.getUTCFullYear();
  const startMonth = start.getUTCMonth() + 1;
  const startDay = start.getUTCDate();
  const total = daysInMonth(year, month);

  // Contrato começou depois do período faturado: nada a cobrar.
  if (startYear > year || (startYear === year && startMonth > month)) {
    return { amount: 0, isProportional: false, days: 0, startDay, daysInMonth: total, notStarted: true };
  }
  // Mês de entrada e não começou no dia 1 → proporcional.
  if (startYear === year && startMonth === month && startDay > 1) {
    const days = total - startDay + 1;
    return { amount: round((full / total) * days), isProportional: true, days, startDay, daysInMonth: total };
  }
  return { amount: full, isProportional: false, days: total, startDay, daysInMonth: total };
}

/** Descrição do item de armazenamento, já com o detalhe do proporcional. */
function storageDescription(type, calc) {
  const label = STORAGE_LABELS[type] || 'Armazenamento';
  if (!calc.isProportional) return label;
  return `${label} - Proporcional ${calc.days} de ${calc.daysInMonth} dias (entrada dia ${calc.startDay})`;
}

/**
 * Ordena um contrato base pela data de início e diz se ele já valia no período.
 *
 * `rank` é o instante de início em ms, usado para achar o contrato mais recente.
 * Contrato sem data (ou com data inválida) fica com o menor rank possível: ele
 * é elegível, mas perde de qualquer contrato datado — sem data não há como
 * afirmar que é o plano mais novo.
 */
function baseStartRank(startDate, year, month) {
  if (!startDate) return { rank: -Infinity, started: true };
  const start = startDate instanceof Date ? startDate : new Date(startDate);
  if (Number.isNaN(start.getTime())) return { rank: -Infinity, started: true };

  const startYear = start.getUTCFullYear();
  const startMonth = start.getUTCMonth() + 1;
  const started = !(startYear > year || (startYear === year && startMonth > month));
  return { rank: start.getTime(), started };
}

/**
 * Escolhe UM contrato de armazenamento inicial para o período faturado.
 *
 * `base_storage` (1m³ integral) e `base_storage_50` (metade, operação FULL)
 * representam a MESMA linha da fatura em planos diferentes — são mutuamente
 * exclusivos. Antes daqui saía um item para cada tipo contratado, então o
 * cliente que trocou de plano (e ficou com os dois contratos, porque
 * `unique_contract` só barra o mesmo service_id) recebia duas linhas de
 * "Armazenamento Inicial" e pagava 397,00 + 198,50.
 *
 * O critério é o contrato VIGENTE: entre os que já começaram até o fim do
 * período, vale o de início mais recente. Assim, quem migrou para o plano de 50%
 * em março continua com o valor antigo em fevereiro e passa a pagar o novo de
 * março em diante — a fatura de cada competência reflete o plano daquela época.
 *
 * Contrato cujo serviço está com preço zerado no catálogo não concorre: preço
 * zero é o master dizendo "não cobrar isso", e promover o outro plano no lugar
 * cobraria o cliente por algo que foi desligado de propósito.
 *
 * O desempate por `contract_id` existe porque `ORDER BY start_date` sozinho não
 * define ordem quando as datas empatam, e sem desempate o valor faturado podia
 * mudar de uma requisição para outra.
 */
function pickBaseStorageContract({ contracts, prices, year, month }) {
  const candidates = [];

  for (const contract of contracts || []) {
    if (!BASE_STORAGE_TYPES.includes(contract.type)) continue;
    if ((Number(prices?.[contract.type]) || 0) <= 0) continue;

    const { rank, started } = baseStartRank(contract.start_date, year, month);
    if (!started) continue;
    candidates.push({ contract, rank });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.rank !== b.rank) return b.rank - a.rank;
    return Number(b.contract.contract_id ?? 0) - Number(a.contract.contract_id ?? 0);
  });

  return candidates[0].contract;
}

/**
 * Monta os itens de armazenamento da fatura a partir dos contratos do cliente.
 *
 * @param {Array} contracts [{ type, volume, start_date, service_id }]
 * @param {Object} prices   { base_storage, base_storage_50, additional_storage }
 */
function buildStorageItems({ contracts, prices, year, month }) {
  const items = [];

  // UMA linha de armazenamento inicial, sempre. Ver pickBaseStorageContract.
  const base = pickBaseStorageContract({ contracts, prices, year, month });
  if (base) {
    const price = Number(prices[base.type]) || 0;
    const calc = proportionalStorage({ price, year, month, startDate: base.start_date });
    if (!calc.notStarted && calc.amount > 0) {
      items.push({
        description: storageDescription(base.type, calc),
        quantity: 1,
        unit: 'm3',
        unit_price: calc.amount,
        total_price: calc.amount,
        type: 'storage',
        service_id: base.service_id ?? null,
      });
    }
  }

  const additional = contracts.find((c) => c.type === ADDITIONAL_STORAGE_TYPE);
  if (additional) {
    const quantity = parseInt(additional.volume, 10) || 0;
    const price = Number(prices[ADDITIONAL_STORAGE_TYPE]) || 0;
    if (quantity > 0 && price > 0) {
      // O adicional nunca é proporcional: é contratado por m³ cheio no mês.
      const total = round(price * quantity);
      items.push({
        description: STORAGE_LABELS[ADDITIONAL_STORAGE_TYPE],
        quantity,
        unit: 'm3',
        unit_price: round(price),
        total_price: total,
        type: 'storage',
        service_id: additional.service_id ?? null,
      });
    }
  }

  return items;
}

/** Preço unitário por faixa de quantidade (serviços `avulso_quantidade`). */
function getTierUnitPrice(config, quantity) {
  const qty = parseInt(quantity, 10);
  if (!config || !Array.isArray(config.tiers) || !qty || qty < 1) return null;
  for (const tier of config.tiers) {
    const fromOk = typeof tier.from === 'number' ? qty >= tier.from : true;
    const toOk = typeof tier.to === 'number' ? qty <= tier.to : true;
    if (fromOk && toOk) return round(tier.price);
  }
  const openTier = config.tiers.find((t) => t.to === null || typeof t.to === 'undefined');
  return openTier ? round(openTier.price) : null;
}

/** Rótulo legível da unidade, para a fatura e as telas. */
const UNIT_LABELS = {
  m3: 'm³',
  pacote: 'pacote',
  viagem: 'viagem',
  venda: 'venda',
  unidade: 'unidade',
};

function unitLabel(unit, quantity = 1) {
  const label = UNIT_LABELS[unit] || unit || '';
  if (!label || label === 'm³') return label;
  return quantity > 1 ? `${label}s` : label;
}

module.exports = {
  BASE_STORAGE_TYPES,
  ADDITIONAL_STORAGE_TYPE,
  STORAGE_TYPES,
  STORAGE_LABELS,
  UNIT_LABELS,
  round,
  daysInMonth,
  proportionalStorage,
  storageDescription,
  pickBaseStorageContract,
  buildStorageItems,
  getTierUnitPrice,
  unitLabel,
};
