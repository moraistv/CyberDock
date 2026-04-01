/**
 * Construtor de Queries de Cobrança Corrigidas
 * 
 * Responsável por construir queries SQL com filtros de período corretos
 * para diferentes tipos de itens de cobrança, garantindo que apenas
 * itens do período exato sejam incluídos na cobrança.
 */

import { billingPeriodCalculator } from './BillingPeriodCalculator.js';
import { consumptionDateResolver } from './ConsumptionDateResolver.js';

export class BillingQueryBuilder {
    constructor() {
        this.periodCalculator = billingPeriodCalculator;
        this.dateResolver = consumptionDateResolver;
    }

    /**
     * Constrói query para vendas expedidas com filtro de período correto
     * @param {string} userId - ID do usuário
     * @param {number} year - Ano
     * @param {number} month - Mês
     * @returns {Object} Query e parâmetros
     */
    buildSalesQuery(userId, year, month) {
        const period = this.periodCalculator.calculatePeriod(year, month);
        const sqlFormat = this.periodCalculator.toSQLFormat(period);

        // Query corrigida que usa shipping_date como prioridade
        // e aplica filtro de período exato
        const query = `
            SELECT 
                s.id,
                s.sku,
                s.uid,
                s.seller_id,
                s.channel,
                s.account_nickname,
                s.sale_date,
                s.product_title,
                s.quantity,
                s.shipping_mode,
                s.shipping_limit_date,
                s.packages,
                s.shipping_status,
                s.raw_api_data,
                s.processed_at,
                s.updated_at,
                -- Data de consumo calculada
                CASE 
                    WHEN s.processed_at IS NOT NULL THEN s.processed_at
                    WHEN s.raw_api_data->>'shipping_date' IS NOT NULL THEN (s.raw_api_data->>'shipping_date')::timestamp
                    WHEN s.sale_date IS NOT NULL THEN s.sale_date
                    ELSE s.created_at
                END as consumption_date,
                -- Informações de package type para cobrança
                pt.name as package_type_name,
                pt.price as package_type_price
            FROM public.sales s
            LEFT JOIN public.skus sk ON UPPER(TRIM(sk.sku)) = UPPER(TRIM(s.sku)) AND sk.user_id = s.uid
            LEFT JOIN public.package_types pt ON sk.package_type_id = pt.id
            WHERE s.uid = $1
                AND s.processed_at IS NOT NULL  -- Apenas vendas processadas (expedidas)
                AND (
                    -- Prioridade 1: Data de processamento (quando foi expedida)
                    (s.processed_at BETWEEN $2::timestamp AND $3::timestamp)
                    OR
                    -- Prioridade 2: Data de expedição da API do ML
                    (s.processed_at IS NULL AND s.raw_api_data->>'shipping_date' IS NOT NULL 
                     AND (s.raw_api_data->>'shipping_date')::timestamp BETWEEN $2::timestamp AND $3::timestamp)
                    OR
                    -- Prioridade 3: Data da venda (fallback)
                    (s.processed_at IS NULL AND s.raw_api_data->>'shipping_date' IS NULL 
                     AND s.sale_date BETWEEN $2::timestamp AND $3::timestamp)
                )
            ORDER BY consumption_date DESC, s.id DESC
        `;

        const params = [userId, sqlFormat.startDate, sqlFormat.endDate];

        return {
            query,
            params,
            period,
            description: `Vendas expedidas de ${this.periodCalculator.formatPeriodDetailed(period)}`
        };
    }

    /**
     * Constrói query para armazenamento com filtro de período correto
     * @param {string} userId - ID do usuário
     * @param {number} year - Ano
     * @param {number} month - Mês
     * @returns {Object} Query e parâmetros
     */
    buildStorageQuery(userId, year, month) {
        const period = this.periodCalculator.calculatePeriod(year, month);
        const sqlFormat = this.periodCalculator.toSQLFormat(period);

        const query = `
            SELECT 
                uc.id,
                uc.uid,
                uc.service_id,
                uc.volume,
                uc.start_date,
                uc.end_date,
                s.name as service_name,
                s.type as service_type,
                s.price as service_price,
                -- Data de consumo para armazenamento
                CASE 
                    WHEN uc.start_date <= $2::date THEN $2::date
                    ELSE uc.start_date
                END as consumption_date
            FROM public.user_contracts uc
            JOIN public.services s ON uc.service_id = s.id
            WHERE uc.uid = $1
                AND s.type IN ('base_storage', 'additional_storage')
                AND (
                    -- Armazenamento ativo durante o período
                    uc.start_date <= $3::date
                    AND (uc.end_date IS NULL OR uc.end_date >= $2::date)
                )
            ORDER BY uc.start_date DESC
        `;

        const params = [userId, sqlFormat.startDateLocal, sqlFormat.endDateLocal];

        return {
            query,
            params,
            period,
            description: `Armazenamento de ${this.periodCalculator.formatPeriodDetailed(period)}`
        };
    }

