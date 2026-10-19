// utils/mlReturns.js
//
// Devoluções do Mercado Livre: leitura da API do ML, situação da devolução no
// CD, análise (apto / não apto) e volta ao estoque.
//
// Tudo aqui recebe por parâmetro a conexão com o banco (`client` ou `db`, com
// `.query`) e o acesso ao ML (`ml`, com `.get`). A rota decide de onde vêm; os
// testes usam um banco temporário e um ML de mentira.
//
// Regras que não podem quebrar:
//  - o ML informa; quem decide é o CD. Depois que o pacote chegou (no_cd) ou
//    foi analisado, nenhuma atualização do ML volta a situação para trás;
//  - só unidades aptas voltam ao estoque, sempre para o SKU do cliente dono da
//    venda, e só se a venda tirou estoque no CyberDock;
//  - kit não tem estoque próprio: a entrada vai para os componentes;
//  - a entrada é idempotente (restocked_at + chave única no movimento);
//  - o cliente só vê as devoluções dele (uid), sem nomes da equipe e sem a
//    observação interna da análise (`devolucaoParaCliente`).

const { buildSaleLineKey, isDuplicateSaleMovement } = require('./saleProcessing');

const ML_API = 'https://api.mercadolibre.com';

const STAGES = Object.freeze({
  AGUARDANDO_ENVIO: 'aguardando_envio',
  EM_TRANSITO: 'em_transito',
  NO_CD: 'no_cd',
  ANALISADO: 'analisado',
  CANCELADA: 'cancelada',
  NO_ML: 'no_ml',
  SEM_DEVOLUCAO: 'sem_devolucao',
});
const STAGE_VALUES = new Set(Object.values(STAGES));

/* Situações que não vêm para o CD: ficam fora da fila e dos números por padrão. */
const STAGES_FORA_DO_CD = [STAGES.NO_ML, STAGES.SEM_DEVOLUCAO];

const RESULTS = Object.freeze({ APTO: 'apto', NAO_APTO: 'nao_apto', PARCIAL: 'parcial' });

const MOTIVOS_NAO_APTO = Object.freeze({
  danificado: 'Chegou danificado',
  incompleto: 'Veio incompleto',
  diferente: 'Produto diferente do enviado',
  vazio: 'Pacote sem o produto',
  usado: 'Com sinais de uso',
  outro: 'Outro problema',
});

const DESTINOS_NAO_APTO = Object.freeze({
  avaria: 'Guardado como avaria',
  devolver_cliente: 'Devolver ao cliente',
  descarte: 'Descarte',
});

const CHECKLIST = Object.freeze({
  mesmo_produto: 'É o mesmo produto e a mesma variação',
  quantidade_confere: 'A quantidade confere',
  sem_avarias: 'Sem quebra, risco ou amassado',
  sem_uso: 'Sem sinais de uso',
  completo: 'Peças e acessórios completos',
  embalagem_ok: 'Embalagem em condição de venda',
});

const MAX_FOTOS = 10;
const MAX_FOTO_BYTES = 3 * 1024 * 1024;
const MAX_OBSERVACAO = 2000;

/* Status da devolução no ML, agrupados pelo que significam para o CD. */
const ML_AGUARDANDO = new Set(['pending', 'label_generated', 'scheduled', 'opened']);
const ML_EM_TRANSITO = new Set(['shipped', 'pending_delivered']);
const ML_ENCERRADA_SEM_PACOTE = new Set([
  'cancelled', 'pending_cancel', 'expired', 'pending_expiration',
  'failed', 'pending_failure', 'not_delivered', 'return_to_buyer',
]);

/** Erro com status HTTP e código, para a rota responder do jeito certo. */
function erroHttp(status, code, message, extra = {}) {
  const erro = new Error(message);
  erro.status = status;
  erro.code = code;
  Object.assign(erro, extra);
  return erro;
}

/* ------------------------------------------------------------------------- */
/* Leitura do payload do ML                                                   */
/* ------------------------------------------------------------------------- */

/** Id numérico do ML como texto (BIGINT não cabe com segurança em Number). */
function idTexto(valor) {
  if (valor === null || valor === undefined) return null;
  const texto = String(valor).trim();
  return /^\d{1,20}$/.test(texto) ? texto : null;
}

function dataOuNull(valor) {
  if (!valor) return null;
  const data = new Date(valor);
  return Number.isNaN(data.getTime()) ? null : data;
}

/** "1.0" -> 1. Quantidade inválida vira 1 (o ML só abre devolução de algo). */
function quantidade(valor, padrao = 1) {
  const numero = Math.round(Number(valor));
  return Number.isFinite(numero) && numero > 0 ? numero : padrao;
}

/**
 * Remessas da devolução. O formato v2 traz `shipments[]`; o antigo trazia um
 * único `shipping`. As duas formas viram a mesma lista.
 */
function remessas(ret) {
  if (Array.isArray(ret?.shipments)) {
    return ret.shipments.map((s) => ({
      id: idTexto(s?.shipment_id ?? s?.id),
      status: String(s?.status || '').toLowerCase(),
      tracking: s?.tracking_number || null,
      destino: s?.destination?.name || null,
      tipo: s?.type || null,
    }));
  }
  if (ret?.shipping) {
    const s = ret.shipping;
    return [{
      id: idTexto(s.id ?? s.shipment_id),
      status: String(s.status || '').toLowerCase(),
      tracking: s.tracking_number || null,
      destino: s.destination?.name || null,
      tipo: 'return',
    }];
  }
  return [];
}

/**
 * Remessa que interessa ao CD: a última que vem para o vendedor (devolução
 * direta ou volta da triagem do ML). Sem nenhuma, a que vai para o depósito do
 * ML, porque então o pacote não vem para o CD.
 */
function remessaDoCd(ret) {
  const lista = remessas(ret);
  const paraVendedor = lista.filter((s) => s.destino === 'seller_address');
  if (paraVendedor.length) return { remessa: paraVendedor[paraVendedor.length - 1], destino: 'seller_address' };
  const paraDeposito = lista.find((s) => s.destino === 'warehouse');
  if (paraDeposito) return { remessa: paraDeposito, destino: 'warehouse' };
  return { remessa: lista[lista.length - 1] || null, destino: null };
}

/** Situação no CyberDock a partir do que o ML informa. */
function situacaoPeloMl(ret) {
  const status = String(ret?.status || '').toLowerCase();
  const subtipo = String(ret?.subtype || '').toLowerCase();
  const { remessa, destino } = remessaDoCd(ret);
  const envio = remessa?.status || '';

  // Reembolso sem pedir o produto de volta: não existe pacote.
  if (subtipo === 'low_cost' || String(ret?.refund_at || '').toLowerCase() === 'n/a') return STAGES.SEM_DEVOLUCAO;

  if (destino === 'warehouse') {
    return ML_ENCERRADA_SEM_PACOTE.has(status) ? STAGES.CANCELADA : STAGES.NO_ML;
  }

  if (envio === 'delivered' || status === 'delivered') return STAGES.NO_CD;
  if (status === 'closed') {
    // Encerrada: vale o que aconteceu com o pacote.
    if (envio === 'shipped') return STAGES.EM_TRANSITO;
    return STAGES.CANCELADA;
  }
  if (ML_ENCERRADA_SEM_PACOTE.has(status)) return STAGES.CANCELADA;
  if (envio === 'shipped' || ML_EM_TRANSITO.has(status)) return STAGES.EM_TRANSITO;
  if (ML_AGUARDANDO.has(status) || !status) return STAGES.AGUARDANDO_ENVIO;
  return STAGES.AGUARDANDO_ENVIO;
}

/** O ML nunca desfaz o que o CD registrou. */
function proximaSituacao(atual, peloMl) {
  if (atual === STAGES.ANALISADO || atual === STAGES.NO_CD) return atual;
  return peloMl;
}

/** Prazo que o ML dá ao vendedor para revisar o produto devolvido. */
function prazoDeRevisao(claim) {
  const vendedor = (claim?.players || []).find((p) => p?.type === 'seller' || p?.role === 'respondent');
  const datas = (vendedor?.available_actions || [])
    .filter((a) => /return_review/.test(String(a?.action || '')))
    .map((a) => dataOuNull(a?.due_date))
    .filter(Boolean)
    .sort((a, b) => a - b);
  return datas[0] || null;
}

/** Pedidos e itens devolvidos. Sem `orders`, usa o pedido da reclamação. */
function pedidosDaDevolucao(ret, claim) {
  if (Array.isArray(ret?.orders) && ret.orders.length) {
    return ret.orders
      .map((o) => ({
        orderId: idTexto(o?.order_id),
        itemId: o?.item_id ? String(o.item_id) : '',
        variationId: o?.variation_id ? String(o.variation_id) : '',
        quantidade: quantidade(o?.return_quantity ?? o?.total_quantity),
        quantidadeVendida: o?.total_quantity ? quantidade(o.total_quantity) : null,
        contexto: o?.context_type || null,
      }))
      .filter((o) => o.orderId);
  }
  const recurso = String(ret?.resource_type || ret?.resource || claim?.resource || '').toLowerCase();
  const pedido = recurso === 'order' ? idTexto(ret?.resource_id ?? claim?.resource_id) : null;
  return pedido ? [{ orderId: pedido, itemId: '', variationId: '', quantidade: null, quantidadeVendida: null, contexto: null }] : [];
}

/** Campos da devolução vindos do ML, prontos para gravar. */
function camposDoMl(ret, claim) {
  const { remessa, destino } = remessaDoCd(ret);
  const pedidos = pedidosDaDevolucao(ret, claim);
  return {
    claim_id: idTexto(ret?.claim_id ?? claim?.id),
    order_id: pedidos[0]?.orderId || null,
    ml_status: ret?.status ? String(ret.status).toLowerCase() : null,
    ml_subtype: ret?.subtype || null,
    ml_status_money: ret?.status_money || null,
    refund_at: ret?.refund_at || null,
    destination: destino,
    shipment_id: remessa?.id || null,
    shipment_status: remessa?.status || null,
    tracking_number: remessa?.tracking || null,
    claim_status: claim?.status || null,
    claim_stage: claim?.stage || null,
    claim_reason_id: claim?.reason_id || null,
    review_due_at: prazoDeRevisao(claim),
    ml_created_at: dataOuNull(ret?.date_created),
    ml_closed_at: dataOuNull(ret?.date_closed),
    ml_last_updated: dataOuNull(ret?.last_updated),
  };
}

/* ------------------------------------------------------------------------- */
/* Vínculo com as vendas do CyberDock                                         */
/* ------------------------------------------------------------------------- */

const linkDoAnuncio = (itemId) => {
  const m = /^MLB(\d+)$/i.exec(String(itemId || ''));
  return m ? `https://produto.mercadolivre.com.br/MLB-${m[1]}` : null;
};

const mesmoSku = (a, b) => String(a || '').trim().toUpperCase() === String(b || '').trim().toUpperCase();

