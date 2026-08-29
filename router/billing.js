// backend/routes/billing.js
const express = require('express');
const db = require('../utils/postgres');
const { authenticateToken, requireMaster } = require('../utils/authMiddleware');
const { BillingQueryBuilder } = require('../utils/billingQueryBuilder');
const {
  BASE_STORAGE_TYPES,
  STORAGE_TYPES,
  buildStorageItems,
  getTierUnitPrice,
  round,
} = require('../utils/billingRules');

const asaas = require('../utils/asaasClient');

const router = express.Router();

// Instância do construtor de queries corrigidas
const billingQueryBuilder = new BillingQueryBuilder();

/* -------------------------------------------------------------------------- */
/* Cobrança externa (Asaas)                                                   */
/*                                                                            */
/* Tudo aqui passa por utils/asaasClient.js, que é o único arquivo que conhece */
/* o provedor. Sem ASAAS_API_KEY no ambiente, qualquer chamada falha com       */
/* code 'not_configured' antes de tocar a rede — então estas rotas existirem   */
/* não liga nada sozinho.                                                      */
/* -------------------------------------------------------------------------- */

const PERIODO_VALIDO = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Erro do provedor traduzido para resposta HTTP, sem vazar detalhe interno. */
function responderErroAsaas(res, erro, contexto) {
  if (erro?.name !== 'AsaasError') {
    console.error(`Erro inesperado em ${contexto}:`, erro);
    return res.status(500).json({ error: 'Erro interno na integração de cobrança.' });
  }

  console.warn(`[Cobrança] ${contexto} falhou: ${erro.code || erro.status} — ${erro.message}`);

  /* 'not_configured' é 503 e não 500: o sistema está bem, falta configuração.
   * Timeout e falha de rede também são 503 — são condição temporária do
   * provedor, e devolver 500 faria a tela sugerir bug nosso. */
  const indisponivel = ['not_configured', 'timeout', 'network_error'].includes(erro.code);
  return res.status(indisponivel ? 503 : (erro.status || 502)).json({
    error: erro.message,
    code: erro.code || null,
    provider: 'asaas',
  });
}

/**
 * ===== Diagnóstico da integração (master) =====
 *
 * Não cria nada. `describe()` diz o que está configurado (sem devolver a chave,
 * só os quatro últimos dígitos) e `ping()` faz a chamada mais barata que existe
 * para provar quatro coisas de uma vez: chave presente, chave válida, ambiente
 * certo e rede alcançável.
 *
 * É a primeira coisa a abrir depois de configurar o ambiente: se aqui não
 * responder, nada mais vai funcionar e o motivo aparece aqui em vez de aparecer
 * no meio de uma emissão.
 */
router.get('/asaas/status', authenticateToken, requireMaster, async (req, res) => {
  const configuracao = asaas.describe();
  if (!configuracao.enabled) {
    return res.json({
      ...configuracao,
      reachable: false,
      motivo: 'ASAAS_API_KEY não configurada. A integração está desligada.',
    });
  }

  try {
    const teste = await asaas.ping();
    return res.json({ ...configuracao, reachable: true, elapsedMs: teste.elapsedMs });
  } catch (erro) {
    // Credencial errada não é erro do sistema: é resposta útil do diagnóstico.
    return res.json({
      ...configuracao,
      reachable: false,
      motivo: erro.message,
      code: erro.code || null,
      status: erro.status || null,
    });
  }
});

/**
 * ===== Garante o cadastro do cliente no provedor (master) =====
 *
 * Idempotente, e a ordem da busca não é arbitrária:
 *
 * 1. `asaas_customer_id` já gravado: nada a fazer.
 * 2. Procura por `externalReference` = uid. É o nosso identificador, não depende
 *    de comparar nome nem documento.
 * 3. Procura por CPF/CNPJ, que é o critério de duplicidade do provedor. Isto
 *    cobre o cadastro criado à mão no painel do Asaas, que não tem
 *    externalReference.
 * 4. Só então cria.
 *
 * O Asaas ACEITA cadastro duplicado, então essa checagem é responsabilidade
 * nossa: sem ela, cada clique criaria um cliente novo.
 */
