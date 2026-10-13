// utils/billingDescription.js
//
// Descrição da cobrança enviada ao Asaas, montada a partir dos itens da fatura.
//
// Antes o texto era fixo ("CyberDock - Fatura 2026-08 - CLIENTE"): o cliente
// recebia um valor sem saber do que ele era composto. Agora cada serviço vira
// uma linha com descrição, quantidade e valor, e a soma das linhas é conferida
// contra o total cobrado — em centavos, para arredondamento não esconder
// diferença.
//
// O Asaas aceita no máximo 500 caracteres na descrição. Quando a lista não
// cabe, a montagem perde detalhe em etapas, sempre nesta ordem: preço unitário,
// descrições longas e, por último, os itens finais juntam-se numa linha
// "Outros N serviços". O total nunca sai, e a soma das linhas continua igual a
// ele em qualquer etapa.
//
// Função pura: não consulta banco nem provedor, para a mesma montagem servir à
// emissão, à prévia e aos testes.

const { moneyCents } = require('./billingSafety');
const { unitLabel } = require('./billingRules');

const LIMITE_DESCRICAO_ASAAS = 500;

/* Ordem de leitura da fatura: armazenamento, expedição, avulsos e, por último,
 * qualquer tipo novo que apareça no banco. É a ordem da tela de cobrança. */
const ORDEM_DOS_TIPOS = { storage: 0, shipment: 1, manual: 2 };
const ORDEM_DESCONHECIDA = 3;

/* Etapas de compactação, da mais detalhada para a mais curta. */
const ETAPAS = [
  { unitario: true, maxDescricao: null },
  { unitario: false, maxDescricao: null },
  { unitario: false, maxDescricao: 40 },
  { unitario: false, maxDescricao: 24 },
];

/** 1234 -> "1.234". */
function agruparMilhar(inteiro) {
  return String(inteiro).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/**
 * Centavos -> "R$ 1.234,56".
 *
 * Sem Intl de propósito: o `toLocaleString` separa "R$" do número com espaço
 * não separável (U+00A0), que o boleto e alguns leitores mostram como lixo.
 */
function formatarReais(centavos) {
  const absoluto = Math.abs(centavos);
  const reais = agruparMilhar(Math.floor(absoluto / 100));
  const resto = String(absoluto % 100).padStart(2, '0');
  return `${centavos < 0 ? '-' : ''}R$ ${reais},${resto}`;
}

/** "2026-08" -> "08/2026". */
function rotuloCompetencia(period) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(period || ''));
  return match ? `${match[2]}/${match[1]}` : String(period || '');
}

function encurtar(texto, limite) {
  if (!limite || texto.length <= limite) return texto;
  return `${texto.slice(0, limite - 3).trimEnd()}...`;
}

/**
 * Converte as linhas do banco e soma em centavos.
 *
 * `valido` cai para false se algum total não for dinheiro exato (por exemplo
 * "10.005"): nesse caso não há como afirmar que os itens fecham com o total.
 */
function normalizarItens(items) {
  const lista = [];
  let somaCentavos = 0;
  let valido = true;

  (Array.isArray(items) ? items : []).forEach((item, indice) => {
    const totalCentavos = moneyCents(item?.total_price);
    if (totalCentavos === null) {
      valido = false;
      return;
    }
    somaCentavos += totalCentavos;

    const quantidade = Number.parseInt(item?.quantity, 10);
    lista.push({
      indice,
      ordem: ORDEM_DOS_TIPOS[item?.type] ?? ORDEM_DESCONHECIDA,
      descricao: String(item?.description ?? '').replace(/\s+/g, ' ').trim() || 'Serviço',
      quantidade: Number.isFinite(quantidade) ? quantidade : 1,
      unidade: item?.unit || null,
      unitarioCentavos: moneyCents(item?.unit_price),
      totalCentavos,
    });
  });

  lista.sort((a, b) => (a.ordem - b.ordem) || (a.indice - b.indice));
  return { lista, somaCentavos, valido };
}

