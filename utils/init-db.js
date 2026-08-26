// backend/utils/init-db.js

const crypto = require('crypto');
const db = require('./postgres');

const schema = {
    package_types: `
        CREATE TABLE public.package_types (
            id SERIAL PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            price NUMERIC(10, 2) NOT NULL
        );`,
    services: `
        CREATE TABLE public.services (
            id SERIAL PRIMARY KEY,
            name VARCHAR(255) NOT NULL UNIQUE,
            price NUMERIC(10,2) NOT NULL,
            description TEXT,
            type VARCHAR(50),
            config JSONB
        );`,
    users: `
        CREATE TABLE public.users (
            uid VARCHAR(255) PRIMARY KEY,
            email VARCHAR(255) UNIQUE NOT NULL,
            name VARCHAR(255),
            role VARCHAR(50) NOT NULL DEFAULT 'cliente',
            active BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP WITH TIME ZONE,
            password_hash VARCHAR(255)
        );`,
    ml_accounts: `
        CREATE TABLE public.ml_accounts (
            uid VARCHAR(255) NOT NULL,
            user_id BIGINT NOT NULL,
            nickname VARCHAR(255),
            access_token TEXT NOT NULL,
            refresh_token TEXT NOT NULL,
            expires_in BIGINT,
            status VARCHAR(50) DEFAULT 'active',
            connected_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP WITH TIME ZONE,
            PRIMARY KEY (uid, user_id)
        );`,
    ml_sync_cursors: `
        CREATE TABLE public.ml_sync_cursors (
            uid VARCHAR(255) NOT NULL,
            seller_id BIGINT NOT NULL,
            last_remote_updated_at TIMESTAMP WITH TIME ZONE NOT NULL,
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (uid, seller_id)
        );`,
    sales: `
        CREATE TABLE public.sales (
            id BIGINT NOT NULL,
            sku VARCHAR(255) NOT NULL,
            uid VARCHAR(255) NOT NULL,
            seller_id BIGINT NOT NULL,
            channel VARCHAR(50),
            account_nickname VARCHAR(255),
            sale_date TIMESTAMP WITH TIME ZONE,
            product_title TEXT,
            quantity INTEGER,
            shipping_mode VARCHAR(255),
            shipping_limit_date TIMESTAMP WITH TIME ZONE,
            packages INTEGER,
            shipping_status VARCHAR(100) DEFAULT 'Pendente',
            raw_api_data JSONB,
            updated_at TIMESTAMP WITH TIME ZONE,
            processed_at TIMESTAMP WITH TIME ZONE,
            UNIQUE (id, sku, uid)
        );`,
    system_settings: `
        CREATE TABLE public.system_settings (
            key VARCHAR(100) PRIMARY KEY,
            value JSONB,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );`,
    shopee_oauth_attempts: `
        CREATE TABLE IF NOT EXISTS public.shopee_oauth_attempts (
            state_hash CHAR(64) PRIMARY KEY,
            uid VARCHAR(255) NOT NULL REFERENCES public.users(uid) ON DELETE CASCADE,
            expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
            claim_id UUID,
            claimed_at TIMESTAMP WITH TIME ZONE,
            consumed_at TIMESTAMP WITH TIME ZONE,
            shop_id BIGINT,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_shopee_oauth_attempts_expires
            ON public.shopee_oauth_attempts (expires_at);`,
    shopee_accounts: `
        CREATE TABLE public.shopee_accounts (
            uid VARCHAR(255) NOT NULL,
            shop_id BIGINT NOT NULL,
            shop_name VARCHAR(255),
            merchant_id VARCHAR(255),
            access_token TEXT NOT NULL,
            refresh_token TEXT NOT NULL,
            expires_at TIMESTAMP WITH TIME ZONE,
            status VARCHAR(50) DEFAULT 'active',
            connected_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP WITH TIME ZONE,
            PRIMARY KEY (uid, shop_id)
        );`,
    shopee_sync_cursors: `
        CREATE TABLE public.shopee_sync_cursors (
            uid VARCHAR(255) NOT NULL,
            shop_id BIGINT NOT NULL,
            update_time_scanned_through TIMESTAMP WITH TIME ZONE,
            backfill_scanned_through TIMESTAMP WITH TIME ZONE,
            backfill_started_at TIMESTAMP WITH TIME ZONE,
            initial_backfill_completed_at TIMESTAMP WITH TIME ZONE,
            last_deep_sweep_at TIMESTAMP WITH TIME ZONE,
            last_attempt_at TIMESTAMP WITH TIME ZONE,
            last_success_at TIMESTAMP WITH TIME ZONE,
            status VARCHAR(20) NOT NULL DEFAULT 'idle',
            last_error TEXT,
            last_result JSONB,
            job_id VARCHAR(100),
            locked_until TIMESTAMP WITH TIME ZONE,
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (uid, shop_id),
            FOREIGN KEY (uid, shop_id) REFERENCES public.shopee_accounts(uid, shop_id) ON DELETE CASCADE
        );`,
    shopee_sync_jobs: `
        CREATE TABLE public.shopee_sync_jobs (
            client_id VARCHAR(100) PRIMARY KEY,
            uid VARCHAR(255) NOT NULL,
            shop_id BIGINT NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'running',
            result JSONB,
            error TEXT,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
            expires_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '1 day'),
            FOREIGN KEY (uid, shop_id) REFERENCES public.shopee_accounts(uid, shop_id) ON DELETE CASCADE
        );`,
    shopee_sales: `
        CREATE TABLE public.shopee_sales (
            order_sn VARCHAR(50) NOT NULL,
            sku VARCHAR(255) NOT NULL,
            uid VARCHAR(255) NOT NULL,
            shop_id BIGINT NOT NULL,
            account_nickname VARCHAR(255),
            sale_date TIMESTAMP WITH TIME ZONE,
            product_title TEXT,
            quantity INTEGER,
            unit_price NUMERIC(10, 2),
            total_amount NUMERIC(10, 2),
            platform_fee NUMERIC(10, 2),
            freight NUMERIC(10, 2),
            net_revenue NUMERIC(10, 2),
            order_status VARCHAR(50),
            buyer_username VARCHAR(255),
            recipient_name VARCHAR(255),
            tracking_number VARCHAR(255),
            shipping_carrier VARCHAR(100),
            ship_by_date TIMESTAMP WITH TIME ZONE,
            shipping_status VARCHAR(100) DEFAULT 'Pendente',
            raw_api_data JSONB,
            updated_at TIMESTAMP WITH TIME ZONE,
            processed_at TIMESTAMP WITH TIME ZONE,
            PRIMARY KEY (order_sn, sku, uid)
        );`,
    skus: `
        CREATE TABLE public.skus (
            id SERIAL PRIMARY KEY,
            user_id VARCHAR(255) NOT NULL REFERENCES public.users(uid) ON DELETE CASCADE,
            sku VARCHAR(255) NOT NULL,
            descricao TEXT,
            dimensoes JSONB,
            quantidade INTEGER DEFAULT 0,
            package_type_id INTEGER REFERENCES public.package_types(id) ON DELETE SET NULL,
            kit_parent_id INTEGER,
            is_kit BOOLEAN DEFAULT FALSE,
            ativo BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP WITH TIME ZONE,
            UNIQUE (user_id, sku)
        );`,
    stock_movements: `
        CREATE TABLE public.stock_movements (
            id SERIAL PRIMARY KEY,
            sku_id INTEGER NOT NULL REFERENCES public.skus(id) ON DELETE CASCADE,
            user_id VARCHAR(255) NOT NULL,
            movement_type VARCHAR(20) NOT NULL,
            quantity_change INTEGER NOT NULL,
            reason TEXT,
            related_sale_id BIGINT,
            external_sale_id VARCHAR(100),
            package_type_id INTEGER REFERENCES public.package_types(id),
            package_type_context TEXT,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );`,
    user_contracts: `
        CREATE TABLE public.user_contracts (
            id SERIAL PRIMARY KEY,
            uid VARCHAR(255) NOT NULL REFERENCES public.users(uid) ON DELETE CASCADE,
            service_id INTEGER NOT NULL REFERENCES public.services(id) ON DELETE RESTRICT,
            name VARCHAR(255) NOT NULL,
            price NUMERIC(10,2) NOT NULL,
            volume INTEGER,
            start_date DATE NOT NULL,
            CONSTRAINT unique_contract UNIQUE (uid, service_id)
        );`,
    user_statuses: `
        CREATE TABLE public.user_statuses (
            user_id VARCHAR(255) PRIMARY KEY REFERENCES public.users(uid) ON DELETE CASCADE,
            statuses JSONB,
            updated_at TIMESTAMP WITH TIME ZONE
        );`,
    invoices: `
        CREATE TABLE public.invoices (
            id SERIAL PRIMARY KEY,
            uid VARCHAR(255) NOT NULL REFERENCES public.users(uid) ON DELETE CASCADE,
            period VARCHAR(7) NOT NULL,
            due_date DATE NOT NULL,
            payment_date DATE,
            total_amount NUMERIC(10, 2) NOT NULL,
            status VARCHAR(50) NOT NULL DEFAULT 'pending',
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(uid, period)
        );`,
    invoice_items: `
        CREATE TABLE public.invoice_items (
            id SERIAL PRIMARY KEY,
            invoice_id INTEGER NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
            description TEXT NOT NULL,
            quantity INTEGER NOT NULL,
            unit_price NUMERIC(10, 2) NOT NULL,
            total_price NUMERIC(10, 2) NOT NULL,
            type VARCHAR(50) NOT NULL,
            service_date DATE
        );`,
    sku_kit_components: `
        CREATE TABLE public.sku_kit_components (
            id SERIAL PRIMARY KEY,
            kit_sku_id INTEGER NOT NULL REFERENCES public.skus(id) ON DELETE CASCADE,
            child_sku_id INTEGER NOT NULL REFERENCES public.skus(id) ON DELETE CASCADE,
            quantity_per_kit INTEGER NOT NULL DEFAULT 1 CHECK (quantity_per_kit > 0),
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (kit_sku_id, child_sku_id)
        );`,
    kit_parents: `
        CREATE TABLE public.kit_parents (
            id SERIAL PRIMARY KEY,
            user_id VARCHAR(255) NOT NULL REFERENCES public.users(uid) ON DELETE CASCADE,
            nome VARCHAR(255) NOT NULL,
            descricao TEXT,
            ativo BOOLEAN DEFAULT true,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );`,
    /* Eventos recebidos do provedor de cobrança.
     *
     * Existe por dois motivos, e nenhum é opcional em integração financeira:
     *
     * 1. IDEMPOTÊNCIA. O mesmo evento pode chegar mais de uma vez (retentativa
     *    do provedor, timeout nosso que ele interpreta como falha). `event_id`
     *    é PRIMARY KEY, então processar duas vezes é impossível por construção,
     *    não por lembrança de quem escreveu o handler.
     *
     * 2. AUDITORIA. Quando um cliente disser que pagou e o sistema disser que
     *    não, a resposta tem que estar gravada com o payload cru e a hora, sem
     *    depender de log rotativo de container.
     *
     * `processed_at` nulo = chegou mas não foi aplicado (erro no processamento);
     * é o que permite reprocessar sem receber o evento de novo.
     */
    asaas_webhook_events: `
        CREATE TABLE public.asaas_webhook_events (
            event_id VARCHAR(120) PRIMARY KEY,
            event_type VARCHAR(60),
            payment_id VARCHAR(40),
            uid VARCHAR(255),
            period VARCHAR(7),
            payload JSONB NOT NULL,
            received_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
            processed_at TIMESTAMP WITH TIME ZONE,
            error TEXT
        );`
};