router.post('/asaas/customers/:uid', authenticateToken, requireMaster, async (req, res) => {
  const { uid } = req.params;

  try {
    const { rows, rowCount } = await db.query(
      `SELECT uid, name, email, cpf_cnpj, phone, asaas_customer_id,
              postal_code, address, address_number, address_complement, province
         FROM public.users WHERE uid = $1`,
      [uid]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Cliente não encontrado.' });

    const cliente = rows[0];
    /* O endereço vai junto na criação E na atualização: é o que habilita boleto,
     * e um cadastro criado sem ele continuaria recusando boleto para sempre se a
     * gente só enviasse na criação. */
    const endereco = {
      postalCode: cliente.postal_code,
      address: cliente.address,
      addressNumber: cliente.address_number,
      addressComplement: cliente.address_complement,
      province: cliente.province,
    };

    /* Documento é obrigatório no provedor. Recusar aqui, com o nome do campo,
     * evita a mensagem crua do Asaas — que fala em "cpfCnpj" e não diz onde
     * preencher. GET /users/billing-info/pending lista quem falta. */
    if (!cliente.cpf_cnpj || !String(cliente.cpf_cnpj).trim()) {
      return res.status(422).json({
        error: 'Este cliente não tem CPF/CNPJ cadastrado, e o provedor exige o documento do pagador.',
        code: 'missing_billing_info',
        /* `faltando` é o que permite à tela abrir o formulário já apontando o
         * campo, em vez de mostrar a mensagem e deixar o master sem saída. */
        faltando: ['cpfCnpj'],
        field: 'cpfCnpj',
      });
    }

    /* Já vinculado: em vez de sair sem fazer nada, SINCRONIZA o cadastro. É o
     * que faz o endereço preenchido depois da vinculação chegar ao provedor —
     * sem isso, quem vinculou antes de ter CEP nunca conseguiria emitir boleto. */
    if (cliente.asaas_customer_id) {
      await asaas.updateCustomer(cliente.asaas_customer_id, {
        name: cliente.name || cliente.email,
        cpfCnpj: cliente.cpf_cnpj,
        email: cliente.email,
        phone: cliente.phone,
        ...endereco,
      });
      return res.json({
        ok: true,
        created: false,
        updated: true,
        customerId: cliente.asaas_customer_id,
        boletoReady: Boolean(cliente.postal_code && cliente.address_number),
        message: 'Cadastro do cliente atualizado no provedor.',
      });
    }

    let remoto = await asaas.findCustomerByExternalReference(uid);
    let criado = false;

    if (!remoto) remoto = await asaas.findCustomerByCpfCnpj(cliente.cpf_cnpj);

    if (!remoto) {
      remoto = await asaas.createCustomer({
        uid,
        name: cliente.name || cliente.email,
        cpfCnpj: cliente.cpf_cnpj,
        email: cliente.email,
        phone: cliente.phone,
        ...endereco,
      });
      criado = true;
    }

    if (!remoto?.id) {
      return res.status(502).json({ error: 'O provedor não devolveu o identificador do cliente.' });
    }

    /* O índice único parcial idx_users_asaas_customer impede o mesmo cadastro
     * do provedor em dois clientes nossos. Traduzo a violação em vez de deixar
     * virar 500. */
    try {
      await db.query(
        'UPDATE public.users SET asaas_customer_id = $1, updated_at = NOW() WHERE uid = $2',
        [remoto.id, uid]
      );
    } catch (erro) {
      if (erro.code === '23505' || erro.code === '23514') {
        return res.status(409).json({
          error: `O cadastro ${remoto.id} do provedor já está vinculado a outro cliente.`,
          code: 'customer_already_linked',
        });
      }
      throw erro;
    }

    console.log(`[Cobrança] Cliente ${uid} ${criado ? 'criado' : 'vinculado'} no provedor como ${remoto.id} `
      + `por ${req.user.email || req.user.uid}.`);

    res.json({ ok: true, created: criado, customerId: remoto.id });
  } catch (erro) {
    return responderErroAsaas(res, erro, `vincular cliente ${uid}`);
  }
});

/**
 * Gera/atualiza itens automáticos da fatura (armazenamento + expedições),
 * preservando itens manuais, e recalcula o total somando manual + automático.
 */
async function calculateAndSaveInvoice(client, uid, period) {
  const [year, month] = period.split('-').map(Number);

  /* Competência FECHADA não é recalculada.
   *
   * Esta função apaga e recria os itens automáticos e regrava o total a cada
   * chamada — e ela é chamada em toda abertura da fatura. Enquanto o mês está
   * aberto, isso é o certo: venda processada hoje entra na conta de hoje.
   *
   * Deixa de ser certo no instante em que o valor sai do sistema (cobrança
   * emitida, boleto enviado, nota fiscal). Uma venda com processed_at retroativo
   * ou um avulso lançado depois mudariam o total de uma fatura já cobrada, e o
   * cliente receberia um valor diferente do que está no documento.
   *
   * Sair aqui é o que torna o fechamento uma garantia, e não uma convenção que
   * cada chamador precisa lembrar de respeitar: `GET /invoices/:uid`,
   * `POST /add-manual-item`, `POST /recalculate/:uid` e o backfill do boot
   * passam todos por esta função.
   */
  const existente = await client.query(
    'SELECT closed_at FROM public.invoices WHERE uid = $1 AND period = $2',
    [uid, period]
  );
  if (existente.rows[0]?.closed_at) {
    return { recalculada: false, motivo: 'competencia_fechada' };
  }

  // === 1) Preços "master" dos serviços de armazenamento ===
  // Inclui base_storage_50 (Armazenamento Inicial 1m³ 50% | FULL).
  const masterPricesRes = await client.query(`
    SELECT type, price
    FROM public.services
    WHERE type = ANY($1);
  `, [STORAGE_TYPES]);
  const masterPrices = masterPricesRes.rows.reduce((acc, s) => {
    acc[s.type] = parseFloat(s.price);
    return acc;
  }, {});

  // === 2) Contratos de armazenamento do cliente ===
  // A start_date vem junto: antes era buscada numa segunda query por
  // `type = 'base_storage' LIMIT 1`, que apontava para o serviço errado
  // quando havia mais de um registro do mesmo tipo no catálogo.
  // `uc.id AS contract_id` é o desempate de pickBaseStorageContract quando dois
  // contratos base têm a mesma data de início: sem ele, `ORDER BY start_date`
  // não define ordem e o valor faturado podia mudar entre requisições.
  const contractsRes = await client.query(`
    SELECT s.type, s.id AS service_id, uc.id AS contract_id, uc.volume, uc.start_date
    FROM public.user_contracts uc
    JOIN public.services s ON uc.service_id = s.id
    WHERE uc.uid = $1 AND s.type = ANY($2)
    ORDER BY uc.start_date ASC, uc.id ASC;
  `, [uid, STORAGE_TYPES]);

  // Regras de proporcional e rótulos ficam em utils/billingRules.js, para não
  // divergirem de novo entre a fatura e a estimativa do armazenamento.
  const autoItems = buildStorageItems({
    contracts: contractsRes.rows,
    prices: masterPrices,
    year,
    month,
  });
  let autoTotal = autoItems.reduce((sum, item) => sum + item.total_price, 0);

  // === 3) Expedições do período, filtradas por processed_at (data real da
  // expedição) e não por sale_date, que colocava a venda no mês errado. ===
  const salesQuery = billingQueryBuilder.buildSalesQuery(uid, year, month);
  const shipmentsRes = await client.query(salesQuery.query, salesQuery.params);

  const shipmentSummary = shipmentsRes.rows.reduce((acc, sale) => {
    if (sale.package_type_name && sale.package_type_price) {
      const key = sale.package_type_name;
      if (!acc[key]) acc[key] = { quantity: 0, price: parseFloat(sale.package_type_price) };
      acc[key].quantity += parseInt(sale.quantity) || 1;
    }
    return acc;
  }, {});

  for (const [description, data] of Object.entries(shipmentSummary)) {
    if (data.quantity > 0) {
      const total = round(data.quantity * data.price);
      autoItems.push({
        description,
        quantity: data.quantity,
        unit: 'venda',
        unit_price: data.price,
        total_price: total,
        type: 'shipment',
        service_id: null
      });
      autoTotal += total;
    }
  }

  // === 4) Upsert da fatura (cria se não existir) ===
  // O status NÃO é mais reescrito aqui. Antes o recálculo forçava 'pending' e
  // a leitura da fatura dispara o recálculo, então uma fatura marcada como paga
  // voltava para pendente sozinha na próxima vez que a tela era aberta.
  /* Vencimento no dia 10 do mês SEGUINTE à competência.
   *
   * `month` vem 1-based do período (AAAA-MM) e o mês de `Date.UTC` é 0-based,
   * então passar `month` sem subtrair 1 já cai no mês seguinte — é isso que faz
   * a competência 2026-08 vencer em 10/09/2026. Parece um erro de índice e não é.
   *
   * Era dia 5. Mudou para 10 a pedido, e vale para todos os clientes.
   *
   * Como a mudança alcança as faturas que já existem: o upsert regrava
   * `due_date` a cada recálculo, e o recálculo roda em toda abertura da fatura.
   * Então competência ABERTA se ajusta sozinha na próxima leitura, sem migração.
   * Competência FECHADA não muda, porque a guarda no topo desta função sai antes
   * de chegar aqui — e isso é o certo: o valor e o documento dela já foram
   * congelados, possivelmente já comunicados ao cliente.
   */
  const DIA_VENCIMENTO = 10;
  const dueDate = new Date(Date.UTC(year, month, DIA_VENCIMENTO));
  const upsertRes = await client.query(`
    INSERT INTO public.invoices (uid, period, due_date, total_amount, status)
    VALUES ($1, $2, $3, 0, 'pending')
    ON CONFLICT (uid, period) DO UPDATE
      SET due_date = EXCLUDED.due_date
    RETURNING id;
  `, [uid, period, dueDate]);
  const invoiceId = upsertRes.rows[0].id;

  // === 5) Remove SOMENTE itens automáticos e recria ===
  await client.query(
    `DELETE FROM public.invoice_items WHERE invoice_id = $1 AND type IN ('storage','shipment');`,
    [invoiceId]
  );

  if (autoItems.length) {
    for (const it of autoItems) {
      await client.query(`
        INSERT INTO public.invoice_items (invoice_id, description, quantity, unit, unit_price, total_price, type, service_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8);
      `, [invoiceId, it.description, it.quantity, it.unit || null, it.unit_price, it.total_price, it.type, it.service_id || null]);
    }
  }

  // === 6) Recalcula total: automáticos + manuais ===
  const manualSumRes = await client.query(`
    SELECT COALESCE(SUM(total_price), 0) AS sum
    FROM public.invoice_items
    WHERE invoice_id = $1 AND type = 'manual';
  `, [invoiceId]);

  const newTotal = autoTotal + parseFloat(manualSumRes.rows[0].sum || 0);
  await client.query(`UPDATE public.invoices SET total_amount = $1 WHERE id = $2;`, [newTotal, invoiceId]);

  return { recalculada: true, invoiceId, total: newTotal };
}

/** ===== ROTAS ===== */

// Lista faturas (gera/atualiza automáticos, preserva manuais)
router.get('/invoices/:uid', authenticateToken, async (req, res) => {
  const { uid } = req.params;
  const periodToProcess = req.query.period || new Date().toISOString().slice(0, 7);

  if (req.user.role !== 'master' && req.user.uid !== uid) {
    return res.status(403).json({ error: 'Acesso negado.' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    await calculateAndSaveInvoice(client, uid, periodToProcess);

    const q = `
      SELECT i.id, i.uid, i.period, i.due_date, i.payment_date, i.total_amount, i.status,
             i.paid_at, i.paid_by,
             -- Fechamento e vínculo externo: a tela precisa saber se o valor
             -- ainda pode mudar e se já existe cobrança emitida.
             i.closed_at, i.closed_by,
             i.asaas_payment_id, i.asaas_status, i.asaas_invoice_url,
             COALESCE(json_agg(json_build_object(
               'id', it.id,
               'description', it.description,
               'quantity', it.quantity,
               'unit', it.unit,
               'unit_price', it.unit_price,
               'total_price', it.total_price,
               'type', it.type,
               'service_id', it.service_id,
               'service_date', it.service_date
             ) ORDER BY it.type, it.id) FILTER (WHERE it.id IS NOT NULL), '[]') AS items
      FROM public.invoices i
      LEFT JOIN public.invoice_items it ON i.id = it.invoice_id
      WHERE i.uid = $1
      GROUP BY i.id
      ORDER BY i.period DESC;
    `;
    const { rows } = await client.query(q, [uid]);

    await client.query('COMMIT');
    res.json(rows.map(inv => ({
      ...inv,
      total_amount: parseFloat(inv.total_amount)
    })));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro ao buscar/gerar faturas:', err);
    res.status(500).json({ error: 'Erro interno ao processar faturas.' });
  } finally {
    client.release();
  }
});

// Resumo (master)
router.get('/summary', authenticateToken, requireMaster, async (req, res) => {
  try {
    const q = `
      SELECT 
        u.uid,
        u.email,
        (SELECT i.total_amount FROM public.invoices i WHERE i.uid = u.uid ORDER BY i.period DESC LIMIT 1) AS last_invoice_total,
        (SELECT i.status FROM public.invoices i WHERE i.uid = u.uid ORDER BY i.period DESC LIMIT 1) AS last_invoice_status,
        (SELECT i.period FROM public.invoices i WHERE i.uid = u.uid ORDER BY i.period DESC LIMIT 1) AS last_invoice_period
      FROM public.users u
      WHERE u.role = 'cliente'
      ORDER BY u.email;
    `;
    const { rows } = await db.query(q);
    res.json(rows.map(r => ({
      ...r,
      last_invoice_total: r.last_invoice_total ? parseFloat(r.last_invoice_total) : 0
    })));
  } catch (err) {
    console.error('Erro ao buscar resumo de faturamento:', err);
    res.status(500).json({ error: 'Erro interno ao buscar resumo de faturamento.' });
  }
});

/** ===== NOVO: lista de serviços manuais disponíveis (master) ===== */
router.get('/manual-services', authenticateToken, requireMaster, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT id, name, type, price, config
      FROM public.services
      WHERE type IN ('avulso_simples', 'avulso_quantidade')
      ORDER BY name;
    `);
    res.json(rows.map(s => ({
      id: s.id,
      name: s.name,
      type: s.type,
      price: s.price !== null ? parseFloat(s.price) : null,
      config: s.config || null
    })));
  } catch (err) {
    console.error('Erro ao listar serviços manuais:', err);
    res.status(500).json({ error: 'Erro ao listar serviços manuais.' });
  }
});

/** ===== NOVO: adiciona item manual na fatura (master) ===== */
router.post('/add-manual-item', authenticateToken, requireMaster, async (req, res) => {
  const { uid, period, serviceId, quantity, serviceDate } = req.body || {};

  if (!uid || !period || !serviceId) {
    return res.status(400).json({ error: 'uid, period e serviceId são obrigatórios.' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // 1) Busca o serviço
    const serviceRes = await client.query(`SELECT id, name, type, price, config, unit FROM public.services WHERE id = $1`, [serviceId]);
    if (serviceRes.rowCount === 0) throw new Error('Serviço não encontrado.');
    const service = serviceRes.rows[0];

    // 2) Define quantidade e preço unitário
    let qty = 1;
    let unitPrice = null;

    if (service.type === 'avulso_quantidade') {
      const q = parseInt(quantity, 10);
      if (!q || q < 1) {
        return res.status(400).json({ error: 'Quantidade inválida para serviço por quantidade.' });
      }
      qty = q;
      unitPrice = getTierUnitPrice(service.config, qty);
      if (unitPrice === null) {
        return res.status(400).json({ error: 'Configuração de tiers inválida para este serviço.' });
      }
    } else if (service.type === 'avulso_simples') {
      unitPrice = parseFloat(service.price);
      qty = 1;
    } else {
      return res.status(400).json({ error: 'Tipo de serviço não permitido para lançamento manual.' });
    }

    const totalPrice = unitPrice * qty;

    /* Competência fechada não recebe lançamento.
     *
     * Sem esta guarda o fechamento seria furado: `calculateAndSaveInvoice` sai
     * cedo na fatura fechada, mas o INSERT do item manual e o UPDATE do total
     * abaixo continuariam rodando — o valor congelado mudaria por um caminho
     * diferente. Quem precisa lançar em mês fechado reabre a competência,
     * assumindo que vai ter de reemitir a cobrança.
     */
    const fechada = await client.query(
      'SELECT closed_at FROM public.invoices WHERE uid = $1 AND period = $2',
      [uid, period]
    );
    if (fechada.rows[0]?.closed_at) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Esta competência está fechada e não aceita novos lançamentos. Reabra antes de lançar.',
        code: 'period_closed',
        closedAt: fechada.rows[0].closed_at,
      });
    }

    // 3) Garante fatura do período (gera automáticos e preserva manuais)
    await calculateAndSaveInvoice(client, uid, period);

    // 4) Obtém id da fatura
    const invRes = await client.query(`SELECT id FROM public.invoices WHERE uid = $1 AND period = $2`, [uid, period]);
    if (invRes.rowCount === 0) throw new Error('Fatura não encontrada após geração.');
    const invoiceId = invRes.rows[0].id;

    // 5) Data do serviço (DATE)
    let serviceDateSql = null;
    if (serviceDate) {
      const d = new Date(serviceDate);
      if (!isNaN(d)) serviceDateSql = d.toISOString().slice(0, 10);
    }

    // 6) Insere item manual. Guarda service_id e unidade para o item ser
    //    rastreável até o catálogo e para a fatura poder exibir "150 pacotes".
    await client.query(`
      INSERT INTO public.invoice_items (invoice_id, description, quantity, unit, unit_price, total_price, type, service_id, service_date)
      VALUES ($1, $2, $3, $4, $5, $6, 'manual', $7, $8);
    `, [invoiceId, service.name, qty, service.unit || null, unitPrice, totalPrice, service.id, serviceDateSql]);

    // 7) Recalcula total da fatura (manual + automáticos)
    const sumRes = await client.query(`
      SELECT COALESCE(SUM(total_price), 0) AS sum
      FROM public.invoice_items WHERE invoice_id = $1;
    `, [invoiceId]);
    const newTotal = parseFloat(sumRes.rows[0].sum || 0);
    await client.query(`UPDATE public.invoices SET total_amount = $1 WHERE id = $2`, [newTotal, invoiceId]);

    await client.query('COMMIT');
    res.status(201).json({ ok: true, invoice_id: invoiceId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro ao adicionar item manual:', err);
    res.status(500).json({ error: 'Erro ao adicionar item manual.' });
  } finally {
    client.release();
  }
});

/** ===== NOVO: debug de cobrança - comparação sistema antigo vs novo ===== */
router.get('/debug-comparison/:uid', authenticateToken, requireMaster, async (req, res) => {
  const { uid } = req.params;
  const period = req.query.period || new Date().toISOString().slice(0, 7);
  const [year, month] = period.split('-').map(Number);

  try {
    const comparisonQuery = billingQueryBuilder.buildComparisonQuery(uid, year, month);
    const { rows } = await db.query(comparisonQuery.query, comparisonQuery.params);
    
    const result = {
      period: comparisonQuery.description,
      comparison: rows,
      summary: {
        old_system: rows.find(r => r.system_type === 'old_system'),
        new_system: rows.find(r => r.system_type === 'new_system')
      }
    };
    
    // Calcular diferença
    if (result.summary.old_system && result.summary.new_system) {
      result.summary.difference = {
        items: result.summary.new_system.total_items - result.summary.old_system.total_items,
        amount: result.summary.new_system.total_amount - result.summary.old_system.total_amount
      };
    }
    
    res.json(result);
  } catch (err) {
    console.error('Erro ao comparar sistemas de cobrança:', err);
    res.status(500).json({ error: 'Erro ao comparar sistemas de cobrança.' });
  }
});

/**
 * ===== Baixa/reabertura de fatura (master) =====
 * Só o master altera o status. Antes isso não existia em nenhum lugar: o único
 * status escrito era 'pending', e o recálculo o reescrevia a cada leitura da
 * fatura — por isso o passo 4 de calculateAndSaveInvoice deixou de tocar nele.
 */
router.patch('/invoices/:uid/:period/status', authenticateToken, requireMaster, async (req, res) => {
  const { uid, period } = req.params;
  const { status, paymentDate } = req.body || {};

  const allowed = ['paid', 'pending'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `Status inválido. Use: ${allowed.join(' ou ')}.` });
  }
  if (!/^\d{4}-\d{2}$/.test(period)) {
    return res.status(400).json({ error: 'Competência inválida. Use o formato YYYY-MM.' });
  }

  try {
    // Data do pagamento: a informada, ou hoje. Ao reabrir, é limpa.
    let paidDate = null;
    if (status === 'paid') {
      const parsed = paymentDate ? new Date(paymentDate) : new Date();
      if (Number.isNaN(parsed.getTime())) {
        return res.status(400).json({ error: 'Data de pagamento inválida.' });
      }
      paidDate = parsed.toISOString().slice(0, 10);
    }

    // O cast em $1 é obrigatório: o mesmo parâmetro alimenta uma coluna
    // VARCHAR (status) e uma comparação com literal de texto no CASE. Sem ele o
    // Postgres tenta deduzir dois tipos para o mesmo parâmetro e recusa a query
    // com 42P08 ("inconsistent types deduced ... text versus character varying").
    const isPaid = status === 'paid';
    const { rows, rowCount } = await db.query(`
      UPDATE public.invoices
         SET status = $1::varchar,
             payment_date = $2::date,
             paid_at = CASE WHEN $3::boolean THEN NOW() ELSE NULL END,
             paid_by = CASE WHEN $3::boolean THEN $4::varchar ELSE NULL END
       WHERE uid = $5 AND period = $6
       RETURNING id, uid, period, status, payment_date, paid_at, paid_by, total_amount;
    `, [status, paidDate, isPaid, req.user.email || req.user.uid, uid, period]);

    if (rowCount === 0) {
      return res.status(404).json({ error: 'Fatura não encontrada para este cliente e competência.' });
    }

    const invoice = rows[0];
    res.json({
      ok: true,
      invoice: { ...invoice, total_amount: parseFloat(invoice.total_amount) }
    });
  } catch (err) {
    console.error('Erro ao atualizar status da fatura:', err);
    res.status(500).json({ error: 'Erro interno ao atualizar o status da fatura.' });
  }
});

/**
 * ===== Remove um serviço avulso lançado (master) =====
 * Não existia forma de desfazer um lançamento errado a não ser no banco.
 * Restrito a itens 'manual': storage e shipment são recalculados automaticamente.
 */
router.delete('/manual-item/:itemId', authenticateToken, requireMaster, async (req, res) => {
  const { itemId } = req.params;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    /* Traz o fechamento junto: remover um avulso muda o total, e numa
     * competência fechada isso quebraria o valor congelado pelo mesmo caminho
     * que o lançamento (ver a guarda em POST /add-manual-item). */
    const { rows } = await client.query(`
      SELECT it.id, it.invoice_id, it.type, i.closed_at, i.uid, i.period
        FROM public.invoice_items it
        JOIN public.invoices i ON i.id = it.invoice_id
       WHERE it.id = $1
    `, [itemId]);
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Lançamento não encontrado.' });
    }
    if (rows[0].type !== 'manual') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Somente serviços avulsos podem ser removidos.' });
    }
    if (rows[0].closed_at) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `A competência ${rows[0].period} está fechada e o valor não pode mais mudar. `
          + 'Reabra a competência antes de remover o lançamento.',
        code: 'period_closed',
        closedAt: rows[0].closed_at,
      });
    }

    const invoiceId = rows[0].invoice_id;
    await client.query(`DELETE FROM public.invoice_items WHERE id = $1`, [itemId]);

    const sumRes = await client.query(
      `SELECT COALESCE(SUM(total_price), 0) AS sum FROM public.invoice_items WHERE invoice_id = $1`,
      [invoiceId]
    );
    await client.query(
      `UPDATE public.invoices SET total_amount = $1 WHERE id = $2`,
      [parseFloat(sumRes.rows[0].sum || 0), invoiceId]
    );

    await client.query('COMMIT');
    res.json({ ok: true, invoice_id: invoiceId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro ao remover serviço avulso:', err);
    res.status(500).json({ error: 'Erro ao remover o lançamento.' });
  } finally {
    client.release();
  }
});

/** ===== NOVO: histórico (master) de TODOS os serviços manuais lançados ===== */
router.get('/all-manual-services', authenticateToken, requireMaster, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT 
        ii.id,
        ii.service_date,
        ii.description,
        ii.quantity,
        ii.unit_price,
        ii.total_price,
        i.period,
        u.name AS client_name,
        u.email AS client_email
      FROM public.invoice_items ii
      JOIN public.invoices i ON i.id = ii.invoice_id
      JOIN public.users u ON u.uid = i.uid
      WHERE ii.type = 'manual'
      ORDER BY ii.service_date DESC NULLS LAST, i.period DESC, ii.id DESC;
    `);
    res.json(rows.map(r => ({
      id: r.id,
      service_date: r.service_date,
      description: r.description,
      quantity: r.quantity,
      unit_price: parseFloat(r.unit_price),
      total_price: parseFloat(r.total_price),
      period: r.period,
      client_name: r.client_name,
      client_email: r.client_email
    })));
  } catch (err) {
    console.error('Erro ao buscar histórico de serviços manuais:', err);
    res.status(500).json({ error: 'Erro ao buscar histórico.' });
  }
});

