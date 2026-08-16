// backend/routes/billing.js
const express = require('express');
const db = require('../utils/postgres');
const { authenticateToken, requireMaster } = require('../utils/authMiddleware');
const { BillingQueryBuilder } = require('../utils/billingQueryBuilder');
const {
  STORAGE_TYPES,
  buildStorageItems,
  getTierUnitPrice,
  round,
} = require('../utils/billingRules');

const router = express.Router();

// Instância do construtor de queries corrigidas
const billingQueryBuilder = new BillingQueryBuilder();

/**
 * Gera/atualiza itens automáticos da fatura (armazenamento + expedições),
 * preservando itens manuais, e recalcula o total somando manual + automático.
 */
async function calculateAndSaveInvoice(client, uid, period) {
  const [year, month] = period.split('-').map(Number);

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
  const contractsRes = await client.query(`
    SELECT s.type, s.id AS service_id, uc.volume, uc.start_date
    FROM public.user_contracts uc
    JOIN public.services s ON uc.service_id = s.id
    WHERE uc.uid = $1 AND s.type = ANY($2)
    ORDER BY uc.start_date ASC;
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
  const dueDate = new Date(Date.UTC(year, month, 5));
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

    const { rows } = await client.query(
      `SELECT id, invoice_id, type FROM public.invoice_items WHERE id = $1`,
      [itemId]
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Lançamento não encontrado.' });
    }
    if (rows[0].type !== 'manual') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Somente serviços avulsos podem ser removidos.' });
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

module.exports = router;
