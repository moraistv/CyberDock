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
 * Caixa que envolve TODOS os retângulos (`re`) desenhados na página.
 *
 * Serve apenas como último recurso. Não confunda com "a caixa da etiqueta": se
 * houver um único `re` perdido no rodapé da folha, o contorno vira a página
 * inteira. Foi exatamente o que aconteceu na primeira versão deste módulo — num
 * A4 com a etiqueta no topo, o SKU foi impresso no pé da folha, longe da
 * etiqueta. A âncora boa é o QR code (ver findQrCodeBox).
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

/** Retângulo quase quadrado? O QR é, uma faixa ou uma logo esticada não. */
function ehQuadrado(largura, altura, tolerancia = 0.2) {
  if (largura <= 0 || altura <= 0) return false;
  const razao = largura / altura;
  return razao > (1 - tolerancia) && razao < (1 + tolerancia);
}

/** Concatenação de matrizes do PDF: resultado de aplicar `m` antes de `ctm`. */
function multiplicaMatriz(m, ctm) {
  const [a1, b1, c1, d1, e1, f1] = m;
  const [a2, b2, c2, d2, e2, f2] = ctm;
  return [
    a1 * a2 + b1 * c2,
    a1 * b2 + b1 * d2,
    c1 * a2 + d1 * c2,
    c1 * b2 + d1 * d2,
    e1 * a2 + f1 * c2 + e2,
    e1 * b2 + f1 * d2 + f2,
  ];
}

/**
 * Imagens desenhadas na página, com posição e tamanho em pontos.
 *
 * Uma imagem no PDF é sempre desenhada como o quadrado unitário (0,0)-(1,1)
 * transformado pela matriz corrente. E a matriz corrente é a CONCATENAÇÃO de
 * todos os `cm` ativos, não o último deles. O pdf-lib, por exemplo, escreve:
 *
 *   q
 *   1 0 0 1 60 520 cm     <- move para a posição
 *   150 0 0 150 0 0 cm    <- escala para 150x150
 *   1 0 0 1 0 0 cm
 *   /Image-1 Do
 *   Q
 *
 * Ler apenas o último `cm` dá a identidade: uma imagem de 1x1 na origem. Foi
 * esse o erro da primeira tentativa de ancorar no QR — nenhuma imagem passava
 * pelo filtro de tamanho, a busca do QR falhava e o texto caía no fallback, no
 * pé da folha.
 *
 * Então a pilha de estado gráfico é reproduzida de verdade: `q` empilha, `Q`
 * desempilha e `cm` concatena. Imagem rotacionada ou distorcida (b ou c não
 * nulos) é descartada em vez de virar uma posição errada.
 */