/* ---------------------------------------------------------------------------
 * View unificada de vendas (Mercado Livre + Shopee).
 *
 * As telas de venda/expedição são multi-marketplace: quem separa pedido precisa
 * de UMA fila, não de uma tela por canal. A view normaliza as duas tabelas num
 * formato comum para que filtro, busca e paginação funcionem sobre o conjunto.
 *
 * `id` é TEXT porque o ML usa order_id numérico e a Shopee usa order_sn
 * alfanumérico. Coluna exclusiva de um canal vem NULL no outro.
 * ------------------------------------------------------------------------- */
const UNIFIED_SALES_VIEW_SQL = `
    CREATE VIEW public.unified_sales AS
    SELECT
        'ML'::text                              AS marketplace,
        s.id::text                              AS id,
        s.sku,
        s.uid,
        s.seller_id::text                       AS account_id,
        s.account_nickname,
        s.sale_date,
        s.product_title,
        s.quantity,
        s.shipping_mode,
        -- O SLA do ML é o prazo real de despacho e tem precedência. O cast é
        -- guardado por regex: um valor malformado no JSON derrubaria a consulta
        -- inteira da view, não apenas a linha.
        COALESCE(
            CASE
                WHEN s.raw_api_data->'sla_data'->>'expected_date' ~ '^\\d{4}-\\d{2}-\\d{2}'
                THEN (s.raw_api_data->'sla_data'->>'expected_date')::timestamptz
            END,
            s.shipping_limit_date
        )                                       AS shipping_deadline,
        s.shipping_status,
        s.processed_at,
        s.updated_at,
        s.raw_api_data->>'status'               AS order_status,
        s.raw_api_data->'shipping'->>'id'       AS shipping_id,
        s.raw_api_data->'order_items'->0->'item'->>'thumbnail'  AS product_thumbnail,
        s.raw_api_data->'order_items'->0->'item'->>'permalink'  AS product_permalink,
        s.raw_api_data->'order_items'->0->'item'->>'id'         AS item_id,
        TRIM(CONCAT_WS(' ',
            s.raw_api_data->'buyer'->>'first_name',
            s.raw_api_data->'buyer'->>'last_name'
        ))                                      AS buyer_name,
        s.raw_api_data->'buyer'->>'nickname'    AS buyer_nickname,
        s.raw_api_data                          AS raw_api_data
    FROM public.sales s

    UNION ALL

    SELECT
        'Shopee'::text                          AS marketplace,
        sp.order_sn                             AS id,
        sp.sku,
        sp.uid,
        sp.shop_id::text                        AS account_id,
        sp.account_nickname,
        sp.sale_date,
        sp.product_title,
        sp.quantity,
        -- A Shopee não tem a modalidade do ML (FULL/FLEX). Usamos a
        -- transportadora do pacote como modalidade exibida.
        COALESCE(NULLIF(sp.shipping_carrier, ''), 'Shopee')     AS shipping_mode,
        sp.ship_by_date                         AS shipping_deadline,
        sp.shipping_status,
        sp.processed_at,
        sp.updated_at,
        sp.order_status,
        NULL::text                              AS shipping_id,
        COALESCE(
            sp.raw_api_data->'synced_item',
            sp.raw_api_data->'item_list'->0
        )->'image_info'->>'image_url'           AS product_thumbnail,
        CASE
            WHEN COALESCE(
                sp.raw_api_data->'synced_item',
                sp.raw_api_data->'item_list'->0
            )->>'item_id' IS NOT NULL
            THEN 'https://shopee.com.br/product/' || sp.shop_id::text || '/' ||
                 (COALESCE(
                    sp.raw_api_data->'synced_item',
                    sp.raw_api_data->'item_list'->0
                 )->>'item_id')
            ELSE NULL
        END                                     AS product_permalink,
        COALESCE(
            sp.raw_api_data->'synced_item',
            sp.raw_api_data->'item_list'->0
        )->>'item_id'                           AS item_id,
        sp.recipient_name                       AS buyer_name,
        sp.buyer_username                       AS buyer_nickname,
        sp.raw_api_data                         AS raw_api_data
    FROM public.shopee_sales sp;
`;

/**
 * Cria/atualiza public.unified_sales fora da transação de schema.
 *
 * Antes isto rodava dentro da transação que já mantinha lock exclusivo em
 * `sales` (ALTER TABLE/CREATE INDEX). O DROP/CREATE da view precisa de
 * AccessExclusiveLock nela; uma requisição simultânea lendo `unified_sales` e
 * precisando de `sales` fechava o ciclo e o Postgres abortava o boot com
 * deadlock (40P01) — a aplicação entrava em loop de reinício.
 *
 * Agora: só recria quando a definição realmente mudou, usa lock_timeout curto e
 * não é fatal quando a view já existe.
 */
