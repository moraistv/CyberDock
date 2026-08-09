// utils/shopeeFinance.js
//
// Cálculo financeiro da Shopee — portado 1:1 de v2/src/lib/shopee-finance.ts
// (que por sua vez replica CONTAZOOM, regra "shopee-effective-sale-v5").
//
// NÃO altere a matemática: deriva o subtotal efetivo do produto, a taxa da
// plataforma e o frete do vendedor a partir do escrow (order_income) da
// Shopee, com várias camadas de fallback para dados que às vezes vêm
// ausentes ou com nomes de campo diferentes.

const SHOPEE_FINANCIAL_RULE_VERSION = 'shopee-effective-sale-v5';

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

function roundCurrency(value) {
  const rounded = Math.round((value + Number.EPSILON) * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function positive(value) {
  const n = toFiniteNumber(value);
  if (n === null || n <= 0) return 0;
  return n;
}

function maxPositive(...values) {
  let max = 0;
  for (const value of values) {
    const n = positive(value);
    if (n > max) max = n;
  }
  return max;
}

function firstPositive(...values) {
  for (const value of values) {
    const n = toFiniteNumber(value);
    if (n !== null && n > 0) return n;
  }
  return null;
}

function sumPositive(...values) {
  return roundCurrency(values.reduce((acc, value) => acc + positive(value), 0));
}

function feeFromNetOrRebate(netValue, grossValue, rebateOffset, fallbackValue) {
  const net = toFiniteNumber(netValue);
  if (net !== null && net >= 0) return roundCurrency(net);

  const gross = positive(grossValue);
  const offset = positive(rebateOffset);
  if (gross > 0 && offset > 0) {
    return roundCurrency(Math.max(0, gross - offset));
  }

  const fallback = toFiniteNumber(fallbackValue);
  if (fallback !== null && fallback >= 0) return roundCurrency(fallback);

  return gross;
}

function sumOrderQuantities(itemList) {
  return itemList.reduce((acc, item) => {
    const qty =
      toFiniteNumber(item?.model_quantity_purchased) ??
      toFiniteNumber(item?.quantity_purchased) ??
      toFiniteNumber(item?.quantity) ??
      0;
    return acc + qty;
  }, 0);
}

function sumItemsSubtotal(itemList, preferDiscounted) {
  return itemList.reduce((acc, item) => {
    const price = preferDiscounted
      ? firstPositive(
          item?.model_discounted_price,
          item?.discounted_price,
          item?.model_original_price,
          item?.original_price,
          item?.price
        )
      : firstPositive(
          item?.model_original_price,
          item?.original_price,
          item?.model_discounted_price,
          item?.discounted_price,
          item?.price
        );
    const qty =
      toFiniteNumber(item?.model_quantity_purchased) ??
      toFiniteNumber(item?.quantity_purchased) ??
      toFiniteNumber(item?.quantity) ??
      1;
    return acc + (price ?? 0) * qty;
  }, 0);
}

/**
 * Calcula os valores financeiros efetivos de um pedido Shopee.
 * @param {object} order - Pedido enriquecido (com escrow_details ou order_income).
 * @param {object} [fallback] - Valores de fallback quando o cálculo não resolve.
 */
function calculateShopeeFinancials(order, fallback) {
  const fb = fallback || {};
  const paymentDetails = rec(fb.paymentDetails);
  const escrowDetails =
    order?.escrow_details && typeof order.escrow_details === 'object'
      ? order.escrow_details
      : order?.order_income && typeof order.order_income === 'object'
        ? order
        : paymentDetails;
  const incomeDetails = rec(escrowDetails.order_income || order.order_income || paymentDetails.order_income || {});
  const productValueBreakdown = rec(paymentDetails.productValueBreakdown);
  const platformFeeBreakdown = rec(paymentDetails.platformFeeBreakdown);
  const sellerProductRebate = rec(incomeDetails.seller_product_rebate);
  const invoiceData = rec(order.invoice_data);
  const itemList = Array.isArray(order.item_list)
    ? order.item_list
    : Array.isArray(incomeDetails.items)
      ? incomeDetails.items
      : [];

  const quantity = sumOrderQuantities(itemList) || positive(fb.quantidade) || 1;
  const grossItemsSubtotal = sumItemsSubtotal(itemList, false);
  const discountedItemsSubtotal = sumItemsSubtotal(itemList, true);

  const explicitGrossProductSource = firstPositive(
    incomeDetails.original_cost_of_goods_sold,
    invoiceData.products_total_value,
    productValueBreakdown.product_gross_subtotal,
    grossItemsSubtotal
  );
  const grossProductSource = firstPositive(explicitGrossProductSource, incomeDetails.order_selling_price);
  const grossProductSubtotal = roundCurrency(
    firstPositive(
      grossProductSource,
      incomeDetails.cost_of_goods_sold,
      invoiceData.products_total_value,
      order.total_amount,
      fb.valorTotal
    ) ?? 0
  );

  const pixPaymentAdjustment = maxPositive(
    incomeDetails.pix_discount,
    incomeDetails.seller_transaction_fee,
    productValueBreakdown.pix_payment_adjustment
  );
  const sellerDiscount = maxPositive(incomeDetails.voucher_from_seller, productValueBreakdown.voucher_from_seller);
  const shopeeDiscount = maxPositive(
    incomeDetails.voucher_from_shopee,
    productValueBreakdown.shopee_discount,
    productValueBreakdown.voucher_from_shopee
  );
  const realCouponAdjustment = sumPositive(sellerDiscount, shopeeDiscount);
  const buyerCouponAdjustment =
    realCouponAdjustment > 0 ? realCouponAdjustment : positive(productValueBreakdown.buyer_coupon_adjustment);
  const voucherFromSeller =
    positive(incomeDetails.voucher_from_seller) || positive(productValueBreakdown.voucher_from_seller);
  const voucherFromShopee =
    positive(incomeDetails.voucher_from_shopee) || positive(productValueBreakdown.voucher_from_shopee);
  const coins = positive(incomeDetails.coins) || positive(productValueBreakdown.coins);
  const paymentPromotion = maxPositive(
    incomeDetails.payment_promotion,
    incomeDetails.credit_card_promotion,
    incomeDetails.buyer_payment_method_discount,
    incomeDetails.payment_channel_discount,
    productValueBreakdown.payment_promotion
  );

  let productDiscountTotal = roundCurrency(pixPaymentAdjustment + buyerCouponAdjustment);

  const directDiscountedSubtotal = firstPositive(
    invoiceData.total_value,
    incomeDetails.order_discounted_price,
    productValueBreakdown.product_effective_subtotal,
    discountedItemsSubtotal
  );
  const costOfGoodsSold = firstPositive(incomeDetails.cost_of_goods_sold, productValueBreakdown.product_effective_subtotal);

  let effectiveProductSubtotal = grossProductSubtotal;
  if (explicitGrossProductSource !== null && productDiscountTotal > 0 && grossProductSubtotal > productDiscountTotal) {
    effectiveProductSubtotal = grossProductSubtotal - productDiscountTotal;
  } else if (
    directDiscountedSubtotal !== null &&
    directDiscountedSubtotal > 0 &&
    directDiscountedSubtotal < grossProductSubtotal - 0.005
  ) {
    effectiveProductSubtotal = directDiscountedSubtotal;
  } else if (costOfGoodsSold !== null && costOfGoodsSold > 0 && costOfGoodsSold < grossProductSubtotal - 0.005) {
    effectiveProductSubtotal = costOfGoodsSold;
  } else if (fb.valorTotal && fb.valorTotal > 0) {
    effectiveProductSubtotal = fb.valorTotal;
  }
  effectiveProductSubtotal = roundCurrency(effectiveProductSubtotal);

  const commissionFee = feeFromNetOrRebate(
    incomeDetails.net_commission_fee,
    incomeDetails.commission_fee,
    sellerProductRebate.commission_fee_offset,
    platformFeeBreakdown.commission_fee
  );
  const serviceFee = feeFromNetOrRebate(
    incomeDetails.net_service_fee,
    incomeDetails.service_fee,
    sellerProductRebate.service_fee_offset,
    platformFeeBreakdown.service_fee
  );
  const shippingSellerProtectionFee =
    positive(incomeDetails.shipping_seller_protection_fee_amount) || positive(platformFeeBreakdown.outros_encargos);

  const actualShippingFee = positive(incomeDetails.actual_shipping_fee);
  const reverseShippingFee = positive(incomeDetails.reverse_shipping_fee);
  const shopeeShippingRebate = positive(incomeDetails.shopee_shipping_rebate);
  const buyerPaidShippingFee = positive(incomeDetails.buyer_paid_shipping_fee);
  const shippingFeeDiscountFrom3pl = positive(incomeDetails.shipping_fee_discount_from_3pl);
  const custoVendedorFrete = roundCurrency(
    actualShippingFee - buyerPaidShippingFee - shopeeShippingRebate - shippingFeeDiscountFrom3pl + reverseShippingFee
  );
  const freight = custoVendedorFrete > 0.005 ? -custoVendedorFrete : 0;

  const directNetRevenue = firstPositive(
    escrowDetails?.escrow_amount,
    incomeDetails.escrow_amount,
    paymentDetails?.escrow_amount,
    incomeDetails.actual_income,
    incomeDetails.estimated_income,
    incomeDetails.seller_income,
    incomeDetails.final_income,
    incomeDetails.net_income
  );
  const platformFeeRaw = roundCurrency(commissionFee + serviceFee + shippingSellerProtectionFee);
  const effectiveSubtotalFromNet =
    directNetRevenue !== null && platformFeeRaw > 0 ? roundCurrency(directNetRevenue + platformFeeRaw - freight) : null;

  if (
    effectiveSubtotalFromNet !== null &&
    effectiveSubtotalFromNet > 0 &&
    (grossProductSubtotal <= 0 || effectiveSubtotalFromNet <= grossProductSubtotal + 0.005)
  ) {
    effectiveProductSubtotal = effectiveSubtotalFromNet;
    productDiscountTotal = roundCurrency(Math.max(0, grossProductSubtotal - effectiveProductSubtotal));
  }

  const platformFeeFromNet =
    directNetRevenue !== null ? roundCurrency(directNetRevenue - effectiveProductSubtotal - freight) : null;
  const platformFee =
    platformFeeFromNet !== null && platformFeeFromNet < -0.005 ? platformFeeFromNet : platformFeeRaw > 0 ? -platformFeeRaw : null;

  const unitPrice = roundCurrency((grossProductSubtotal || effectiveProductSubtotal) / quantity);
  const netRevenue =
    directNetRevenue !== null
      ? roundCurrency(directNetRevenue)
      : roundCurrency(effectiveProductSubtotal + (platformFee ?? 0) + freight);

  return {
    quantity,
    grossProductSubtotal,
    effectiveProductSubtotal,
    unitPrice,
    platformFee,
    freight,
    netRevenue,
    paymentBreakdown: {
      product_gross_subtotal: grossProductSubtotal,
      product_effective_subtotal: effectiveProductSubtotal,
      product_discount_total: productDiscountTotal,
      pix_payment_adjustment: pixPaymentAdjustment,
      buyer_coupon_adjustment: buyerCouponAdjustment,
      seller_discount: sellerDiscount,
      shopee_discount: shopeeDiscount,
      voucher_from_seller: voucherFromSeller,
      voucher_from_shopee: voucherFromShopee,
      coins,
      payment_promotion: roundCurrency(paymentPromotion),
      commission_fee: commissionFee,
      service_fee: serviceFee,
      outros_encargos: shippingSellerProtectionFee,
      ignored_as_platform_fee: {
        seller_transaction_fee: pixPaymentAdjustment,
        drc_adjustable_refund: buyerCouponAdjustment,
      },
    },
    shipmentBreakdown: {
      actual_shipping_fee: actualShippingFee,
      reverse_shipping_fee: reverseShippingFee,
      shopee_shipping_rebate: shopeeShippingRebate,
      buyer_paid_shipping_fee: buyerPaidShippingFee,
      shipping_fee_discount_from_3pl: shippingFeeDiscountFrom3pl,
      custo_vendedor_frete: custoVendedorFrete,
    },
  };
}

module.exports = { calculateShopeeFinancials, SHOPEE_FINANCIAL_RULE_VERSION };
