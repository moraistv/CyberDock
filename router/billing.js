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

/* Descrições usadas pelo item de armazenamento inicial, hoje e no passado.
 *
 * O rótulo atual vem de STORAGE_LABELS ("Armazenamento Inicial (1m³)" e
 * "... 50% | FULL"), mas faturas antigas foram gravadas com o nome do catálogo,
 * "Armazenamento Base (até 1m³)". Um diagnóstico que olhasse só a grafia nova
 * diria que está tudo certo no histórico. */
const BASE_STORAGE_DESCRIPTION_PATTERNS = ['Armazenamento Base%', 'Armazenamento Inicial%'];

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
    const alvo = pedidos && pedidos.length
      ? pedidos.map(String)
      : (await db.query(
          `SELECT period FROM public.invoices WHERE uid = $1${filtroPago} ORDER BY period ASC`,
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
             COALESCE(i.status, '') = 'paid' AS paga
        FROM public.invoices i
        JOIN public.invoice_items it ON it.invoice_id = i.id
       WHERE it.description ILIKE ANY ($1::text[])
       GROUP BY i.id, i.uid, i.period, i.status
      HAVING COUNT(*) > 1
       ORDER BY i.period ASC
    `, [BASE_STORAGE_DESCRIPTION_PATTERNS]);

    if (alvo.rowCount === 0) {
      await marcarConcluido();
      return;
    }

    const pagas = alvo.rows.filter((r) => r.paga);
    const aCorrigir = alvo.rows.filter((r) => !r.paga);

    console.log(`   -> Correção retroativa: ${alvo.rowCount} fatura(s) com armazenamento inicial duplicado `
      + `(${aCorrigir.length} a recalcular, ${pagas.length} já paga(s), preservada(s)).`);

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

module.exports = router;
// Anexado ao router porque este arquivo exporta o próprio middleware. O boot
// (server.js) chama isto em segundo plano depois de começar a atender.
module.exports.recalculateDuplicatedStorageInvoices = recalculateDuplicatedStorageInvoices;
