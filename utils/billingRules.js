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
 * Monta os itens de armazenamento da fatura a partir dos contratos do cliente.
 *
 * @param {Array} contracts [{ type, volume, start_date, service_id }]
 * @param {Object} prices   { base_storage, base_storage_50, additional_storage }
 */
function buildStorageItems({ contracts, prices, year, month }) {
  const items = [];

  for (const type of BASE_STORAGE_TYPES) {
    const contract = contracts.find((c) => c.type === type);
    if (!contract) continue;
    const price = Number(prices[type]) || 0;
    if (price <= 0) continue;

    const calc = proportionalStorage({ price, year, month, startDate: contract.start_date });
    if (calc.notStarted || calc.amount <= 0) continue;

    items.push({
      description: storageDescription(type, calc),
      quantity: 1,
      unit: 'm3',
      unit_price: calc.amount,
      total_price: calc.amount,
      type: 'storage',
      service_id: contract.service_id ?? null,
    });
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
  buildStorageItems,
  getTierUnitPrice,
  unitLabel,
};