/* Descrições usadas pelo item de armazenamento inicial, hoje e no passado.
 *
 * O rótulo atual vem de STORAGE_LABELS ("Armazenamento Inicial (1m³)" e
 * "... 50% | FULL"), mas faturas antigas foram gravadas com o nome do catálogo,
 * "Armazenamento Base (até 1m³)". Um diagnóstico que olhasse só a grafia nova
 * diria que está tudo certo no histórico. */
const BASE_STORAGE_DESCRIPTION_PATTERNS = ['Armazenamento Base%', 'Armazenamento Inicial%'];

/**
 * ===== Fecha a competência (master) =====
 *
 * Fechar congela o valor: a partir daqui a fatura para de ser recalculada e o
 * total exibido é o mesmo que pode ser cobrado do cliente por fora do sistema.
 *
 * Recalcula UMA última vez antes de congelar. Sem isso, o valor congelado seria
 * o da última vez que alguém abriu a tela, que pode ser de dias antes e não
 * incluir as expedições mais recentes.
 */
router.post('/invoices/:uid/:period/close', authenticateToken, requireMaster, async (req, res) => {
  const { uid, period } = req.params;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    return res.status(400).json({ error: 'Competência inválida. Use o formato AAAA-MM.' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const atual = await client.query(
      'SELECT id, closed_at FROM public.invoices WHERE uid = $1 AND period = $2',
      [uid, period]
    );
    if (atual.rowCount > 0 && atual.rows[0].closed_at) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Esta competência já está fechada.',
        code: 'already_closed',
        closedAt: atual.rows[0].closed_at,
      });
    }

    // Último recálculo com o mês aberto: é o valor que vai ser congelado.
    await calculateAndSaveInvoice(client, uid, period);

    const { rows, rowCount } = await client.query(`
      UPDATE public.invoices
         SET closed_at = NOW(), closed_by = $1
       WHERE uid = $2 AND period = $3
       RETURNING id, uid, period, total_amount, status, due_date, closed_at, closed_by;
    `, [req.user.email || req.user.uid, uid, period]);

    if (rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Não há fatura desta competência para este cliente.' });
    }

    await client.query('COMMIT');
    const fatura = rows[0];
    console.log(`[Cobrança] Competência ${period} de ${uid} fechada por ${fatura.closed_by} `
      + `no valor de ${fatura.total_amount}.`);
    res.json({ ok: true, invoice: { ...fatura, total_amount: parseFloat(fatura.total_amount) } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`Erro ao fechar a competência ${period} de ${uid}:`, err);
    res.status(500).json({ error: 'Erro interno ao fechar a competência.' });
  } finally {
    client.release();
  }
});

