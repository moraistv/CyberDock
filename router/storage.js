// backend/router/storage.js
const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../utils/postgres');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'seu-segredo-super-secreto-para-jwt';

// --- Middlewares ---
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token de acesso requerido' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Token inválido' });
    req.user = user;
    next();
  });
};

const requireMaster = (req, res, next) => {
  if (req.user.role !== 'master') {
    return res.status(403).json({ error: 'Acesso negado.' });
  }
  next();
};

const requireOwnerOrMaster = (req, res, next) => {
  const targetUid = req.params.userId || req.params.uid || req.body?.userId;
  if (req.user.role !== 'master' && req.user.uid !== targetUid) {
    return res.status(403).json({ error: 'Acesso negado.' });
  }
  next();
};

// --- ROTAS PARA TIPOS DE PACOTE (PACKAGE TYPES) ---

// GET /api/storage/package-types - Listar todos os tipos de pacote
router.get('/package-types', authenticateToken, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT id, name, price FROM public.package_types ORDER BY name ASC');
    const formattedRows = rows.map(pt => ({ ...pt, price: parseFloat(pt.price) }));
    res.json(formattedRows);
  } catch (error) {
    console.error('Erro ao buscar tipos de pacote:', error);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

// POST /api/storage/package-types - Criar um novo tipo de pacote (master only)
router.post('/package-types', authenticateToken, requireMaster, async (req, res) => {
  const { name, price } = req.body;
  if (!name || price == null) {
    return res.status(400).json({ error: 'Nome e preço são obrigatórios.' });
  }
  try {
    const { rows } = await db.query(
      'INSERT INTO public.package_types (name, price) VALUES ($1, $2) RETURNING *',
      [name, parseFloat(price)]
    );
    res.status(201).json(rows[0]);
  } catch (error) {
    console.error('Erro ao criar tipo de pacote:', error);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

// PUT /api/storage/package-types/:id - Atualizar um tipo de pacote (master only)
router.put('/package-types/:id', authenticateToken, requireMaster, async (req, res) => {
  const { id } = req.params;
  const { name, price } = req.body;
  if (!name || price == null) {
    return res.status(400).json({ error: 'Nome e preço são obrigatórios.' });
  }
  try {
    const { rows } = await db.query(
      'UPDATE public.package_types SET name = $1, price = $2 WHERE id = $3 RETURNING *',
      [name, parseFloat(price), id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Tipo de pacote não encontrado.' });
    }
    res.json(rows[0]);
  } catch (error) {
    console.error('Erro ao atualizar tipo de pacote:', error);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

// DELETE /api/storage/package-types/:id - Deletar um tipo de pacote (master only)
router.delete('/package-types/:id', authenticateToken, requireMaster, async (req, res) => {
  const { id } = req.params;
  try {
    const { rowCount } = await db.query('DELETE FROM public.package_types WHERE id = $1', [id]);
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Tipo de pacote não encontrado.' });
    }
    res.status(200).json({ message: 'Tipo de pacote excluído com sucesso.' });
  } catch (error) {
    console.error('Erro ao deletar tipo de pacote:', error);
    if (error.code === '23503') {
      return res.status(400).json({ error: 'Não é possível excluir. Este tipo de pacote está em uso por um ou mais SKUs.' });
    }
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

// --- ROTA DE CÁLCULO DE FATURAMENTO DE ARMAZENAMENTO ---
router.get('/user/:userId/billing-summary', authenticateToken, requireOwnerOrMaster, async (req, res) => {
  const { userId } = req.params;
  try {
    const masterPricesQuery = `SELECT type, price FROM public.services WHERE type IN ('base_storage', 'additional_storage');`;
    const masterPricesResult = await db.query(masterPricesQuery);
    const masterPrices = masterPricesResult.rows.reduce((acc, service) => {
      acc[service.type] = parseFloat(service.price);
      return acc;
    }, {});

    const masterBasePrice = masterPrices['base_storage'] || 0;
    const masterAdditionalPrice = masterPrices['additional_storage'] || 0;
    
    // === DEBUG: Log dos preços master ===
    console.log('🔍 DEBUG - Preços master:');
    console.log('Query:', masterPricesQuery);
    console.log('Resultados:', JSON.stringify(masterPricesResult.rows, null, 2));
    console.log(`• masterBasePrice: R$ ${masterBasePrice.toFixed(2)}`);
    console.log(`• masterAdditionalPrice: R$ ${masterAdditionalPrice.toFixed(2)}`);

    const contractsQuery = `
      SELECT s.type, uc.volume, uc.start_date
      FROM public.user_contracts uc
      JOIN public.services s ON uc.service_id = s.id
      WHERE uc.uid = $1 AND s.type IN ('base_storage', 'additional_storage');
    `;
    const contractsResult = await db.query(contractsQuery, [userId]);
    
    // === DEBUG: Log dos contratos encontrados ===
    console.log('🔍 DEBUG - Contratos encontrados:');
    console.log('Query:', contractsQuery);
    console.log('User ID:', userId);
    console.log('Resultados:', JSON.stringify(contractsResult.rows, null, 2));

    let totalCost = 0, baseCost = 0, additionalCost = 0, additionalVolume = 0;

    // === BUSCAR TODOS OS TIPOS DE CONTRATOS ===
    const baseService = contractsResult.rows.find(c => c.type === 'base_storage');
    const additionalService = contractsResult.rows.find(c => c.type === 'additional_storage');
    
    console.log('🔍 DEBUG - Serviços encontrados:');
    console.log('• Base:', baseService);
    console.log('• Adicional:', additionalService);
    
        // === LÓGICA PARA ARMAZENAMENTO BASE COM CÁLCULO PROPORCIONAL ===
    if (baseService) {
      const currentDate = new Date();
      const contractStartDate = new Date(baseService.start_date);
      const currentYear = currentDate.getFullYear();
      const currentMonth = currentDate.getMonth();
      const contractStartYear = contractStartDate.getFullYear();
      const contractStartMonth = contractStartDate.getMonth();
      
      // Se for o mês de entrada do usuário, calcular proporcional
      if (currentYear === contractStartYear && currentMonth === contractStartMonth) {
        // === USUÁRIO NO PRIMEIRO MÊS - CÁLCULO PROPORCIONAL ===
        const startDay = contractStartDate.getDate();
        const daysInMonth = 30; // Fixo em 30 dias
        const daysRemaining = daysInMonth - startDay + 1;
        
        // Cálculo: 397 ÷ 30 dias × dias restantes
        const dailyRate = masterBasePrice / daysInMonth;
        baseCost = dailyRate * daysRemaining;
        
        console.log('🔍 DEBUG - Cálculo base (PROPORCIONAL - primeiro mês):');
        console.log(`• Serviço usado: Armazenamento Base (até 1m³) - Proporcional`);
        console.log(`• Data do contrato: ${contractStartDate.toLocaleDateString('pt-BR')}`);
        console.log(`• Mês atual: ${currentDate.toLocaleDateString('pt-BR')}`);
        console.log(`• Dia de entrada: ${startDay}`);
        console.log(`• Dias restantes: ${daysRemaining}`);
        console.log(`• Taxa diária: R$ ${dailyRate.toFixed(2)}`);
        console.log(`• Custo base (PROPORCIONAL): R$ ${baseCost.toFixed(2)}`);
        console.log(`• NOTA: Usando contrato base com cálculo proporcional`);
      } else {
        // === USUÁRIO TEM CONTRATO BASE (meses seguintes) ===
        baseCost = masterBasePrice;
        
        console.log('🔍 DEBUG - Cálculo base (BASE - meses seguintes):');
        console.log(`• Serviço usado: Armazenamento Base (até 1m³)`);
        console.log(`• Custo base (COMPLETO): R$ ${baseCost.toFixed(2)}`);
        console.log(`• NOTA: Usando contrato base (valor integral)`);
      }
    } else {
      console.log('🔍 DEBUG - Nenhum serviço base encontrado');
    }

    if (additionalService) {
      const quantity = parseInt(additionalService.volume, 10) || 0;
      // === CORREÇÃO: Armazenamento adicional é sempre valor completo ===
      // Não é proporcional como o base
      additionalCost = masterAdditionalPrice * quantity;
      additionalVolume = quantity;
      
      console.log('🔍 DEBUG - Cálculo adicional:');
      console.log(`• Volume: ${quantity}`);
      console.log(`• Preço por m³: R$ ${masterAdditionalPrice.toFixed(2)}`);
      console.log(`• Custo adicional (COMPLETO): R$ ${additionalCost.toFixed(2)}`);
      console.log(`• NOTA: Armazenamento adicional sempre cobra valor integral`);
    } else {
      console.log('🔍 DEBUG - Nenhum serviço adicional encontrado');
    }

    totalCost = baseCost + additionalCost;
    
    // === DEBUG: Log dos valores calculados ===
    console.log('🔍 DEBUG - Valores calculados:');
    console.log(`• baseCost: R$ ${baseCost.toFixed(2)}`);
    console.log(`• additionalCost: R$ ${additionalCost.toFixed(2)}`);
    console.log(`• totalCost: R$ ${totalCost.toFixed(2)}`);
    console.log(`• additionalVolume: ${additionalVolume} m³`);

    // === NOVA LÓGICA: Cálculo de armazenamento mensal proporcional ===
    const now = new Date();
    const currentYear = now.getUTCFullYear();
    const currentMonth = now.getUTCMonth();
    const daysInMonth = 30; // Fixo em 30 dias
    
    // === CÁLCULO DE ARMAZENAMENTO PROPORCIONAL ESPECÍFICO PARA 21/08 ===
    const august21Date = new Date(2024, 7, 21); // 21 de agosto de 2024 (mês 7 = agosto)
    const isAugust2024 = currentYear === 2024 && currentMonth === 7;
    
    const monthlyStorageQuery = `
      SELECT 
        s.id,
        s.sku,
        s.descricao,
        s.monthly_price,
        s.monthly_start_date,
        s.is_monthly,
        s.dimensoes,
        s.quantidade
      FROM public.skus s
      WHERE s.user_id = $1 
        AND s.is_monthly = true 
        AND s.ativo = true
        AND s.monthly_start_date IS NOT NULL
        AND s.monthly_price IS NOT NULL;
    `;
    
    const monthlyStorageResult = await db.query(monthlyStorageQuery, [userId]);
    let monthlyStorageCost = 0;
    let monthlyStorageDetails = [];

    for (const sku of monthlyStorageResult.rows) {
      const startDate = new Date(sku.monthly_start_date);
      const startYear = startDate.getUTCFullYear();
      const startMonth = startDate.getUTCMonth();
      
      // === LÓGICA ESPECIAL PARA AGOSTO 2024 - CÁLCULO PROPORCIONAL A PARTIR DE 21/08 ===
      if (isAugust2024 && startDate >= august21Date) {
        // SKU iniciado em 21/08 ou depois - cálculo proporcional para agosto
        const startDay = startDate.getUTCDate();
        const daysInAugust = daysInMonth - startDay + 1;
        const proportionalPrice = (sku.monthly_price / daysInMonth) * daysInAugust;
        
        monthlyStorageCost += proportionalPrice;
        monthlyStorageDetails.push({
          sku: sku.sku,
          descricao: sku.descricao,
          monthlyPrice: parseFloat(sku.monthly_price),
          startDate: sku.monthly_start_date,
          daysInMonth: daysInAugust,
          proportionalPrice: Math.round(proportionalPrice * 100) / 100,
          tipo: 'proporcional_agosto_21'
        });
      } else if (startYear === currentYear && startMonth === currentMonth) {
        // Se o SKU foi criado no mês atual (outros meses)
        const startDay = startDate.getUTCDate();
        const daysInCurrentMonth = daysInMonth - startDay + 1;
        const proportionalPrice = (sku.monthly_price / daysInMonth) * daysInCurrentMonth;
        
        monthlyStorageCost += proportionalPrice;
        monthlyStorageDetails.push({
          sku: sku.sku,
          descricao: sku.descricao,
          monthlyPrice: parseFloat(sku.monthly_price),
          startDate: sku.monthly_start_date,
          daysInMonth: daysInCurrentMonth,
          proportionalPrice: Math.round(proportionalPrice * 100) / 100,
          tipo: 'proporcional_mes_atual'
        });
      } else {
        // SKU de meses anteriores - cobrar preço completo
        monthlyStorageCost += parseFloat(sku.monthly_price);
        monthlyStorageDetails.push({
          sku: sku.sku,
          descricao: sku.descricao,
          monthlyPrice: parseFloat(sku.monthly_price),
          startDate: sku.monthly_start_date,
          daysInMonth: daysInMonth,
          proportionalPrice: parseFloat(sku.monthly_price),
          tipo: 'mes_completo'
        });
      }
    }

    totalCost += monthlyStorageCost;

    const volumeQuery = `
      SELECT COALESCE(SUM((s.dimensoes->>'altura')::numeric * (s.dimensoes->>'largura')::numeric * (s.dimensoes->>'comprimento')::numeric / 1000000 * s.quantidade), 0) as total_volume
      FROM public.skus s
      WHERE s.user_id = $1;
    `;
    const volumeResult = await db.query(volumeQuery, [userId]);
    const consumedVolume = parseFloat(volumeResult.rows[0].total_volume);

    const currentDate = new Date();
    const year = currentDate.getUTCFullYear();
    const month = currentDate.getUTCMonth();
    const startDate = new Date(Date.UTC(year, month, 1));
    const endDate = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, -1));

    const shipmentsQuery = `
      SELECT sm.quantity_change, pt.name as package_type_name, pt.price as package_type_price
      FROM public.stock_movements sm
      JOIN public.skus s ON sm.sku_id = s.id
      JOIN public.package_types pt ON COALESCE(sm.package_type_id, s.package_type_id) = pt.id
      WHERE sm.user_id = $1
        AND sm.movement_type = 'saida'
        AND sm.reason LIKE 'Saída por Venda%'
        AND sm.created_at BETWEEN $2 AND $3;
    `;
    const shipmentsResult = await db.query(shipmentsQuery, [userId, startDate, endDate]);

    let expedicaoComumCost = 0;
    let expedicaoPremiumCost = 0;

    for (const shipment of shipmentsResult.rows) {
      if (shipment.package_type_name === 'Expedição Comum') {
        expedicaoComumCost += shipment.quantity_change * parseFloat(shipment.package_type_price);
      } else if (shipment.package_type_name === 'Expedição Premium') {
        expedicaoPremiumCost += shipment.quantity_change * parseFloat(shipment.package_type_price);
      }
    }

    totalCost += expedicaoComumCost + expedicaoPremiumCost;

    res.json({
      consumedVolume,
      baseCost,
      additionalVolume,
      additionalCost,
      expedicaoComumCost,
      expedicaoPremiumCost,
      monthlyStorageCost: Math.round(monthlyStorageCost * 100) / 100,
      monthlyStorageDetails,
      totalCost: Math.round(totalCost * 100) / 100
    });

  } catch (error) {
    console.error('Erro ao calcular faturamento de armazenamento:', error);
    res.status(500).json({ error: 'Erro interno ao calcular faturamento.' });
  }
});

// --- ROTAS DE GERENCIAMENTO DE SKU ---

// GET /api/storage/user/:userId/available-child-skus
router.get('/user/:userId/available-child-skus', authenticateToken, async (req, res) => {
  const { userId } = req.params;

  if (req.user.role !== 'master' && req.user.uid !== userId) {
    return res.status(403).json({ error: 'Acesso negado.' });
  }
  try {
    const query = `
      SELECT id, sku, descricao, quantidade, dimensoes
      FROM public.skus
      WHERE user_id = $1 AND is_kit = false
      ORDER BY sku ASC
    `;
    const { rows } = await db.query(query, [userId]);
    const skus = rows.map(sku => ({
      ...sku,
      dimensoes: typeof sku.dimensoes === 'string' ? JSON.parse(sku.dimensoes) : sku.dimensoes
    }));
    res.json(skus);
  } catch (error) {
    console.error('Erro ao buscar SKUs disponíveis para kit:', error);
    res.status(500).json({ error: 'Erro interno ao buscar SKUs.' });
  }
});

// GET /api/storage/user/:userId/skus  (AGORA COM USO/HIERARQUIA)
router.get('/user/:userId/skus', authenticateToken, async (req, res) => {
  const { userId } = req.params;

  if (req.user.role !== 'master' && req.user.uid !== userId) {
    return res.status(403).json({ error: 'Acesso negado.' });
  }
  try {
    const query = `
      SELECT 
        s.id, s.user_id, s.sku, s.descricao, s.dimensoes, s.quantidade, s.package_type_id, s.kit_parent_id, s.is_kit, s.ativo,
        pt.name as package_type_name, pt.price as package_type_price,
        kp.nome as kit_parent_name
      FROM public.skus s
      LEFT JOIN public.package_types pt ON s.package_type_id = pt.id
      LEFT JOIN public.kit_parents kp ON s.kit_parent_id = kp.id
      WHERE s.user_id = $1 
      ORDER BY s.is_kit ASC, s.created_at DESC
    `;
    const { rows } = await db.query(query, [userId]);

    // Puxa componentes dos kits
    const kitComponentsQuery = `
      SELECT 
        kc.kit_sku_id,
        kc.child_sku_id,
        kc.quantity_per_kit,
        cs.sku as child_sku_code,
        cs.descricao as child_descricao,
        cs.quantidade as child_stock,
        cs.dimensoes as child_dimensoes
      FROM public.sku_kit_components kc
      JOIN public.skus cs ON kc.child_sku_id = cs.id
      WHERE kc.kit_sku_id IN (SELECT id FROM public.skus WHERE user_id = $1 AND is_kit = true)
    `;
    const kitComponentsResult = await db.query(kitComponentsQuery, [userId]);

    // Mapa componentes por kit
    const kitComponentsMap = {};
    // Mapa de uso de um SKU filho em kits (para hierarquia inversa: filho -> [kits])
    const childUsageMap = {};

    kitComponentsResult.rows.forEach(row => {
      if (!kitComponentsMap[row.kit_sku_id]) kitComponentsMap[row.kit_sku_id] = [];
      const component = {
        child_sku_id: row.child_sku_id,
        child_sku_code: row.child_sku_code,
        child_descricao: row.child_descricao,
        child_stock: row.child_stock,
        child_dimensoes: typeof row.child_dimensoes === 'string' ? JSON.parse(row.child_dimensoes) : row.child_dimensoes,
        quantity_per_kit: row.quantity_per_kit
      };
      kitComponentsMap[row.kit_sku_id].push(component);
    });

    // Para montar childUsageMap precisamos do sku do kit
    const kitsBasicQuery = `
      SELECT id, sku, descricao
      FROM public.skus
      WHERE user_id = $1 AND is_kit = true
    `;
    const kitsBasicRes = await db.query(kitsBasicQuery, [userId]);
    const kitIdToMeta = kitsBasicRes.rows.reduce((acc, k) => {
      acc[k.id] = { sku: k.sku, descricao: k.descricao };
      return acc;
    }, {});

    // Preenche childUsageMap com metadados do kit
    kitComponentsResult.rows.forEach(row => {
      if (!childUsageMap[row.child_sku_id]) childUsageMap[row.child_sku_id] = [];
      childUsageMap[row.child_sku_id].push({
        kit_id: row.kit_sku_id,
        kit_sku_code: kitIdToMeta[row.kit_sku_id]?.sku || null,
        kit_descricao: kitIdToMeta[row.kit_sku_id]?.descricao || null,
        quantity_per_kit: row.quantity_per_kit
      });
    });

    // Monta resposta final
    const skus = rows.map(sku => {
      const result = {
        ...sku,
        dimensoes: typeof sku.dimensoes === 'string' ? JSON.parse(sku.dimensoes) : sku.dimensoes,
        package_type_price: sku.package_type_price ? parseFloat(sku.package_type_price) : null
      };

      if (sku.is_kit && kitComponentsMap[sku.id]) {
        result.kit_components = kitComponentsMap[sku.id];
        result.available_kit_quantity = result.kit_components.reduce((min, component) => {
          const availableFromChild = Math.floor(component.child_stock / component.quantity_per_kit);
          return Math.min(min, availableFromChild);
        }, Infinity);
        if (result.available_kit_quantity === Infinity) result.available_kit_quantity = 0;
      }

      // Para SKUs normais, informa em quais kits ele está sendo usado
      if (!sku.is_kit) {
        result.used_in_kits = childUsageMap[sku.id] || [];
      }

      return result;
    });

    res.json(skus);
  } catch (error) {
    console.error('Erro ao buscar SKUs do usuário:', error);
    res.status(500).json({ error: 'Erro interno ao buscar SKUs.' });
  }
});

// --- ROTA DE CRIAÇÃO DE SKU/KIT (CORRIGIDA) ---
router.post('/user/:userId/skus', authenticateToken, async (req, res) => {
  const { userId } = req.params;
  const {
    sku,
    descricao,
    dimensoes,
    quantidade,
    package_type_id,
    is_kit,
    ativo,
    kit_components,
    is_monthly,
    monthly_price,
    monthly_start_date
  } = req.body;

  console.log('🚀 [BACKEND] Criando SKU/Kit para usuário:', userId);
  console.log('📦 [BACKEND] Dados recebidos:', { sku, descricao, is_kit, userId });

  if (req.user.role !== 'master' && req.user.uid !== userId) {
    console.log('❌ [BACKEND] Acesso negado - usuário não autorizado');
    return res.status(403).json({ error: 'Acesso negado.' });
  }

  if (!sku || !descricao) {
    console.log('❌ [BACKEND] Validação falhou - campos obrigatórios');
    return res.status(400).json({ error: 'SKU e Descrição são obrigatórios.' });
  }

  // Validação para SKUs mensais
  if (is_monthly) {
    if (!monthly_price || monthly_price <= 0) {
      return res.status(400).json({ error: 'Preço mensal é obrigatório para SKUs mensais.' });
    }
    if (!monthly_start_date) {
      return res.status(400).json({ error: 'Data de início é obrigatória para SKUs mensais.' });
    }
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // VALIDAÇÃO ADICIONAL: Verificar se já existe um SKU com o mesmo código para este usuário
    console.log('🔍 [BACKEND] Verificando se SKU já existe para o usuário:', userId);
    const existingSkuCheck = await client.query(
      'SELECT id, sku FROM public.skus WHERE user_id = $1 AND sku = $2',
      [userId, sku]
    );

    if (existingSkuCheck.rows.length > 0) {
      console.log('⚠️ [BACKEND] SKU já existe para este usuário:', existingSkuCheck.rows[0]);
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `O SKU '${sku}' já existe para este usuário.` });
    }

    console.log('✅ [BACKEND] SKU é único para este usuário, prosseguindo com criação');

    const skuInsertQuery = `
      INSERT INTO public.skus
      (user_id, sku, descricao, dimensoes, quantidade, package_type_id, is_kit, ativo, is_monthly, monthly_price, monthly_start_date)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING id, sku, descricao, is_kit, ativo, is_monthly, monthly_price, monthly_start_date;
    `;
    
    const skuResult = await client.query(skuInsertQuery, [
      userId,
      sku,
      descricao,
      JSON.stringify(dimensoes),
      is_kit ? 0 : (quantidade || 0),
      package_type_id || null,
      is_kit || false,
      ativo === undefined ? true : ativo,
      is_monthly || false,
      is_monthly ? parseFloat(monthly_price) : null,
      is_monthly ? monthly_start_date : null
    ]);
    const newSku = skuResult.rows[0];

    console.log('✅ [BACKEND] SKU/Kit criado com sucesso:', newSku);

    if (is_kit && kit_components && kit_components.length > 0) {
      const newKitId = newSku.id;
      console.log('🔧 [BACKEND] Adicionando componentes ao kit:', kit_components.length);
      
      const componentInsertQuery = `
        INSERT INTO public.sku_kit_components
        (kit_sku_id, child_sku_id, quantity_per_kit)
        VALUES ($1, $2, $3);
      `;
      for (const component of kit_components) {
        await client.query(componentInsertQuery, [
          newKitId,
          component.child_sku_id,
          component.quantity_per_kit
        ]);
      }
      console.log('✅ [BACKEND] Componentes do kit adicionados com sucesso');
    }

    await client.query('COMMIT');
    console.log('🎉 [BACKEND] Transação confirmada - SKU/Kit criado para usuário:', userId);
    res.status(201).json(newSku);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('💥 [BACKEND] Erro ao criar SKU/Kit:', error);
    
    // Tratamento específico para constraint única
    if (error.code === '23505') {
      console.log('⚠️ [BACKEND] Violação de constraint única detectada');
      return res.status(400).json({ error: `O SKU '${sku}' já existe para este usuário.` });
    }
    
    res.status(500).json({ error: 'Erro interno ao criar SKU. A operação foi cancelada.' });
  } finally {
    client.release();
  }
});

router.put('/skus/:skuId', authenticateToken, async (req, res) => {
  const { skuId } = req.params;
  const { descricao, dimensoes, package_type_id, kit_parent_id, ativo, kit_components } = req.body;

  const skuOwnerCheck = await db.query('SELECT user_id FROM public.skus WHERE id = $1', [skuId]);
  if (skuOwnerCheck.rows.length === 0) {
    return res.status(404).json({ error: 'SKU não encontrado.' });
  }

  const skuOwnerId = skuOwnerCheck.rows[0].user_id;
  if (req.user.role !== 'master' && req.user.uid !== skuOwnerId) {
    return res.status(403).json({ error: 'Acesso negado.' });
  }

  try {
    const client = await db.pool.connect();
    try {
      if (kit_components !== undefined) {
        await client.query('BEGIN');

        await client.query('DELETE FROM public.sku_kit_components WHERE kit_sku_id = $1', [skuId]);

        if (kit_components && kit_components.length > 0) {
          for (const component of kit_components) {
            const childCheck = await client.query(
              'SELECT id FROM public.skus WHERE id = $1 AND user_id = $2 AND is_kit = false',
              [component.child_sku_id, skuOwnerId]
            );
            if (childCheck.rows.length === 0) {
              throw new Error(`SKU filho com ID ${component.child_sku_id} não encontrado`);
            }
            await client.query(
              'INSERT INTO public.sku_kit_components (kit_sku_id, child_sku_id, quantity_per_kit) VALUES ($1, $2, $3)',
              [skuId, component.child_sku_id, component.quantity_per_kit]
            );
          }
        }
      }

      const updateFields = [];
      const updateValues = [];
      let paramCounter = 1;

      if (descricao !== undefined) {
        updateFields.push(`descricao = $${paramCounter}`);
        updateValues.push(descricao);
        paramCounter++;
      }
      if (dimensoes !== undefined) {
        updateFields.push(`dimensoes = $${paramCounter}`);
        updateValues.push(JSON.stringify(dimensoes));
        paramCounter++;
      }
      if (package_type_id !== undefined) {
        updateFields.push(`package_type_id = $${paramCounter}`);
        updateValues.push(package_type_id || null);
        paramCounter++;
      }
      if (kit_parent_id !== undefined) {
        updateFields.push(`kit_parent_id = $${paramCounter}`);
        updateValues.push(kit_parent_id || null);
        paramCounter++;
      }
      if (ativo !== undefined) {
        updateFields.push(`ativo = $${paramCounter}`);
        updateValues.push(ativo);
        paramCounter++;
      }

      updateFields.push('updated_at = NOW()');

      if (updateFields.length === 1) {
        const q = `SELECT * FROM public.skus WHERE id = $1`;
        const { rows } = await client.query(q, [skuId]);
        if (kit_components !== undefined) {
          await client.query('COMMIT');
        }
        return res.json(rows[0]);
      }

      updateValues.push(skuId);
      const query = `
        UPDATE public.skus
        SET ${updateFields.join(', ')}
        WHERE id = $${paramCounter}
        RETURNING *;
      `;
      const { rows } = await client.query(query, updateValues);
      if (rows.length === 0) {
        if (kit_components !== undefined) await client.query('ROLLBACK');
        return res.status(404).json({ error: 'SKU não encontrado.' });
      }

      if (kit_components !== undefined) await client.query('COMMIT');

      res.json(rows[0]);
    } catch (error) {
      if (kit_components !== undefined) await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Erro ao atualizar SKU:', error);
    res.status(500).json({ error: 'Erro interno ao atualizar SKU.' });
  }
});

router.delete('/skus/:skuId', authenticateToken, requireMaster, async (req, res) => {
  const { skuId } = req.params;
  const client = await db.pool.connect();

  try {
    await client.query('BEGIN');

    const skuCheck = await client.query('SELECT quantidade, user_id FROM public.skus WHERE id = $1 FOR UPDATE', [skuId]);
    if (skuCheck.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'SKU não encontrado.' });
    }
    
    const { quantidade, user_id } = skuCheck.rows[0];
    
    // Verificar se o SKU é componente de algum kit
    const isKitComponentQuery = `
      SELECT kc.kit_sku_id, ks.sku as kit_sku_code 
      FROM public.sku_kit_components kc 
      JOIN public.skus ks ON kc.kit_sku_id = ks.id 
      WHERE kc.child_sku_id = $1 AND ks.user_id = $2
    `;
    const kitComponentResult = await client.query(isKitComponentQuery, [skuId, user_id]);
    
    if (kitComponentResult.rows.length > 0) {
      await client.query('ROLLBACK');
      const kitNames = kitComponentResult.rows.map(row => row.kit_sku_code).join(', ');
      return res.status(400).json({ 
        error: `Não é possível excluir este SKU pois ele é componente do(s) kit(s): ${kitNames}. Desconecte do kit primeiro.` 
      });
    }
    
    if (quantidade > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Não é possível excluir SKU com estoque positivo. Zere o estoque primeiro.' });
    }

    await client.query('DELETE FROM public.stock_movements WHERE sku_id = $1', [skuId]);
    const { rowCount } = await client.query('DELETE FROM public.skus WHERE id = $1', [skuId]);
    if (rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Falha ao excluir o SKU após limpar o histórico.' });
    }

    await client.query('COMMIT');
    res.status(200).json({ message: 'SKU e seu histórico foram excluídos com sucesso.' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao deletar SKU:', error);
    if (error.code === '23503') {
      return res.status(400).json({ error: 'Não é possível excluir. O SKU está sendo referenciado em outra parte do sistema.' });
    }
    res.status(500).json({ error: 'Erro interno ao deletar SKU.' });
  } finally {
    client.release();
  }
});

// --- ROTAS DE MOVIMENTAÇÃO DE ESTOQUE ---

router.get('/user/:userId/movements', authenticateToken, async (req, res) => {
  const { userId } = req.params;
  if (req.user.role !== 'master' && req.user.uid !== userId) {
    return res.status(403).json({ error: 'Acesso negado.' });
  }
  try {
    const wantsPagination = req.query.page !== undefined || req.query.limit !== undefined;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const offset = (page - 1) * limit;
    const baseFrom = `
      FROM public.stock_movements sm
      JOIN public.skus s ON sm.sku_id = s.id
      WHERE sm.user_id = $1`;

    if (!wantsPagination) {
      const { rows } = await db.query(`
        SELECT sm.id, s.sku, sm.movement_type, sm.quantity_change, sm.reason,
               sm.related_sale_id, sm.created_at
        ${baseFrom}
        ORDER BY sm.created_at DESC
      `, [userId]);
      return res.json(rows);
    }

    const [countResult, dataResult] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS total ${baseFrom}`, [userId]),
      db.query(`
        SELECT sm.id, s.sku, sm.movement_type, sm.quantity_change, sm.reason,
               sm.related_sale_id, sm.created_at
        ${baseFrom}
        ORDER BY sm.created_at DESC
        LIMIT $2 OFFSET $3
      `, [userId, limit, offset]),
    ]);
    const total = countResult.rows[0]?.total || 0;
    res.json({
      data: dataResult.rows,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    });
  } catch (error) {
    console.error('Erro ao buscar todas as movimentações do usuário:', error);
    res.status(500).json({ error: 'Erro interno ao buscar movimentações.' });
  }
});

router.get('/sku/:skuCode/movements', authenticateToken, requireMaster, async (req, res) => {
  const { skuCode } = req.params;
  const { uid } = req.query;

  if (!uid) return res.status(400).json({ error: 'UID do usuário é obrigatório.' });

  try {
    const query = `
      SELECT sm.id, sm.movement_type, sm.quantity_change, sm.reason, sm.related_sale_id, sm.created_at
      FROM public.stock_movements sm
      JOIN public.skus s ON sm.sku_id = s.id
      WHERE s.sku = $1 AND sm.user_id = $2
      ORDER BY sm.created_at DESC
    `;
    const { rows } = await db.query(query, [skuCode, uid]);
    res.json(rows);
  } catch (error) {
    console.error('Erro ao buscar histórico do SKU:', error);
    res.status(500).json({ error: 'Erro interno ao buscar histórico.' });
  }
});

// Endpoint específico para ajuste de estoque de componentes
router.post('/component/:skuCode/movements', authenticateToken, async (req, res) => {
  const { skuCode } = req.params;
  const { userId, movementType, quantityChange, reason, forceComponent } = req.body;

  if (!userId || !movementType || !quantityChange || !reason) {
    return res.status(400).json({ error: 'Todos os campos são obrigatórios.' });
  }

  if (!forceComponent) {
    return res.status(400).json({ error: 'Este endpoint é específico para componentes. Use forceComponent: true.' });
  }

  // Verificar permissão: master ou próprio usuário
  if (req.user.role !== 'master' && req.user.uid !== userId) {
    return res.status(403).json({ error: 'Acesso negado. Apenas masters ou o próprio usuário podem ajustar estoque.' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const findSkuQuery = 'SELECT id, quantidade, is_kit FROM public.skus WHERE sku = $1 AND user_id = $2 FOR UPDATE';
    const skuFound = await client.query(findSkuQuery, [skuCode, userId]);

    if (skuFound.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'SKU não encontrado ou pertence a outro usuário.' });
    }
    const { id: skuId, quantidade: currentQuantity, is_kit } = skuFound.rows[0];

    // Verificar se o SKU é realmente componente de algum kit
    const isKitComponentQuery = `
      SELECT kc.kit_sku_id, ks.sku as kit_sku_code 
      FROM public.sku_kit_components kc 
      JOIN public.skus ks ON kc.kit_sku_id = ks.id 
      WHERE kc.child_sku_id = $1 AND ks.user_id = $2
    `;
    const kitComponentResult = await client.query(isKitComponentQuery, [skuId, userId]);
    
    if (kitComponentResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        error: 'Este SKU não é componente de nenhum kit. Use o endpoint padrão de movimentação.' 
      });
    }

    if (is_kit) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Kits não podem ser tratados como componentes.' });
    }

    // Validar se o estoque não ficará negativo
    const newQuantity = movementType === 'entrada' 
      ? currentQuantity + quantityChange 
      : currentQuantity - quantityChange;

    if (newQuantity < 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        error: `Estoque insuficiente. Estoque atual: ${currentQuantity}, tentativa de retirar: ${quantityChange}` 
      });
    }

    // Atualizar o estoque
    const updateQuery = 'UPDATE public.skus SET quantidade = $1 WHERE id = $2';
    await client.query(updateQuery, [newQuantity, skuId]);

    // Registrar a movimentação
    const insertMovementQuery = `
      INSERT INTO public.stock_movements 
      (sku_id, user_id, movement_type, quantity_change, reason, related_sale_id, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      RETURNING id, created_at
    `;
    const movementResult = await client.query(insertMovementQuery, [
      skuId, userId, movementType, quantityChange, reason, null
    ]);

    await client.query('COMMIT');

    // Buscar informações dos kits afetados
    const affectedKitsQuery = `
      SELECT ks.sku as kit_sku_code, kc.quantity_per_kit
      FROM public.sku_kit_components kc 
      JOIN public.skus ks ON kc.kit_sku_id = ks.id 
      WHERE kc.child_sku_id = $1 AND ks.user_id = $2
    `;
    const affectedKits = await client.query(affectedKitsQuery, [skuId, userId]);

    res.json({
      success: true,
      message: 'Estoque de componente ajustado com sucesso.',
      data: {
        skuCode,
        movementId: movementResult.rows[0].id,
        previousQuantity: currentQuantity,
        newQuantity: newQuantity,
        movementType,
        quantityChange,
        reason,
        timestamp: movementResult.rows[0].created_at,
        affectedKits: affectedKits.rows.map(kit => ({
          kitCode: kit.kit_sku_code,
          quantityPerKit: kit.quantity_per_kit,
          availableKits: Math.floor(newQuantity / kit.quantity_per_kit)
        }))
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao ajustar estoque de componente:', error);
    res.status(500).json({ error: 'Erro interno ao ajustar estoque de componente.' });
  } finally {
    client.release();
  }
});

router.post('/sku/:skuCode/movements', authenticateToken, requireMaster, async (req, res) => {
  const { skuCode } = req.params;
  const { userId, movementType, quantityChange, reason, relatedSaleId } = req.body;

  if (!userId || !movementType || !quantityChange || !reason) {
    return res.status(400).json({ error: 'Todos os campos são obrigatórios.' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const findSkuQuery = 'SELECT id, quantidade, is_kit FROM public.skus WHERE sku = $1 AND user_id = $2 FOR UPDATE';
    const skuFound = await client.query(findSkuQuery, [skuCode, userId]);

    if (skuFound.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'SKU não encontrado ou pertence a outro usuário.' });
    }
    const { id: skuId, quantidade: currentQuantity, is_kit } = skuFound.rows[0];

    // Verificar se o SKU é componente de algum kit
    const isKitComponentQuery = `
      SELECT kc.kit_sku_id, ks.sku as kit_sku_code 
      FROM public.sku_kit_components kc 
      JOIN public.skus ks ON kc.kit_sku_id = ks.id 
      WHERE kc.child_sku_id = $1 AND ks.user_id = $2
    `;
    const kitComponentResult = await client.query(isKitComponentQuery, [skuId, userId]);
    
    if (kitComponentResult.rows.length > 0) {
      await client.query('ROLLBACK');
      const kitNames = kitComponentResult.rows.map(row => row.kit_sku_code).join(', ');
      return res.status(400).json({ 
        error: `Este SKU é componente do(s) kit(s): ${kitNames}. O estoque é controlado através do kit. Use o endpoint específico para componentes se necessário.` 
      });
    }

    if (is_kit && movementType === 'entrada') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Kits não possuem estoque físico de entrada/armazenagem. Registre entradas diretamente nos SKUs filhos.' });
    }

    if (is_kit && movementType === 'saida') {
      const kitComponentsQuery = `
        SELECT child_sku_id, quantity_per_kit
        FROM public.sku_kit_components
        WHERE kit_sku_id = $1
      `;
      const kitComponents = await client.query(kitComponentsQuery, [skuId]);

      if (kitComponents.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Kit não possui componentes filhos configurados.' });
      }

      // Checa disponibilidade de todos os filhos
      for (const component of kitComponents.rows) {
        const childSkuQuery = 'SELECT id, sku, quantidade FROM public.skus WHERE id = $1 FOR UPDATE';
        const childSku = await client.query(childSkuQuery, [component.child_sku_id]);

        if (childSku.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'SKU filho não encontrado.' });
        }

        const requiredQuantity = component.quantity_per_kit * quantityChange;
        if (childSku.rows[0].quantidade < requiredQuantity) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: `Estoque insuficiente do SKU filho ${childSku.rows[0].sku}. Disponível: ${childSku.rows[0].quantidade}, Necessário: ${requiredQuantity}`
          });
        }
      }

      // Debita os filhos e registra movimentações
      for (const component of kitComponents.rows) {
        const requiredQuantity = component.quantity_per_kit * quantityChange;

        const updateChildQuery = `
          UPDATE public.skus SET quantidade = quantidade - $1, updated_at = NOW() WHERE id = $2;
        `;
        await client.query(updateChildQuery, [requiredQuantity, component.child_sku_id]);

        const insertChildMovementQuery = `
          INSERT INTO public.stock_movements (sku_id, user_id, movement_type, quantity_change, reason, related_sale_id)
          VALUES ($1, $2, 'saida', $3, $4, $5);
        `;
        const childReason = `Saída por Kit (${skuCode})${reason ? ' - ' + reason : ''}`;
        await client.query(insertChildMovementQuery, [
          component.child_sku_id,
          userId,
          requiredQuantity,
          childReason,
          relatedSaleId || null
        ]);
      }

      // Registra a "movimentação" do kit (estoque do kit não muda)
      const insertKitMovementQuery = `
        INSERT INTO public.stock_movements (sku_id, user_id, movement_type, quantity_change, reason, related_sale_id)
        VALUES ($1, $2, $3, $4, $5, $6) RETURNING *;
      `;
      await client.query(insertKitMovementQuery, [skuId, userId, movementType, quantityChange, reason, relatedSaleId || null]);
    } else {
      const finalQuantityChange = movementType === 'entrada' ? quantityChange : -quantityChange;

      if (movementType === 'saida' && currentQuantity < quantityChange) {
        console.warn(`Alerta: Estoque do SKU ${skuCode} ficará negativo. Estoque atual: ${currentQuantity}, Saída: ${quantityChange}`);
      }

      const updateSkuQuery = `
        UPDATE public.skus SET quantidade = quantidade + $1, updated_at = NOW() WHERE id = $2;
      `;
      await client.query(updateSkuQuery, [finalQuantityChange, skuId]);

      const insertMovementQuery = `
        INSERT INTO public.stock_movements (sku_id, user_id, movement_type, quantity_change, reason, related_sale_id)
        VALUES ($1, $2, $3, $4, $5, $6) RETURNING *;
      `;
      await client.query(insertMovementQuery, [skuId, userId, movementType, quantityChange, reason, relatedSaleId || null]);
    }

    await client.query('COMMIT');
    res.status(201).json({ message: 'Movimentação registrada com sucesso.' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao registrar ajuste de estoque:', error);
    res.status(500).json({ error: 'Erro interno ao ajustar estoque.' });
  } finally {
    client.release();
  }
});

// DELETE /api/storage/movements/:movementId - removendo uma movimentação (reverte estoque quando aplicável)
router.delete('/movements/:movementId', authenticateToken, async (req, res) => {
  const { movementId } = req.params;
  const client = await db.pool.connect();

  try {
    await client.query('BEGIN');

    const movementQ = 'SELECT id, sku_id, user_id, movement_type, quantity_change FROM public.stock_movements WHERE id = $1 FOR UPDATE';
    const mRes = await client.query(movementQ, [movementId]);
    if (mRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Movimentação não encontrada.' });
    }

    const movement = mRes.rows[0];

    // Permissão: master ou dono da movimentação
    if (req.user.role !== 'master' && String(req.user.uid) !== String(movement.user_id)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Acesso negado.' });
    }

    // Buscar SKU relacionado (para checar se é kit e atualizar estoque quando aplicável)
    const skuQ = 'SELECT id, quantidade, is_kit FROM public.skus WHERE id = $1 FOR UPDATE';
    const skuRes = await client.query(skuQ, [movement.sku_id]);
    if (skuRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'SKU relacionado não encontrado.' });
    }

    const sku = skuRes.rows[0];
    const qty = Number(movement.quantity_change) || 0;

    // Apenas atualiza quantidade para SKUs físicos (is_kit = false)
    if (!sku.is_kit) {
      if (movement.movement_type === 'entrada') {
        // Reverter entrada -> subtrai quantidade
        if (Number(sku.quantidade) < qty) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Não é possível reverter entrada: estoque atual menor que a quantidade da entrada.' });
        }
        await client.query('UPDATE public.skus SET quantidade = quantidade - $1, updated_at = NOW() WHERE id = $2', [qty, sku.id]);
      } else if (movement.movement_type === 'saida') {
        // Reverter saída -> adiciona quantidade
        await client.query('UPDATE public.skus SET quantidade = quantidade + $1, updated_at = NOW() WHERE id = $2', [qty, sku.id]);
      }
    }

    // Remove a movimentação
    await client.query('DELETE FROM public.stock_movements WHERE id = $1', [movementId]);

    await client.query('COMMIT');
    res.json({ message: 'Movimentação removida e estoque atualizado quando aplicável.' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao excluir movimentação:', error);
    res.status(500).json({ error: 'Erro interno ao excluir movimentação.' });
  } finally {
    client.release();
  }
});

// --- ROTA PARA CONECTAR SKU A KITS EXISTENTES ---
router.post('/user/:userId/connect-sku-to-kits', authenticateToken, async (req, res) => {
  const { userId } = req.params;
  const { sku_id, connections } = req.body;

  if (req.user.role !== 'master' && req.user.uid !== userId) {
    return res.status(403).json({ error: 'Acesso negado.' });
  }
  if (!sku_id || !Array.isArray(connections)) {
    return res.status(400).json({ error: 'SKU ID e a lista de conexões são obrigatórios.' });
  }

  const normalizedConnections = connections.map((connection) => ({
    kit_id: Number(connection.kit_id),
    quantity_per_kit: Number(connection.quantity_per_kit),
  }));
  const kitIds = normalizedConnections.map((connection) => connection.kit_id);
  if (normalizedConnections.some((connection) =>
    !Number.isInteger(connection.kit_id)
    || !Number.isInteger(connection.quantity_per_kit)
    || connection.quantity_per_kit < 1
  )) {
    return res.status(400).json({ error: 'Kit e quantidade por kit devem ser números inteiros válidos.' });
  }
  if (new Set(kitIds).size !== kitIds.length) {
    return res.status(400).json({ error: 'A lista contém o mesmo kit mais de uma vez.' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const skuCheck = await client.query(
      `SELECT id
         FROM public.skus
        WHERE id = $1 AND user_id = $2 AND is_kit = false
        FOR UPDATE`,
      [sku_id, userId]
    );
    if (skuCheck.rowCount === 0) {
      const error = new Error('SKU não encontrado ou não é um SKU individual.');
      error.status = 400;
      throw error;
    }

    if (kitIds.length > 0) {
      const kitsCheck = await client.query(
        `SELECT id
           FROM public.skus
          WHERE id = ANY($1::int[]) AND user_id = $2 AND is_kit = true AND ativo = true
          FOR UPDATE`,
        [kitIds, userId]
      );
      if (kitsCheck.rowCount !== kitIds.length) {
        const error = new Error('Um ou mais kits não existem, estão inativos ou pertencem a outro usuário.');
        error.status = 400;
        throw error;
      }
    }

    // O payload representa o estado completo dos vínculos deste SKU. Remover
    // um kit não afeta os demais; uma lista vazia desconecta de todos.
    let removedResult;
    if (kitIds.length === 0) {
      removedResult = await client.query(
        `DELETE FROM public.sku_kit_components kc
          USING public.skus ks
          WHERE kc.child_sku_id = $1
            AND ks.id = kc.kit_sku_id
            AND ks.user_id = $2`,
        [sku_id, userId]
      );
    } else {
      removedResult = await client.query(
        `DELETE FROM public.sku_kit_components kc
          USING public.skus ks
          WHERE kc.child_sku_id = $1
            AND ks.id = kc.kit_sku_id
            AND ks.user_id = $2
            AND NOT (kc.kit_sku_id = ANY($3::int[]))`,
        [sku_id, userId, kitIds]
      );
    }

    for (const connection of normalizedConnections) {
      await client.query(
        `INSERT INTO public.sku_kit_components
           (kit_sku_id, child_sku_id, quantity_per_kit)
         VALUES ($1, $2, $3)
         ON CONFLICT (kit_sku_id, child_sku_id)
         DO UPDATE SET quantity_per_kit = EXCLUDED.quantity_per_kit, updated_at = NOW()`,
        [connection.kit_id, sku_id, connection.quantity_per_kit]
      );
    }

    await client.query('COMMIT');
    res.status(200).json({
      message: 'Vínculos do SKU atualizados com sucesso.',
      connections_count: normalizedConnections.length,
      removed_count: removedResult.rowCount,
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    console.error('Erro ao atualizar vínculos do SKU com kits:', error);
    res.status(error.status || 500).json({ error: error.message || 'Erro interno do servidor.' });
  } finally {
    client.release();
  }
});

// --- ROTA PARA DESCONECTAR SKU DE KIT ---
router.delete('/user/:userId/disconnect-sku-from-kit', authenticateToken, async (req, res) => {
  const { userId } = req.params;
  const { sku_id, kit_id } = req.body;

  if (req.user.role !== 'master' && req.user.uid !== userId) {
    return res.status(403).json({ error: 'Acesso negado.' });
  }

  if (!sku_id || !kit_id) {
    return res.status(400).json({ error: 'SKU ID e Kit ID são obrigatórios.' });
  }

  try {
    const result = await db.query(
      'DELETE FROM public.sku_kit_components WHERE kit_sku_id = $1 AND child_sku_id = $2 AND EXISTS (SELECT 1 FROM public.skus WHERE id = $1 AND user_id = $3) AND EXISTS (SELECT 1 FROM public.skus WHERE id = $2 AND user_id = $3)',
      [kit_id, sku_id, userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Conexão não encontrada ou acesso negado.' });
    }

    res.status(200).json({ message: 'SKU desconectado do kit com sucesso.' });

  } catch (error) {
    console.error('Erro ao desconectar SKU do kit:', error);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

// --- ROTA PARA BUSCAR CONEXÕES DE UM SKU ---
router.get('/user/:userId/sku/:skuId/kit-connections', authenticateToken, async (req, res) => {
  const { userId, skuId } = req.params;

  if (req.user.role !== 'master' && req.user.uid !== userId) {
    return res.status(403).json({ error: 'Acesso negado.' });
  }

  try {
    const query = `
      SELECT 
        kc.kit_sku_id as kit_id,
        kc.quantity_per_kit,
        ks.sku as kit_sku,
        ks.descricao as kit_descricao,
        ks.ativo as kit_ativo
      FROM public.sku_kit_components kc
      JOIN public.skus ks ON kc.kit_sku_id = ks.id
      WHERE kc.child_sku_id = $1 
        AND EXISTS (SELECT 1 FROM public.skus WHERE id = $1 AND user_id = $2)
        AND ks.user_id = $2
      ORDER BY ks.sku
    `;
    
    const result = await db.query(query, [skuId, userId]);
    res.status(200).json(result.rows);

  } catch (error) {
    console.error('Erro ao buscar conexões do SKU:', error);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

module.exports = router;