/** "- Pacote P: 120 vendas x R$ 2,50 = R$ 300,00" */
function linhaDoItem(item, etapa) {
  // Item sem unidade gravada (lançamento antigo) conta como "unidade".
  const unidade = unitLabel(item.unidade || 'unidade', item.quantidade);
  const quantidade = `${agruparMilhar(item.quantidade)} ${unidade}`.trim();
  const unitario = etapa.unitario && item.quantidade > 1 && item.unitarioCentavos !== null
    ? ` x ${formatarReais(item.unitarioCentavos)}`
    : '';
  return `- ${encurtar(item.descricao, etapa.maxDescricao)}: ${quantidade}${unitario} = `
    + formatarReais(item.totalCentavos);
}

/**
 * Monta a descrição da cobrança de uma fatura.
 *
 * @param {object} params
 * @param {Array}  params.items  linhas de invoice_items (description, quantity,
 *                               unit, unit_price, total_price, type)
 * @param {string|number} params.total  total_amount da fatura
 * @param {string} params.period competência AAAA-MM
 * @returns {{
 *   description: string, length: number, matches: boolean,
 *   total: number|null, itemsTotal: number|null,
 *   totalCents: number|null, itemsCents: number|null,
 *   itemCount: number, groupedItems: number, compacted: boolean
 * }}
 *   `matches` diz se a soma dos itens é exatamente o total. Quem emite deve
 *   recusar quando for false: a descrição detalharia um valor diferente do
 *   cobrado.
 */
function montarDescricaoCobranca({ items, total, period }) {
  const totalCentavos = moneyCents(total);
  const { lista, somaCentavos, valido } = normalizarItens(items);
  const confere = valido && totalCentavos !== null && somaCentavos === totalCentavos;

  /* Item zerado não compõe o valor cobrado; listá-lo só gastaria espaço. */
  const itens = lista.filter((item) => item.totalCentavos !== 0);

  const cabecalho = `CyberDock - Fatura ${rotuloCompetencia(period)}`;
  const rodape = `Total: ${totalCentavos === null ? '-' : formatarReais(totalCentavos)}`;
  const montar = (linhas) => [cabecalho, ...linhas, rodape].join('\n');
  const completa = montar(itens.map((item) => linhaDoItem(item, ETAPAS[0])));

  const resultado = (description, groupedItems = 0) => ({
    description,
    length: description.length,
    matches: confere,
    total: totalCentavos === null ? null : totalCentavos / 100,
    itemsTotal: valido ? somaCentavos / 100 : null,
    totalCents: totalCentavos,
    itemsCents: valido ? somaCentavos : null,
    itemCount: itens.length,
    groupedItems,
    compacted: description !== completa,
  });

  for (const etapa of ETAPAS) {
    const texto = montar(itens.map((item) => linhaDoItem(item, etapa)));
    if (texto.length <= LIMITE_DESCRICAO_ASAAS) return resultado(texto);
  }

  /* Último recurso: os itens finais viram uma linha só, com a soma deles. A
   * cauda tem pelo menos dois itens — trocar uma linha por "Outros 1" não
   * economiza nada. */
  const etapaFinal = ETAPAS[ETAPAS.length - 1];
  for (let mantidos = itens.length - 2; mantidos >= 0; mantidos -= 1) {
    const agrupados = itens.slice(mantidos);
    const somaAgrupados = agrupados.reduce((soma, item) => soma + item.totalCentavos, 0);
    const texto = montar([
      ...itens.slice(0, mantidos).map((item) => linhaDoItem(item, etapaFinal)),
      `- Outros ${agrupados.length} serviços (detalhes no painel CyberDock): ${formatarReais(somaAgrupados)}`,
    ]);
    if (texto.length <= LIMITE_DESCRICAO_ASAAS) return resultado(texto, agrupados.length);
  }

  // Inalcançável com cabeçalho e rodapé deste tamanho; fica como garantia.
  return resultado(montar([]), itens.length);
}

module.exports = {
  LIMITE_DESCRICAO_ASAAS,
  formatarReais,
  montarDescricaoCobranca,
};