/**
 * ===== Reabre a competência (master) =====
 *
 * Volta a fatura a ser recalculada. Serve para corrigir fechamento feito antes
 * da hora.
 *
 * Com cobrança já emitida no provedor, exige `?force=1`: reabrir faz o total
 * voltar a mudar, e aí o valor do sistema pode divergir do documento que o
 * cliente recebeu. Quem reabre nesse caso tem que saber que vai precisar
 * cancelar ou reemitir a cobrança.
 */
router.post('/invoices/:uid/:period/reopen', authenticateToken, requireMaster, async (req, res) => {
  const { uid, period } = req.params;
  const force = req.query.force === '1';
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    return res.status(400).json({ error: 'Competência inválida. Use o formato AAAA-MM.' });
  }

  try {
    const atual = await db.query(
      'SELECT id, closed_at, asaas_payment_id, status FROM public.invoices WHERE uid = $1 AND period = $2',
      [uid, period]
    );
    if (atual.rowCount === 0) {
      return res.status(404).json({ error: 'Não há fatura desta competência para este cliente.' });
    }
    if (!atual.rows[0].closed_at) {
      return res.json({ ok: true, alreadyOpen: true, message: 'Esta competência já está aberta.' });
    }
    if (atual.rows[0].asaas_payment_id && !force) {
      return res.status(409).json({
        error: 'Esta competência já tem cobrança emitida. Reabrir faz o total voltar a mudar e ele pode '
          + 'divergir do documento enviado ao cliente. Repita com force=1 para assumir isso.',
        code: 'has_external_charge',
        paymentId: atual.rows[0].asaas_payment_id,
      });
    }

    const { rows } = await db.query(`
      UPDATE public.invoices
         SET closed_at = NULL, closed_by = NULL
       WHERE uid = $1 AND period = $2
       RETURNING id, uid, period, total_amount, status, closed_at;
    `, [uid, period]);

    console.log(`[Cobrança] Competência ${period} de ${uid} REABERTA por ${req.user.email || req.user.uid}`
      + `${force ? ' (forçado, havia cobrança emitida)' : ''}.`);
    res.json({ ok: true, invoice: { ...rows[0], total_amount: parseFloat(rows[0].total_amount) } });
  } catch (err) {
    console.error(`Erro ao reabrir a competência ${period} de ${uid}:`, err);
    res.status(500).json({ error: 'Erro interno ao reabrir a competência.' });
  }
});

/**
 * ===== Diagnóstico da duplicidade de armazenamento inicial (master) =====
 *
 * SOMENTE LEITURA. Responde três perguntas, que são coisas diferentes:
 *
 * 1. `faturasComDuplicidade`: competências com mais de uma linha de
 *    armazenamento inicial. Se o `type` é 'storage', o recálculo resolve — é o
 *    que POST /recalculate faz.
 * 2. `itensForaDoRecalculo`: linha de armazenamento gravada com `type` diferente
 *    de 'storage' (por exemplo 'manual'). O recálculo NÃO apaga essas: ele só
 *    remove type IN ('storage','shipment'). Elas convivem com a linha automática
 *    e continuam somando no total. Exigem decisão humana, por isso só listo.
 * 3. `clientesComDoisContratosBase`: a origem do problema. Enquanto os dois
 *    contratos existirem, a fatura escolhe o vigente (o mais recente) — não
 *    duplica mais, mas o plano antigo continua cadastrado.
 */
