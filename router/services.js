// backend/routes/services.js
const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../utils/postgres');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'seu-segredo-super-secreto-para-jwt';

// Middleware para verificar token JWT
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Token de acesso requerido' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Token inválido' });
    }
    req.user = user;
    next();
  });
};

// Middleware para verificar se é master
const requireMaster = (req, res, next) => {
  if (req.user.role !== 'master') {
    return res.status(403).json({ error: 'Acesso negado. Apenas masters podem acessar este recurso.' });
  }
  next();
};

// --- Rota para buscar todos os serviços (catálogo) ---
/**
 * Tipos de serviço reconhecidos pelo faturamento. Um serviço com type fora
 * desta lista (ou nulo) NÃO é cobrado em lugar nenhum — foi exatamente o que
 * aconteceu com o "Armazenamento Inicial (1m³)" criado pela tela, que só
 * gravava nome e preço. Por isso o tipo agora é validado na entrada.
 */
const SERVICE_TYPES = [
  'base_storage',
  'base_storage_50',
  'additional_storage',
  'avulso_simples',
  'avulso_quantidade',
];

/** Valida tipo e, para serviços por faixa, a consistência dos tiers. */
function validateServicePayload({ type, config }) {
  if (type !== undefined && type !== null && type !== '' && !SERVICE_TYPES.includes(type)) {
    return `Tipo inválido. Use um destes: ${SERVICE_TYPES.join(', ')}.`;
  }
  if (type === 'avulso_quantidade') {
    const tiers = config && Array.isArray(config.tiers) ? config.tiers : null;
    if (!tiers || tiers.length === 0) {
      return 'Serviço por quantidade exige ao menos uma faixa de preço.';
    }
    for (const tier of tiers) {
      const from = Number(tier.from);
      const price = Number(tier.price);
      if (!Number.isFinite(from) || from < 1) return 'Faixa com início inválido.';
      if (!Number.isFinite(price) || price < 0) return 'Faixa com preço inválido.';
      if (tier.to !== null && tier.to !== undefined && Number(tier.to) < from) {
        return 'Faixa com fim menor que o início.';
      }
    }
    // Sem faixa aberta, uma quantidade acima da última faixa não teria preço.
    const hasOpenTier = tiers.some((t) => t.to === null || t.to === undefined || t.to === '');
    if (!hasOpenTier) return 'A última faixa deve ser aberta (sem valor final) para cobrir quantidades maiores.';
  }
  return null;
}

// Suporta ?manualOnly=1 para retornar apenas serviços avulsos lançáveis no faturamento
router.get('/', authenticateToken, async (req, res) => {
  try {
    const manualOnly = String(req.query.manualOnly || '').toLowerCase();
    const onlyManual = manualOnly === '1' || manualOnly === 'true';

    const q = `
      SELECT id, name, type, price, config, unit, description
      FROM public.services
      ${onlyManual ? "WHERE type IN ('avulso_simples','avulso_quantidade')" : ""}
      ORDER BY name ASC
    `;
    const { rows } = await db.query(q);

    const formatted = rows.map((s) => ({
      id: s.id,
      name: s.name,
      type: s.type || null,
      price: s.price !== null ? parseFloat(s.price) : null,
      config: s.config || null,
      unit: s.unit || null,
      description: s.description || null
    }));

    res.json(formatted);
  } catch (error) {
    console.error('Erro ao buscar serviços:', error);
    res.status(500).json({ error: 'Erro interno ao buscar serviços.' });
  }
});

// --- Rota para criar um novo serviço (apenas master) ---
// Agora aceita opcionalmente "type" e "config" (json)
router.post('/', authenticateToken, requireMaster, async (req, res) => {
  const { name, price = null, type = null, config = null, unit = null, description = null } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Nome é obrigatório.' });
  }
  const invalid = validateServicePayload({ type, config });
  if (invalid) return res.status(400).json({ error: invalid });

  try {
    const insertQuery = `
      INSERT INTO public.services (name, type, price, config, unit, description)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, name, type, price, config, unit, description
    `;
    const { rows } = await db.query(insertQuery, [name, type, price, config, unit, description]);
    const r = rows[0];
    res.status(201).json({
      id: r.id,
      name: r.name,
      type: r.type,
      price: r.price !== null ? parseFloat(r.price) : null,
      config: r.config || null,
      unit: r.unit || null,
      description: r.description || null
    });
  } catch (error) {
    console.error('Erro ao criar serviço:', error);
    res.status(500).json({ error: 'Erro interno ao criar serviço.' });
  }
});