/**
 * Linha de venda (pedido + SKU) do item devolvido. O ML identifica o anúncio
 * (item_id) e a variação; o SKU vem de order_items da própria venda.
 */
function vendaDoItem(vendas, pedido) {
  const doPedido = vendas.filter((v) => String(v.id) === pedido.orderId);
  if (!doPedido.length) return { venda: null, itemDoPedido: null };

  for (const venda of doPedido) {
    const itens = Array.isArray(venda.order_items) ? venda.order_items : [];
    const achado = itens.find((oi) => {
      const item = oi?.item || {};
      if (pedido.itemId && String(item.id || '') !== pedido.itemId) return false;
      if (pedido.variationId && item.variation_id && String(item.variation_id) !== pedido.variationId) return false;
      return mesmoSku(item.seller_sku || item.id, venda.sku);
    });
    if (achado) return { venda, itemDoPedido: achado };
  }
  // Pedido com um SKU só: não há dúvida de qual é.
  if (doPedido.length === 1) {
    const itens = Array.isArray(doPedido[0].order_items) ? doPedido[0].order_items : [];
    return { venda: doPedido[0], itemDoPedido: itens[0] || null };
  }
  return { venda: null, itemDoPedido: null };
}

/**
 * Cliente dono da devolução = dono da venda. Com o mesmo pedido em dois
 * clientes (conta ligada a duas pessoas), vale o que teve baixa de estoque.
 */
function donoPelasVendas(vendas) {
  const ordenadas = [...vendas].sort((a, b) => {
    const pa = a.processed_at ? 0 : 1;
    const pb = b.processed_at ? 0 : 1;
    return pa - pb || String(a.uid).localeCompare(String(b.uid));
  });
  return ordenadas[0]?.uid || null;
}

function nomeDoComprador(vendas) {
  for (const venda of vendas) {
    const comprador = venda.buyer || {};
    const nome = [comprador.first_name, comprador.last_name].filter(Boolean).join(' ').trim();
    if (nome) return nome;
    if (comprador.nickname) return String(comprador.nickname);
  }
  return null;
}

async function donoPelaConta(client, sellerId) {
  const r = await client.query('SELECT DISTINCT uid FROM public.ml_accounts WHERE user_id = $1', [sellerId]);
  return r.rows.length === 1 ? r.rows[0].uid : null;
}

/* ------------------------------------------------------------------------- */
/* Gravação da devolução vinda do ML                                          */
/* ------------------------------------------------------------------------- */

async function registrarEvento(client, returnId, evento) {
  await client.query(
    `INSERT INTO public.ml_return_events (return_id, kind, source, from_value, to_value, actor, note, payload, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, NOW()))`,
    [
      returnId, evento.kind, evento.source, evento.from ?? null, evento.to ?? null,
      evento.actor ?? null, evento.note ?? null, evento.payload ? JSON.stringify(evento.payload) : null,
      evento.at ?? null,
    ]
  );
}

/**
 * Cria ou atualiza a devolução com o que veio do ML. Uma transação por
 * devolução, com a linha travada: o aviso do ML e a sincronização podem chegar
 * juntos.
 *
 * @returns {{ id: string, criada: boolean, situacao: string, mudouSituacao: boolean }}
 */
async function gravarDevolucaoDoMl(client, { ret, claim = null, sellerId, motivoTexto = null, miniaturas = {} }) {
  const mlReturnId = idTexto(ret?.id);
  if (!mlReturnId) throw new Error('Devolução do Mercado Livre sem identificador.');
  const seller = idTexto(sellerId);
  if (!seller) throw new Error('Conta do Mercado Livre sem identificador.');

  const campos = camposDoMl(ret, claim);
  const pedidos = pedidosDaDevolucao(ret, claim);
  const idsDePedido = [...new Set(pedidos.map((p) => p.orderId))];

  const vendas = idsDePedido.length
    ? (await client.query(
      `SELECT id::text AS id, sku, uid, quantity, account_nickname, processed_at, product_title,
              raw_api_data->'order_items' AS order_items,
              raw_api_data->'buyer'       AS buyer,
              raw_api_data->>'pack_id'    AS pack_id
         FROM public.sales
        WHERE id = ANY($1::bigint[]) AND seller_id = $2`,
      [idsDePedido, seller]
    )).rows
    : [];

  const dono = donoPelasVendas(vendas) || await donoPelaConta(client, seller);
  const vendasDoDono = dono ? vendas.filter((v) => v.uid === dono) : vendas;
  const comprador = nomeDoComprador(vendasDoDono);
  const apelido = vendasDoDono.find((v) => v.account_nickname)?.account_nickname
    || (await client.query('SELECT nickname FROM public.ml_accounts WHERE user_id = $1 AND nickname IS NOT NULL LIMIT 1', [seller])).rows[0]?.nickname
    || null;
  const pack = idTexto(vendasDoDono.find((v) => v.pack_id)?.pack_id);
  const situacaoMl = situacaoPeloMl(ret);

  await client.query('BEGIN');
  try {
    const inserida = await client.query(
      `INSERT INTO public.ml_returns (
          ml_return_id, claim_id, seller_id, uid, account_nickname, order_id, pack_id, buyer_name,
          ml_status, ml_subtype, ml_status_money, refund_at, destination, shipment_id, shipment_status,
          tracking_number, claim_status, claim_stage, claim_reason_id, claim_reason_text, review_due_at,
          stage, status_changed_at, received_at, ml_created_at, ml_closed_at, ml_last_updated, raw_return, raw_claim)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21,
               $22::text, COALESCE($24, $23, NOW()), CASE WHEN $22::text = 'no_cd' THEN COALESCE($24, NOW()) END,
               $25, $26, $24, $27, $28)
       ON CONFLICT (ml_return_id) DO NOTHING
       RETURNING id`,
      [
        mlReturnId, campos.claim_id, seller, dono, apelido, campos.order_id, pack, comprador,
        campos.ml_status, campos.ml_subtype, campos.ml_status_money, campos.refund_at, campos.destination,
        campos.shipment_id, campos.shipment_status, campos.tracking_number, campos.claim_status, campos.claim_stage,
        campos.claim_reason_id, motivoTexto, campos.review_due_at,
        situacaoMl, campos.ml_created_at, campos.ml_last_updated, campos.ml_created_at, campos.ml_closed_at,
        JSON.stringify(ret), claim ? JSON.stringify(claim) : null,
      ]
    );

    let id;
    let criada = false;
    let situacao = situacaoMl;
    let mudouSituacao = false;

    if (inserida.rowCount === 1) {
      id = String(inserida.rows[0].id);
      criada = true;
      await registrarEvento(client, id, {
        kind: 'aberta', source: 'mercadolivre', to: situacaoMl, at: campos.ml_created_at,
        note: motivoTexto ? `Devolução aberta no Mercado Livre. Motivo: ${motivoTexto}` : 'Devolução aberta no Mercado Livre.',
      });
      if (situacaoMl !== STAGES.AGUARDANDO_ENVIO) {
        await registrarEvento(client, id, { kind: 'situacao', source: 'mercadolivre', from: STAGES.AGUARDANDO_ENVIO, to: situacaoMl, at: campos.ml_last_updated });
      }
    } else {
      const atual = (await client.query(
        `SELECT id, stage, ml_status, uid, claim_reason_text FROM public.ml_returns WHERE ml_return_id = $1 FOR UPDATE`,
        [mlReturnId]
      )).rows[0];
      id = String(atual.id);
      situacao = proximaSituacao(atual.stage, situacaoMl);
      mudouSituacao = situacao !== atual.stage;
      const mudouStatusMl = (campos.ml_status || null) !== (atual.ml_status || null);

      await client.query(
        `UPDATE public.ml_returns SET
            claim_id = COALESCE($2, claim_id),
            uid = COALESCE(uid, $3),
            account_nickname = COALESCE($4, account_nickname),
            order_id = COALESCE($5, order_id),
            pack_id = COALESCE($6, pack_id),
            buyer_name = COALESCE($7, buyer_name),
            ml_status = $8, ml_subtype = $9, ml_status_money = $10, refund_at = $11,
            destination = $12, shipment_id = COALESCE($13, shipment_id), shipment_status = $14,
            tracking_number = COALESCE($15, tracking_number),
            claim_status = COALESCE($16, claim_status), claim_stage = COALESCE($17, claim_stage),
            claim_reason_id = COALESCE($18, claim_reason_id),
            claim_reason_text = COALESCE($19, claim_reason_text),
            review_due_at = CASE WHEN $25::boolean THEN $20 ELSE review_due_at END,
            stage = $21::text,
            received_at = CASE WHEN $21::text = 'no_cd' AND received_at IS NULL THEN COALESCE($22, NOW()) ELSE received_at END,
            status_changed_at = CASE WHEN $26::boolean THEN COALESCE($22, NOW()) ELSE status_changed_at END,
            ml_created_at = COALESCE(ml_created_at, $23), ml_closed_at = $24, ml_last_updated = $22,
            raw_return = $27, raw_claim = COALESCE($28, raw_claim),
            updated_at = NOW()
          WHERE id = $1`,
        [
          id, campos.claim_id, dono, apelido, campos.order_id, pack, comprador,
          campos.ml_status, campos.ml_subtype, campos.ml_status_money, campos.refund_at,
          campos.destination, campos.shipment_id, campos.shipment_status, campos.tracking_number,
          campos.claim_status, campos.claim_stage, campos.claim_reason_id, motivoTexto,
          campos.review_due_at, situacao, campos.ml_last_updated, campos.ml_created_at, campos.ml_closed_at,
          Boolean(claim), mudouSituacao || mudouStatusMl,
          JSON.stringify(ret), claim ? JSON.stringify(claim) : null,
        ]
      );

      if (mudouStatusMl) {
        await registrarEvento(client, id, { kind: 'status_ml', source: 'mercadolivre', from: atual.ml_status, to: campos.ml_status, at: campos.ml_last_updated });
      }
      if (mudouSituacao) {
        await registrarEvento(client, id, { kind: 'situacao', source: 'mercadolivre', from: atual.stage, to: situacao, at: campos.ml_last_updated });
      }
    }

    await gravarItens(client, id, { pedidos, vendas: vendasDoDono, miniaturas });

    await client.query('COMMIT');
    return { id, criada, situacao, mudouSituacao };
  } catch (erro) {
    await client.query('ROLLBACK').catch(() => {});
    throw erro;
  }
}

/** Uma linha de item a partir da venda (pedido + SKU) e do item do pedido. */
function linhaDaVenda(venda, itemDoPedido, pedido, miniaturas) {
  const item = itemDoPedido?.item || {};
  const itemId = pedido.itemId || (item.id ? String(item.id) : '');
  const vendidaNoPedido = itemDoPedido?.quantity ? quantidade(itemDoPedido.quantity) : null;
  return {
    orderId: pedido.orderId,
    itemId,
    variationId: pedido.variationId || (item.variation_id ? String(item.variation_id) : ''),
    sku: venda?.sku || null,
    titulo: item.title || venda?.product_title || null,
    miniatura: item.secure_thumbnail || item.thumbnail || miniaturas[itemId] || null,
    link: item.permalink || linkDoAnuncio(itemId),
    quantidade: pedido.quantidade ?? vendidaNoPedido ?? quantidade(venda?.quantity),
    vendida: pedido.quantidadeVendida ?? vendidaNoPedido ?? (venda?.quantity ?? null),
    contexto: pedido.contexto,
  };
}