router.get('/storage-duplicates', authenticateToken, requireMaster, async (req, res) => {
  try {
    const duplicadas = await db.query(`
      SELECT i.uid, u.name AS client_name, u.email AS client_email, i.period,
             i.total_amount,
             COUNT(*)::int AS itens_base,
             json_agg(json_build_object(
               'id', it.id, 'description', it.description, 'type', it.type,
               'total_price', it.total_price
             ) ORDER BY it.id) AS itens
        FROM public.invoices i
        JOIN public.invoice_items it ON it.invoice_id = i.id
        LEFT JOIN public.users u ON u.uid = i.uid
       WHERE it.description ILIKE ANY ($1::text[])
       GROUP BY i.id, i.uid, u.name, u.email, i.period, i.total_amount
      HAVING COUNT(*) > 1
       ORDER BY i.period DESC, u.name NULLS LAST;
    `, [BASE_STORAGE_DESCRIPTION_PATTERNS]);

    const foraDoRecalculo = await db.query(`
      SELECT it.id, it.description, it.type, it.total_price,
             i.uid, i.period, u.name AS client_name
        FROM public.invoice_items it
        JOIN public.invoices i ON i.id = it.invoice_id
        LEFT JOIN public.users u ON u.uid = i.uid
       WHERE it.description ILIKE ANY ($1::text[])
         AND it.type <> 'storage'
       ORDER BY i.period DESC, it.id;
    `, [BASE_STORAGE_DESCRIPTION_PATTERNS]);

    const contratos = await db.query(`
      SELECT uc.uid, u.name AS client_name, u.email AS client_email,
             json_agg(json_build_object(
               'contractId', uc.id, 'serviceId', uc.service_id, 'name', s.name,
               'type', s.type, 'price', uc.price, 'startDate', uc.start_date
             ) ORDER BY uc.start_date DESC, uc.id DESC) AS contratos
        FROM public.user_contracts uc
        JOIN public.services s ON s.id = uc.service_id
        LEFT JOIN public.users u ON u.uid = uc.uid
       WHERE s.type = ANY($1::text[])
       GROUP BY uc.uid, u.name, u.email
      HAVING COUNT(*) > 1
       ORDER BY u.name NULLS LAST;
    `, [BASE_STORAGE_TYPES]);

    res.json({
      faturasComDuplicidade: duplicadas.rows,
      itensForaDoRecalculo: foraDoRecalculo.rows,
      clientesComDoisContratosBase: contratos.rows,
      resumo: {
        faturasAfetadas: duplicadas.rowCount,
        itensQueORecalculoNaoResolve: foraDoRecalculo.rowCount,
        clientesComDoisContratosBase: contratos.rowCount,
      },
    });
  } catch (err) {
    console.error('Erro ao diagnosticar duplicidade de armazenamento:', err);
    res.status(500).json({ error: 'Erro ao diagnosticar duplicidade de armazenamento.' });
  }
});

/**
 * ===== Recálculo das competências passadas (master) =====
 *
 * A regra nova de armazenamento vale para qualquer competência, mas a fatura só
 * é regravada quando alguém abre aquele período: GET /invoices/:uid recalcula
 * apenas `req.query.period`. Sem isto, corrigir "o passado" dependeria de abrir
 * cada mês de cada cliente na mão.
 *
 * Não apaga dado de negócio. Reusa `calculateAndSaveInvoice`, cujo DELETE atinge
 * somente `type IN ('storage','shipment')` — os itens automáticos, que ele
 * recria na sequência. Lançamento manual, status de pagamento e paid_at/paid_by
 * ficam onde estão.
 *
 * Uma transação POR competência: um período que falhe não desfaz os outros, e a
 * resposta diz exatamente o que mudou em cada um. Em série de propósito — o
 * recálculo varre vendas, e treze consultas dessas em paralelo já esgotaram o
 * pool antes (ver o incidente de 25/08).
 *
 * `?dryRun=1` calcula nada e só devolve a lista de competências que seriam
 * processadas.
 */
router.post('/recalculate/:uid', authenticateToken, requireMaster, async (req, res) => {
  const { uid } = req.params;
  const dryRun = req.query.dryRun === '1';
  /* Fatura PAGA fica de fora por padrão.
   *
   * O recálculo não mexe no status (nem em paid_at/paid_by), mas mexe no
   * `total_amount`. Numa competência já quitada, corrigir a duplicidade faria o
   * sistema passar a exibir um total MENOR do que o cliente efetivamente pagou —
   * um problema contábil criado por uma correção técnica. Quem quiser assumir
   * isso pede explicitamente com ?includePaid=1. */
  const includePaid = req.query.includePaid === '1';
  const pedidos = Array.isArray(req.body?.periods) ? req.body.periods : null;

  const PERIODO_VALIDO = /^\d{4}-(0[1-9]|1[0-2])$/;
  if (pedidos && pedidos.some((p) => !PERIODO_VALIDO.test(String(p)))) {
    return res.status(400).json({ error: 'Competência inválida. Use o formato AAAA-MM.' });
  }

  try {
    const filtroPago = includePaid ? '' : " AND COALESCE(status, '') <> 'paid'";
    /* Competência fechada não entra na lista. `calculateAndSaveInvoice` já sai
     * cedo nesse caso, então incluí-la só produziria linhas de relatório
     * dizendo "nada mudou" — e esconderia o motivo real. */
    const alvo = pedidos && pedidos.length
      ? pedidos.map(String)
      : (await db.query(
          `SELECT period FROM public.invoices
            WHERE uid = $1 AND closed_at IS NULL${filtroPago}
            ORDER BY period ASC`,
          [uid]
        )).rows.map((r) => r.period);

    if (alvo.length === 0) {
      return res.json({ uid, periodos: [], resumo: { processados: 0, alterados: 0, falhas: 0 } });
    }
    if (dryRun) {
      return res.json({ uid, dryRun: true, periodos: alvo, resumo: { aProcessar: alvo.length } });
    }

    // Contagem de linhas de armazenamento inicial e total, antes e depois.
    const medir = async (client, period) => {
      const { rows } = await client.query(`
        SELECT i.total_amount,
               COUNT(it.id) FILTER (WHERE it.description ILIKE ANY ($3::text[]))::int AS itens_base
          FROM public.invoices i
          LEFT JOIN public.invoice_items it ON it.invoice_id = i.id
         WHERE i.uid = $1 AND i.period = $2
         GROUP BY i.id, i.total_amount;
      `, [uid, period, BASE_STORAGE_DESCRIPTION_PATTERNS]);
      if (rows.length === 0) return { total: null, itensBase: 0 };
      return { total: parseFloat(rows[0].total_amount), itensBase: rows[0].itens_base };
    };

    const resultado = [];
    for (const period of alvo) {
      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');
        const antes = await medir(client, period);
        await calculateAndSaveInvoice(client, uid, period);
        const depois = await medir(client, period);
        await client.query('COMMIT');
        resultado.push({
          period,
          ok: true,
          itensBaseAntes: antes.itensBase,
          itensBaseDepois: depois.itensBase,
          totalAntes: antes.total,
          totalDepois: depois.total,
          alterado: antes.itensBase !== depois.itensBase || antes.total !== depois.total,
        });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(`Erro ao recalcular ${uid} ${period}:`, err.message);
        resultado.push({ period, ok: false, erro: err.message });
      } finally {
        client.release();
      }
    }

    res.json({
      uid,
      includePaid,
      periodos: resultado,
      resumo: {
        processados: resultado.filter((r) => r.ok).length,
        alterados: resultado.filter((r) => r.ok && r.alterado).length,
        falhas: resultado.filter((r) => !r.ok).length,
      },
    });
  } catch (err) {
    console.error(`Erro ao recalcular faturas de ${uid}:`, err);
    res.status(500).json({ error: 'Erro ao recalcular as faturas do cliente.' });
  }
});

/**
 * ===== Correção retroativa da duplicidade de armazenamento inicial =====
 *
 * Roda UMA vez, em segundo plano, depois que o servidor já está atendendo
 * (chamada em server.js). Existe porque corrigir a regra de geração não reescreve
 * o que já está gravado: `GET /invoices/:uid` só recalcula a competência que
 * alguém abre. Sem isto, "corrigir o passado" dependia de abrir mês a mês, de
 * cliente em cliente, ou de chamar POST /recalculate/:uid na mão para cada um.
 *
 * Escopo deliberadamente estreito:
 *
 *   - só faturas que REALMENTE têm mais de uma linha de armazenamento inicial;
 *   - só faturas NÃO pagas, pelo mesmo motivo do endpoint acima: numa
 *     competência quitada, baixar o total para menos do que o cliente pagou é
 *     criar um problema contábil. As pagas ficam listadas em
 *     GET /billing/storage-duplicates, para decisão humana.
 *
 * Uma transação por competência, em série, com pausa entre elas — recálculo
 * varre vendas, e treze dessas em paralelo já esgotaram o pool antes.
 *
 * O marcador em system_settings só é gravado quando TODAS passam: se alguma
 * falhar, a próxima subida tenta de novo. O recálculo é idempotente, então
 * repetir não causa dano.
 */