    /**
     * Constrói query para serviços avulsos com filtro de período correto
     * @param {string} userId - ID do usuário
     * @param {number} year - Ano
     * @param {number} month - Mês
     * @returns {Object} Query e parâmetros
     */
    buildServicesQuery(userId, year, month) {
        const period = this.periodCalculator.calculatePeriod(year, month);
        const sqlFormat = this.periodCalculator.toSQLFormat(period);

        const query = `
            SELECT 
                ii.id,
                ii.invoice_id,
                ii.description,
                ii.quantity,
                ii.unit_price,
                ii.total_price,
                ii.service_date,
                ii.type,
                i.uid,
                i.period,
                -- Data de consumo para serviços
                COALESCE(ii.service_date, i.due_date, i.created_at) as consumption_date
            FROM public.invoice_items ii
            JOIN public.invoices i ON ii.invoice_id = i.id
            WHERE i.uid = $1
                AND ii.type = 'manual'  -- Apenas serviços manuais/avulsos
                AND (
                    -- Usar service_date se disponível
                    (ii.service_date IS NOT NULL 
                     AND ii.service_date BETWEEN $2::date AND $3::date)
                    OR
                    -- Fallback para data de vencimento da fatura
                    (ii.service_date IS NULL 
                     AND i.due_date BETWEEN $2::timestamp AND $3::timestamp)
                )
            ORDER BY consumption_date DESC, ii.id DESC
        `;

        const params = [userId, sqlFormat.startDateLocal, sqlFormat.endDateLocal];

        return {
            query,
            params,
            period,
            description: `Serviços avulsos de ${this.periodCalculator.formatPeriodDetailed(period)}`
        };
    }