/* Índices de performance das telas de venda.
 *
 * Estavam apenas em migrations/create-unified-sales-indexes.sql, que só roda por
 * `psql -f` manual — ou seja, em produção provavelmente NÃO existiam, e toda
 * busca textual virava varredura completa das duas tabelas.
 *
 * Rodam FORA da transação de schema e com CONCURRENTLY: não bloqueiam escrita e
 * uma falha aqui não derruba o boot (o índice é otimização, não requisito).
 */
const PERFORMANCE_INDEXES = [
    'CREATE EXTENSION IF NOT EXISTS pg_trgm',
    // Busca por produto/SKU/conta (ILIKE '%termo%' precisa de trigrama).
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sales_product_title_trgm ON public.sales USING gin (product_title gin_trgm_ops)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sales_sku_trgm ON public.sales USING gin (sku gin_trgm_ops)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sales_nickname_trgm ON public.sales USING gin (account_nickname gin_trgm_ops)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_shopee_sales_product_title_trgm ON public.shopee_sales USING gin (product_title gin_trgm_ops)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_shopee_sales_sku_trgm ON public.shopee_sales USING gin (sku gin_trgm_ops)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_shopee_sales_nickname_trgm ON public.shopee_sales USING gin (account_nickname gin_trgm_ops)',
    // Filtro "processado / não processado", nos dois sentidos.
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sales_pending_processing ON public.sales (uid, sale_date DESC) WHERE processed_at IS NULL',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sales_done_processing ON public.sales (uid, processed_at DESC) WHERE processed_at IS NOT NULL',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_shopee_sales_pending_processing ON public.shopee_sales (uid, sale_date DESC) WHERE processed_at IS NULL',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_shopee_sales_done_processing ON public.shopee_sales (uid, processed_at DESC) WHERE processed_at IS NOT NULL',
    // Prazo de despacho do ML: o COALESCE não é indexável, mas os dois lados são.
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sales_sla_expected_text ON public.sales ((raw_api_data->'sla_data'->>'expected_date')) WHERE raw_api_data->'sla_data'->>'expected_date' IS NOT NULL`,
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sales_limit_date_no_sla ON public.sales (shipping_limit_date) WHERE raw_api_data->'sla_data'->>'expected_date' IS NULL`,
    // Modalidade, status e agrupamento de pacote.
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sales_logistic_type ON public.sales ((raw_api_data->'shipping'->>'logistic_type'))`,
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sales_shipping_id_expr ON public.sales ((raw_api_data->'shipping'->>'id')) WHERE raw_api_data->'shipping'->>'id' IS NOT NULL`,
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sales_uid_shipping_status ON public.sales (uid, shipping_status)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_shopee_sales_order_status ON public.shopee_sales (order_status)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_shopee_sales_ship_by_date ON public.shopee_sales (ship_by_date)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_shopee_sales_shipping_status ON public.shopee_sales (shipping_status)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_shopee_sales_carrier ON public.shopee_sales (shipping_carrier)',
    // Cursores de sincronização.
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ml_sync_cursors_lookup ON public.ml_sync_cursors (uid, seller_id)',
    // Movimentações de estoque: a tabela não tinha NENHUM índice, e a tela de
    // armazenamento pagina por usuário e data.
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_stock_movements_user_created ON public.stock_movements (user_id, created_at DESC)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_stock_movements_sku ON public.stock_movements (sku_id)',
];

async function applyPerformanceIndexes() {
    console.log('   -> Verificando índices de performance das telas de venda...');
    let created = 0;
    let failed = 0;

    for (const statement of PERFORMANCE_INDEXES) {
        try {
            // Sem transação: CONCURRENTLY não é permitido dentro de uma.
            await db.query(statement);
            created += 1;
        } catch (error) {
            failed += 1;
            const name = statement.match(/idx_[a-z0-9_]+/i)?.[0] || 'extensão pg_trgm';
            console.warn(`   -> índice ${name} não pôde ser criado agora: ${error.message}`);
        }
    }

    console.log(`   -> Índices verificados (${created} ok, ${failed} pendentes).`);
    try {
        await db.query('ANALYZE public.sales');
        await db.query('ANALYZE public.shopee_sales');
    } catch (error) {
        console.warn(`   -> ANALYZE não concluído: ${error.message}`);
    }
}

/* ---------------------------------------------------------------------------
 * Correções retroativas de dado histórico.
 *
 * São três: preencher `date_last_updated` e `sync_signature` em public.sales
 * (colunas criadas depois das linhas) e recalcular `sale_date` em
 * public.shopee_sales (o sync antigo gravava "wall clock" numa coluna que
 * guarda instante absoluto).
 *
 * Rodavam DENTRO da transação de esquema, filtradas por `coluna IS NULL`. Não
 * existe índice que responda isso, então o Postgres varria as duas tabelas
 * inteiras em TODO boot — medido em produção: 17 dos 19 segundos, numa etapa
 * que já não tinha nada para fazer. E a varredura acontecia com
 * AccessExclusiveLock nas tabelas (dos ALTER TABLE), travando qualquer
 * requisição de vendas durante o deploy.
 *
 * Agora: em segundo plano, depois que o servidor já responde, EM LOTES com uma
 * transação curta por lote. O sistema nunca espera por isso, e nenhum lote
 * segura lock por mais que alguns milissegundos. Terminou tudo, grava o
 * marcador e nunca mais roda.
 *
 * Interromper no meio é seguro: o marcador só é gravado no fim, e cada lote já
 * confirmado não volta a aparecer no filtro.
 * ------------------------------------------------------------------------- */
const BACKFILL_BATCH = 5000;

const LEGACY_BACKFILLS = [
    {
        key: 'sales_sync_columns_backfilled',
        label: 'date_last_updated e sync_signature em public.sales',
        steps: [
            // ctid é o endereço físico da linha: o jeito mais barato de recortar
            // um lote sem depender de índice na condição do filtro.
            `WITH lote AS (
                 SELECT ctid
                   FROM public.sales
                  WHERE date_last_updated IS NULL
                    AND raw_api_data ? 'date_last_updated'
                    AND (raw_api_data->>'date_last_updated') ~ '^[0-9]{4}-'
                  LIMIT ${BACKFILL_BATCH}
             )
             UPDATE public.sales s
                SET date_last_updated = (s.raw_api_data->>'date_last_updated')::timestamptz
               FROM lote
              WHERE s.ctid = lote.ctid`,

            `WITH lote AS (
                 SELECT ctid
                   FROM public.sales
                  WHERE sync_signature IS NULL
                    AND raw_api_data IS NOT NULL
                  LIMIT ${BACKFILL_BATCH}
             )
             UPDATE public.sales s
                SET sync_signature =
                      COALESCE(s.raw_api_data->>'status','') || '|' ||
                      COALESCE(s.raw_api_data->'shipping'->>'status','') || '|' ||
                      COALESCE(s.raw_api_data->'shipping'->>'substatus','') || '|' ||
                      COALESCE(
                        CASE
                          WHEN jsonb_typeof(s.raw_api_data->'tags') = 'array'
                          THEN (SELECT string_agg(t, ',' ORDER BY t)
                                  FROM jsonb_array_elements_text(s.raw_api_data->'tags') t)
                          ELSE ''
                        END,
                        ''
                      )
               FROM lote
              WHERE s.ctid = lote.ctid`,
        ],
    },
    {
        /* Preenche os campos derivados do JSON criados em syncDatabaseSchema.
         *
         * Escreve APENAS as cinco colunas novas. Nenhuma coluna existente entra
         * no SET, então nada do que já estava gravado é alterado ou perdido.
         *
         * Os valores são copiados exatamente como o JSON os entrega, inclusive
         * NULL quando o campo não existe. Isso é essencial: `U_OPERATIONAL_STATUS`
         * faz COALESCE(shipping.status, order_status, shipping_status) e depende
         * do NULL para cair para o campo seguinte. Guardar '' no lugar de NULL
         * mudaria silenciosamente o status operacional de pedidos sem
         * shipping.status.
         *
         * ATENÇÃO: a extração aqui precisa bater EXATAMENTE com a do lado da
         * gravação em router/sales.js (mapOrdersToRows). Se divergirem, linha
         * antiga e linha nova passam a ter valores diferentes para o mesmo
         * pedido. */
        key: 'sales_derived_fields_backfilled_v1',
        label: 'campos derivados do JSON em public.sales (order_status, logistic_type, shipment_status, sla_expected_date)',
        steps: [
            `WITH lote AS (
                 SELECT ctid
                   FROM public.sales
                  WHERE derived_fields_at IS NULL
                  LIMIT ${BACKFILL_BATCH}
             )
             UPDATE public.sales s
                SET order_status      = s.raw_api_data->>'status',
                    logistic_type     = s.raw_api_data->'shipping'->>'logistic_type',
                    shipment_status   = s.raw_api_data->'shipping'->>'status',
                    sla_expected_date = CASE
                                          WHEN (s.raw_api_data->'sla_data'->>'expected_date') ~ '^\\d{4}-\\d{2}-\\d{2}'
                                          THEN (s.raw_api_data->'sla_data'->>'expected_date')::timestamptz
                                        END,
                    derived_fields_at = NOW()
               FROM lote
              WHERE s.ctid = lote.ctid`,
        ],
    },
    {
        key: 'shopee_sale_date_tz_fixed',
        label: 'fuso da data de venda em public.shopee_sales',
        steps: [
            `WITH lote AS (
                 SELECT ctid
                   FROM public.shopee_sales
                  WHERE raw_api_data ? 'create_time'
                    AND (raw_api_data->>'create_time') ~ '^[0-9]+$'
                    AND (raw_api_data->>'create_time')::double precision > 0
                    AND sale_date IS DISTINCT FROM
                        to_timestamp((raw_api_data->>'create_time')::double precision)
                  LIMIT ${BACKFILL_BATCH}
             )
             UPDATE public.shopee_sales s
                SET sale_date = to_timestamp((s.raw_api_data->>'create_time')::double precision)
               FROM lote
              WHERE s.ctid = lote.ctid`,
        ],
    },
];

