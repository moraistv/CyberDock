// /server.js

require('dotenv').config();

const express = require('express');
const cors = require('cors');

const mainRouter = require('./router');
const { initializeDatabase } = require('./utils/init-db');

const app = express();

const PORT = process.env.PORT || 3001;
const BODY_LIMIT = process.env.BODY_LIMIT || '10mb';

// CORS
app.use(cors());

// ⬇️ aumenta o limite do body (JSON e URLENCODED) — evita 413
app.use(express.json({ limit: BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: BODY_LIMIT }));

// Rotas
app.use('/api', mainRouter);

// Health opcional
app.get('/health', (_req, res) => res.status(200).json({ ok: true }));

app.listen(PORT, async () => {
  await initializeDatabase();
  console.log(`🚀 Servidor backend rodando na porta ${PORT}`);
});