async function recalculateDuplicatedStorageInvoices() {
  const MARCADOR = 'storage_base_duplicate_invoices_recalculated_v1';

  try {
    const feito = await db.query('SELECT 1 FROM public.system_settings WHERE key = $1', [MARCADOR]);
    if (feito.rowCount > 0) return;

    const marcarConcluido = () => db.query(
      `INSERT INTO public.system_settings (key, value, updated_at)
       VALUES ($1, to_jsonb(NOW()::text), NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [MARCADOR]
    );

    const alvo = await db.query(`
      SELECT i.uid, i.period,
             COUNT(*)::int AS itens_base,
             COALESCE(i.status, '') = 'paid' AS paga,
             i.closed_at IS NOT NULL AS fechada
        FROM public.invoices i
        JOIN public.invoice_items it ON it.invoice_id = i.id
       WHERE it.description ILIKE ANY ($1::text[])
       GROUP BY i.id, i.uid, i.period, i.status, i.closed_at
      HAVING COUNT(*) > 1
       ORDER BY i.period ASC
    `, [BASE_STORAGE_DESCRIPTION_PATTERNS]);

    if (alvo.rowCount === 0) {
      await marcarConcluido();
      return;
    }

    /* Preservadas por dois motivos diferentes, e os dois são deliberados:
     * paga (baixar o total abaixo do que o cliente pagou é problema contábil) e
     * fechada (o valor foi congelado justamente para não mudar mais). */
    const pagas = alvo.rows.filter((r) => r.paga && !r.fechada);
    const fechadas = alvo.rows.filter((r) => r.fechada);
    const aCorrigir = alvo.rows.filter((r) => !r.paga && !r.fechada);

    console.log(`   -> Correção retroativa: ${alvo.rowCount} fatura(s) com armazenamento inicial duplicado `
      + `(${aCorrigir.length} a recalcular, ${pagas.length} já paga(s), ${fechadas.length} fechada(s)).`);

    let corrigidas = 0;
    let falhas = 0;

    for (const { uid, period } of aCorrigir) {
      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');
        await calculateAndSaveInvoice(client, uid, period);
        await client.query('COMMIT');
        corrigidas += 1;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        falhas += 1;
        console.warn(`   -> Falha ao recalcular ${uid} ${period}: ${err.message}`);
      } finally {
        client.release();
      }
      // Devolve a vez para as requisições entre competências.
      await new Promise((resolve) => setTimeout(resolve, 120));
    }

    if (pagas.length > 0) {
      console.warn('   -> Faturas PAGAS com duplicidade não foram alteradas (o total pago não seria mais o exibido): '
        + `${pagas.map((r) => `${r.uid}/${r.period}`).join(', ')}. `
        + 'Use GET /api/billing/storage-duplicates para revisar.');
    }
    if (fechadas.length > 0) {
      console.warn('   -> Faturas com competência FECHADA não foram alteradas (o valor está congelado): '
        + `${fechadas.map((r) => `${r.uid}/${r.period}`).join(', ')}. `
        + 'Reabra a competência se quiser recalcular.');
    }

    if (falhas === 0) {
      await marcarConcluido();
      console.log(`   -> Concluído: ${corrigidas} fatura(s) recalculada(s).`);
    } else {
      console.warn(`   -> Correção retroativa incompleta (${corrigidas} ok, ${falhas} falha(s)); `
        + 'será retomada na próxima subida.');
    }
  } catch (error) {
    // Nunca fatal: é correção de dado histórico, não parte da prontidão.
    console.warn(`   -> Correção retroativa do armazenamento não concluída agora: ${error.message}`);
  }
}

/* ==========================================================================
 * Emissão, sincronização, alteração e cancelamento da cobrança
 * ========================================================================== */

/* Tradução do status do provedor para o status local.
 *
 * O local tem domínio fechado em ['paid','pending'] (ver PATCH .../status), e
 * `asaas_status` guarda o valor CRU do provedor. Não misturar os dois é
 * deliberado: a tela lê o local, e o master pode dar baixa à mão quando o
 * cliente paga por fora.
 *
 * CONFIRMED conta como pago, e isso importa: no cartão de crédito o RECEIVED só
 * chega 32 dias depois do CONFIRMED (o dinheiro fica retido). Esperar RECEIVED
 * deixaria quem pagou com cartão aparecendo como devedor por um mês. */
const ASAAS_PAGO = ['CONFIRMED', 'RECEIVED', 'RECEIVED_IN_CASH'];

/* Estorno e chargeback DESFAZEM a baixa. É o único caso em que o provedor pode
 * rebaixar uma fatura paga: OVERDUE não rebaixa nada, senão uma fatura que o
 * cliente pagou por PIX fora do sistema e o master baixou na mão voltaria
 * sozinha para pendente. */
const ASAAS_ESTORNADO = [
  'REFUNDED', 'REFUND_REQUESTED', 'REFUND_IN_PROGRESS',
  'CHARGEBACK_REQUESTED', 'CHARGEBACK_DISPUTE', 'AWAITING_CHARGEBACK_REVERSAL',
];

/**
 * Grava na fatura local o que o provedor diz sobre a cobrança.
 *
 * `asaas_status` é sempre atualizado. O `status` local só muda quando o
 * provedor afirma algo conclusivo (pago ou estornado) — nos outros estados a
 * baixa manual do master é preservada.
 */
async function aplicarCobrancaNaFatura(client, { uid, period, cobranca }) {
  const statusProvedor = String(cobranca?.status || '').toUpperCase();
  const pago = ASAAS_PAGO.includes(statusProvedor);
  const estornado = ASAAS_ESTORNADO.includes(statusProvedor);

  await client.query(`
    UPDATE public.invoices
       SET asaas_payment_id = $1,
           asaas_status = $2,
           asaas_invoice_url = $3,
           asaas_synced_at = NOW()
     WHERE uid = $4 AND period = $5
  `, [cobranca.id, statusProvedor || null, cobranca.invoiceUrl || null, uid, period]);

  if (pago) {
    /* `paid_by` recebe 'asaas' e não um e-mail: quem deu a baixa foi o
     * provedor, e essa distinção é o que permite auditar depois se o valor
     * entrou de fato ou se alguém marcou à mão. `paymentDate` do provedor
     * quando vier; senão, hoje. */
    await client.query(`
      UPDATE public.invoices
         SET status = 'paid',
             payment_date = COALESCE($1::date, CURRENT_DATE),
             paid_at = COALESCE(paid_at, NOW()),
             paid_by = COALESCE(paid_by, 'asaas')
       WHERE uid = $2 AND period = $3
    `, [cobranca.paymentDate || cobranca.clientPaymentDate || null, uid, period]);
    return { statusLocal: 'paid', statusProvedor };
  }

  if (estornado) {
    await client.query(`
      UPDATE public.invoices
         SET status = 'pending', payment_date = NULL, paid_at = NULL, paid_by = NULL
       WHERE uid = $1 AND period = $2
    `, [uid, period]);
    return { statusLocal: 'pending', statusProvedor };
  }

  return { statusLocal: null, statusProvedor };
}

/** Carrega a fatura com o que a emissão precisa validar. */
async function carregarFaturaParaCobranca(uid, period) {
  const { rows } = await db.query(`
    SELECT i.id, i.uid, i.period, i.due_date, i.total_amount, i.status, i.closed_at,
           i.asaas_payment_id, i.asaas_status, i.asaas_invoice_url,
           u.name AS client_name, u.email AS client_email, u.asaas_customer_id
      FROM public.invoices i
      JOIN public.users u ON u.uid = i.uid
     WHERE i.uid = $1 AND i.period = $2
  `, [uid, period]);
  return rows[0] || null;
}

/**
 * ===== Emite a cobrança da competência (master) =====
 *
 * Exige competência FECHADA. Não é burocracia: com o mês aberto o total é
 * recalculado a cada abertura da tela, e uma venda com processed_at retroativo
 * mudaria o valor DEPOIS de o cliente ter recebido o documento. O fechamento é
 * o que torna o valor comunicável para fora.
 *
 * Idempotência em três camadas, porque cobrar duas vezes é o pior defeito
 * possível aqui:
 *   1. `asaas_payment_id` local preenchido -> 409, com o id que já existe.
 *   2. Busca no provedor por externalReference -> ADOTA a cobrança em vez de
 *      criar outra. Isto cobre o caso real: o Asaas criou, a rede caiu antes de
 *      gravarmos o id, e alguém clicou de novo.
 *   3. Índice único parcial idx_invoices_asaas_payment no banco.
 *
 * `?dryRun=1` valida tudo e mostra o que SERIA enviado, sem criar nada e sem
 * notificar ninguém. É o jeito de testar o caminho inteiro em produção antes de
 * emitir de verdade.
 */
router.post('/invoices/:uid/:period/charge', authenticateToken, requireMaster, async (req, res) => {
  const { uid, period } = req.params;
  const dryRun = req.query.dryRun === '1';
  const { dueDate: vencimentoInformado, billingType, description } = req.body || {};

  if (!PERIODO_VALIDO.test(period)) {
    return res.status(400).json({ error: 'Competência inválida. Use o formato AAAA-MM.' });
  }

  try {
    const fatura = await carregarFaturaParaCobranca(uid, period);
    if (!fatura) {
      return res.status(404).json({ error: 'Não há fatura desta competência para este cliente.' });
    }

    if (!fatura.closed_at) {
      return res.status(409).json({
        error: 'Feche a competência antes de emitir a cobrança. Com o mês aberto o total ainda muda, '
          + 'e o cliente receberia um documento com valor diferente do que o sistema vai exibir depois.',
        code: 'period_not_closed',
      });
    }

    const valor = round(parseFloat(fatura.total_amount) || 0);
    if (valor <= 0) {
      return res.status(422).json({
        error: 'A fatura desta competência está zerada; não há o que cobrar.',
        code: 'zero_amount',
      });
    }

    if (fatura.asaas_payment_id) {
      return res.status(409).json({
        error: 'Esta competência já tem cobrança emitida.',
        code: 'already_charged',
        paymentId: fatura.asaas_payment_id,
        invoiceUrl: fatura.asaas_invoice_url,
      });
    }

    if (!fatura.asaas_customer_id) {
      return res.status(422).json({
        error: 'Este cliente ainda não está vinculado ao provedor. Vincule antes de emitir.',
        code: 'missing_customer',
      });
    }

    /* Vencimento no passado é recusado pelo provedor. Em vez de trocar a data em
     * silêncio — o que faria a cobrança vencer num dia diferente do que a tela
     * mostra — a rota recusa e pede a data nova explicitamente. */
    const hoje = new Date().toISOString().slice(0, 10);
    const vencimentoFatura = new Date(fatura.due_date).toISOString().slice(0, 10);
    const vencimento = vencimentoInformado || vencimentoFatura;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(vencimento)) {
      return res.status(400).json({ error: 'Data de vencimento inválida. Use AAAA-MM-DD.' });
    }
    if (vencimento < hoje) {
      return res.status(422).json({
        error: `O vencimento desta competência (${vencimentoFatura}) já passou, e o provedor recusa cobrança `
          + 'com data no passado. Informe uma nova data de vencimento para emitir.',
        code: 'due_date_in_past',
        invoiceDueDate: vencimentoFatura,
        today: hoje,
      });
    }

    const descricao = description
      || `CyberDock - Fatura ${period} - ${fatura.client_name || fatura.client_email}`;

    if (dryRun) {
      return res.json({
        dryRun: true,
        wouldSend: {
          customer: fatura.asaas_customer_id,
          value: valor,
          dueDate: vencimento,
          description: descricao,
          billingType: billingType || 'UNDEFINED',
          externalReference: asaas.invoiceReference(uid, period),
        },
        message: 'Nada foi criado no provedor e ninguém foi notificado.',
      });
    }

    // Camada 2 da idempotência: o provedor pode já ter a cobrança.
    let cobranca = await asaas.findPaymentByInvoice(uid, period);
    let adotada = Boolean(cobranca);

    if (!cobranca) {
      cobranca = await asaas.createPayment({
        customerId: fatura.asaas_customer_id,
        value: valor,
        dueDate: vencimento,
        description: descricao,
        uid,
        period,
        ...(billingType ? { billingType } : {}),
      });
    }

    if (!cobranca?.id) {
      return res.status(502).json({ error: 'O provedor não devolveu o identificador da cobrança.' });
    }

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const aplicado = await aplicarCobrancaNaFatura(client, { uid, period, cobranca });
      await client.query('COMMIT');

      console.log(`[Cobrança] ${adotada ? 'Adotada' : 'Emitida'} cobrança ${cobranca.id} para ${uid} ${period} `
        + `no valor de ${valor} por ${req.user.email || req.user.uid}.`);

      return res.json({
        ok: true,
        adopted: adotada,
        paymentId: cobranca.id,
        status: cobranca.status,
        statusLocal: aplicado.statusLocal,
        invoiceUrl: cobranca.invoiceUrl || null,
        bankSlipUrl: cobranca.bankSlipUrl || null,
        value: valor,
        dueDate: vencimento,
      });
    } catch (erro) {
      await client.query('ROLLBACK').catch(() => {});
      /* A cobrança EXISTE no provedor e o vínculo não foi gravado. Não é 500
       * silencioso: a resposta entrega o id para não perder o rastro, e uma nova
       * tentativa vai adotá-la pela camada 2 em vez de duplicar. */
      console.error(`[Cobrança] Cobrança ${cobranca.id} criada mas NÃO vinculada a ${uid} ${period}:`, erro);
      return res.status(500).json({
        error: 'A cobrança foi criada no provedor, mas o vínculo com a fatura não foi gravado. '
          + 'Repita a emissão: ela reconhece a cobrança existente em vez de criar outra.',
        code: 'link_failed',
        paymentId: cobranca.id,
      });
    } finally {
      client.release();
    }
  } catch (erro) {
    return responderErroAsaas(res, erro, `emitir cobrança de ${uid} ${period}`);
  }
});

/**
 * ===== Relê a cobrança no provedor (master) =====
 *
 * O webhook é o caminho normal, este é o de conferência e de recuperação: se um
 * evento se perdeu, ou se a fila do provedor ficou pausada, isto traz o estado
 * atual. Ler a cobrança pelo id é a fonte da verdade — evento pode chegar fora
 * de ordem, `getPayment` sempre diz o agora.
 */
router.post('/invoices/:uid/:period/charge/sync', authenticateToken, requireMaster, async (req, res) => {
  const { uid, period } = req.params;
  if (!PERIODO_VALIDO.test(period)) {
    return res.status(400).json({ error: 'Competência inválida. Use o formato AAAA-MM.' });
  }

  try {
    const fatura = await carregarFaturaParaCobranca(uid, period);
    if (!fatura) return res.status(404).json({ error: 'Fatura não encontrada.' });
    if (!fatura.asaas_payment_id) {
      return res.status(409).json({
        error: 'Esta competência não tem cobrança emitida.',
        code: 'not_charged',
      });
    }

    const cobranca = await asaas.getPayment(fatura.asaas_payment_id);

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const aplicado = await aplicarCobrancaNaFatura(client, { uid, period, cobranca });
      await client.query('COMMIT');
      return res.json({
        ok: true,
        paymentId: cobranca.id,
        status: cobranca.status,
        statusLocal: aplicado.statusLocal,
        invoiceUrl: cobranca.invoiceUrl || null,
        value: cobranca.value,
        dueDate: cobranca.dueDate,
      });
    } catch (erro) {
      await client.query('ROLLBACK').catch(() => {});
      throw erro;
    } finally {
      client.release();
    }
  } catch (erro) {
    return responderErroAsaas(res, erro, `sincronizar cobrança de ${uid} ${period}`);
  }
});

/**
 * ===== Altera o vencimento da cobrança (master) =====
 *
 * Só vencimento. Alterar o VALOR aqui criaria divergência silenciosa com o
 * total congelado da competência: a fatura diria um número e o documento do
 * cliente, outro. Para valor diferente o caminho é cancelar, reabrir a
 * competência, corrigir e emitir de novo — passos que deixam rastro nos dois
 * lados.
 *
 * O caso de uso real é o cliente pedindo mais prazo.
 */
router.patch('/invoices/:uid/:period/charge', authenticateToken, requireMaster, async (req, res) => {
  const { uid, period } = req.params;
  const { dueDate } = req.body || {};

  if (!PERIODO_VALIDO.test(period)) {
    return res.status(400).json({ error: 'Competência inválida. Use o formato AAAA-MM.' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dueDate || ''))) {
    return res.status(400).json({ error: 'Informe a nova data de vencimento em AAAA-MM-DD.' });
  }
  if (dueDate < new Date().toISOString().slice(0, 10)) {
    return res.status(422).json({ error: 'A nova data de vencimento não pode estar no passado.' });
  }

  try {
    const fatura = await carregarFaturaParaCobranca(uid, period);
    if (!fatura) return res.status(404).json({ error: 'Fatura não encontrada.' });
    if (!fatura.asaas_payment_id) {
      return res.status(409).json({ error: 'Esta competência não tem cobrança emitida.', code: 'not_charged' });
    }
    if (ASAAS_PAGO.includes(String(fatura.asaas_status || '').toUpperCase())) {
      return res.status(409).json({
        error: 'Esta cobrança já foi paga; o vencimento não muda mais.',
        code: 'already_paid',
      });
    }

    /* O provedor exige valor e forma de pagamento nesta chamada mesmo quando não
     * mudam, então releio a cobrança para reenviar o que já está lá — mandar o
     * total local poderia sobrescrever um valor ajustado no painel do Asaas. */
    const atual = await asaas.getPayment(fatura.asaas_payment_id);
    const cobranca = await asaas.updatePayment(fatura.asaas_payment_id, {
      value: atual.value,
      dueDate,
      description: atual.description,
      billingType: atual.billingType,
    });

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await aplicarCobrancaNaFatura(client, { uid, period, cobranca });
      /* O vencimento local acompanha: a competência está fechada, então
       * calculateAndSaveInvoice não vai sobrescrever isto depois. */
      await client.query(
        'UPDATE public.invoices SET due_date = $1::date WHERE uid = $2 AND period = $3',
        [dueDate, uid, period]
      );
      await client.query('COMMIT');
    } catch (erro) {
      await client.query('ROLLBACK').catch(() => {});
      throw erro;
    } finally {
      client.release();
    }

    console.log(`[Cobrança] Vencimento da cobrança ${fatura.asaas_payment_id} (${uid} ${period}) alterado `
      + `para ${dueDate} por ${req.user.email || req.user.uid}.`);

    return res.json({ ok: true, paymentId: cobranca.id, dueDate, status: cobranca.status });
  } catch (erro) {
    return responderErroAsaas(res, erro, `alterar cobrança de ${uid} ${period}`);
  }
});

/**
 * ===== Cancela a cobrança (master) =====
 *
 * Remove a cobrança no provedor e desfaz o vínculo, deixando a competência
 * pronta para reemissão. Serve para cobrança emitida por engano, valor errado
 * ou cliente que pediu outro meio de pagamento.
 *
 * Cobrança PAGA não é cancelada por aqui: devolver dinheiro é estorno, operação
 * diferente, com consequência contábil, e tem que ser decidida no painel do
 * provedor e não por um clique numa tela de administração.
 *
 * A baixa local NÃO é desfeita junto. Se o pagamento entrou, ele entrou — o
 * vínculo sai, o fato não.
 */
router.delete('/invoices/:uid/:period/charge', authenticateToken, requireMaster, async (req, res) => {
  const { uid, period } = req.params;
  if (!PERIODO_VALIDO.test(period)) {
    return res.status(400).json({ error: 'Competência inválida. Use o formato AAAA-MM.' });
  }

  try {
    const fatura = await carregarFaturaParaCobranca(uid, period);
    if (!fatura) return res.status(404).json({ error: 'Fatura não encontrada.' });
    if (!fatura.asaas_payment_id) {
      return res.json({ ok: true, alreadyClear: true, message: 'Esta competência não tem cobrança emitida.' });
    }
    if (ASAAS_PAGO.includes(String(fatura.asaas_status || '').toUpperCase())) {
      return res.status(409).json({
        error: 'Esta cobrança já foi paga e não pode ser cancelada. Estorno é feito no painel do provedor.',
        code: 'already_paid',
        paymentId: fatura.asaas_payment_id,
      });
    }

    const paymentId = fatura.asaas_payment_id;

    /* Cobrança que não existe mais no provedor (apagada no painel) devolve 404.
     * Isso não impede limpar o vínculo daqui — insistir deixaria a fatura presa
     * a um id morto, sem poder reemitir. */
    try {
      await asaas.deletePayment(paymentId);
    } catch (erro) {
      if (erro?.name === 'AsaasError' && erro.status === 404) {
        console.warn(`[Cobrança] ${paymentId} não existe mais no provedor; limpando o vínculo local.`);
      } else {
        throw erro;
      }
    }

    await db.query(`
      UPDATE public.invoices
         SET asaas_payment_id = NULL, asaas_status = NULL,
             asaas_invoice_url = NULL, asaas_synced_at = NOW()
       WHERE uid = $1 AND period = $2
    `, [uid, period]);

    console.log(`[Cobrança] Cobrança ${paymentId} de ${uid} ${period} cancelada por `
      + `${req.user.email || req.user.uid}.`);

    return res.json({ ok: true, paymentId, message: 'Cobrança cancelada e vínculo desfeito.' });
  } catch (erro) {
    return responderErroAsaas(res, erro, `cancelar cobrança de ${uid} ${period}`);
  }
});

/**
 * ===== Webhook do provedor =====
 *
 * SEM authenticateToken de propósito: quem chama é o Asaas, não um usuário. A
 * autenticidade vem do token compartilhado no header `asaas-access-token`, que
 * nós definimos ao cadastrar o webhook. Sem ASAAS_WEBHOOK_TOKEN no ambiente,
 * `isValidWebhookToken` recusa TUDO — endpoint que dá baixa em pagamento não
 * pode ficar aberto.
 *
 * A ordem das operações segue a recomendação do provedor, e cada passo tem
 * motivo:
 *
 * 1. Valida o token. Inválido responde 401: não é o Asaas, ou está mal
 *    configurado, e nesse caso a retentativa dele é desejável.
 * 2. Grava o evento com ON CONFLICT (event_id) DO NOTHING. A entrega é "at least
 *    once": o MESMO evento chega mais de uma vez, e a chave primária torna
 *    processar duas vezes impossível por construção.
 * 3. Responde 200 IMEDIATAMENTE. Depois de 15 falhas consecutivas o provedor
 *    pausa a fila, e evento não entregue se perde em 14 dias.
 * 4. Só então processa. Falha no processamento deixa `processed_at` nulo com o
 *    motivo em `error`, e não custa a fila.
 *
 * Evento de qualquer erro responde 200 também: só o token errado responde 401.
 * Devolver erro por problema NOSSO é o caminho para a fila pausada.
 */
router.post('/webhook/asaas', async (req, res) => {
  if (!asaas.isValidWebhookToken(req.get('asaas-access-token'))) {
    console.warn('[Cobrança] Webhook recusado: token ausente ou inválido.');
    return res.status(401).json({ error: 'Token de webhook inválido.' });
  }

  const evento = req.body || {};
  const eventId = String(evento.id || '').slice(0, 120);
  const eventType = String(evento.event || '').slice(0, 60) || null;
  const cobranca = evento.payment || null;

  /* Evento sem id não tem como ser deduplicado. Aceito e registro, porque
   * recusar faria o provedor reenviar para sempre. */
  if (!eventId) {
    console.warn(`[Cobrança] Webhook sem id (event=${eventType}); nada a deduplicar.`);
    return res.status(200).json({ received: true, ignored: 'missing_event_id' });
  }

  /* A referência externa é o que separa o que é nosso do que não é: no Asaas
   * TUDO é payment, inclusive transferência recebida e PIX avulso que nada tem
   * a ver com fatura. Sem o nosso prefixo, o evento é só arquivado. */
  const referencia = String(cobranca?.externalReference || '');
  const nosso = referencia.startsWith('cyberdock:invoice:');
  const [, , uidEvento, periodoEvento] = nosso ? referencia.split(':') : [];

  let novo = false;
  try {
    const gravado = await db.query(`
      INSERT INTO public.asaas_webhook_events
        (event_id, event_type, payment_id, uid, period, payload)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (event_id) DO NOTHING
      RETURNING event_id
    `, [eventId, eventType, cobranca?.id || null, uidEvento || null,
      periodoEvento || null, JSON.stringify(evento)]);
    novo = gravado.rowCount > 0;
  } catch (erro) {
    // Não conseguir gravar não justifica derrubar a fila do provedor.
    console.error('[Cobrança] Falha ao registrar evento de webhook:', erro.message);
    return res.status(200).json({ received: true, stored: false });
  }

  // 200 antes de processar. Nada abaixo daqui pode alterar a resposta.
  res.status(200).json({ received: true, duplicate: !novo });

  if (!novo) return;
  if (!nosso || !uidEvento || !periodoEvento) {
    await db.query(
      `UPDATE public.asaas_webhook_events SET processed_at = NOW(), error = $2 WHERE event_id = $1`,
      [eventId, 'Evento sem referência do CyberDock; nenhuma fatura envolvida.']
    ).catch(() => {});
    return;
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    /* A verdade vem de getPayment, não do corpo do evento.
     *
     * A entrega é "at least once" e a retentativa pode inverter a ordem: dá para
     * receber RECEIVED antes de CONFIRMED. Reler a cobrança pelo id elimina o
     * problema de ordem inteiro — o provedor sempre responde o estado de agora. */
    const atual = cobranca?.id ? await asaas.getPayment(cobranca.id) : null;
    const efetiva = atual || cobranca;

    if (efetiva?.id) {
      await aplicarCobrancaNaFatura(client, {
        uid: uidEvento, period: periodoEvento, cobranca: efetiva,
      });
    }

    await client.query(
      `UPDATE public.asaas_webhook_events SET processed_at = NOW(), error = NULL WHERE event_id = $1`,
      [eventId]
    );
    await client.query('COMMIT');
    console.log(`[Cobrança] Webhook ${eventType} aplicado a ${uidEvento} ${periodoEvento} `
      + `(status ${efetiva?.status}).`);
  } catch (erro) {
    await client.query('ROLLBACK').catch(() => {});
    /* `processed_at` fica nulo com o motivo gravado: é o que permite
     * reprocessar sem depender de o provedor reenviar. */
    await db.query(
      `UPDATE public.asaas_webhook_events SET error = $2 WHERE event_id = $1`,
      [eventId, String(erro.message || erro).slice(0, 2000)]
    ).catch(() => {});
    console.error(`[Cobrança] Webhook ${eventId} recebido e NÃO aplicado: ${erro.message}`);
  } finally {
    client.release();
  }
});

/**
 * ===== Eventos de webhook pendentes (master) =====
 *
 * `processed_at` nulo é evento que chegou e não foi aplicado. Sem esta listagem
 * o dado fica no banco sem ninguém saber, e a fatura segue desatualizada em
 * silêncio. O reprocessamento é o sync da competência correspondente.
 */
router.get('/webhook/asaas/pending', authenticateToken, requireMaster, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT event_id, event_type, payment_id, uid, period, received_at, error
        FROM public.asaas_webhook_events
       WHERE processed_at IS NULL
       ORDER BY received_at DESC
       LIMIT 200
    `);
    res.json({ pendentes: rows, total: rows.length });
  } catch (erro) {
    console.error('Erro ao listar eventos de webhook pendentes:', erro);
    res.status(500).json({ error: 'Erro ao listar eventos pendentes.' });
  }
});

module.exports = router;
// Anexado ao router porque este arquivo exporta o próprio middleware. O boot
// (server.js) chama isto em segundo plano depois de começar a atender.
module.exports.recalculateDuplicatedStorageInvoices = recalculateDuplicatedStorageInvoices;