// --- Rota para atualizar um serviço existente (apenas master) ---
// Agora aceita opcionalmente "type" e "config"
router.put('/:id', authenticateToken, requireMaster, async (req, res) => {
  const { id } = req.params;
  const { name, price = null, type = undefined, config = undefined, unit = undefined, description = undefined } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Nome é obrigatório.' });
  }
  const invalid = validateServicePayload({ type, config });
  if (invalid) return res.status(400).json({ error: invalid });

  try {
    const updateQuery = `
      UPDATE public.services
      SET
        name        = $1,
        price       = $2,
        type        = COALESCE($3, type),
        config      = COALESCE($4, config),
        unit        = COALESCE($5, unit),
        description = COALESCE($6, description)
      WHERE id = $7
      RETURNING id, name, type, price, config, unit, description
    `;
    const { rows } = await db.query(updateQuery, [name, price, type ?? null, config ?? null, unit ?? null, description ?? null, id]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Serviço não encontrado.' });
    }

    const r = rows[0];
    res.json({
      id: r.id,
      name: r.name,
      type: r.type,
      price: r.price !== null ? parseFloat(r.price) : null,
      config: r.config || null,
      unit: r.unit || null,
      description: r.description || null
    });
  } catch (error) {
    console.error('Erro ao atualizar serviço:', error);
    res.status(500).json({ error: 'Erro interno ao atualizar serviço.' });
  }
});

// --- Rota para deletar um serviço (apenas master) ---
router.delete('/:id', authenticateToken, requireMaster, async (req, res) => {
  const { id } = req.params;

  try {
    /* Serviço contratado não pode ser excluído.
     *
     * `user_contracts.service_id` tem ON DELETE RESTRICT, então o banco recusava
     * a exclusão e a tela recebia um 500 com a mensagem crua do Postgres
     * ("violates foreign key constraint"), sem dizer o que fazer. Agora o caso
     * é detectado antes e explicado: quantos clientes usam e quais.
     */
    const inUse = await db.query(
      `SELECT COUNT(*)::int AS total,
              (array_agg(COALESCE(NULLIF(TRIM(u.name), ''), u.email) ORDER BY u.email))[1:3] AS amostra
         FROM public.user_contracts c
         JOIN public.users u ON u.uid = c.uid
        WHERE c.service_id = $1`,
      [id]
    );

    const total = inUse.rows[0]?.total || 0;
    if (total > 0) {
      const amostra = (inUse.rows[0].amostra || []).filter(Boolean);
      const listados = amostra.join(', ');
      const resto = total - amostra.length;
      return res.status(409).json({
        error:
          `Este serviço está contratado por ${total} cliente(s) e não pode ser excluído.` +
          (listados ? ` Ex.: ${listados}${resto > 0 ? ` e mais ${resto}` : ''}.` : '') +
          ' Remova o serviço desses clientes antes de excluí-lo do catálogo.',
        code: 'SERVICE_IN_USE',
        contracts: total,
      });
    }

    const { rows } = await db.query(
      `DELETE FROM public.services WHERE id = $1 RETURNING id`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Serviço não encontrado.' });
    }

    res.json({ message: 'Serviço excluído com sucesso.' });
  } catch (error) {
    // Rede de segurança: se um contrato for criado entre a checagem e o DELETE,
    // o banco ainda barra — e a mensagem continua sendo útil, não um 500 cru.
    if (error.code === '23503') {
      return res.status(409).json({
        error: 'Este serviço está contratado por algum cliente e não pode ser excluído. Remova o serviço dos clientes antes.',
        code: 'SERVICE_IN_USE',
      });
    }
    console.error('Erro ao deletar serviço:', error);
    res.status(500).json({ error: 'Erro interno ao deletar serviço.' });
  }
});

module.exports = router;