function getDrawnImageBoxes(content) {
  if (!content) return [];

  const IDENTIDADE = [1, 0, 0, 1, 0, 0];
  const token = /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+cm|\/([A-Za-z0-9_.#-]+)\s+Do\b|(\bq\b)|(\bQ\b)/g;

  const boxes = [];
  const pilha = [];
  let ctm = IDENTIDADE;
  let match;

  while ((match = token.exec(content))) {
    if (match[8]) { pilha.push(ctm); continue; }
    if (match[9]) { ctm = pilha.pop() || IDENTIDADE; continue; }

    if (match[7] !== undefined) {
      const [a, b, c, d, e, f] = ctm;
      if (b !== 0 || c !== 0) continue;
      const largura = Math.abs(a);
      const altura = Math.abs(d);
      if (largura < 1 || altura < 1) continue;
      boxes.push({
        minX: Math.min(e, e + a),
        minY: Math.min(f, f + d),
        maxX: Math.max(e, e + a),
        maxY: Math.max(f, f + d),
        largura,
        altura,
      });
      continue;
    }

    const m = [1, 2, 3, 4, 5, 6].map((i) => parseFloat(match[i]));
    if (m.some((n) => Number.isNaN(n))) continue;
    ctm = multiplicaMatriz(m, ctm);
  }

  return boxes;
}

/**
 * Aglomerado de módulos de um QR desenhado com vetores.
 *
 * Alguns geradores não usam imagem: desenham cada módulo como um retângulo
 * pequeno e quadrado. Nesse caso o QR é o contorno desses retângulos.
 * Exijo uma quantidade mínima para não confundir com casinhas de checkbox ou
 * bordas decorativas.
 */
function getVectorQrBox(content, minimoModulos = 40) {
  if (!content) return null;
  const re = /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+re\b/g;
  let match;
  let minX = Infinity; let minY = Infinity;
  let maxX = -Infinity; let maxY = -Infinity;
  let modulos = 0;

  while ((match = re.exec(content))) {
    const x = parseFloat(match[1]);
    const y = parseFloat(match[2]);
    const w = Math.abs(parseFloat(match[3]));
    const h = Math.abs(parseFloat(match[4]));
    if ([x, y, w, h].some((n) => Number.isNaN(n))) continue;
    // Módulo de QR é pequeno e quadrado. Barra de código de barras é fina e
    // alta, então não entra aqui.
    if (w > 14 || h > 14 || !ehQuadrado(w, h, 0.12)) continue;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
    modulos += 1;
  }

  if (modulos < minimoModulos || !Number.isFinite(minX)) return null;
  const largura = maxX - minX;
  const altura = maxY - minY;
  if (!ehQuadrado(largura, altura, 0.25)) return null;
  return { minX, minY, maxX, maxY, largura, altura };
}

/**
 * Onde está o QR code da etiqueta.
 *
 * Entre as imagens quase quadradas, vale a de MAIOR área. É o que separa o QR
 * da logo da transportadora, que também é quase quadrada mas bem menor (na
 * etiqueta da Shopee, o QR tem umas cinco vezes a área da logo "Entrega
 * Rápida"). Se não houver imagem, tenta o QR vetorial.
 */
function findQrCodeBox(content, pageSize = {}) {
  const { width = Infinity, height = Infinity } = pageSize;

  const candidatas = getDrawnImageBoxes(content).filter((box) => (
    ehQuadrado(box.largura, box.altura)
    // Grande o bastante para ser QR, e não um ícone.
    && box.largura >= 40
    && box.largura <= width
    && box.altura <= height
  ));

  if (candidatas.length > 0) {
    return candidatas.reduce(
      (maior, atual) => ((atual.largura * atual.altura) > (maior.largura * maior.altura) ? atual : maior)
    );
  }

  return getVectorQrBox(content);
}

/**
 * Escreve as linhas num bloco de destaque em cada página do PDF.
 *
 * O bloco tem fundo branco opaco e borda: a etiqueta da Shopee tem faixas
 * pretas e áreas de código de barras, e texto preto direto sobre elas ficaria
 * ilegível — que é justamente o oposto do pedido.
 *
 * Ancoragem, em ordem de preferência:
 *   1. IMEDIATAMENTE ACIMA DO QR CODE, centralizado nele. É onde quem separa o
 *      pedido está olhando, e é a região que o PDF deixa livre entre a linha da
 *      data de entrega e o QR.
 *   2. contorno dos retângulos da página, como último recurso.
 *
 * A primeira versão usava direto a opção 2 e o resultado foi ruim: num A4 com a
 * etiqueta no topo, o contorno de todos os retângulos virou a folha inteira e o
 * SKU foi impresso no pé da página, longe da etiqueta.
 *
 * NÃO desenha SOBRE o QR nem sobre o código de barras, de propósito. Cobrir os
 * módulos do QR pode impedir a leitura pelo coletor da transportadora, e uma
 * etiqueta que não é lida no centro de distribuição custa mais caro que um SKU
 * pouco visível. Fica encostado no topo do QR.
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

  const maxFontSize = options.maxFontSize || 12;
  const minFontSize = options.minFontSize || 5.5;

  try {
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const pages = pdfDoc.getPages();
    if (pages.length === 0) return pdfBuffer;

    const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    for (const page of pages) {
      const { width, height } = page.getSize();
      const content = decodePdfPageContent(page);
      const qr = findQrCodeBox(content, { width, height });

      const padding = 4;
      let areaX;
      let areaLargura;
      let alvoBase;

      if (qr) {
        /* Centralizado no QR, mas com folga para os lados: "Qtd: 1 | SKU: ..."
         * costuma ser mais largo que o próprio QR. O bloco pode extrapolar a
         * largura do QR desde que fique na página. */
        areaLargura = Math.min(width - padding * 2, Math.max(qr.largura, width * 0.6));
        areaX = Math.max(
          padding,
          Math.min(
            width - padding - areaLargura,
            qr.minX + (qr.largura - areaLargura) / 2
          )
        );
        alvoBase = qr.maxY + 2;
      } else {
        const box = getLabelBoxFromContent(content);
        const caixaUtil = box
          && (box.maxX - box.minX) > 80
          && (box.maxY - box.minY) > 80
          && (box.maxX - box.minX) <= width
          && (box.maxY - box.minY) <= height;
        console.warn('[labelStamp] QR code não localizado; usando o rodapé da área desenhada.');
        areaX = caixaUtil ? box.minX : 0;
        areaLargura = caixaUtil ? (box.maxX - box.minX) : width;
        alvoBase = (caixaUtil ? box.minY : 0) + padding;
      }

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
      const larguraBloco = Math.min(areaLargura, maiorLinha() + padding * 4);
      const blocoX = areaX + Math.max(0, (areaLargura - larguraBloco) / 2);
      // Não deixa o bloco sair pelo topo da página quando o QR está muito alto.
      const blocoY = Math.max(padding, Math.min(alvoBase, height - alturaBloco - padding));

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
        const x = blocoX + Math.max(0, (larguraBloco - larguraTexto) / 2);
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
  getDrawnImageBoxes,
  getVectorQrBox,
  findQrCodeBox,
  stampLabelLines,
  buildItemLines,
};
