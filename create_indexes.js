require('dotenv').config();
const db = require('./utils/postgres.js');

async function run() {
  try {
    await db.query('CREATE INDEX IF NOT EXISTS idx_sales_seller_id ON public.sales(seller_id);');
    await db.query('CREATE INDEX IF NOT EXISTS idx_sales_sale_date ON public.sales(sale_date DESC);');
    await db.query(`CREATE INDEX IF NOT EXISTS idx_sales_status ON public.sales((raw_api_data->>'status'));`);
    await db.query('CREATE INDEX IF NOT EXISTS idx_sales_seller_date ON public.sales(seller_id, sale_date DESC);');
    // Separação de Itens (fila de despacho)
    await db.query('CREATE INDEX IF NOT EXISTS idx_sales_shipping_limit_date ON public.sales(shipping_limit_date);');
    await db.query('CREATE INDEX IF NOT EXISTS idx_sales_shipping_mode ON public.sales(shipping_mode);');
    await db.query(`CREATE INDEX IF NOT EXISTS idx_sales_ship_status ON public.sales((raw_api_data->'shipping'->>'status'));`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_sales_prazo_despacho ON public.sales((COALESCE(raw_api_data->'sla_data'->>'expected_date', shipping_limit_date::text)));`);
    console.log('Indexes created successfully');
  } catch (e) {
    console.error('Error:', e);
  } finally {
    process.exit();
  }
}
run();