async function gravarItens(client, returnId, { pedidos, vendas, miniaturas }) {
  const linhas = [];
  for (const pedido of pedidos) {
    if (pedido.itemId) {
      const { venda, itemDoPedido } = vendaDoItem(vendas, pedido);
      linhas.push(linhaDaVenda(venda, itemDoPedido, pedido, miniaturas));
      continue;
    }
    // O ML não disse qual anúncio: vale cada SKU vendido naquele pedido.
    const doPedido = vendas.filter((v) => String(v.id) === pedido.orderId);
    if (!doPedido.length) {
      linhas.push(linhaDaVenda(null, null, pedido, miniaturas));
      continue;
    }
    for (const venda of doPedido) {
      const itemDoPedido = (Array.isArray(venda.order_items) ? venda.order_items : [])
        .find((oi) => mesmoSku(oi?.item?.seller_sku || oi?.item?.id, venda.sku)) || null;
      linhas.push(linhaDaVenda(venda, itemDoPedido, pedido, miniaturas));
    }
  }

  for (const l of linhas) {
    await client.query(
      `INSERT INTO public.ml_return_items
          (return_id, order_id, item_id, variation_id, sku, title, thumbnail, permalink, quantity, sold_quantity, context_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (return_id, order_id, item_id, variation_id) DO UPDATE SET
          sku = COALESCE(public.ml_return_items.sku, EXCLUDED.sku),
          title = COALESCE(EXCLUDED.title, public.ml_return_items.title),
          thumbnail = COALESCE(EXCLUDED.thumbnail, public.ml_return_items.thumbnail),
          permalink = COALESCE(EXCLUDED.permalink, public.ml_return_items.permalink),
          quantity = CASE WHEN public.ml_return_items.qty_apt IS NULL AND public.ml_return_items.qty_not_apt IS NULL
                          THEN EXCLUDED.quantity ELSE public.ml_return_items.quantity END,
          sold_quantity = COALESCE(EXCLUDED.sold_quantity, public.ml_return_items.sold_quantity),
          context_type = COALESCE(EXCLUDED.context_type, public.ml_return_items.context_type),
          updated_at = NOW()`,
      [returnId, l.orderId, l.itemId, l.variationId, l.sku, l.titulo, l.miniatura, l.link, l.quantidade, l.vendida, l.contexto]
    );
  }

  // O item provisório (sem anúncio) sai quando o ML passa a dizer qual é.
  if (linhas.some((l) => l.itemId)) {
    await client.query(
      `DELETE FROM public.ml_return_items
        WHERE return_id = $1 AND item_id = '' AND qty_apt IS NULL AND qty_not_apt IS NULL`,
      [returnId]
    );
  }
}

/* ------------------------------------------------------------------------- */
/* Ações do CD                                                                */
/* ------------------------------------------------------------------------- */

async function travarDevolucao(client, id) {
  const r = await client.query('SELECT * FROM public.ml_returns WHERE id = $1 FOR UPDATE', [id]);
  if (!r.rowCount) throw erroHttp(404, 'nao_encontrada', 'Devolução não encontrada.');
  return r.rows[0];
}

const SITUACOES_QUE_PODEM_CHEGAR = new Set([STAGES.AGUARDANDO_ENVIO, STAGES.EM_TRANSITO, STAGES.CANCELADA]);

/**
 * A CyberDock confirma que o pacote está no CD. É o sinal que o cliente vê na
 * tela dele ("Recebida pela CyberDock") e o filtro "Recebimento" das telas.
 *  - Ainda a caminho no ML (ou cancelada, e chegou mesmo assim): passa para
 *    "No CD" e registra a chegada agora, como o antigo "Registrar chegada".
 *  - Já "No CD" porque o ML avisou a entrega: só confirma. `received_at` e
 *    `received_by` ficam como estão (a hora da chegada é a do ML).
 * A análise (salvar ou concluir) também confirma, se ninguém confirmou antes.
 */
async function confirmarRecebimento(client, id, autor) {
  await client.query('BEGIN');
  try {
    const dev = await travarDevolucao(client, id);
    if (STAGES_FORA_DO_CD.includes(dev.stage)) {
      throw erroHttp(409, 'situacao_invalida', 'Esta devolução não vem para a CyberDock.');
    }
    if (dev.receipt_confirmed_at) {
      throw erroHttp(409, 'ja_confirmado', 'O recebimento desta devolução já foi confirmado.');
    }
    const chegouAgora = SITUACOES_QUE_PODEM_CHEGAR.has(dev.stage);
    if (chegouAgora) {
      await client.query(
        `UPDATE public.ml_returns
            SET stage = 'no_cd', received_at = NOW(), received_by = $2, status_changed_at = NOW(),
                receipt_confirmed_at = NOW(), receipt_confirmed_by = $2, updated_at = NOW()
          WHERE id = $1`,
        [id, autor]
      );
    } else {
      await client.query(
        `UPDATE public.ml_returns
            SET receipt_confirmed_at = NOW(), receipt_confirmed_by = $2,
                received_at = COALESCE(received_at, NOW()), updated_at = NOW()
          WHERE id = $1`,
        [id, autor]
      );
    }
    await registrarEvento(client, id, {
      kind: 'recebimento', source: 'cd', actor: autor,
      from: chegouAgora ? dev.stage : null, to: chegouAgora ? STAGES.NO_CD : null,
      note: 'Recebimento confirmado pela CyberDock.',
    });
    await client.query('COMMIT');
    return { chegouAgora };
  } catch (erro) {
    await client.query('ROLLBACK').catch(() => {});
    throw erro;
  }
}

/** Nome antigo (POST /:id/chegada). Confirmar o recebimento já registra a chegada. */
const registrarChegada = confirmarRecebimento;

/* Quem analisa está com o pacote na mão: salvar ou concluir a análise confirma
 * o recebimento que ainda não foi confirmado (o UPDATE da análise grava as
 * colunas; aqui fica o histórico). */
async function registrarRecebimentoNaAnalise(client, dev, autor) {
  if (dev.receipt_confirmed_at) return;
  await registrarEvento(client, dev.id, { kind: 'recebimento', source: 'cd', actor: autor, note: 'Recebimento confirmado na análise.' });
}

function normalizarChecklist(entrada) {
  const saida = {};
  if (!entrada || typeof entrada !== 'object') return saida;
  for (const chave of Object.keys(CHECKLIST)) {
    if (typeof entrada[chave] === 'boolean') saida[chave] = entrada[chave];
  }
  return saida;
}

function normalizarObservacao(texto) {
  if (texto === null || texto === undefined) return null;
  const limpo = String(texto).trim();
  if (limpo.length > MAX_OBSERVACAO) {
    throw erroHttp(400, 'observacao_longa', `A observação passa de ${MAX_OBSERVACAO} caracteres.`);
  }
  return limpo || null;
}

/** Salva a análise sem decidir (checklist e observação). */
async function salvarAnalise(client, id, { checklist, notes }, autor) {
  const lista = normalizarChecklist(checklist);
  const observacao = normalizarObservacao(notes);
  await client.query('BEGIN');
  try {
    const dev = await travarDevolucao(client, id);
    if (dev.stage !== STAGES.NO_CD) {
      throw erroHttp(409, 'situacao_invalida', dev.stage === STAGES.ANALISADO
        ? 'Esta devolução já foi analisada.'
        : 'Confirme o recebimento no CD antes de analisar.');
    }
    await client.query(
      `UPDATE public.ml_returns
          SET checklist = $2, notes = $3,
              receipt_confirmed_by = CASE WHEN receipt_confirmed_at IS NULL THEN $4 ELSE receipt_confirmed_by END,
              receipt_confirmed_at = COALESCE(receipt_confirmed_at, NOW()),
              updated_at = NOW()
        WHERE id = $1`,
      [id, JSON.stringify(lista), observacao, autor]
    );
    await registrarRecebimentoNaAnalise(client, dev, autor);
    await registrarEvento(client, id, { kind: 'analise_salva', source: 'cd', actor: autor, note: 'Análise salva sem decisão.' });
    await client.query('COMMIT');
  } catch (erro) {
    await client.query('ROLLBACK').catch(() => {});
    throw erro;
  }
}

/** A venda tirou estoque no CyberDock? Sem baixa, não há o que devolver. */
async function vendaBaixouEstoque(client, uid, orderId, sku) {
  const r = await client.query(
    `SELECT EXISTS (
        SELECT 1 FROM public.sales
         WHERE id = $2 AND uid = $1 AND UPPER(TRIM(sku)) = UPPER(TRIM($3)) AND processed_at IS NOT NULL
     ) OR EXISTS (
        SELECT 1 FROM public.stock_movements
         WHERE related_sale_id = $2 AND user_id = $1 AND movement_type = 'saida'
     ) AS baixou`,
    [uid, orderId, sku]
  );
  return Boolean(r.rows[0]?.baixou);
}

/**
 * Quantas unidades do componente saíram por unidade vendida do kit. Lê o
 * movimento original da venda (a composição pode ter mudado depois); sem ele,
 * usa a composição atual.
 */
async function porUnidadeNaVenda(client, { uid, orderId, sku, childId, vendida, porKit }) {
  let chave;
  try {
    chave = buildSaleLineKey({ marketplace: 'mercadolivre', uid, orderId, soldSku: sku, movementSkuId: childId });
  } catch {
    return Number(porKit);
  }
  const r = await client.query(
    `SELECT quantity_change FROM public.stock_movements
      WHERE sale_line_key = $1 AND movement_type = 'saida' LIMIT 1`,
    [chave]
  );
  const original = Number(r.rows[0]?.quantity_change);
  if (Number.isFinite(original) && original > 0 && Number(vendida) > 0) return original / Number(vendida);
  return Number(porKit);
}

async function inserirEntrada(client, { skuId, uid, quantidade: qtd, motivo, orderId, chave }) {
  try {
    await client.query(
      `INSERT INTO public.stock_movements
          (sku_id, user_id, movement_type, quantity_change, reason, related_sale_id, sale_line_key)
       VALUES ($1, $2, 'entrada', $3, $4, $5, $6)`,
      [skuId, uid, qtd, motivo, orderId, chave]
    );
  } catch (erro) {
    if (isDuplicateSaleMovement(erro)) {
      throw erroHttp(409, 'ja_aplicado', 'Esta devolução já entrou no estoque. Nada foi somado de novo.');
    }
    throw erro;
  }
}

