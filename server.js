// /server.js

require('dotenv').config();

const express = require('express');
const cors = require('cors');

const mainRouter = require('./router');
const { initializeDatabase } = require('./utils/init-db');

const app = express();

const PORT = process.env.PORT || 3001;
const BODY_LIMIT = process.env.BODY_LIMIT || '10mb';

// CORS - Configuração Robusta
app.use(cors({
  origin: ['https://cyberdock.com.br', 'http://localhost:8080'],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  optionsSuccessStatus: 200 // Algumas versões do browser bugam com 204 em preflight
}));

// ⬇️ aumenta o limite do body (JSON e URLENCODED) — evita 413
app.use(express.json({ limit: BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: BODY_LIMIT }));

// Rotas
app.use('/api', mainRouter);

// Health opcional
app.get('/health', (_req, res) => res.status(200).json({ ok: true }));

// Middleware de Erro Global (importante para não quebrar o CORS em caso de crash)
app.use((err, req, res, next) => {
  console.error('💥 Erro Crítico no Servidor:', err.stack);
  res.status(500).json({ 
    error: 'Erro interno no servidor.', 
    message: err.message,
    path: req.path
  });
});

app.listen(PORT, async () => {
  await initializeDatabase();
  console.log(`🚀 Servidor backend rodando na porta ${PORT}`);
});
