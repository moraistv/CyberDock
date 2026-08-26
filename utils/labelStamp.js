/**
 * Estampa texto de conferência (SKU, quantidade) sobre uma etiqueta em PDF.
 *
 * Quem separa o pedido lê a etiqueta, não a tela. Sem o SKU impresso é preciso
 * conferir pedido por pedido no sistema antes de embalar.
 *
 * O fluxo do Mercado Livre (router/mercadolivre.js) faz isso desde antes, com
 * uma implementação própria que também remove a página de declaração de conteúdo
 * e trata ZPL. Este módulo é a parte genérica, para a Shopee usar sem que eu
 * precise mexer naquele caminho, que está em produção e funciona.
 */
const zlib = require('zlib');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

/**
 * Content stream da página como texto latin1.
 *
 * Tenta inflar (Flate) e cai para o conteúdo cru quando não está comprimido.
 * Erro aqui nunca é fatal: sem o conteúdo, apenas não há como achar a caixa da
 * etiqueta e o desenho usa a página inteira.
 */
function decodePdfPageContent(page) {
  try {
    const decodeOne = (stream) => {
      const raw = stream && stream.contents;
      if (!raw) return '';
      try { return zlib.inflateSync(Buffer.from(raw)).toString('latin1'); }
      catch { return Buffer.from(raw).toString('latin1'); }
    };
    const contents = page.node.Contents();
    if (!contents) return '';
    if (contents.constructor && contents.constructor.name === 'PDFArray') {
      let out = '';
      for (let i = 0; i < contents.size(); i += 1) out += `${decodeOne(contents.lookup(i))}\n`;
      return out;
    }
    return decodeOne(contents);
  } catch {
    return '';
  }
}

/**
 * Caixa que envolve os retângulos (`re`) desenhados na página.
 *
 * A etiqueta é desenhada com bordas, então esses retângulos delimitam bem onde
 * ela está — o que importa quando o PDF é A4 com a etiqueta só num pedaço:
 * escrever no rodapé da PÁGINA colocaria o texto fora do recorte da impressão.
 */