    /**
     * Constrói query unificada para todos os tipos de itens de cobrança
     * @param {string} userId - ID do usuário
     * @param {number} year - Ano
     * @param {number} month - Mês
     * @returns {Object} Query e parâmetros
     */
    buildUnifiedBillingQuery(userId, year, month) {
        const period = this.periodCalculator.calculatePeriod(year, month);
        const sqlFormat = this.periodCalculator.toSQLFormat(period);

        const query = `
            -- Vendas expedidas
            SELECT 
                'SALE' as item_type,
                s.id::text as item_id,
                s.sku,
                s.product_title as description,
                s.quantity,
                pt.price as unit_price,
                (s.quantity * COALESCE(pt.price, 0)) as total_price,
                s.processed_at as consumption_date,
                s.account_nickname,
                s.shipping_mode,
                'Venda Expedida' as category
            FROM public.sales s
            LEFT JOIN public.skus sk ON UPPER(TRIM(sk.sku)) = UPPER(TRIM(s.sku)) AND sk.user_id = s.uid
            LEFT JOIN public.package_types pt ON sk.package_type_id = pt.id
            WHERE s.uid = $1
                AND s.processed_at IS NOT NULL
                AND s.processed_at BETWEEN $2::timestamp AND $3::timestamp

            UNION ALL

            -- Armazenamento base (proporcional se necessário)
            SELECT 
                'STORAGE_BASE' as item_type,
                uc.id::text as item_id,
                NULL as sku,
                CASE 
                    WHEN DATE_PART('year', uc.start_date) = $4 
                         AND DATE_PART('month', uc.start_date) = $5
                         AND DATE_PART('day', uc.start_date) > 1
                    THEN CONCAT('Armazenamento Base (até 1m³) - Proporcional ', 
                               (DATE_PART('day', DATE_TRUNC('month', uc.start_date) + INTERVAL '1 month' - INTERVAL '1 day') - DATE_PART('day', uc.start_date) + 1)::int,
                               ' dias (entrada dia ', DATE_PART('day', uc.start_date)::int, ')')
                    ELSE 'Armazenamento Base (até 1m³)'
                END as description,
                1 as quantity,
                CASE 
                    WHEN DATE_PART('year', uc.start_date) = $4 
                         AND DATE_PART('month', uc.start_date) = $5
                         AND DATE_PART('day', uc.start_date) > 1
                    THEN ROUND((s.price / 30.0) * (DATE_PART('day', DATE_TRUNC('month', uc.start_date) + INTERVAL '1 month' - INTERVAL '1 day') - DATE_PART('day', uc.start_date) + 1), 2)
                    ELSE s.price
                END as unit_price,
                CASE 
                    WHEN DATE_PART('year', uc.start_date) = $4 
                         AND DATE_PART('month', uc.start_date) = $5
                         AND DATE_PART('day', uc.start_date) > 1
                    THEN ROUND((s.price / 30.0) * (DATE_PART('day', DATE_TRUNC('month', uc.start_date) + INTERVAL '1 month' - INTERVAL '1 day') - DATE_PART('day', uc.start_date) + 1), 2)
                    ELSE s.price
                END as total_price,
                CASE 
                    WHEN uc.start_date <= $6::date THEN $6::date
                    ELSE uc.start_date
                END::timestamp as consumption_date,
                NULL as account_nickname,
                NULL as shipping_mode,
                'Armazenamento' as category
            FROM public.user_contracts uc
            JOIN public.services s ON uc.service_id = s.id
            WHERE uc.uid = $1
                AND s.type = 'base_storage'
                AND uc.start_date <= $7::date
                AND (uc.end_date IS NULL OR uc.end_date >= $6::date)

            UNION ALL

            -- Armazenamento adicional
            SELECT 
                'STORAGE_ADDITIONAL' as item_type,
                uc.id::text as item_id,
                NULL as sku,
                'Armazenamento Adicional (m³)' as description,
                uc.volume as quantity,
                s.price as unit_price,
                (uc.volume * s.price) as total_price,
                CASE 
                    WHEN uc.start_date <= $6::date THEN $6::date
                    ELSE uc.start_date
                END::timestamp as consumption_date,
                NULL as account_nickname,
                NULL as shipping_mode,
                'Armazenamento' as category
            FROM public.user_contracts uc
            JOIN public.services s ON uc.service_id = s.id
            WHERE uc.uid = $1
                AND s.type = 'additional_storage'
                AND uc.volume > 0
                AND uc.start_date <= $7::date
                AND (uc.end_date IS NULL OR uc.end_date >= $6::date)

            UNION ALL

            -- Serviços avulsos
            SELECT 
                'SERVICE' as item_type,
                ii.id::text as item_id,
                NULL as sku,
                ii.description,
                ii.quantity,
                ii.unit_price,
                ii.total_price,
                COALESCE(ii.service_date::timestamp, i.due_date, i.created_at) as consumption_date,
                NULL as account_nickname,
                NULL as shipping_mode,
                'Serviço Avulso' as category
            FROM public.invoice_items ii
            JOIN public.invoices i ON ii.invoice_id = i.id
            WHERE i.uid = $1
                AND ii.type = 'manual'
                AND (
                    (ii.service_date IS NOT NULL 
                     AND ii.service_date BETWEEN $6::date AND $7::date)
                    OR
                    (ii.service_date IS NULL 
                     AND i.due_date BETWEEN $2::timestamp AND $3::timestamp)
                )

            ORDER BY consumption_date DESC, item_type, item_id
        `;

        const params = [
            userId,                    // $1
            sqlFormat.startDate,       // $2
            sqlFormat.endDate,         // $3
            year,                      // $4
            month,                     // $5
            sqlFormat.startDateLocal,  // $6
            sqlFormat.endDateLocal     // $7
        ];

        return {
            query,
            params,
            period,
            description: `Cobrança unificada de ${this.periodCalculator.formatPeriodDetailed(period)}`
        };
    }

    /**
     * Constrói query para debug - mostra itens que estão sendo incluídos incorretamente
     * @param {string} userId - ID do usuário
     * @param {number} year - Ano
     * @param {number} month - Mês
     * @returns {Object} Query e parâmetros
     */
    buildDebugQuery(userId, year, month) {
        const period = this.periodCalculator.calculatePeriod(year, month);
        const sqlFormat = this.periodCalculator.toSQLFormat(period);

        const query = `
            SELECT 
                'SALE' as item_type,
                s.id,
                s.sku,
                s.product_title,
                s.sale_date,
                s.processed_at,
                s.raw_api_data->>'shipping_date' as api_shipping_date,
                -- Verificar se está no período correto
                CASE 
                    WHEN s.processed_at BETWEEN $2::timestamp AND $3::timestamp THEN 'CORRETO'
                    WHEN s.processed_at < $2::timestamp THEN 'ANTERIOR'
                    WHEN s.processed_at > $3::timestamp THEN 'POSTERIOR'
                    ELSE 'SEM_DATA'
                END as period_status,
                -- Data que seria usada para cobrança
                CASE 
                    WHEN s.processed_at IS NOT NULL THEN s.processed_at
                    WHEN s.raw_api_data->>'shipping_date' IS NOT NULL THEN (s.raw_api_data->>'shipping_date')::timestamp
                    WHEN s.sale_date IS NOT NULL THEN s.sale_date
                    ELSE s.created_at
                END as consumption_date_used
            FROM public.sales s
            WHERE s.uid = $1
                AND s.processed_at IS NOT NULL
            ORDER BY s.processed_at DESC
            LIMIT 100
        `;

        const params = [userId, sqlFormat.startDate, sqlFormat.endDate];

        return {
            query,
            params,
            period,
            description: `Debug de vendas para ${this.periodCalculator.formatPeriodDetailed(period)}`
        };
    }

