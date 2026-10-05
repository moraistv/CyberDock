const crypto = require('crypto');

/**
 * Chave estável de UM efeito de estoque provocado por uma linha de venda.
 *
 * `movementSkuId` faz parte da chave porque um kit gera vários efeitos: um para
 * cada componente físico e um movimento comercial para o SKU pai. A chave é
 * igual em todos os caminhos que podem processar a mesma venda (botão em lote
 * ou mudança para "Despachado").
 *
 * O hash mantém o índice pequeno mesmo com UID/SKU longos. Não é usado para
 * segurança; a unicidade continua sendo garantida pelo PostgreSQL.
 */
function buildSaleLineKey({ marketplace, uid, orderId, soldSku, movementSkuId }) {
  const channel = String(marketplace || '').trim().toLowerCase();
  const owner = String(uid || '').trim();
  const order = String(orderId ?? '').trim();
  const sku = String(soldSku || '').trim().toUpperCase();
  const movementSku = String(movementSkuId ?? '').trim();

  if (!channel || !owner || !order || !sku || !movementSku) {
    throw new TypeError('Não foi possível montar a chave idempotente da venda.');
  }

  const canonical = JSON.stringify([channel, owner, order, sku, movementSku]);
  return `v1:${channel}:${crypto.createHash('sha256').update(canonical).digest('hex')}`;
}

/** Traduz a violação do índice em falha explícita para o operador. */
function isDuplicateSaleMovement(error) {
  return error?.code === '23505'
    && (error?.constraint === 'idx_stock_movements_sale_line_key'
      || String(error?.message || '').includes('sale_line_key'));
}

function duplicateSaleMovementError() {
  const error = new Error(
    'Esta venda já possui baixa de estoque registrada. Nada foi processado novamente.'
  );
  error.code = 'sale_already_applied';
  return error;
}

module.exports = {
  buildSaleLineKey,
  isDuplicateSaleMovement,
  duplicateSaleMovementError,
};