function getLabelBoxFromContent(content) {
  if (!content) return null;
  const re = /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+re\b/g;
  let match;
  let minX = Infinity; let minY = Infinity;
  let maxX = -Infinity; let maxY = -Infinity;
  let count = 0;

  while ((match = re.exec(content))) {
    const x = parseFloat(match[1]);
    const y = parseFloat(match[2]);
    const w = parseFloat(match[3]);
    const h = parseFloat(match[4]);
    if ([x, y, w, h].some((n) => Number.isNaN(n))) continue;
    minX = Math.min(minX, x, x + w);
    minY = Math.min(minY, y, y + h);
    maxX = Math.max(maxX, x, x + w);
    maxY = Math.max(maxY, y, y + h);
    count += 1;
  }

  if (!count || !Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

/**
 * Escreve as linhas num bloco de destaque em cada página do PDF.
 *
 * O bloco tem fundo branco opaco e borda: a etiqueta da Shopee tem faixas
 * pretas e áreas de código de barras, e texto preto direto sobre elas ficaria
 * ilegível — que é justamente o oposto do pedido.
 *
 * Ancoragem, em ordem de preferência:
 *   1. base da caixa da etiqueta, logo acima da borda inferior;
 *   2. base da página, quando não há caixa reconhecível.
 *
 * NÃO desenha sobre o QR code de propósito. Cobrir os módulos do QR ou as
 * barras do código de rastreio pode impedir a leitura pelo coletor da
 * transportadora, e uma etiqueta que não é lida no centro de distribuição custa
 * mais caro que um SKU pouco visível.
 *
 * Falha aqui devolve o PDF ORIGINAL: a etiqueta é o que o cliente precisa
 * imprimir, e perdê-la por causa do texto de apoio seria péssimo negócio.
 *
 * @param {Buffer} pdfBuffer PDF vindo do marketplace.
 * @param {string[]} lines Linhas a imprimir, da primeira (topo) à última.
 * @param {{ maxFontSize?: number, minFontSize?: number }} [options]
 * @returns {Promise<Buffer>}
 */
async function stampLabelLines(pdfBuffer, lines, options = {}) {
  const texto = (lines || []).map((l) => String(l || '').trim()).filter(Boolean);
  if (texto.length === 0) return pdfBuffer;

  const maxFontSize = options.maxFontSize || 11;
  const minFontSize = options.minFontSize || 5.5;

  try {
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const pages = pdfDoc.getPages();
    if (pages.length === 0) return pdfBuffer;

    const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    for (const page of pages) {
      const { width, height } = page.getSize();
      const box = getLabelBoxFromContent(decodePdfPageContent(page));

      // Caixa só serve se for plausível: grande o bastante para caber texto e
      // dentro dos limites da página. Retângulo decorativo minúsculo, ou maior
      // que a página, indica que a heurística não achou a etiqueta.
      const caixaUtil = box
        && (box.maxX - box.minX) > 80
        && (box.maxY - box.minY) > 80
        && (box.maxX - box.minX) <= width
        && (box.maxY - box.minY) <= height;

      const areaX = caixaUtil ? box.minX : 0;
      const areaLargura = caixaUtil ? (box.maxX - box.minX) : width;
      const areaBase = caixaUtil ? box.minY : 0;

      const padding = 4;
      const larguraDisponivel = Math.max(20, areaLargura - padding * 4);

      // Maior corpo em que a linha mais larga ainda cabe.
      let fontSize = maxFontSize;
      const maiorLinha = () => texto.reduce(
        (maior, linha) => Math.max(maior, font.widthOfTextAtSize(linha, fontSize)),
        0
      );
      while (fontSize > minFontSize && maiorLinha() > larguraDisponivel) fontSize -= 0.5;

      const alturaLinha = fontSize + 3;
      const alturaBloco = alturaLinha * texto.length + padding * 2;
      const larguraBloco = Math.min(
        areaLargura - padding * 2,
        maiorLinha() + padding * 4
      );
      const blocoX = areaX + Math.max(padding, (areaLargura - larguraBloco) / 2);
      const blocoY = areaBase + padding;

      page.drawRectangle({
        x: blocoX,
        y: blocoY,
        width: larguraBloco,
        height: alturaBloco,
        color: rgb(1, 1, 1),
        borderColor: rgb(0, 0, 0),
        borderWidth: 0.7,
      });

      // Primeira linha no topo do bloco, última embaixo.
      texto.forEach((linha, indice) => {
        const larguraTexto = font.widthOfTextAtSize(linha, fontSize);
        const x = blocoX + Math.max(padding, (larguraBloco - larguraTexto) / 2);
        const y = blocoY + padding + (texto.length - 1 - indice) * alturaLinha + 1;
        page.drawText(linha, { x, y, size: fontSize, font, color: rgb(0, 0, 0) });
      });
    }

    return Buffer.from(await pdfDoc.save());
  } catch (error) {
    console.error('[labelStamp] Não foi possível estampar a etiqueta:', error.message);
    return pdfBuffer;
  }
}

/**
 * Linhas de conferência a partir dos itens da venda.
 *
 * Um pedido pode ter vários SKUs no mesmo pacote, então sai uma linha por item.
 * Item sem SKU é ignorado: imprimir "SKU: N/A" ocupa espaço e não ajuda quem
 * está separando.
 */
function buildItemLines(items) {
  return (items || [])
    .filter((item) => item && item.sku && String(item.sku).trim())
    .map((item) => {
      const qtd = Number(item.quantity) > 0 ? Number(item.quantity) : 1;
      return `Qtd: ${qtd}  |  SKU: ${String(item.sku).trim()}`;
    });
}

module.exports = {
  decodePdfPageContent,
  getLabelBoxFromContent,
  stampLabelLines,
  buildItemLines,
};
