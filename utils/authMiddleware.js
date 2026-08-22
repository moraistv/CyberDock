// backend/utils/authMiddleware.js
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'seu-segredo-super-secreto-para-jwt';

const getBearerToken = (req) => {
    const authHeader = req.headers['authorization'];
    return authHeader && authHeader.split(' ')[1];
};

/**
 * Verifica um JWT e devolve seu payload. A função também é usada por fluxos
 * que aceitam uma credencial temporária própria (como o retorno OAuth da
 * Shopee), mas ainda precisam saber se a sessão normal continua válida.
 */
const verifyAccessToken = (token) => jwt.verify(token, JWT_SECRET);

/**
 * Middleware para verificar o token JWT presente no header Authorization.
 * Adiciona o payload do token (user) ao objeto da requisição (req).
 */
const authenticateToken = (req, res, next) => {
    const token = getBearerToken(req);

    if (!token) {
        // 401 Unauthorized: O cliente não forneceu credenciais.
        return res.status(401).json({ error: 'Token de acesso requerido' });
    }

    try {
        req.user = verifyAccessToken(token);
        next();
    } catch (error) {
        console.error('JWT Verification Error:', error.message);
        // 403 Forbidden: O cliente forneceu credenciais, mas elas são inválidas ou expiraram.
        return res.status(403).json({ error: 'Token inválido ou expirado' });
    }
};

/**
 * Middleware para garantir que o usuário autenticado tem a role 'master'.
 * Deve ser usado *após* o middleware authenticateToken.
 */
const requireMaster = (req, res, next) => {
    if (req.user.role !== 'master') {
        return res.status(403).json({ error: 'Acesso negado. Apenas masters podem acessar este recurso.' });
    }
    next();
};

/**
 * Middleware para rotas de autoatendimento: o próprio usuário pode acessar
 * seus dados (uid da rota == uid do token) OU um master pode acessar
 * qualquer usuário. Usado em recursos como status de venda e contratos, que
 * o cliente comum precisa ver sobre si mesmo, mas não sobre terceiros.
 * Deve ser usado *após* o middleware authenticateToken. Requer que a rota
 * tenha um parâmetro `:uid`.
 */
const requireOwnerOrMaster = (req, res, next) => {
    if (req.user.role === 'master' || req.user.uid === req.params.uid) {
        return next();
    }
    return res.status(403).json({ error: 'Acesso negado. Você só pode acessar seus próprios dados.' });
};

module.exports = {
    authenticateToken,
    getBearerToken,
    requireMaster,
    requireOwnerOrMaster,
    verifyAccessToken,
};