/**
 * Soma ao estoque as unidades aptas de um item. Roda dentro da transação da
 * decisão. Devolve o que mudou, ou o motivo de não ter mudado.
 */
async function devolverAoEstoque(client, { dev, item, qtd }) {
  if (!dev.uid) return { aplicado: false, motivo: 'sem_cliente' };
  if (!item.sku) return { aplicado: false, motivo: 'sem_sku' };
  if (!(await vendaBaixouEstoque(client, dev.uid, item.order_id, item.sku))) {
    return { aplicado: false, motivo: 'venda_sem_baixa' };
  }

  const skus = await client.query(
    `SELECT id, sku, is_kit, quantidade FROM public.skus
      WHERE user_id = $1 AND UPPER(TRIM(sku)) = UPPER(TRIM($2)) AND ativo = true
      ORDER BY id LIMIT 2 FOR UPDATE`,
    [dev.uid, item.sku]
  );
  if (skus.rowCount === 0) {
    throw erroHttp(409, 'sku_nao_encontrado',
      `O SKU ${item.sku} não está ativo no armazenamento do cliente. Cadastre ou reative o SKU antes de concluir.`);
  }
  if (skus.rowCount > 1) {
    throw erroHttp(409, 'sku_duplicado', `O SKU ${item.sku} aparece duplicado no armazenamento do cliente. Corrija antes de concluir.`);
  }

  const estoque = skus.rows[0];
  const chave = (movimentoSkuId) => buildSaleLineKey({
    marketplace: 'ml_return', uid: dev.uid, orderId: `${dev.ml_return_id}:${item.id}`, soldSku: item.sku, movementSkuId: movimentoSkuId,
  });
  const movimentos = [];

  if (estoque.is_kit) {
    const componentes = await client.query(
      `SELECT c.child_sku_id, c.quantity_per_kit FROM public.sku_kit_components c
        WHERE c.kit_sku_id = $1 ORDER BY c.child_sku_id`,
      [estoque.id]
    );
    if (!componentes.rowCount) {
      throw erroHttp(409, 'kit_sem_componentes', `O kit ${item.sku} não tem componentes cadastrados. Cadastre a composição antes de concluir.`);
    }
    for (const comp of componentes.rows) {
      const porUnidade = await porUnidadeNaVenda(client, {
        uid: dev.uid, orderId: item.order_id, sku: item.sku, childId: comp.child_sku_id,
        vendida: item.sold_quantity, porKit: comp.quantity_per_kit,
      });
      const delta = Math.max(1, Math.round(porUnidade * qtd));
      const atualizado = await client.query(
        `UPDATE public.skus SET quantidade = COALESCE(quantidade, 0) + $1, updated_at = NOW()
          WHERE id = $2 RETURNING sku, quantidade`,
        [delta, comp.child_sku_id]
      );
      const filho = atualizado.rows[0];
      await inserirEntrada(client, {
        skuId: comp.child_sku_id, uid: dev.uid, quantidade: delta, orderId: item.order_id,
        motivo: `Entrada por Kit: Devolução ML - Pedido ${item.order_id}`, chave: chave(comp.child_sku_id),
      });
      movimentos.push({ sku: filho.sku, quantidade: delta, antes: Number(filho.quantidade) - delta, depois: Number(filho.quantidade) });
    }
    // Movimento do kit, sem mexer em quantidade: espelha a saída da venda.
    await inserirEntrada(client, {
      skuId: estoque.id, uid: dev.uid, quantidade: qtd, orderId: item.order_id,
      motivo: `Entrada por Devolução ML - Pedido ${item.order_id} (kit)`, chave: chave(estoque.id),
    });
  } else {
    const atualizado = await client.query(
      `UPDATE public.skus SET quantidade = COALESCE(quantidade, 0) + $1, updated_at = NOW()
        WHERE id = $2 RETURNING quantidade`,
      [qtd, estoque.id]
    );
    await inserirEntrada(client, {
      skuId: estoque.id, uid: dev.uid, quantidade: qtd, orderId: item.order_id,
      motivo: `Entrada por Devolução ML - Pedido ${item.order_id}`, chave: chave(estoque.id),
    });
    const depois = Number(atualizado.rows[0].quantidade);
    movimentos.push({ sku: estoque.sku, quantidade: qtd, antes: depois - qtd, depois });
  }

  return { aplicado: true, movimentos };
}

const MOTIVO_SEM_ENTRADA = {
  sem_cliente: 'sem entrada no estoque: a devolução não tem cliente identificado',
  sem_sku: 'sem entrada no estoque: o item não tem SKU identificado',
  venda_sem_baixa: 'sem entrada no estoque: a venda não tinha tirado estoque no CyberDock',
};

/**
 * Conclui a análise. `itens` diz quantas unidades de cada item estão aptas; o
 * resto é não apto e exige motivo e destino. Tudo numa transação: estoque,
 * itens, devolução e histórico entram juntos ou não entram.
 */