async function applyLegacyBackfills() {
    for (const { key, label, steps } of LEGACY_BACKFILLS) {
        try {
            const done = await db.query(
                `SELECT 1 FROM public.system_settings WHERE key = $1`,
                [key]
            );
            if (done.rowCount > 0) continue;

            console.log(`   -> Preenchimento retroativo em segundo plano: ${label}...`);
            let total = 0;

            for (const step of steps) {
                for (;;) {
                    const client = await db.pool.connect();
                    let affected = 0;
                    try {
                        await client.query('BEGIN');
                        // Só neste lote: o pool corta em 30s e um lote de 5.000
                        // linhas com detoast de JSONB pode passar disso.
                        await client.query('SET LOCAL statement_timeout = 0');
                        const result = await client.query(step);
                        affected = result.rowCount || 0;
                        await client.query('COMMIT');
                    } catch (error) {
                        try { await client.query('ROLLBACK'); } catch { /* já encerrada */ }
                        throw error;
                    } finally {
                        client.release();
                    }

                    total += affected;
                    if (affected < BACKFILL_BATCH) break;
                    // Devolve a vez para as requisições entre lotes.
                    await new Promise((resolve) => setTimeout(resolve, 250));
                }
            }

            await db.query(
                `INSERT INTO public.system_settings (key, value, updated_at)
                 VALUES ($1, to_jsonb(NOW()::text), NOW())
                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
                [key]
            );
            console.log(`   -> Concluído: ${label} (${total} linha(s) ajustada(s)).`);
        } catch (error) {
            // Nunca fatal: o marcador não é gravado e a próxima subida retoma de
            // onde parou. Correção de dado histórico não derruba o sistema.
            console.warn(`   -> Preenchimento retroativo "${label}" não concluído agora: ${error.message}`);
        }
    }
}

async function applyUnifiedSalesView() {
    const desiredHash = crypto.createHash('md5').update(UNIFIED_SALES_VIEW_SQL).digest('hex');
    const client = await db.pool.connect();

    try {
        const existing = await client.query(`SELECT to_regclass('public.unified_sales') IS NOT NULL AS exists`);
        const viewExists = existing.rows[0]?.exists === true;

        const stored = await client.query(
            `SELECT value #>> '{}' AS hash FROM public.system_settings WHERE key = 'unified_sales_view_hash'`
        );
        const storedHash = stored.rows[0]?.hash || null;

        if (viewExists && storedHash === desiredHash) {
            console.log('   -> View public.unified_sales já está atualizada.');
            return;
        }

        console.log('   -> Criando/atualizando view public.unified_sales...');
        await client.query('BEGIN');
        // Desiste rápido em vez de brigar por lock com as telas em uso.
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query('DROP VIEW IF EXISTS public.unified_sales;');
        await client.query(UNIFIED_SALES_VIEW_SQL);
        await client.query(
            `INSERT INTO public.system_settings (key, value, updated_at)
             VALUES ('unified_sales_view_hash', to_jsonb($1::text), NOW())
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
            [desiredHash]
        );
        await client.query('COMMIT');
        console.log('   -> View public.unified_sales atualizada.');
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* transação já encerrada */ }

        const viewStillThere = await client
            .query(`SELECT to_regclass('public.unified_sales') IS NOT NULL AS exists`)
            .then((r) => r.rows[0]?.exists === true)
            .catch(() => false);

        if (viewStillThere) {
            // A view antiga continua servindo as telas. Não vale derrubar o
            // sistema por não conseguir atualizá-la agora.
            console.warn(`⚠️  Não foi possível atualizar public.unified_sales agora (${error.message}). A versão atual segue em uso; será tentado no próximo start.`);
            return;
        }
        throw error;
    } finally {
        client.release();
    }
}

async function syncDatabaseSchema() {
    const client = await db.pool.connect();
    try {
        console.log('--- Iniciando sincronização do esquema do banco de dados ---');
        const res = await client.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
        const existingTables = res.rows.map(row => row.tablename);
        
        const tablesInOrder = [
            'users', 'package_types', 'services', 'ml_accounts', 'ml_sync_cursors', 'system_settings',
            'user_statuses', 'user_contracts', 'skus', 'sku_kit_components', 'kit_parents', 'sales', 'stock_movements',
            'invoices', 'invoice_items', 'shopee_oauth_attempts', 'shopee_accounts',
            'shopee_sync_cursors', 'shopee_sync_jobs', 'shopee_sales'
        ];

        await client.query('BEGIN');
        for (const tableName of tablesInOrder) {
            if (!existingTables.includes(tableName)) {
                console.log(`   -> Criando tabela: public.${tableName}`);
                await client.query(schema[tableName]);
            } else {
                // Lógica de migração para tabelas existentes
                if (tableName === 'shopee_oauth_attempts') {
                    await client.query('ALTER TABLE public.shopee_oauth_attempts ADD COLUMN IF NOT EXISTS claim_id UUID;');
                    await client.query('ALTER TABLE public.shopee_oauth_attempts ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMP WITH TIME ZONE;');
                    await client.query('ALTER TABLE public.shopee_oauth_attempts ADD COLUMN IF NOT EXISTS shop_id BIGINT;');
                    await client.query(`
                        CREATE INDEX IF NOT EXISTS idx_shopee_oauth_attempts_expires
                            ON public.shopee_oauth_attempts (expires_at)
                    `);
                }
                if (tableName === 'shopee_sync_cursors') {
                    await client.query('ALTER TABLE public.shopee_sync_cursors ADD COLUMN IF NOT EXISTS last_result JSONB;');
                    await client.query('ALTER TABLE public.shopee_sync_cursors ADD COLUMN IF NOT EXISTS backfill_scanned_through TIMESTAMP WITH TIME ZONE;');
                    await client.query('ALTER TABLE public.shopee_sync_cursors ADD COLUMN IF NOT EXISTS backfill_started_at TIMESTAMP WITH TIME ZONE;');
                    // Antes desta coluna existir, toda sincronização incremental já
                    // relia 24h. Portanto um cursor existente já fez uma varredura
                    // profunda; carimbá-lo evita cobrar novamente esse mesmo dia
                    // inteiro logo no primeiro clique após o deploy.
                    await client.query('ALTER TABLE public.shopee_sync_cursors ADD COLUMN IF NOT EXISTS last_deep_sweep_at TIMESTAMP WITH TIME ZONE;');
                    await client.query(`
                        UPDATE public.shopee_sync_cursors
                           SET last_deep_sweep_at = NOW()
                         WHERE last_deep_sweep_at IS NULL
                           AND update_time_scanned_through IS NOT NULL
                    `);
                }
                if (tableName === 'users') {
                    // Verifica e adiciona a coluna 'name' se não existir
                    const nameColRes = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'name'`);
                    if (nameColRes.rowCount === 0) {
                        console.log(`   -> Adicionando coluna 'name' à tabela: public.users`);
                        await client.query('ALTER TABLE public.users ADD COLUMN name VARCHAR(255);');
                    }
                    // Verifica e adiciona a coluna 'updated_at' se não existir
                    const updatedAtColRes = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'updated_at'`);
                    if (updatedAtColRes.rowCount === 0) {
                        console.log(`   -> Adicionando coluna 'updated_at' à tabela: public.users`);
                        await client.query('ALTER TABLE public.users ADD COLUMN updated_at TIMESTAMP WITH TIME ZONE;');
                    }
                    // Verifica e adiciona a coluna 'active' se não existir
                    const activeColRes = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'active'`);
                    if (activeColRes.rowCount === 0) {
                        console.log(`   -> Adicionando coluna 'active' à tabela: public.users`);
                        await client.query('ALTER TABLE public.users ADD COLUMN active BOOLEAN DEFAULT TRUE;');
                    }

                    /* ---------------- Dados de cobrança do cliente ----------------
                     *
                     * O cadastro só tinha e-mail e nome. Qualquer emissão de
                     * cobrança fora do sistema (Asaas, banco, nota fiscal) exige
                     * o documento do pagador, e o CPF/CNPJ é justamente o critério
                     * que a maioria dessas APIs usa para não duplicar cadastro.
                     *
                     * Guardado SEM máscara (só dígitos), para a comparação não
                     * depender de quem digitou com ponto ou sem. A formatação é
                     * problema da tela.
                     *
                     * `asaas_customer_id` fica aqui, e não numa tabela separada,
                     * porque é uma relação de um para um com o cliente e evita um
                     * JOIN em todo lugar que precisa cobrar. Se um dia entrar um
                     * segundo provedor, aí sim vale uma tabela de vínculos.
                     */
                    const cpfCnpjColRes = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'cpf_cnpj'`);
                    if (cpfCnpjColRes.rowCount === 0) {
                        console.log(`   -> Adicionando coluna 'cpf_cnpj' à tabela: public.users`);
                        await client.query('ALTER TABLE public.users ADD COLUMN cpf_cnpj VARCHAR(14);');
                    }
                    const phoneColRes = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'phone'`);
                    if (phoneColRes.rowCount === 0) {
                        console.log(`   -> Adicionando coluna 'phone' à tabela: public.users`);
                        await client.query('ALTER TABLE public.users ADD COLUMN phone VARCHAR(20);');
                    }
                    const asaasCustomerColRes = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'asaas_customer_id'`);
                    if (asaasCustomerColRes.rowCount === 0) {
                        console.log(`   -> Adicionando coluna 'asaas_customer_id' à tabela: public.users`);
                        await client.query('ALTER TABLE public.users ADD COLUMN asaas_customer_id VARCHAR(40);');
                    }
                    // Um cadastro do provedor por cliente. Índice parcial: a
                    // esmagadora maioria das linhas é NULL enquanto não houver
                    // integração, e NULL não conflita com NULL.
                    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_asaas_customer
                                        ON public.users(asaas_customer_id)
                                     WHERE asaas_customer_id IS NOT NULL;`);
                }
                 if (tableName === 'services') {
                    const colRes = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'services' AND column_name = 'config'`);
                    if (colRes.rowCount === 0) {
                        console.log(`   -> Adicionando coluna 'config' à tabela: public.services`);
                        await client.query('ALTER TABLE public.services ADD COLUMN config JSONB;');
                    }
                    // Unidade de medida do serviço (m³, pacote, viagem, venda, unidade).
                    // Antes a unidade só existia embutida no nome ("... (até 1m³)"),
                    // o que impedia exibir "3 pacotes" ou "1 m³" na fatura.
                    const unitColRes = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'services' AND column_name = 'unit'`);
                    if (unitColRes.rowCount === 0) {
                        console.log(`   -> Adicionando coluna 'unit' à tabela: public.services`);
                        await client.query(`ALTER TABLE public.services ADD COLUMN unit VARCHAR(30);`);
                    }
                    const constraintRes = await client.query(`SELECT constraint_name FROM information_schema.table_constraints WHERE table_name = 'services' AND constraint_type = 'UNIQUE' AND table_schema = 'public' AND constraint_name = 'services_name_key';`);
                    if(constraintRes.rowCount === 0) {
                        console.log(`   -> Adicionando restrição UNIQUE à coluna 'name' em public.services`);
                        await client.query('ALTER TABLE public.services ADD CONSTRAINT services_name_key UNIQUE (name);');
                    }
                }
                if (tableName === 'invoice_items') {
                    const colRes = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'invoice_items' AND column_name = 'service_date'`);
                    if (colRes.rowCount === 0) {
                        console.log(`   -> Adicionando coluna 'service_date' à tabela: public.invoice_items`);
                        await client.query('ALTER TABLE public.invoice_items ADD COLUMN service_date DATE;');
                    }
                    // Sem esta coluna era impossível saber de qual serviço um item
                    // veio (a descrição é texto livre), logo impossível editar ou
                    // remover um lançamento avulso com segurança.
                    const serviceIdColRes = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'invoice_items' AND column_name = 'service_id'`);
                    if (serviceIdColRes.rowCount === 0) {
                        console.log(`   -> Adicionando coluna 'service_id' à tabela: public.invoice_items`);
                        await client.query('ALTER TABLE public.invoice_items ADD COLUMN service_id INTEGER REFERENCES public.services(id) ON DELETE SET NULL;');
                    }
                    // A unidade fica congelada no item: se o serviço mudar de
                    // unidade depois, faturas antigas continuam corretas.
                    const unitColRes = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'invoice_items' AND column_name = 'unit'`);
                    if (unitColRes.rowCount === 0) {
                        console.log(`   -> Adicionando coluna 'unit' à tabela: public.invoice_items`);
                        await client.query(`ALTER TABLE public.invoice_items ADD COLUMN unit VARCHAR(30);`);
                    }
                    await client.query('CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON public.invoice_items(invoice_id);');
                }
                if (tableName === 'invoices') {
                    // O status era sempre reescrito para 'pending' pelo recálculo.
                    // paid_at/paid_by registram quem baixou a fatura e quando,
                    // e permitem ao recálculo preservar uma fatura já paga.
                    const paidByColRes = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'invoices' AND column_name = 'paid_by'`);
                    if (paidByColRes.rowCount === 0) {
                        console.log(`   -> Adicionando coluna 'paid_by' à tabela: public.invoices`);
                        await client.query('ALTER TABLE public.invoices ADD COLUMN paid_by VARCHAR(255);');
                    }
                    const paidAtColRes = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'invoices' AND column_name = 'paid_at'`);
                    if (paidAtColRes.rowCount === 0) {
                        console.log(`   -> Adicionando coluna 'paid_at' à tabela: public.invoices`);
                        await client.query('ALTER TABLE public.invoices ADD COLUMN paid_at TIMESTAMP WITH TIME ZONE;');
                    }

                    /* -------------------- Fechamento da competência --------------------
                     *
                     * `closed_at` é a data em que a competência deixou de ser
                     * recalculada. Hoje `calculateAndSaveInvoice` roda a CADA
                     * abertura da fatura e regrava os itens automáticos e o
                     * total — o que é correto enquanto o mês está aberto e passa
                     * a ser um defeito no instante em que o valor é comunicado
                     * para fora (cobrança emitida, boleto enviado, nota fiscal).
                     *
                     * Uma venda com processed_at retroativo, ou um avulso lançado
                     * depois, mudaria o total de uma fatura já cobrada. Fechada,
                     * a fatura para de mudar e o que chegar atrasado fica para a
                     * competência seguinte.
                     *
                     * NULL = aberta, que é o comportamento de sempre. Nenhuma
                     * fatura existente muda de comportamento por causa desta
                     * coluna.
                     */
                    const closedAtColRes = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'invoices' AND column_name = 'closed_at'`);
                    if (closedAtColRes.rowCount === 0) {
                        console.log(`   -> Adicionando coluna 'closed_at' à tabela: public.invoices`);
                        await client.query('ALTER TABLE public.invoices ADD COLUMN closed_at TIMESTAMP WITH TIME ZONE;');
                    }
                    const closedByColRes = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'invoices' AND column_name = 'closed_by'`);
                    if (closedByColRes.rowCount === 0) {
                        console.log(`   -> Adicionando coluna 'closed_by' à tabela: public.invoices`);
                        await client.query('ALTER TABLE public.invoices ADD COLUMN closed_by VARCHAR(255);');
                    }

                    /* ------------- Vínculo com a cobrança no provedor -------------
                     *
                     * Guardado na própria fatura porque a relação é de um para um
                     * com a competência. `asaas_status` é o status CRU do
                     * provedor: não misturo com `status` local, que é o que a
                     * tela usa e que o master pode alterar à mão para pagamento
                     * recebido por fora.
                     */
                    for (const [coluna, tipo] of [
                        ['asaas_payment_id', 'VARCHAR(40)'],
                        ['asaas_status', 'VARCHAR(40)'],
                        ['asaas_invoice_url', 'TEXT'],
                        ['asaas_synced_at', 'TIMESTAMP WITH TIME ZONE'],
                    ]) {
                        const res = await client.query(
                            `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'invoices' AND column_name = $1`,
                            [coluna]
                        );
                        if (res.rowCount === 0) {
                            console.log(`   -> Adicionando coluna '${coluna}' à tabela: public.invoices`);
                            await client.query(`ALTER TABLE public.invoices ADD COLUMN ${coluna} ${tipo};`);
                        }
                    }
                    // Uma cobrança do provedor não pode estar em duas faturas: é
                    // o que impede cobrar a mesma competência duas vezes se uma
                    // emissão for repetida por falha de rede.
                    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_asaas_payment
                                        ON public.invoices(asaas_payment_id)
                                     WHERE asaas_payment_id IS NOT NULL;`);
                }
                if (tableName === 'skus') {
                    const isKitColRes = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'skus' AND column_name = 'is_kit'`);
                    if (isKitColRes.rowCount === 0) {
                        console.log(`   -> Adicionando coluna 'is_kit' à tabela: public.skus`);
                        await client.query('ALTER TABLE public.skus ADD COLUMN is_kit BOOLEAN DEFAULT FALSE;');
                    }
                    const kitParentColRes = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'skus' AND column_name = 'kit_parent_id'`);
                    if (kitParentColRes.rowCount === 0) {
                        console.log(`   -> Adicionando coluna 'kit_parent_id' à tabela: public.skus`);
                        await client.query('ALTER TABLE public.skus ADD COLUMN kit_parent_id INTEGER;');
                    }
                    const ativoColRes = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'skus' AND column_name = 'ativo'`);
                    if (ativoColRes.rowCount === 0) {
                        console.log(`   -> Adicionando coluna 'ativo' à tabela: public.skus`);
                        await client.query('ALTER TABLE public.skus ADD COLUMN ativo BOOLEAN DEFAULT TRUE;');
                    }
                }
                if (tableName === 'sku_kit_components') {
                    const updatedAtColRes = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sku_kit_components' AND column_name = 'updated_at'`);
                    if (updatedAtColRes.rowCount === 0) {
                        console.log(`   -> Adicionando coluna 'updated_at' à tabela: public.sku_kit_components`);
                        await client.query('ALTER TABLE public.sku_kit_components ADD COLUMN updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;');
                    }
                    // O relacionamento já é N:N: a unicidade vale somente para
                    // o par kit/componente. Estes índices aceleram os dois lados
                    // e o CHECK impede composições sem quantidade válida.
                    await client.query('CREATE INDEX IF NOT EXISTS idx_sku_kit_components_child ON public.sku_kit_components(child_sku_id);');
                    await client.query('CREATE INDEX IF NOT EXISTS idx_sku_kit_components_kit ON public.sku_kit_components(kit_sku_id);');
                    await client.query(`
                        DO $$ BEGIN
                            IF NOT EXISTS (
                                SELECT 1 FROM pg_constraint
                                WHERE conname = 'sku_kit_components_quantity_positive'
                                  AND conrelid = 'public.sku_kit_components'::regclass
                            ) THEN
                                ALTER TABLE public.sku_kit_components
                                  ADD CONSTRAINT sku_kit_components_quantity_positive
                                  CHECK (quantity_per_kit > 0) NOT VALID;
                            END IF;
                        END $$;
                    `);
                }
                if (tableName === 'kit_parents') {
                    // Criar índice para otimizar buscas por user_id na tabela kit_parents
                    const indexCheck = await client.query(`
                        SELECT 1 FROM pg_indexes 
                        WHERE schemaname = 'public' 
                        AND tablename = 'kit_parents' 
                        AND indexname = 'idx_kit_parents_user_id'
                    `);
                    if (indexCheck.rowCount === 0) {
                        console.log(`   -> Criando índice 'idx_kit_parents_user_id' na tabela: public.kit_parents`);
                        await client.query('CREATE INDEX idx_kit_parents_user_id ON public.kit_parents(user_id);');
                    }
                }
                if (tableName === 'stock_movements') {
                    // Verifica e adiciona a coluna 'package_type_id' se não existir
                    const packageTypeColRes = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'stock_movements' AND column_name = 'package_type_id'`);
                    if (packageTypeColRes.rowCount === 0) {
                        console.log(`   -> Adicionando coluna 'package_type_id' à tabela: public.stock_movements`);
                        await client.query('ALTER TABLE public.stock_movements ADD COLUMN package_type_id INTEGER REFERENCES public.package_types(id);');
                    }
                    
                    // Verifica e adiciona a coluna 'package_type_context' se não existir
                    const packageContextColRes = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'stock_movements' AND column_name = 'package_type_context'`);
                    if (packageContextColRes.rowCount === 0) {
                        console.log(`   -> Adicionando coluna 'package_type_context' à tabela: public.stock_movements`);
                        await client.query('ALTER TABLE public.stock_movements ADD COLUMN package_type_context TEXT;');
                    }

                    // Pedidos Shopee são alfanuméricos e não cabem em
                    // related_sale_id (BIGINT). Este vínculo mantém o ID
                    // externo pesquisável sem alterar o contrato legado do ML.
                    const externalSaleIdColRes = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'stock_movements' AND column_name = 'external_sale_id'`);
                    if (externalSaleIdColRes.rowCount === 0) {
                        console.log(`   -> Adicionando coluna 'external_sale_id' à tabela: public.stock_movements`);
                        await client.query('ALTER TABLE public.stock_movements ADD COLUMN external_sale_id VARCHAR(100);');
                    }
                }
            }
        }
        
        console.log('   -> Verificando índices de performance em public.sales...');
        // SET LOCAL remove o statement_timeout do pool só nesta transação:
        // criar índice em tabela grande pode levar mais que o timeout de 30s.
        await client.query('SET LOCAL statement_timeout = 0;');

        // Coluna dedicada com o date_last_updated do pedido (cursor confiável de
        // mudança). Preenchida no momento de salvar; as linhas antigas são
        // cobertas em segundo plano por applyLegacyBackfills().
        await client.query('ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS date_last_updated TIMESTAMPTZ;');
        // Assinatura de mudança relevante: status | shipping.status |
        // shipping.substatus | tags(ordenadas). Se não muda, o pedido não teve
        // mudança real (só "bump" interno do ML) e pode ser pulado sem baixar.
        await client.query('ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS sync_signature TEXT;');

        // O preenchimento retroativo destas colunas NÃO acontece aqui: ele roda
        // em segundo plano, em lotes, depois que o servidor já está atendendo.
        // Ver applyLegacyBackfills(). Aqui só garantimos que a coluna exista.

        /* Estado remoto comparável do pedido: date_last_updated | status | tags.
         *
         * `sync_signature` não servia para decidir o que pular, porque era
         * gravada a partir do pedido JÁ enriquecido (shipping.status vindo de
         * /shipments) e comparada com o resumo de /orders/search, que traz
         * shipping apenas com o id. As duas nunca batiam e o sync refazia
         * detalhe + shipment + SLA de todos os pedidos em cada execução.
         */
        /* Apenas cria a coluna. NÃO existe backfill em massa aqui.
         *
         * A primeira versão desta migração fazia UPDATE em toda a tabela
         * `sales` no boot. Com a base real isso passa dos 30s de
         * `query_timeout`, a exceção abortava `syncDatabaseSchema` e o
         * servidor entrava em loop de reinício ("Falha crítica ao inicializar
         * o banco de dados"), derrubando o sistema inteiro.
         *
         * Backfill é desnecessário: `remote_state` nulo já significa "preciso
         * reavaliar este pedido". A própria sincronização preenche o valor no
         * primeiro ciclo, pedido por pedido, sem varrer a tabela.
         */
        await client.query('ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS remote_state TEXT;');

        /* Campos derivados do JSON, promovidos a colunas reais.
         *
         * Medição em produção (25/08/2026): contar 46.809 pedidos de 90 dias
         * levava 27–44s e movia ~13,8 GB de I/O lógico numa base de 718 MB.
         * `raw_api_data` fica em TOAST (413 MB dos 718 MB) e cada `->` num valor
         * TOAST refaz a leitura fora da página. As agregações do dashboard só
         * precisam de quatro escalares de dentro desse JSON, mas pagavam a
         * leitura do blob inteiro, várias vezes por linha.
         *
         * A prova está no próprio plano: o lado Shopee do UNION, que não toca
         * JSON nenhum, gastou 358 buffers para 7.721 linhas; o lado ML gastou
         * 488.202 para 39.086. Mesma consulta, mesma máquina.
         *
         * Estas colunas são CÓPIA de dado que já existe dentro do JSON — nada
         * novo, nada calculado. `raw_api_data` continua intacto e é ele que a
         * listagem usa. Nenhuma coluna existente foi alterada ou removida.
         *
         * `derived_fields_at` é o marcador de "esta linha já tem os campos".
         * Enquanto for nulo, a leitura cai de volta no JSON — então o número na
         * tela está correto durante todo o preenchimento, sem cutover.
         *
         * SEM backfill em massa aqui, pelo mesmo motivo documentado acima em
         * `remote_state`: UPDATE na tabela inteira dentro do boot passa do
         * timeout, aborta o schema e joga o servidor em loop de reinício. O
         * preenchimento roda em lotes, em segundo plano, em applyLegacyBackfills().
         */
        await client.query('ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS order_status TEXT;');
        await client.query('ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS logistic_type TEXT;');
        await client.query('ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS shipment_status TEXT;');
        await client.query('ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS sla_expected_date TIMESTAMPTZ;');
        await client.query('ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS derived_fields_at TIMESTAMPTZ;');

        await client.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_id_sku_uid_unique ON public.sales(id, sku, uid);');
        await client.query('CREATE INDEX IF NOT EXISTS idx_sales_seller_id ON public.sales(seller_id);');
        await client.query('CREATE INDEX IF NOT EXISTS idx_sales_sale_date ON public.sales(sale_date DESC);');
        await client.query(`CREATE INDEX IF NOT EXISTS idx_sales_status ON public.sales((raw_api_data->>'status'));`);
        await client.query('CREATE INDEX IF NOT EXISTS idx_sales_seller_date ON public.sales(seller_id, sale_date DESC);');
        await client.query('CREATE INDEX IF NOT EXISTS idx_sales_uid ON public.sales(uid);');
        await client.query('CREATE INDEX IF NOT EXISTS idx_sales_uid_date ON public.sales(uid, sale_date DESC);');
        // Índices para o last-sync e o skip por conta (cursor por date_last_updated).
        await client.query('CREATE INDEX IF NOT EXISTS idx_sales_uid_seller_updated ON public.sales(uid, seller_id, updated_at DESC);');
        await client.query('CREATE INDEX IF NOT EXISTS idx_sales_uid_seller_saledate ON public.sales(uid, seller_id, sale_date DESC);');
        await client.query('CREATE INDEX IF NOT EXISTS idx_sales_uid_seller_dlu ON public.sales(uid, seller_id, date_last_updated DESC);');

        // Índices para a tela de Separação de Itens (fila de despacho). As
        // queries filtram por prazo de despacho, modalidade e status do envio.
        await client.query('CREATE INDEX IF NOT EXISTS idx_sales_shipping_limit_date ON public.sales(shipping_limit_date);');
        await client.query('CREATE INDEX IF NOT EXISTS idx_sales_shipping_mode ON public.sales(shipping_mode);');
        await client.query(`CREATE INDEX IF NOT EXISTS idx_sales_ship_status ON public.sales((raw_api_data->'shipping'->>'status'));`);

        // ------------------------------------------------------------------
        // View unificada de vendas (Mercado Livre + Shopee).
        //
        // As telas de venda/expedição da CyberDock são por natureza
        // multi-marketplace: quem separa pedido precisa de UMA fila, não de
        // uma tela por canal. Esta view normaliza as duas tabelas num formato
        // comum para que filtros, busca e paginação funcionem sobre o
        // conjunto inteiro, sem duplicar endpoint nem componente.
        //
        // `id` é TEXT porque o ML usa order_id numérico e a Shopee usa
        // order_sn alfanumérico. Colunas exclusivas de um canal vêm NULL no
        // outro (ex.: shipping_id do ML, usado só para etiqueta).
        // ------------------------------------------------------------------
        // DROP antes de criar: CREATE OR REPLACE VIEW falha se a lista de
        // colunas mudar (nome, tipo ou ordem), o que travaria o boot numa
        // futura evolução do schema.
        //
        // A recriação NÃO acontece mais aqui. Ela exige AccessExclusiveLock na
        // view enquanto esta transação já mantém lock exclusivo em `sales`
        // (ALTER TABLE/CREATE INDEX acima). Uma requisição simultânea lendo
        // `unified_sales` e precisando de `sales` fechava o ciclo e o Postgres
        // matava o boot com deadlock (40P01) — derrubando a aplicação em loop.
        // Ver applyUnifiedSalesView(), executada depois do COMMIT.
        // ------------------------------------------------------------------
        // Índice FUNCIONAL em public.skus.
        //
        // As telas de venda resolvem "SKU mapeado?" e a descrição interna com
        // subconsultas por linha do tipo:
        //   WHERE sk.user_id = $1 AND UPPER(TRIM(sk.sku)) = UPPER(TRIM(s.sku))
        //
        // Um índice comum em (sku) NÃO serve para uma comparação sobre
        // UPPER(TRIM(sku)): o Postgres precisa do índice na MESMA expressão.
        // Sem ele, cada linha da página fazia varredura completa de `skus`
        // duas vezes (50 linhas = 100 varreduras por request), que era uma
        // das causas da lentidão das telas de venda.
        // ------------------------------------------------------------------
        console.log('   -> Verificando índice funcional em public.skus...');
        await client.query(
            'CREATE INDEX IF NOT EXISTS idx_skus_user_upper_sku ON public.skus (user_id, UPPER(TRIM(sku)));'
        );

        console.log('   -> Verificando índices de performance em public.shopee_sales...');
        await client.query('CREATE INDEX IF NOT EXISTS idx_shopee_sales_uid ON public.shopee_sales(uid);');
        await client.query('CREATE INDEX IF NOT EXISTS idx_shopee_sales_shop_id ON public.shopee_sales(shop_id);');
        await client.query('CREATE INDEX IF NOT EXISTS idx_shopee_sales_sale_date ON public.shopee_sales(sale_date DESC);');
        await client.query('CREATE INDEX IF NOT EXISTS idx_shopee_sales_uid_saledate ON public.shopee_sales(uid, sale_date DESC);');
        await client.query('CREATE INDEX IF NOT EXISTS idx_shopee_sales_uid_shop ON public.shopee_sales(uid, shop_id);');

        // ------------------------------------------------------------------
        // Correção de fuso da DATA DA VENDA da Shopee (D-1).
        //
        // O sync antigo subtraía 3h do create_time (convenção de "wall clock"
        // do projeto V2, onde a coluna NÃO tem timezone) e gravava numa coluna
        // TIMESTAMP WITH TIME ZONE, que guarda instante absoluto. A conversão
        // para Brasília acontecia de novo na exibição, então a venda aparecia
        // 3h mais cedo e, entre 00:00 e 02:59, no dia anterior.
        //
        // O valor é RECALCULADO a partir do create_time original preservado em
        // raw_api_data, em vez de somar 3h no valor atual. Isso é idempotente
        // (rodar de novo não muda nada) e imune a sync concorrente, já que
        // initializeDatabase roda junto com o servidor no ar — um "+3h" cego
        // corromperia linhas gravadas já corrigidas.
        //
        // ship_by_date NÃO entra aqui: sempre foi gravado como instante real
        // (new Date(epoch * 1000)) e já exibe o prazo correto.
        // ------------------------------------------------------------------
        // A correção de fuso do sale_date da Shopee também saiu daqui: é uma
        // correção de dado histórico, não parte do esquema. Ver applyLegacyBackfills().

        await client.query('COMMIT');
        console.log('✅ Esquema do banco de dados está atualizado.');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Erro durante a sincronização do esquema:', error);
        throw error;
    } finally {
        client.release();
    }
}

async function seedInitialData() {
    const client = await db.pool.connect();
    try {
        console.log('--- Verificando e inserindo dados iniciais (seeding) ---');
        await client.query('BEGIN');

        const packageCheck = await client.query('SELECT COUNT(*) FROM public.package_types');
        if (parseInt(packageCheck.rows[0].count, 10) === 0) {
            console.log('Nenhum tipo de pacote encontrado. Inserindo padrões...');
            await client.query(
                `INSERT INTO public.package_types (name, price) VALUES 
                    ('Expedição Comum', 2.97),
                    ('Expedição Premium', 3.97)`
            );
        }

        // Catálogo base. Os preços seguem a tabela oficial CyberDock; o seed é
        // idempotente e nunca sobrescreve um preço já ajustado pelo master,
        // exceto onde indicado (tiers da Montagem de Full, que estavam abaixo
        // da tabela e por isso cobravam menos do que o devido).
        const servicesCheck = await client.query("SELECT COUNT(*) FROM public.services WHERE type IN ('base_storage', 'additional_storage', 'avulso_simples', 'avulso_quantidade')");
        if (parseInt(servicesCheck.rows[0].count, 10) < 5) {
            console.log('Serviços não encontrados ou incompletos. Inserindo/Atualizando...');

            await client.query(`INSERT INTO public.services (name, price, description, type, unit) VALUES ('Armazenamento Base (até 1m³)', 397.00, 'Taxa base de armazenamento para o primeiro metro cúbico. Cobrança proporcional baseada na data de entrada do usuário.', 'base_storage', 'm3'), ('Metro Cúbico Adicional', 197.00, 'Custo por cada metro cúbico adicional utilizado.', 'additional_storage', 'm3') ON CONFLICT (name) DO NOTHING;`);
            await client.query(`INSERT INTO public.services (name, price, description, type, unit) VALUES ('Coleta CyberSegura', 197.00, 'Coleta até 1m³ e 40km da sede da CyberDock.', 'avulso_simples', 'viagem'), ('Transbordo Full CyberSeguro', 297.00, 'Envios ao Full - C.D do ML - cidade de São Paulo.', 'avulso_simples', 'viagem') ON CONFLICT (name) DO NOTHING;`);
        }

        // === Montagem de Full: faixas conforme a tabela oficial ===
        // 01 a 100 = 1,49 | 101 a 300 = 1,35 | acima de 301 = 1,19.
        // Rodava com 1,29 e 1,19 nas duas últimas faixas, cobrando menos.
        // O UPDATE das faixas é intencional: é correção de preço, não preferência.
        const montagemFullConfig = {
            tiers: [
                { from: 1, to: 100, price: 1.49 },
                { from: 101, to: 300, price: 1.35 },
                { from: 301, to: null, price: 1.19 },
            ],
            quantity_label: 'Quantidade de pacotes',
            placeholder: 'Ex: 150',
        };
        await client.query(
            `INSERT INTO public.services (name, price, description, type, config, unit)
             VALUES ('Montagem de Full', 0, 'Preparação completa no padrão Full. O preço por pacote varia conforme a quantidade.', 'avulso_quantidade', $1, 'pacote')
             ON CONFLICT (name) DO UPDATE SET config = EXCLUDED.config, type = 'avulso_quantidade', unit = 'pacote', description = EXCLUDED.description;`,
            [JSON.stringify(montagemFullConfig)]
        );

        // === Armazenamento Inicial (1m³) 50% | FULL ===
        // Metade do armazenamento base, para a operação que usa 10% Full.
        // Tem type próprio para o faturamento reconhecê-lo: criado pela tela de
        // catálogo ele nasceria com type NULL e jamais seria cobrado.
        await client.query(
            `INSERT INTO public.services (name, price, description, type, unit)
             VALUES ('Armazenamento Inicial (1m³) 50% | FULL', 198.50, 'Metade do armazenamento inicial de 1m³, para operação Full. Cobrança proporcional na entrada, igual ao base.', 'base_storage_50', 'm3')
             ON CONFLICT (name) DO UPDATE SET type = 'base_storage_50', unit = 'm3';`
        );

        // Preenche a unidade dos serviços que já existiam antes da coluna.
        await client.query(`
            UPDATE public.services SET unit = CASE
                WHEN type IN ('base_storage', 'base_storage_50', 'additional_storage') THEN 'm3'
                WHEN type = 'avulso_quantidade' THEN 'pacote'
                WHEN type = 'avulso_simples' THEN 'viagem'
                ELSE 'unidade' END
            WHERE unit IS NULL;
        `);

        const defaultStatuses = [ { value: 'custom_01_imprimir_etiqueta', label: '01 Imprimir Etiqueta' }, { value: 'custom_02_preparar_pacote', label: '02 Preparar Pacote' }, { value: 'custom_03_pacote_embalado', label: '03 Pacote Embalado' }, { value: 'custom_04_aguardando_coleta', label: '04 Aguardando Coleta' }, { value: 'custom_05_enviado', label: '05 Enviado' }, { value: 'custom_05_despachado', label: '05 Despachado' } ];
        const statusesCheck = await client.query("SELECT 1 FROM public.system_settings WHERE key = 'sales_statuses'");
        if (statusesCheck.rows.length === 0) {
            await client.query('INSERT INTO public.system_settings (key, value) VALUES ($1, $2)', ['sales_statuses', JSON.stringify(defaultStatuses)]);
        }

        await client.query('COMMIT');
        console.log('--- Verificação de dados iniciais concluída ---');

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Erro ao inserir dados iniciais:', error);
        throw error;
    } finally {
        client.release();
    }
}

async function initializeDatabase() {
    try {
        await syncDatabaseSchema();
        // Fora da transação de schema, para não disputar lock com as telas.
        await applyUnifiedSalesView();
        await seedInitialData();
        console.log('✅ Banco de dados inicializado e pronto para uso.');

        /* Índices em segundo plano.
         *
         * CONCURRENTLY é lento em tabela grande e o servidor não precisa
         * esperar por otimização para começar a atender. Falha aqui é logada,
         * nunca derruba a aplicação.
         */
        applyPerformanceIndexes()
            .catch((error) => {
                console.warn('Índices de performance não concluídos:', error.message);
            })
            /* Correções de dado histórico DEPOIS dos índices, e nunca em
             * paralelo com eles: as duas coisas escrevem nas mesmas tabelas e
             * disputariam I/O justamente enquanto as telas começam a ser usadas.
             * Cada uma já é tolerante a falha por conta própria. */
            .then(() => applyLegacyBackfills());
    } catch (error) {
        console.error('Falha crítica ao inicializar o banco de dados. A aplicação não pode continuar.');
        process.exit(1);
    }
}

module.exports = { initializeDatabase };
