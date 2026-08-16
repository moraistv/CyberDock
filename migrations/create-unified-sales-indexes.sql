-- ============================================================================
-- Índices para as telas de vendas / separação de itens
--
-- ATENÇÃO — esta migração foi REESCRITA.
--
-- A versão anterior criava índices sobre `public.unified_sales`, que é uma
-- VIEW. O Postgres não aceita CREATE INDEX em view, então o script falhava na
-- primeira instrução e NENHUM dos índices era criado. Quem rodasse via psql
-- veria o erro; quem rodasse ignorando erro seguia acreditando que os índices
-- existiam.
--
-- Índices têm de ser criados nas TABELAS DE ORIGEM da view (`sales` e
-- `shopee_sales`). O planejador usa esses índices normalmente ao consultar a
-- view, porque ela é expandida em tempo de planejamento.
--
-- CONCURRENTLY não pode rodar dentro de transação: execute este arquivo com
-- `psql -f`, sem envolver em BEGIN/COMMIT.
--
--   psql -U postgres -d postgres -f create-unified-sales-indexes.sql
--
-- Todos são IF NOT EXISTS e seguros com a aplicação em execução.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Busca textual (ILIKE '%termo%') nas telas de venda.
-- Um índice B-tree comum não serve para LIKE com curinga à esquerda; é preciso
-- trigrama. Sem isto, buscar por produto/SKU varre as duas tabelas inteiras.
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sales_product_title_trgm
  ON public.sales USING gin (product_title gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sales_sku_trgm
  ON public.sales USING gin (sku gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_shopee_sales_product_title_trgm
  ON public.shopee_sales USING gin (product_title gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_shopee_sales_sku_trgm
  ON public.shopee_sales USING gin (sku gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- 2) Filtro "processado / não processado" (abatimento de estoque).
-- Índice parcial: só interessa saber quem AINDA não foi processado.
-- ---------------------------------------------------------------------------
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sales_pending_processing
  ON public.sales (uid, sale_date DESC)
  WHERE processed_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_shopee_sales_pending_processing
  ON public.shopee_sales (uid, sale_date DESC)
  WHERE processed_at IS NULL;

-- ---------------------------------------------------------------------------
-- 3) Prazo de despacho do ML.
--
-- A view calcula shipping_deadline como
--   COALESCE( (sla_data->>'expected_date')::timestamptz , shipping_limit_date )
--
-- NÃO é possível indexar essa expressão. O cast de texto para timestamptz
-- depende do fuso e do DateStyle da sessão, então o Postgres o classifica como
-- STABLE e recusa o índice com:
--   ERROR: functions in index expression must be marked IMMUTABLE
--
-- (A tentativa anterior aqui usava exatamente esse cast e falhava.)
--
-- O que dá para indexar, sem gambiarra:
--   a) o texto ISO cru extraído do JSON — extração de JSONB é imutável. As
--      datas do ML vêm em ISO 8601, que ordena corretamente como texto, então
--      serve para recortes por faixa quando a comparação é feita em texto;
--   b) shipping_limit_date, que é o outro lado do COALESCE e já tem índice
--      (idx_sales_shipping_limit_date, criado em utils/init-db.js).
--
-- Com (a) e (b) o planejador tem caminho para a maioria das linhas. Indexar o
-- COALESCE inteiro exigiria uma coluna materializada preenchida na escrita.
-- ---------------------------------------------------------------------------
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sales_sla_expected_text
  ON public.sales ((raw_api_data->'sla_data'->>'expected_date'))
  WHERE raw_api_data->'sla_data'->>'expected_date' IS NOT NULL;

-- Cobre as vendas que caem no segundo termo do COALESCE.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sales_limit_date_no_sla
  ON public.sales (shipping_limit_date)
  WHERE raw_api_data->'sla_data'->>'expected_date' IS NULL;

-- ---------------------------------------------------------------------------
-- 4) Modalidade de envio derivada do logistic_type (filtro "Envio").
-- ---------------------------------------------------------------------------
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sales_logistic_type
  ON public.sales ((raw_api_data->'shipping'->>'logistic_type'));

-- ---------------------------------------------------------------------------
-- 5) Shopee: colunas usadas em filtro que não tinham índice.
-- ---------------------------------------------------------------------------
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_shopee_sales_order_status
  ON public.shopee_sales (order_status);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_shopee_sales_ship_by_date
  ON public.shopee_sales (ship_by_date);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_shopee_sales_shipping_status
  ON public.shopee_sales (shipping_status);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_shopee_sales_carrier
  ON public.shopee_sales (shipping_carrier);

-- ---------------------------------------------------------------------------
-- 6) Agrupamento de pacotes por envio (Separação de Itens do ML).
-- ---------------------------------------------------------------------------
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sales_shipping_id_expr
  ON public.sales ((raw_api_data->'shipping'->>'id'))
  WHERE raw_api_data->'shipping'->>'id' IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 7) Cursor de sincronização por conta.
-- ---------------------------------------------------------------------------
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ml_sync_cursors_lookup
  ON public.ml_sync_cursors (uid, seller_id);

-- ============================================================================
-- ANALYZE para o planejador enxergar as estatísticas novas
-- ============================================================================
ANALYZE public.sales;
ANALYZE public.shopee_sales;
ANALYZE public.skus;
ANALYZE public.users;

SELECT 'indices de vendas criados' AS resultado;