async function concluirAnalise(client, id, { itens, motivo, destino, checklist, notes }, autor) {
  const lista = normalizarChecklist(checklist);
  const observacao = normalizarObservacao(notes);
  const pedidoDeItens = new Map();
  for (const entrada of Array.isArray(itens) ? itens : []) {
    const itemId = idTexto(entrada?.id);
    const aptas = Number(entrada?.qtyApt);
    if (!itemId || !Number.isInteger(aptas) || aptas < 0) {
      throw erroHttp(400, 'itens_invalidos', 'Informe quantas unidades de cada item estão aptas.');
    }
    pedidoDeItens.set(itemId, aptas);
  }

  await client.query('BEGIN');
  try {
    const dev = await travarDevolucao(client, id);
    if (dev.stage === STAGES.ANALISADO) {
      throw erroHttp(409, 'ja_analisada', 'Esta devolução já foi analisada. A decisão não foi alterada.');
    }
    if (dev.stage !== STAGES.NO_CD) {
      throw erroHttp(409, 'situacao_invalida', 'Confirme o recebimento no CD antes de concluir a análise.');
    }

    const itensDaDevolucao = (await client.query(
      'SELECT * FROM public.ml_return_items WHERE return_id = $1 ORDER BY id FOR UPDATE',
      [id]
    )).rows;
    if (!itensDaDevolucao.length) {
      throw erroHttp(409, 'sem_itens', 'Esta devolução não tem itens identificados. Sincronize com o Mercado Livre e tente de novo.');
    }

    let totalAptas = 0;
    let totalNaoAptas = 0;
    const plano = itensDaDevolucao.map((item) => {
      const itemId = String(item.id);
      if (!pedidoDeItens.has(itemId)) {
        throw erroHttp(400, 'itens_invalidos', 'Informe quantas unidades de cada item estão aptas.');
      }
      const aptas = pedidoDeItens.get(itemId);
      const total = Number(item.quantity) || 0;
      if (aptas > total) throw erroHttp(400, 'itens_invalidos', 'Há mais unidades aptas do que unidades devolvidas.');
      totalAptas += aptas;
      totalNaoAptas += total - aptas;
      return { item, aptas, naoAptas: total - aptas };
    });

    if (totalNaoAptas > 0) {
      if (!MOTIVOS_NAO_APTO[motivo]) throw erroHttp(400, 'motivo_obrigatorio', 'Escolha o motivo das unidades não aptas.');
      if (!DESTINOS_NAO_APTO[destino]) throw erroHttp(400, 'destino_obrigatorio', 'Escolha o destino das unidades não aptas.');
    }

    const resultado = totalNaoAptas === 0 ? RESULTS.APTO : (totalAptas === 0 ? RESULTS.NAO_APTO : RESULTS.PARCIAL);
    const entradas = [];
    const semEntrada = [];

    for (const passo of plano) {
      let restocou = false;
      if (passo.aptas > 0) {
        const efeito = await devolverAoEstoque(client, { dev, item: passo.item, qtd: passo.aptas });
        if (efeito.aplicado) {
          restocou = true;
          entradas.push(...efeito.movimentos);
        } else {
          semEntrada.push({ sku: passo.item.sku, motivo: efeito.motivo });
        }
      }
      await client.query(
        `UPDATE public.ml_return_items
            SET qty_apt = $2, qty_not_apt = $3, restocked_at = CASE WHEN $4::boolean THEN NOW() ELSE restocked_at END, updated_at = NOW()
          WHERE id = $1`,
        [passo.item.id, passo.aptas, passo.naoAptas, restocou]
      );
    }

    await client.query(
      `UPDATE public.ml_returns SET
          stage = 'analisado', result = $2, decided_at = NOW(), decided_by = $3,
          checklist = $4, notes = $5,
          not_apt_reason = $6, not_apt_destination = $7,
          receipt_confirmed_by = CASE WHEN receipt_confirmed_at IS NULL THEN $3 ELSE receipt_confirmed_by END,
          receipt_confirmed_at = COALESCE(receipt_confirmed_at, NOW()),
          status_changed_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [id, resultado, autor, JSON.stringify(lista), observacao,
        totalNaoAptas > 0 ? motivo : null, totalNaoAptas > 0 ? destino : null]
    );
    await registrarRecebimentoNaAnalise(client, dev, autor);

    const partes = [];
    if (totalAptas > 0) partes.push(`${totalAptas} ${totalAptas === 1 ? 'unidade apta' : 'unidades aptas'}`);
    if (totalNaoAptas > 0) {
      partes.push(`${totalNaoAptas} ${totalNaoAptas === 1 ? 'não apta' : 'não aptas'} (${MOTIVOS_NAO_APTO[motivo]}; ${DESTINOS_NAO_APTO[destino]})`);
    }
    await registrarEvento(client, id, {
      kind: 'analise_concluida', source: 'cd', from: STAGES.NO_CD, to: resultado, actor: autor,
      note: `Análise concluída: ${partes.join(', ')}.`,
    });
    for (const mov of entradas) {
      await registrarEvento(client, id, {
        kind: 'estoque', source: 'sistema', actor: autor,
        note: `+${mov.quantidade} em ${mov.sku} (estoque ${mov.antes} → ${mov.depois}).`,
        payload: mov,
      });
    }
    for (const falta of semEntrada) {
      await registrarEvento(client, id, {
        kind: 'estoque', source: 'sistema', actor: autor,
        note: `${falta.sku || 'Item'}: ${MOTIVO_SEM_ENTRADA[falta.motivo] || 'sem entrada no estoque'}.`,
      });
    }

    await client.query('COMMIT');
    return { resultado, entradas, semEntrada };
  } catch (erro) {
    await client.query('ROLLBACK').catch(() => {});
    throw erro;
  }
}

/* ------------------------------------------------------------------------- */
/* Fotos                                                                      */
/* ------------------------------------------------------------------------- */

/** Tipo real da imagem pelos primeiros bytes (o nome e o tipo informado não bastam). */
function tipoDaImagem(buffer) {
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length > 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

function lerFoto(base64) {
  const texto = String(base64 || '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  if (!texto || !/^[A-Za-z0-9+/]+={0,2}$/.test(texto)) {
    throw erroHttp(400, 'foto_invalida', 'Envie a foto em JPG, PNG ou WEBP.');
  }
  const buffer = Buffer.from(texto, 'base64');
  if (buffer.length > MAX_FOTO_BYTES) throw erroHttp(413, 'foto_grande', 'A foto passa de 3 MB. Tire de novo ou reduza a imagem.');
  const tipo = tipoDaImagem(buffer);
  if (!tipo) throw erroHttp(400, 'foto_invalida', 'Envie a foto em JPG, PNG ou WEBP.');
  return { buffer, tipo };
}

async function adicionarFoto(client, id, base64, autor) {
  const { buffer, tipo } = lerFoto(base64);
  await client.query('BEGIN');
  try {
    const dev = await travarDevolucao(client, id);
    if (STAGES_FORA_DO_CD.includes(dev.stage)) throw erroHttp(409, 'situacao_invalida', 'Esta devolução não vem para o CD.');
    const total = Number((await client.query('SELECT COUNT(*)::int AS n FROM public.ml_return_photos WHERE return_id = $1', [id])).rows[0].n);
    if (total >= MAX_FOTOS) throw erroHttp(409, 'fotos_demais', `Cada devolução aceita até ${MAX_FOTOS} fotos.`);
    const r = await client.query(
      `INSERT INTO public.ml_return_photos (return_id, content_type, size_bytes, data, uploaded_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, content_type, size_bytes, uploaded_by, created_at`,
      [id, tipo, buffer.length, buffer, autor]
    );
    await registrarEvento(client, id, { kind: 'foto', source: 'cd', actor: autor, note: 'Foto adicionada.' });
    await client.query('COMMIT');
    return r.rows[0];
  } catch (erro) {
    await client.query('ROLLBACK').catch(() => {});
    throw erro;
  }
}

async function removerFoto(client, id, fotoId, autor) {
  await client.query('BEGIN');
  try {
    const dev = await travarDevolucao(client, id);
    if (dev.stage === STAGES.ANALISADO) {
      throw erroHttp(409, 'ja_analisada', 'Depois da análise as fotos ficam guardadas como prova e não podem ser removidas.');
    }
    const r = await client.query('DELETE FROM public.ml_return_photos WHERE id = $1 AND return_id = $2', [fotoId, id]);
    if (!r.rowCount) throw erroHttp(404, 'foto_nao_encontrada', 'Foto não encontrada.');
    await registrarEvento(client, id, { kind: 'foto', source: 'cd', actor: autor, note: 'Foto removida.' });
    await client.query('COMMIT');
  } catch (erro) {
    await client.query('ROLLBACK').catch(() => {});
    throw erro;
  }
}

/* ------------------------------------------------------------------------- */
/* Consultas da tela                                                          */
/* ------------------------------------------------------------------------- */

const PERIODOS = { '7d': 7, '30d': 30, '90d': 90 };
/* `aptos` = apto ou parcial (alguma unidade voltou ao estoque), o mesmo que o número do topo conta. */
const FILTROS_DE_RESULTADO = new Set(['pendente', 'apto', 'nao_apto', 'parcial', 'aptos']);

/** Filtros comuns (período, cliente, conta, busca) em SQL parametrizado. */
function filtrosBase(filtros, params) {
  const where = [];
  const dias = PERIODOS[filtros.periodo];
  if (dias) {
    params.push(dias);
    where.push(`COALESCE(r.ml_created_at, r.created_at) >= NOW() - ($${params.length}::int * INTERVAL '1 day')`);
  }
  if (filtros.uid) {
    params.push(String(filtros.uid));
    where.push(`r.uid = $${params.length}`);
  }
  const seller = idTexto(filtros.seller);
  if (seller) {
    params.push(seller);
    where.push(`r.seller_id = $${params.length}`);
  }
  const busca = String(filtros.busca || '').trim().slice(0, 120);
  if (busca) {
    params.push(`%${busca.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    const p = `$${params.length}`;
    const numero = idTexto(busca.replace(/^#/, ''));
    let porNumero = '';
    if (numero) {
      params.push(numero);
      const n = `$${params.length}`;
      porNumero = ` OR r.order_id = ${n}::bigint OR r.ml_return_id = ${n}::bigint OR r.claim_id = ${n}::bigint
                    OR r.pack_id = ${n}::bigint OR r.shipment_id = ${n}::bigint`;
    }
    where.push(`(
        r.tracking_number ILIKE ${p} OR r.buyer_name ILIKE ${p} OR r.account_nickname ILIKE ${p}
        OR u.name ILIKE ${p} OR u.email ILIKE ${p}
        OR EXISTS (SELECT 1 FROM public.ml_return_items i
                    WHERE i.return_id = r.id AND (i.sku ILIKE ${p} OR i.title ILIKE ${p}))
        ${porNumero}
      )`);
  }
  return where;
}

function filtrosDaLista(filtros, params) {
  const where = filtrosBase(filtros, params);
  if (filtros.situacao === 'a_caminho') {
    where.push(`r.stage IN ('aguardando_envio', 'em_transito')`);
  } else if (STAGE_VALUES.has(filtros.situacao)) {
    params.push(filtros.situacao);
    where.push(`r.stage = $${params.length}`);
  } else {
    where.push(`r.stage NOT IN ('no_ml', 'sem_devolucao')`);
  }
  if (FILTROS_DE_RESULTADO.has(filtros.resultado)) {
    if (filtros.resultado === 'pendente') {
      where.push(`r.stage = 'no_cd'`);
    } else if (filtros.resultado === 'aptos') {
      where.push(`r.result IN ('apto', 'parcial')`);
    } else {
      params.push(filtros.resultado);
      where.push(`r.result = $${params.length}`);
    }
  }
  /* Recebimento confirmado pela CyberDock. "Aguardando" é o que ainda vem (ou
   * já chegou pelo ML) sem confirmação: cancelada fica de fora, senão ficaria
   * aguardando para sempre. */
  if (filtros.recebimento === 'confirmado') {
    where.push('r.receipt_confirmed_at IS NOT NULL');
  } else if (filtros.recebimento === 'aguardando') {
    where.push(`r.receipt_confirmed_at IS NULL AND r.stage IN ('aguardando_envio', 'em_transito', 'no_cd')`);
  }
  return where;
}

/* ---------------- Visão do cliente ---------------- */

/* O cliente vê a própria devolução sem saber quem da equipe fez cada passo
 * (vira "CyberDock"), sem a observação interna da análise e sem os passos de
 * trabalho do CD (análise salva, foto incluída ou removida). */
const PELA_CYBERDOCK = 'CyberDock';
const EVENTOS_DO_CLIENTE = new Set(['aberta', 'situacao', 'status_ml', 'chegada', 'recebimento', 'analise_concluida', 'estoque']);
const quemDaCyberDock = (valor) => (valor ? PELA_CYBERDOCK : null);

function devolucaoParaCliente(dev) {
  const copia = { ...dev };
  delete copia.notes;
  delete copia.client_name;
  delete copia.client_email;
  copia.received_by = quemDaCyberDock(dev.received_by);
  copia.decided_by = quemDaCyberDock(dev.decided_by);
  copia.receipt_confirmed_by = quemDaCyberDock(dev.receipt_confirmed_by);
  return copia;
}

const eventoParaCliente = (evento) => ({ ...evento, actor: quemDaCyberDock(evento.actor) });

/**
 * uid da visão do cliente, ou null na visão do master. Pedir a visão do
 * cliente sem uid é erro: cair na visão do master mostraria tudo de todos.
 */
function clienteDaVisao(opcoes = {}) {
  if (!Object.prototype.hasOwnProperty.call(opcoes, 'cliente')) return null;
  const uid = opcoes.cliente === null || opcoes.cliente === undefined ? '' : String(opcoes.cliente).trim();
  if (!uid) throw erroHttp(401, 'sem_usuario', 'Sessão sem usuário identificado. Entre de novo.');
  return uid;
}

const SELECT_DA_LISTA = `
  SELECT r.id, r.ml_return_id::text AS ml_return_id, r.claim_id::text AS claim_id, r.seller_id::text AS seller_id,
         r.uid, r.account_nickname, r.order_id::text AS order_id, r.pack_id::text AS pack_id, r.buyer_name,
         r.ml_status, r.destination, r.tracking_number, r.claim_reason_text, r.review_due_at,
         r.stage, r.result, r.status_changed_at, r.received_at, r.received_by, r.decided_at, r.decided_by,
         r.receipt_confirmed_at, r.receipt_confirmed_by,
         r.not_apt_reason, r.not_apt_destination, r.notes, r.ml_created_at, r.created_at,
         u.name AS client_name, u.email AS client_email,
         COALESCE((SELECT json_agg(json_build_object(
                    'id', i.id, 'sku', i.sku, 'title', i.title, 'thumbnail', i.thumbnail, 'permalink', i.permalink,
                    'quantity', i.quantity, 'qtyApt', i.qty_apt, 'qtyNotApt', i.qty_not_apt, 'orderId', i.order_id::text)
                    ORDER BY i.id)
                     FROM public.ml_return_items i WHERE i.return_id = r.id), '[]'::json) AS items,
         (SELECT COUNT(*)::int FROM public.ml_return_photos p WHERE p.return_id = r.id) AS photo_count
    FROM public.ml_returns r
    LEFT JOIN public.users u ON u.uid = r.uid`;

/**
 * Lista, números do período e facetas. Com `cliente` (uid), tudo fica preso às
 * devoluções desse cliente: o filtro de cliente da query é ignorado, as
 * facetas só trazem as contas dele e as linhas saem sem dados da equipe.
 */
async function listarDevolucoes(db, filtrosPedidos = {}, opcoes = {}) {
  const cliente = clienteDaVisao(opcoes);
  const filtros = cliente ? { ...filtrosPedidos, uid: cliente } : filtrosPedidos;
  const todas = Boolean(filtros.todas);
  const limite = todas ? 5000 : Math.min(100, Math.max(1, parseInt(filtros.limit, 10) || 25));
  const pagina = todas ? 1 : Math.max(1, parseInt(filtros.page, 10) || 1);

  const params = [];
  const where = filtrosDaLista(filtros, params);
  const clausula = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const paramsKpi = [];
  const whereKpi = filtrosBase(filtros, paramsKpi);
  const clausulaKpi = whereKpi.length ? `WHERE ${whereKpi.join(' AND ')}` : '';

  const totalQ = db.query(`SELECT COUNT(*)::int AS total FROM public.ml_returns r LEFT JOIN public.users u ON u.uid = r.uid ${clausula}`, params);
  const dadosQ = db.query(
    `${SELECT_DA_LISTA} ${clausula}
     ORDER BY r.status_changed_at DESC, r.id DESC
     LIMIT ${limite} OFFSET ${(pagina - 1) * limite}`,
    params
  );
  const kpiQ = db.query(
    `SELECT
        COUNT(*) FILTER (WHERE r.stage NOT IN ('no_ml', 'sem_devolucao'))::int          AS total,
        COUNT(*) FILTER (WHERE r.stage IN ('aguardando_envio', 'em_transito'))::int     AS em_transito,
        COUNT(*) FILTER (WHERE r.stage = 'no_cd')::int                                  AS no_cd,
        COUNT(*) FILTER (WHERE r.stage = 'analisado' AND r.result IN ('apto', 'parcial'))::int AS aptos,
        COUNT(*) FILTER (WHERE r.stage = 'analisado' AND r.result = 'nao_apto')::int    AS nao_aptos,
        COUNT(*) FILTER (WHERE r.stage = 'cancelada')::int                              AS canceladas,
        COUNT(*) FILTER (WHERE r.stage = 'no_ml')::int                                  AS no_ml,
        COUNT(*) FILTER (WHERE r.receipt_confirmed_at IS NOT NULL)::int                 AS recebidas,
        COUNT(*) FILTER (WHERE r.stage = 'no_cd' AND r.receipt_confirmed_at IS NULL)::int AS a_confirmar,
        AVG(EXTRACT(EPOCH FROM (r.decided_at - r.received_at)))
          FILTER (WHERE r.decided_at IS NOT NULL AND r.received_at IS NOT NULL)         AS segundos_analise,
        COALESCE(SUM(q.aptas) FILTER (WHERE r.stage = 'analisado'), 0)::int             AS unidades_aptas,
        COALESCE(SUM(q.nao_aptas) FILTER (WHERE r.stage = 'analisado'), 0)::int         AS unidades_nao_aptas
       FROM public.ml_returns r
       LEFT JOIN public.users u ON u.uid = r.uid
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(i.qty_apt), 0) AS aptas, COALESCE(SUM(i.qty_not_apt), 0) AS nao_aptas
           FROM public.ml_return_items i WHERE i.return_id = r.id
       ) q ON true
       ${clausulaKpi}`,
    paramsKpi
  );

  // Período anterior do mesmo tamanho, para a variação do total.
  let anteriorQ = Promise.resolve(null);
  const dias = PERIODOS[filtros.periodo];
  if (dias) {
    const paramsAnt = [];
    const whereAnt = filtrosBase({ ...filtros, periodo: null }, paramsAnt);
    paramsAnt.push(dias);
    const p = `$${paramsAnt.length}`;
    whereAnt.push(`COALESCE(r.ml_created_at, r.created_at) <  NOW() - (${p}::int * INTERVAL '1 day')`);
    whereAnt.push(`COALESCE(r.ml_created_at, r.created_at) >= NOW() - (${p}::int * 2 * INTERVAL '1 day')`);
    whereAnt.push(`r.stage NOT IN ('no_ml', 'sem_devolucao')`);
    anteriorQ = db.query(
      `SELECT COUNT(*)::int AS total FROM public.ml_returns r LEFT JOIN public.users u ON u.uid = r.uid WHERE ${whereAnt.join(' AND ')}`,
      paramsAnt
    );
  }

  const facetasQ = cliente
    ? db.query(
      `SELECT 'conta' AS tipo, r.seller_id::text AS valor, COALESCE(MAX(r.account_nickname), r.seller_id::text) AS rotulo
         FROM public.ml_returns r
        WHERE r.uid = $1
        GROUP BY r.seller_id
        ORDER BY 3`,
      [String(cliente)]
    )
    : db.query(
      `SELECT 'cliente' AS tipo, r.uid AS valor, COALESCE(NULLIF(TRIM(u.name), ''), u.email, r.uid) AS rotulo
         FROM public.ml_returns r JOIN public.users u ON u.uid = r.uid
        GROUP BY r.uid, u.name, u.email
       UNION ALL
       SELECT 'conta', r.seller_id::text, COALESCE(MAX(r.account_nickname), r.seller_id::text)
         FROM public.ml_returns r
        GROUP BY r.seller_id
       ORDER BY 1, 3`
    );

  const [totalR, dadosR, kpiR, anteriorR, facetasR] = await Promise.all([totalQ, dadosQ, kpiQ, anteriorQ, facetasQ]);
  const total = totalR.rows[0]?.total || 0;
  const k = kpiR.rows[0] || {};
  return {
    data: cliente ? dadosR.rows.map(devolucaoParaCliente) : dadosR.rows,
    total,
    page: pagina,
    limit: limite,
    totalPages: Math.max(1, Math.ceil(total / limite)),
    kpis: {
      total: k.total || 0,
      emTransito: k.em_transito || 0,
      noCd: k.no_cd || 0,
      aptos: k.aptos || 0,
      naoAptos: k.nao_aptos || 0,
      canceladas: k.canceladas || 0,
      noMl: k.no_ml || 0,
      recebidas: k.recebidas || 0,
      aConfirmar: k.a_confirmar || 0,
      unidadesAptas: k.unidades_aptas || 0,
      unidadesNaoAptas: k.unidades_nao_aptas || 0,
      horasMediasDeAnalise: k.segundos_analise === null || k.segundos_analise === undefined
        ? null : Math.round((Number(k.segundos_analise) / 3600) * 10) / 10,
      totalAnterior: anteriorR ? anteriorR.rows[0]?.total || 0 : null,
    },
    facetas: {
      clientes: facetasR.rows.filter((f) => f.tipo === 'cliente').map((f) => ({ valor: f.valor, rotulo: f.rotulo })),
      contas: facetasR.rows.filter((f) => f.tipo === 'conta').map((f) => ({ valor: f.valor, rotulo: f.rotulo })),
    },
  };
}

/** Estoque atual do SKU do item (e dos componentes, se for kit), para a prévia da decisão. */
async function estoqueDoItem(db, uid, item) {
  if (!uid || !item.sku) return null;
  const sku = (await db.query(
    `SELECT id, sku, descricao, quantidade, is_kit FROM public.skus
      WHERE user_id = $1 AND UPPER(TRIM(sku)) = UPPER(TRIM($2)) AND ativo = true ORDER BY id LIMIT 2`,
    [uid, item.sku]
  )).rows;
  if (sku.length !== 1) return { encontrado: false, duplicado: sku.length > 1 };
  const base = { encontrado: true, sku: sku[0].sku, descricao: sku[0].descricao, quantidade: Number(sku[0].quantidade) || 0, kit: Boolean(sku[0].is_kit) };
  if (!base.kit) return base;
  const componentes = (await db.query(
    `SELECT c.child_sku_id, s.sku, s.quantidade, c.quantity_per_kit FROM public.sku_kit_components c
       JOIN public.skus s ON s.id = c.child_sku_id
      WHERE c.kit_sku_id = $1 ORDER BY c.child_sku_id`,
    [sku[0].id]
  )).rows;
  // `porKit` é o que a decisão vai usar de fato: o da saída da venda quando
  // ela existe (a composição pode ter mudado depois), senão o cadastro atual.
  const lista = [];
  for (const c of componentes) {
    const porKit = await porUnidadeNaVenda(db, {
      uid, orderId: item.order_id, sku: item.sku, childId: c.child_sku_id,
      vendida: item.sold_quantity, porKit: c.quantity_per_kit,
    });
    lista.push({ sku: c.sku, quantidade: Number(c.quantidade) || 0, porKit: Number(porKit) || 1 });
  }
  return { ...base, componentes: lista };
}

/**
 * Devolução com itens, histórico e fotos. Com `cliente` (uid), só abre se for
 * desse cliente (senão 404, como se não existisse) e sai na visão dele: sem
 * a conferência de estoque, sem nomes da equipe e sem passos internos.
 */
async function detalharDevolucao(db, id, opcoes = {}) {
  const cliente = clienteDaVisao(opcoes);
  const params = [id];
  if (cliente) params.push(cliente);
  const r = await db.query(
    `SELECT r.id, r.ml_return_id::text AS ml_return_id, r.claim_id::text AS claim_id, r.seller_id::text AS seller_id,
            r.uid, r.account_nickname, r.order_id::text AS order_id, r.pack_id::text AS pack_id, r.buyer_name,
            r.ml_status, r.ml_subtype, r.ml_status_money, r.refund_at, r.destination,
            r.shipment_id::text AS shipment_id, r.shipment_status, r.tracking_number,
            r.claim_status, r.claim_stage, r.claim_reason_id, r.claim_reason_text, r.review_due_at,
            r.stage, r.result, r.status_changed_at, r.received_at, r.received_by, r.decided_at, r.decided_by,
            r.receipt_confirmed_at, r.receipt_confirmed_by,
            r.checklist, r.notes, r.not_apt_reason, r.not_apt_destination,
            r.ml_created_at, r.ml_closed_at, r.ml_last_updated, r.created_at, r.updated_at,
            u.name AS client_name, u.email AS client_email
       FROM public.ml_returns r LEFT JOIN public.users u ON u.uid = r.uid
      WHERE r.id = $1${cliente ? ' AND r.uid = $2' : ''}`,
    params
  );
  if (!r.rowCount) throw erroHttp(404, 'nao_encontrada', 'Devolução não encontrada.');
  const dev = r.rows[0];

  const itens = (await db.query(
    `SELECT id, order_id::text AS order_id, item_id, variation_id, sku, title, thumbnail, permalink,
            quantity, sold_quantity, context_type, qty_apt, qty_not_apt, restocked_at
       FROM public.ml_return_items WHERE return_id = $1 ORDER BY id`,
    [id]
  )).rows;
  if (!cliente) {
    for (const item of itens) {
      item.estoque = await estoqueDoItem(db, dev.uid, item);
      item.vendaBaixouEstoque = dev.uid && item.sku ? await vendaBaixouEstoque(db, dev.uid, item.order_id, item.sku) : false;
    }
  }

  const [eventos, fotos] = await Promise.all([
    db.query(
      `SELECT id, kind, source, from_value, to_value, actor, note, created_at
         FROM public.ml_return_events WHERE return_id = $1 ORDER BY created_at DESC, id DESC LIMIT 200`,
      [id]
    ),
    db.query(
      `SELECT id, content_type, size_bytes, uploaded_by, created_at
         FROM public.ml_return_photos WHERE return_id = $1 ORDER BY id`,
      [id]
    ),
  ]);

  if (cliente) {
    return {
      ...devolucaoParaCliente(dev),
      items: itens,
      events: eventos.rows.filter((evento) => EVENTOS_DO_CLIENTE.has(evento.kind)).map(eventoParaCliente),
      photos: fotos.rows.map((foto) => ({ ...foto, uploaded_by: null })),
    };
  }
  return { ...dev, items: itens, events: eventos.rows, photos: fotos.rows };
}

/* ------------------------------------------------------------------------- */
/* Leitura no Mercado Livre                                                   */
/* ------------------------------------------------------------------------- */

const cacheDeMotivos = new Map();

async function textoDoMotivo(ml, reasonId) {
  if (!reasonId) return null;
  if (cacheDeMotivos.has(reasonId)) return cacheDeMotivos.get(reasonId);
  let texto = null;
  try {
    const motivo = await ml.get(`/post-purchase/v1/claims/reasons/${encodeURIComponent(reasonId)}`, { aceita404: true });
    texto = motivo?.detail || motivo?.name || null;
  } catch {
    texto = null;
  }
  if (cacheDeMotivos.size > 500) cacheDeMotivos.clear();
  cacheDeMotivos.set(reasonId, texto);
  return texto;
}

/** Foto do anúncio quando a venda não guardou a miniatura. */
async function miniaturasDosItens(ml, ret) {
  const ids = [...new Set((ret?.orders || []).map((o) => String(o?.item_id || '')).filter((v) => /^ML[A-Z]\d+$/i.test(v)))];
  if (!ids.length) return {};
  try {
    const resposta = await ml.get(`/items?ids=${ids.slice(0, 20).join(',')}&attributes=id,thumbnail,secure_thumbnail`);
    const mapa = {};
    for (const entrada of Array.isArray(resposta) ? resposta : []) {
      const corpo = entrada?.body || {};
      if (corpo.id) mapa[corpo.id] = corpo.secure_thumbnail || corpo.thumbnail || null;
    }
    return mapa;
  } catch {
    return {};
  }
}

const relacionaDevolucao = (claim) => {
  const relacionados = claim?.related_entities;
  if (!Array.isArray(relacionados) || relacionados.length === 0) return null; // não informado
  return relacionados.some((r) => /^returns?$/i.test(String(r)));
};

/**
 * Busca a devolução de UMA reclamação no ML e grava. Reclamação sem devolução
 * (só mediação, por exemplo) é ignorada.
 */
async function processarReclamacao({ db, ml, sellerId, claimId, claim = null }) {
  const id = idTexto(claimId ?? claim?.id);
  if (!id) return { ignorada: true };

  let reclamacao = claim;
  if (!reclamacao || !Array.isArray(reclamacao.players)) {
    reclamacao = await ml.get(`/post-purchase/v1/claims/${id}`, { aceita404: true });
  }
  const relacionada = relacionaDevolucao(reclamacao);
  if (relacionada === false) return { ignorada: true };

  let resposta;
  try {
    resposta = await ml.get(`/post-purchase/v2/claims/${id}/returns`, { aceita404: true });
  } catch (erro) {
    // A busca não traz a lista de entidades da reclamação. Sem ela, recusa do
    // ML ao pedir a devolução quer dizer que esta reclamação não tem devolução.
    const status = Number(erro?.status);
    if (relacionada === null && status >= 400 && status < 500 && ![401, 408, 429].includes(status)) {
      return { ignorada: true };
    }
    throw erro;
  }
  const devolucoes = (Array.isArray(resposta) ? resposta : [resposta]).filter((d) => d && idTexto(d.id));
  if (!devolucoes.length) return { ignorada: true };

  const motivo = await textoDoMotivo(ml, reclamacao?.reason_id);
  const resultados = [];
  for (const ret of devolucoes) {
    const miniaturas = await miniaturasDosItens(ml, ret);
    const client = await db.pool.connect();
    try {
      resultados.push(await gravarDevolucaoDoMl(client, { ret, claim: reclamacao, sellerId, motivoTexto: motivo, miniaturas }));
    } finally {
      client.release();
    }
  }
  return { ignorada: false, resultados };
}

/* ------------------------------------------------------------------------- */
/* Busca de reclamações no ML                                                 */
/* ------------------------------------------------------------------------- */

const DIA_MS = 24 * 60 * 60 * 1000;
const JANELA_INICIAL_DIAS = 60;
const SOBREPOSICAO_MS = 10 * 60 * 1000;
/* O fim do período vai um pouco à frente: relógio do ML adiantado não esconde a última reclamação. */
const FOLGA_DO_RELOGIO_MS = 10 * 60 * 1000;
const POR_PAGINA = 50;
/* Regra do ML: offset + limit sempre abaixo de 10000. */
const LIMITE_DE_POSICAO = 10000;
/* Formato recusado volta a ser tentado depois deste tempo (o ML pode passar a aceitar). */
const REAVALIAR_FORMATO_MS = 6 * 60 * 60 * 1000;
/* Reclamação que falha por instabilidade segura o cursor por no máximo estas leituras. */
const MAX_FALHAS_TRANSITORIAS = 3;
const LIMITE_DA_MEMORIA = 50000;

/**
 * Formatos da busca, do mais preciso ao mais simples, todos da documentação do
 * ML ("Gerenciar reclamações"). Em produção o ML respondeu 400 em todas as
 * contas ao formato antigo (período só com início, data em "+00:00" e
 * ordenação). Agora, se um formato for recusado, a leitura segue com o
 * próximo e o sistema lembra qual funcionou.
 *  - atualizadas: reclamações alteradas desde a última leitura (o normal);
 *  - criadas: reclamações abertas nos últimos 60 dias. Mudança em reclamação
 *    mais antiga chega pelo aviso do ML e pela releitura das devoluções a caminho;
 *  - abertas: só as reclamações em aberto, sem período (o exemplo mínimo da doc).
 */
const FORMATOS_DA_BUSCA = Object.freeze([
  Object.freeze({ nome: 'atualizadas', campo: 'last_updated' }),
  Object.freeze({ nome: 'criadas', campo: 'date_created' }),
  Object.freeze({ nome: 'abertas', status: 'opened' }),
]);

/* Estado do processo: formato em uso e o que já foi lido (evita reler o que não mudou). */
const estadoDaBusca = { indice: 0, desde: 0, ativo: null, recusados: new Set() };
const versoesLidas = new Map();
const falhasSeguidas = new Map();

/** Volta ao estado inicial (testes e diagnóstico). */
function reiniciarEstadoDaBusca() {
  estadoDaBusca.indice = 0;
  estadoDaBusca.desde = 0;
  estadoDaBusca.ativo = null;
  estadoDaBusca.recusados.clear();
  versoesLidas.clear();
  falhasSeguidas.clear();
}

function lembrarVersao(chave, versao) {
  if (!versao) return;
  if (versoesLidas.size >= LIMITE_DA_MEMORIA) versoesLidas.clear();
  versoesLidas.set(chave, versao);
}

/**
 * Data no horário de Brasília, com milissegundos: "2026-03-19T09:31:54.000-03:00".
 * Brasília não tem horário de verão desde 2019, então o fuso é fixo. Sem "+"
 * na data: numa URL ele pode virar espaço e o ML recusar a data.
 */
function dataParaBusca(data) {
  return `${new Date(data.getTime() - 3 * 60 * 60 * 1000).toISOString().slice(0, 23)}-03:00`;
}

/**
 * Parâmetros da busca. Montados à mão: `range` usa ":" e "," como separadores
 * e vai sem codificação (são caracteres válidos na URL), para o ML ler igual
 * decodificando ou não.
 */
function consultaDaBusca(formato, { seller, desde, ate, offset }) {
  const partes = [`players.user_id=${seller}`, 'players.role=respondent'];
  if (formato.campo) partes.push(`range=${formato.campo}:after:${dataParaBusca(desde)},before:${dataParaBusca(ate)}`);
  if (formato.status) partes.push(`status=${formato.status}`);
  partes.push(`limit=${POR_PAGINA}`, `offset=${offset}`);
  return partes.join('&');
}

function inicioDoFormato(formato, janela) {
  if (formato.campo === 'last_updated') return janela.desdeAtualizacao;
  if (formato.campo === 'date_created') return janela.inicio;
  return null;
}

const caminhoDaBusca = (formato, janela, offset) => `/post-purchase/v1/claims/search?${consultaDaBusca(formato, {
  seller: janela.seller, desde: inicioDoFormato(formato, janela), ate: janela.ate, offset,
})}`;

/**
 * Primeira página da busca, no formato que o ML aceitar. Recusa (400) passa
 * para o formato seguinte; qualquer outro erro (token, instabilidade) sobe
 * como está, porque trocar de formato não resolveria.
 */
async function primeiraPagina(ml, janela) {
  if (estadoDaBusca.indice > 0 && Date.now() - estadoDaBusca.desde > REAVALIAR_FORMATO_MS) {
    estadoDaBusca.indice = 0;
    estadoDaBusca.desde = Date.now();
    estadoDaBusca.recusados.clear();
  }
  let recusa = null;
  for (let i = estadoDaBusca.indice; i < FORMATOS_DA_BUSCA.length; i += 1) {
    const formato = FORMATOS_DA_BUSCA[i];
    try {
      const pagina = await ml.get(caminhoDaBusca(formato, janela, 0));
      if (i < estadoDaBusca.indice) estadoDaBusca.indice = i;
      if (estadoDaBusca.ativo !== formato.nome) {
        estadoDaBusca.ativo = formato.nome;
        console.log(`[DEVOLUCOES] busca de reclamações no formato "${formato.nome}".`);
      }
      return { formato, pagina };
    } catch (erro) {
      if (Number(erro?.status) !== 400) throw erro;
      recusa = erro;
      if (!estadoDaBusca.recusados.has(formato.nome)) {
        estadoDaBusca.recusados.add(formato.nome);
        console.warn(`[DEVOLUCOES] o Mercado Livre recusou a busca no formato "${formato.nome}": ${erro.detalheMl || 'sem motivo na resposta'}.`);
      }
      // As próximas contas já começam pelo formato seguinte. Se nenhum for
      // aceito, fica no último até a próxima reavaliação: uma recusa por conta.
      if (i >= estadoDaBusca.indice) {
        estadoDaBusca.indice = Math.min(i + 1, FORMATOS_DA_BUSCA.length - 1);
        estadoDaBusca.desde = Date.now();
      }
    }
  }
  throw recusa;
}

/** Instabilidade (rede, limite de chamadas, erro do ML): vale tentar de novo. */
function ehTransitoria(erro) {
  const status = Number(erro?.status);
  return !status || status === 408 || status === 429 || status >= 500;
}

/**
 * Versão (last_updated) da reclamação já gravada nas devoluções, para não
 * reler o que não mudou. Reclamação com versões diferentes entre as próprias
 * devoluções é relida.
 */
async function versoesGravadas(db, seller, ids) {
  const mapa = new Map();
  if (!ids.length) return mapa;
  const r = await db.query(
    `SELECT claim_id::text AS claim_id, raw_claim->>'last_updated' AS versao
       FROM public.ml_returns
      WHERE seller_id = $1 AND claim_id = ANY($2::bigint[])`,
    [seller, ids]
  );
  const divergentes = new Set();
  for (const { claim_id: claimId, versao } of r.rows) {
    if (divergentes.has(claimId)) continue;
    if (!versao || (mapa.has(claimId) && mapa.get(claimId) !== versao)) {
      mapa.delete(claimId);
      divergentes.add(claimId);
    } else {
      mapa.set(claimId, versao);
    }
  }
  return mapa;
}

/**
 * Sincroniza UMA conta: reclamações alteradas desde a última leitura e, além
 * delas, as devoluções ainda a caminho (o envio pode mudar sem a reclamação
 * mudar). Uma reclamação que falha não derruba a conta: fica contada no
 * resumo e é tentada de novo na próxima leitura.
 */
async function sincronizarConta({ db, ml, sellerId, agora = new Date() }) {
  const seller = idTexto(sellerId);
  if (!seller) throw new Error('Conta do Mercado Livre sem identificador.');
  const estado = await db.query('SELECT cursor_at FROM public.ml_return_sync WHERE seller_id = $1', [seller]);
  const cursor = estado.rows[0]?.cursor_at ? new Date(estado.rows[0].cursor_at) : null;
  const inicio = new Date(agora.getTime() - JANELA_INICIAL_DIAS * DIA_MS);
  const janela = {
    seller,
    inicio,
    desdeAtualizacao: cursor ? new Date(cursor.getTime() - SOBREPOSICAO_MS) : inicio,
    ate: new Date(agora.getTime() + FOLGA_DO_RELOGIO_MS),
  };

  const resumo = {
    busca: null, reclamacoes: 0, semMudanca: 0, devolucoes: 0, novas: 0,
    reclamacoesComFalha: 0, falhaDeReclamacao: null,
  };
  const vistas = new Set();
  /* Lidas de verdade nesta passada; as puladas (sem mudança) ainda passam pela releitura das que estão a caminho. */
  const processadas = new Set();
  let maisRecente = cursor;
  let menorFalha = null;

  const anotarFalha = (erro) => {
    resumo.reclamacoesComFalha += 1;
    if (!resumo.falhaDeReclamacao) {
      resumo.falhaDeReclamacao = {
        status: Number(erro?.status) || null,
        detalhe: erro?.detalheMl || null,
        mensagem: String(erro?.message || erro).slice(0, 300),
      };
    }
  };

  await db.query(
    `INSERT INTO public.ml_return_sync (seller_id, last_run_at, updated_at) VALUES ($1, NOW(), NOW())
     ON CONFLICT (seller_id) DO UPDATE SET last_run_at = NOW(), updated_at = NOW()`,
    [seller]
  );

  try {
    const { formato, pagina: primeira } = await primeiraPagina(ml, janela);
    resumo.busca = formato.nome;
    let pagina = primeira;
    let offset = 0;
    for (;;) {
      const lista = Array.isArray(pagina?.data) ? pagina.data : [];
      const conhecidas = await versoesGravadas(db, seller, lista.map((c) => idTexto(c?.id)).filter(Boolean));
      for (const claim of lista) {
        const claimId = idTexto(claim?.id);
        if (!claimId || vistas.has(claimId)) continue;
        vistas.add(claimId);
        resumo.reclamacoes += 1;
        const versao = claim?.last_updated ? String(claim.last_updated) : null;
        const atualizada = dataOuNull(versao);
        if (atualizada && (!maisRecente || atualizada > maisRecente)) maisRecente = atualizada;

        const chave = `${seller}:${claimId}`;
        if (versao && (versoesLidas.get(chave) === versao || conhecidas.get(claimId) === versao)) {
          resumo.semMudanca += 1;
          lembrarVersao(chave, versao);
          continue;
        }
        processadas.add(claimId);
        try {
          const r = await processarReclamacao({ db, ml, sellerId: seller, claimId, claim });
          lembrarVersao(chave, versao);
          falhasSeguidas.delete(chave);
          if (!r.ignorada) {
            resumo.devolucoes += r.resultados.length;
            resumo.novas += r.resultados.filter((x) => x.criada).length;
          }
        } catch (erro) {
          if (Number(erro?.status) === 401) throw erro; // token recusado mesmo depois de renovar: a conta toda falha
          anotarFalha(erro);
          const seguidas = (falhasSeguidas.get(chave) || 0) + 1;
          falhasSeguidas.set(chave, seguidas);
          if (ehTransitoria(erro) && seguidas <= MAX_FALHAS_TRANSITORIAS && atualizada && (!menorFalha || atualizada < menorFalha)) {
            menorFalha = atualizada;
          }
        }
      }
      offset += lista.length;
      const total = Number(pagina?.paging?.total);
      if (lista.length < POR_PAGINA || (Number.isFinite(total) && offset >= total) || offset + POR_PAGINA >= LIMITE_DE_POSICAO) break;
      pagina = await ml.get(caminhoDaBusca(formato, janela, offset));
    }

    const abertas = await db.query(
      `SELECT claim_id::text AS claim_id FROM public.ml_returns
        WHERE seller_id = $1 AND claim_id IS NOT NULL
          AND stage IN ('aguardando_envio', 'em_transito', 'no_ml')
          AND COALESCE(ml_created_at, created_at) > NOW() - INTERVAL '120 days'`,
      [seller]
    );
    for (const { claim_id: claimId } of abertas.rows) {
      if (processadas.has(claimId)) continue;
      processadas.add(claimId);
      try {
        const r = await processarReclamacao({ db, ml, sellerId: seller, claimId });
        if (!r.ignorada) resumo.devolucoes += r.resultados.length;
      } catch (erro) {
        if (Number(erro?.status) === 401) throw erro;
        anotarFalha(erro);
      }
    }

    // Só o formato por data de atualização anda o cursor. Reclamação que
    // falhou por instabilidade segura o cursor para ser lida de novo.
    let novoCursor = maisRecente;
    if (menorFalha && (!novoCursor || novoCursor >= menorFalha)) novoCursor = new Date(menorFalha.getTime() - 1);
    const falhasDaLeitura = resumo.reclamacoesComFalha
      ? `${resumo.reclamacoesComFalha} reclamação(ões) não lida(s). ${resumo.falhaDeReclamacao.mensagem}`.slice(0, 500)
      : null;
    await db.query(
      `UPDATE public.ml_return_sync
          SET cursor_at = CASE WHEN $4::boolean THEN COALESCE($2, cursor_at, $3) ELSE cursor_at END,
              last_ok_at = NOW(), last_error = $5, updated_at = NOW()
        WHERE seller_id = $1`,
      [seller, novoCursor, janela.desdeAtualizacao, formato.campo === 'last_updated', falhasDaLeitura]
    );
    return resumo;
  } catch (erro) {
    await db.query(
      'UPDATE public.ml_return_sync SET last_error = $2, updated_at = NOW() WHERE seller_id = $1',
      [seller, String(erro?.message || erro).slice(0, 500)]
    ).catch(() => {});
    throw erro;
  }
}

/* ------------------------------------------------------------------------- */
/* Acesso ao ML com o token da conta                                          */
/* ------------------------------------------------------------------------- */

/**
 * Motivo que o ML deu no corpo da resposta de erro, curto e numa linha só
 * (ex.: "invalid_query: at least any of these filters ..."). Sem ele, um 400
 * não diz qual parâmetro foi recusado.
 */
async function motivoDoMl(res) {
  let texto = '';
  try {
    texto = typeof res?.text === 'function' ? String(await res.text()) : '';
  } catch {
    return null;
  }
  if (!texto.trim()) return null;
  let corpo = null;
  try {
    corpo = JSON.parse(texto);
  } catch {
    corpo = null;
  }
  let motivo = texto.replace(/<[^>]*>/g, ' ');
  if (corpo && typeof corpo === 'object') {
    const partes = [];
    const codigo = corpo.error || corpo.code;
    if (codigo) partes.push(String(codigo));
    if (corpo.message && String(corpo.message) !== String(codigo)) partes.push(String(corpo.message));
    const causas = (Array.isArray(corpo.cause) ? corpo.cause : [])
      .map((c) => (c && typeof c === 'object' ? c.message || c.code : c))
      .filter(Boolean);
    if (causas.length) partes.push(causas.join('; '));
    if (partes.length) motivo = partes.join(': ');
  }
  motivo = motivo.replace(/\s+/g, ' ').trim();
  return motivo ? motivo.slice(0, 300) : null;
}

/**
 * Sessão de leitura no ML para uma conta. Renova o token uma vez quando ele
 * vence; antes de renovar, relê o banco (outra rotina pode ter renovado e o
 * token antigo já não vale).
 */
async function abrirSessaoMl(db, sellerId, { mlFetch, fetchToken }) {
  const seller = idTexto(sellerId);
  const conta = await db.query(
    `SELECT uid, access_token, refresh_token FROM public.ml_accounts
      WHERE user_id = $1 AND access_token IS NOT NULL
      ORDER BY (status = 'active') IS TRUE DESC, updated_at DESC NULLS LAST
      LIMIT 1`,
    [seller]
  );
  if (!conta.rowCount) throw erroHttp(404, 'conta_nao_encontrada', `Conta do Mercado Livre ${seller} não encontrada.`);
  let { uid, access_token: token } = conta.rows[0];

  const renovar = async () => {
    const atual = await db.query(
      'SELECT access_token, refresh_token FROM public.ml_accounts WHERE user_id = $1 AND uid = $2',
      [seller, uid]
    );
    const linha = atual.rows[0];
    if (linha && linha.access_token && linha.access_token !== token) {
      token = linha.access_token;
      return;
    }
    token = await fetchToken({ db, sellerId: seller, uid, refreshToken: linha?.refresh_token });
  };

  const get = async (caminho, { aceita404 = false } = {}) => {
    const url = caminho.startsWith('http') ? caminho : `${ML_API}${caminho}`;
    let res = await mlFetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) {
      await renovar();
      res = await mlFetch(url, { headers: { Authorization: `Bearer ${token}` } });
    }
    if (res.status === 404 && aceita404) return null;
    if (!res.ok) {
      const motivo = await motivoDoMl(res);
      const erro = new Error(`Mercado Livre respondeu ${res.status} em ${caminho.split('?')[0]}${motivo ? `: ${motivo}` : '.'}`);
      erro.status = res.status;
      erro.detalheMl = motivo;
      throw erro;
    }
    try {
      return await res.json();
    } catch {
      return null;
    }
  };

  return { get, sellerId: seller, uid };
}

module.exports = {
  STAGES,
  STAGES_FORA_DO_CD,
  RESULTS,
  MOTIVOS_NAO_APTO,
  DESTINOS_NAO_APTO,
  CHECKLIST,
  MAX_FOTOS,
  erroHttp,
  idTexto,
  situacaoPeloMl,
  proximaSituacao,
  remessaDoCd,
  prazoDeRevisao,
  pedidosDaDevolucao,
  vendaDoItem,
  tipoDaImagem,
  gravarDevolucaoDoMl,
  confirmarRecebimento,
  registrarChegada,
  salvarAnalise,
  concluirAnalise,
  adicionarFoto,
  removerFoto,
  listarDevolucoes,
  detalharDevolucao,
  devolucaoParaCliente,
  processarReclamacao,
  sincronizarConta,
  abrirSessaoMl,
  FORMATOS_DA_BUSCA,
  dataParaBusca,
  consultaDaBusca,
  reiniciarEstadoDaBusca,
};
