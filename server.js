// /server.js

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const compression = require('compression');

const mainRouter = require('./router');
const { initializeDatabase } = require('./utils/init-db');

const app = express();

const PORT = process.env.PORT || 3001;
const BODY_LIMIT = process.env.BODY_LIMIT || '10mb';

// Compressão gzip das respostas. As listagens de venda retornam JSON grande
// (dezenas de campos por linha) e sem isso o payload ia inteiro, sem
// compactação — JSON costuma reduzir várias vezes de tamanho, então este é um
// dos ganhos mais baratos de tempo de carregamento.
app.use(compression());

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

async function startServer() {
  // O schema é parte da prontidão: não aceite OAuth nem marque /health como
  // saudável antes de todas as tabelas obrigatórias estarem disponíveis.
  await initializeDatabase();
  app.listen(PORT, () => {
    console.log(`🚀 Servidor backend rodando na porta ${PORT}`);

    /* Correção de dado histórico, DEPOIS de começar a atender.
     *
     * Faturas antigas que ficaram com duas linhas de armazenamento inicial
     * (`base_storage` e `base_storage_50` contratados ao mesmo tempo) só se
     * corrigem quando alguém abre aquela competência na tela. Isto recalcula as
     * afetadas uma única vez, controlado por marcador em system_settings.
     *
     * Fora da prontidão de propósito: é correção de dado, não requisito para o
     * servidor responder. Falha aqui só registra aviso.
     */
    const { recalculateDuplicatedStorageInvoices } = require('./router/billing');
    recalculateDuplicatedStorageInvoices().catch((error) => {
      console.warn('Correção retroativa do armazenamento não executada:', error.message);
    });
  });
}

startServer().catch((error) => {
  console.error('Falha crítica ao iniciar o servidor:', error);
  process.exit(1);
});
