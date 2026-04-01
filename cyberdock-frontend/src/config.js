
// src/config.js
// Centraliza URLs e configs para facilitar deploy e ambiente local/produção
const isProd = window.location.hostname === 'cyberdock.com.br';

// Forçar uso do backend do Render mesmo em localhost (descomente para testar ML em local)
const FORCE_RENDER_BACKEND = true;

export const FRONTEND_URL = isProd
  ? 'https://cyberdock.com.br'
  : 'http://localhost:8080';

export const API_BASE_URL = (isProd || FORCE_RENDER_BACKEND)
  ? 'https://api.cyberdock.com.br/api'
  : 'http://localhost:3001/api';

// Mercado Livre URLs (ajuste conforme necessário)
export const MERCADOLIVRE_CLIENT_ID = '8423050287338772';

export const MERCADOLIVRE_REDIRECT_URI = (isProd || FORCE_RENDER_BACKEND)
  ? 'https://api.cyberdock.com.br/api/ml/callback'
  : 'http://localhost:3001/api/ml/callback';

// Outras configs podem ser adicionadas aqui
