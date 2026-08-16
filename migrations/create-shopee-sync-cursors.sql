-- Watermark remoto e lock durável da sincronização Shopee.
-- Idempotente; pode ser executada com a aplicação no ar.
CREATE TABLE IF NOT EXISTS public.shopee_sync_cursors (
  uid VARCHAR(255) NOT NULL,
  shop_id BIGINT NOT NULL,
  update_time_scanned_through TIMESTAMP WITH TIME ZONE,
  initial_backfill_completed_at TIMESTAMP WITH TIME ZONE,
  last_attempt_at TIMESTAMP WITH TIME ZONE,
  last_success_at TIMESTAMP WITH TIME ZONE,
  status VARCHAR(20) NOT NULL DEFAULT 'idle',
  last_error TEXT,
  last_result JSONB,
  job_id VARCHAR(100),
  locked_until TIMESTAMP WITH TIME ZONE,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (uid, shop_id),
  FOREIGN KEY (uid, shop_id)
    REFERENCES public.shopee_accounts(uid, shop_id) ON DELETE CASCADE
);

ALTER TABLE public.shopee_sync_cursors
  ADD COLUMN IF NOT EXISTS last_result JSONB;

CREATE INDEX IF NOT EXISTS idx_shopee_sync_cursors_status
  ON public.shopee_sync_cursors (status, locked_until);

CREATE TABLE IF NOT EXISTS public.shopee_sync_jobs (
  client_id VARCHAR(100) PRIMARY KEY,
  uid VARCHAR(255) NOT NULL,
  shop_id BIGINT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'running',
  result JSONB,
  error TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '1 day'),
  FOREIGN KEY (uid, shop_id)
    REFERENCES public.shopee_accounts(uid, shop_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_shopee_sync_jobs_expiry
  ON public.shopee_sync_jobs (expires_at);

SELECT 'cursor e jobs de sincronizacao Shopee criados' AS resultado;