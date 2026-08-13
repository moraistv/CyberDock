// backend/utils/init-db.js

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
        );`
};

async function syncDatabaseSchema() {
    const client = await db.pool.connect();
    try {
        console.log('--- Iniciando sincronização do esquema do banco de dados ---');
        const res = await client.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
        const existingTables = res.rows.map(row => row.tablename);
        
        const tablesInOrder = [
            'users', 'package_types', 'services', 'ml_accounts', 'ml_sync_cursors', 'system_settings',
            'user_statuses', 'user_contracts', 'skus', 'sku_kit_components', 'kit_parents', 'sales', 'stock_movements',
            'invoices', 'invoice_items', 'shopee_accounts', 'shopee_sales'
        ];

        await client.query('BEGIN');
        for (const tableName of tablesInOrder) {
            if (!existingTables.includes(tableName)) {
                console.log(`   -> Criando tabela: public.${tableName}`);
                await client.query(schema[tableName]);
            } else {
                // Lógica de migração para tabelas existentes
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
                }
                 if (tableName === 'services') {
                    const colRes = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'services' AND column_name = 'config'`);
                    if (colRes.rowCount === 0) {
                        console.log(`   -> Adicionando coluna 'config' à tabela: public.services`);
                        await client.query('ALTER TABLE public.services ADD COLUMN config JSONB;');
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
        // SET LOCAL remove o statement_timeout do pool só nesta transação, pois
        // criar índice/backfill em tabela grande pode levar mais que o timeout.
        await client.query('SET LOCAL statement_timeout = 0;');

        // Coluna dedicada com o date_last_updated do pedido (cursor confiável de
        // mudança). Extraída no momento de salvar; aqui fazemos o backfill dos
        // registros existentes a partir do raw_api_data (uma vez).
        await client.query('ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS date_last_updated TIMESTAMPTZ;');
        await client.query(`
            UPDATE public.sales
               SET date_last_updated = (raw_api_data->>'date_last_updated')::timestamptz
             WHERE date_last_updated IS NULL
               AND raw_api_data ? 'date_last_updated'
               AND (raw_api_data->>'date_last_updated') ~ '^[0-9]{4}-';
        `);

        // Assinatura de mudança relevante: status | shipping.status |
        // shipping.substatus | tags(ordenadas). Se não muda, o pedido não teve
        // mudança real (só "bump" interno do ML) e pode ser pulado sem baixar.
        await client.query('ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS sync_signature TEXT;');
        await client.query(`
            UPDATE public.sales
               SET sync_signature =
                     COALESCE(raw_api_data->>'status','') || '|' ||
                     COALESCE(raw_api_data->'shipping'->>'status','') || '|' ||
                     COALESCE(raw_api_data->'shipping'->>'substatus','') || '|' ||
                     COALESCE(
                       CASE
                         WHEN jsonb_typeof(raw_api_data->'tags') = 'array'
                         THEN (SELECT string_agg(t, ',' ORDER BY t)
                                 FROM jsonb_array_elements_text(raw_api_data->'tags') t)
                         ELSE ''
                       END,
                       ''
                     )
             WHERE sync_signature IS NULL
               AND raw_api_data IS NOT NULL;
        `);

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
        console.log('   -> Criando/atualizando view public.unified_sales...');
        await client.query('DROP VIEW IF EXISTS public.unified_sales;');
        await client.query(`
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
                -- O SLA do ML é o prazo real de despacho e tem precedência.
                -- O cast é guardado por regex: um valor malformado no JSON
                -- derrubaria toda a consulta da view, não apenas a linha.
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
                -- A Shopee não tem o conceito de modalidade do ML (FULL/FLEX).
                -- Usamos a transportadora do pacote como modalidade exibida.
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
                )->'image_info'->>'image_url'              AS product_thumbnail,
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
        `);

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
        console.log('   -> Corrigindo fuso da data de venda da Shopee (se necessário)...');
        const shopeeTzFix = await client.query(`
            UPDATE public.shopee_sales
               SET sale_date = to_timestamp((raw_api_data->>'create_time')::double precision)
             WHERE raw_api_data ? 'create_time'
               AND (raw_api_data->>'create_time') ~ '^[0-9]+$'
               AND (raw_api_data->>'create_time')::double precision > 0
               AND sale_date IS DISTINCT FROM
                   to_timestamp((raw_api_data->>'create_time')::double precision);
        `);
        if (shopeeTzFix.rowCount > 0) {
            console.log(`   -> ${shopeeTzFix.rowCount} venda(s) Shopee com data corrigida.`);
        }

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

        const servicesCheck = await client.query("SELECT COUNT(*) FROM public.services WHERE type IN ('base_storage', 'additional_storage', 'avulso_simples', 'avulso_quantidade')");
        if (parseInt(servicesCheck.rows[0].count, 10) < 5) {
            console.log('Serviços não encontrados ou incompletos. Inserindo/Atualizando...');
            
            await client.query(`INSERT INTO public.services (name, price, description, type) VALUES ('Armazenamento Base (até 1m³)', 397.00, 'Taxa base de armazenamento para o primeiro metro cúbico. Cobrança proporcional baseada na data de entrada do usuário.', 'base_storage'), ('Metro Cúbico Adicional', 197.00, 'Custo por cada metro cúbico adicional utilizado.', 'additional_storage') ON CONFLICT (name) DO NOTHING;`);
            await client.query(`INSERT INTO public.services (name, price, description, type) VALUES ('Coleta CyberSegura', 50.00, 'Serviço de coleta avulso.', 'avulso_simples'), ('Transbordo Full CyberSeguro', 75.00, 'Serviço de transbordo avulso.', 'avulso_simples') ON CONFLICT (name) DO NOTHING;`);

            const montagemFullConfig = { tiers: [ { from: 1, to: 100, price: 1.49 }, { from: 101, to: 300, price: 1.29 }, { from: 301, to: null, price: 1.09 } ] };
            await client.query(`INSERT INTO public.services (name, price, description, type, config) VALUES ('Montagem de Full', 0, 'Montagem de pacotes para envio Full. O preço varia com a quantidade.', 'avulso_quantidade', $1) ON CONFLICT (name) DO UPDATE SET config = EXCLUDED.config;`, [JSON.stringify(montagemFullConfig)]);
        }

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
        await seedInitialData();
        console.log('✅ Banco de dados inicializado e pronto para uso.');
    } catch (error) {
        console.error('Falha crítica ao inicializar o banco de dados. A aplicação não pode continuar.');
        process.exit(1);
    }
}

module.exports = { initializeDatabase };