    /**
     * Constrói query para validar se há itens fora do período
     * @param {string} userId - ID do usuário
     * @param {number} year - Ano
     * @param {number} month - Mês
     * @returns {Object} Query e parâmetros
     */
    buildValidationQuery(userId, year, month) {
        const period = this.periodCalculator.calculatePeriod(year, month);
        const sqlFormat = this.periodCalculator.toSQLFormat(period);

        const query = `
            WITH billing_items AS (
                -- Mesma query unificada mas com validação
                SELECT 
                    'SALE' as item_type,
                    s.id::text as item_id,
                    s.processed_at as consumption_date,
                    CASE 
                        WHEN s.processed_at BETWEEN $2::timestamp AND $3::timestamp THEN true
                        ELSE false
                    END as is_in_correct_period
                FROM public.sales s
                WHERE s.uid = $1 AND s.processed_at IS NOT NULL
            )
            SELECT 
                item_type,
                COUNT(*) as total_items,
                COUNT(*) FILTER (WHERE is_in_correct_period) as correct_period_items,
                COUNT(*) FILTER (WHERE NOT is_in_correct_period) as incorrect_period_items,
                ROUND(
                    (COUNT(*) FILTER (WHERE is_in_correct_period)::decimal / COUNT(*)) * 100, 
                    2
                ) as accuracy_percentage
            FROM billing_items
            GROUP BY item_type
            
            UNION ALL
            
            SELECT 
                'TOTAL' as item_type,
                COUNT(*) as total_items,
                COUNT(*) FILTER (WHERE is_in_correct_period) as correct_period_items,
                COUNT(*) FILTER (WHERE NOT is_in_correct_period) as incorrect_period_items,
                ROUND(
                    (COUNT(*) FILTER (WHERE is_in_correct_period)::decimal / COUNT(*)) * 100, 
                    2
                ) as accuracy_percentage
            FROM billing_items
        `;

        const params = [userId, sqlFormat.startDate, sqlFormat.endDate];

        return {
            query,
            params,
            period,
            description: `Validação de período para ${this.periodCalculator.formatPeriodDetailed(period)}`
        };
    }

    /**
     * Gera relatório de comparação entre sistema antigo e novo
     * @param {string} userId - ID do usuário
     * @param {number} year - Ano
     * @param {number} month - Mês
     * @returns {Object} Queries de comparação
     */
    buildComparisonQueries(userId, year, month) {
        const period = this.periodCalculator.calculatePeriod(year, month);
        const sqlFormat = this.periodCalculator.toSQLFormat(period);

        // Query do sistema antigo (problemática)
        const oldSystemQuery = `
            SELECT 
                COUNT(*) as total_items,
                SUM(s.quantity * COALESCE(pt.price, 0)) as total_amount
            FROM public.sales s
            LEFT JOIN public.skus sk ON UPPER(TRIM(sk.sku)) = UPPER(TRIM(s.sku)) AND sk.user_id = s.uid
            LEFT JOIN public.package_types pt ON sk.package_type_id = pt.id
            WHERE s.uid = $1
                AND s.processed_at IS NOT NULL
                -- Sistema antigo: filtro incorreto que pode incluir itens de outros períodos
                AND s.sale_date BETWEEN $2::timestamp AND $3::timestamp
        `;

        // Query do sistema novo (corrigida)
        const newSystemQuery = `
            SELECT 
                COUNT(*) as total_items,
                SUM(s.quantity * COALESCE(pt.price, 0)) as total_amount
            FROM public.sales s
            LEFT JOIN public.skus sk ON UPPER(TRIM(sk.sku)) = UPPER(TRIM(s.sku)) AND sk.user_id = s.uid
            LEFT JOIN public.package_types pt ON sk.package_type_id = pt.id
            WHERE s.uid = $1
                AND s.processed_at IS NOT NULL
                -- Sistema novo: filtro correto usando data de processamento
                AND s.processed_at BETWEEN $2::timestamp AND $3::timestamp
        `;

        const params = [userId, sqlFormat.startDate, sqlFormat.endDate];

        return {
            oldSystemQuery: { query: oldSystemQuery, params },
            newSystemQuery: { query: newSystemQuery, params },
            period,
            description: `Comparação de sistemas para ${this.periodCalculator.formatPeriodDetailed(period)}`
        };
    }
}

// Instância singleton para uso global
export const billingQueryBuilder = new BillingQueryBuilder();

// Export default para compatibilidade
export default BillingQueryBuilder;