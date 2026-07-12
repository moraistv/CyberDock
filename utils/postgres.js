const { Pool } = require('pg');

const pool = new Pool({
  user: process.env.PGUSER,
  host: process.env.PGHOST,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: process.env.PGPORT ? parseInt(process.env.PGPORT) : 5432,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,

  // Pool dimensionado e com timeouts, para que jobs paralelos não esgotem as
  // conexões nem deixem queries travadas segurando conexão indefinidamente.
  max: process.env.PGPOOL_MAX ? parseInt(process.env.PGPOOL_MAX, 10) : 15,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  statement_timeout: 30000,
  query_timeout: 30000,
  application_name: 'cyberdock-backend',
});

pool.on('error', (err) => {
  console.error('Erro inesperado em cliente ocioso do pool PostgreSQL:', err.message);
});

pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('Erro ao conectar com o PostgreSQL:', err);
  } else {
    console.log('Conexão com o PostgreSQL bem-sucedida:', res.rows[0].now);
  }
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
  getClient: () => pool.connect(),
};
