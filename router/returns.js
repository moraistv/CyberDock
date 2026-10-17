// router/returns.js
//
// Devoluções do Mercado Livre — tela /admin/devolucoes (só master).
//
//   GET    /api/returns                       fila com filtros, números do período e facetas
//   GET    /api/returns/sync                  andamento da sincronização com o ML
//   POST   /api/returns/sync                  busca agora as devoluções no ML (roda em segundo plano)
//   GET    /api/returns/:id                   detalhe (itens, estoque, fotos e histórico)
//   POST   /api/returns/:id/chegada           registra que o pacote chegou ao CD
//   PUT    /api/returns/:id/analise           salva checklist e observação sem decidir
//   POST   /api/returns/:id/decisao           conclui a análise (apto / não apto) e soma ao estoque
//   POST   /api/returns/:id/fotos             adiciona foto (base64, já reduzida no navegador)
//   GET    /api/returns/:id/fotos/:fotoId     imagem
//   DELETE /api/returns/:id/fotos/:fotoId     remove foto (só antes da análise)
//
// Os avisos do ML (tópico post_purchase) chegam na mesma URL do webhook de
// vendas; `interceptarAvisoDoMl` é montado antes do router de vendas em
// router/index.js e só pega o que é reclamação/devolução.

const express = require('express');
const fetch = require('node-fetch');
const db = require('../utils/postgres');
const { mlFetch } = require('../utils/mlClient');
const { authenticateToken, requireMaster } = require('../utils/authMiddleware');
const devolucoes = require('../utils/mlReturns');

const router = express.Router();

const autorDe = (req) => req.user?.email || req.user?.uid || 'master';

function responderErro(res, erro, padrao) {
  if (erro?.status >= 400 && erro?.status < 500 && erro?.code) {
    return res.status(erro.status).json({ error: erro.message, code: erro.code });
  }
  console.error(`[DEVOLUCOES] ${padrao}`, erro);
  return res.status(500).json({ error: padrao });
}

async function comCliente(fn) {
  const client = await db.pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------------------- */
/* Token do ML                                                                */
/* ------------------------------------------------------------------------- */

/* Falha de acesso da conta: a tela pede para reconectar. */
const acessoRecusado = (mensagem) => Object.assign(new Error(mensagem), { tipoDaFalha: 'acesso' });

/** Mesma renovação do webhook de vendas, com a mesma trava contra gravar token vazio. */
async function renovarToken({ db: banco, sellerId, uid, refreshToken }) {
  if (!refreshToken) throw acessoRecusado('Conta do Mercado Livre sem renovação de acesso. Reconecte a conta.');
  const resposta = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.ML_CLIENT_ID || '',
      client_secret: process.env.ML_CLIENT_SECRET || '',
      refresh_token: refreshToken,
    }),
  });
  if (!resposta.ok) {
    const erro = new Error(`Mercado Livre recusou a renovação do token (HTTP ${resposta.status}).`);
    erro.tipoDaFalha = resposta.status >= 500 ? 'instavel' : 'acesso';
    throw erro;
  }
  const token = await resposta.json();
  if (!token || !token.access_token || !token.refresh_token) {
    throw acessoRecusado('Renovação de token do ML devolveu resposta sem token.');
  }
  await banco.query(
    `UPDATE public.ml_accounts
        SET access_token = $1, refresh_token = $2, expires_in = $3, status = 'active', updated_at = NOW()
      WHERE user_id = $4 AND uid = $5`,
    [token.access_token, token.refresh_token, token.expires_in, sellerId, uid]
  );
  return token.access_token;
}

const abrirSessao = (sellerId) => devolucoes.abrirSessaoMl(db, sellerId, { mlFetch, fetchToken: renovarToken });

/* ------------------------------------------------------------------------- */
/* Sincronização                                                              */
/* ------------------------------------------------------------------------- */

/* Trava do PostgreSQL: com mais de uma instância do backend, só uma sincroniza. */
const CHAVE_DA_TRAVA = 727410;

/* Contas lidas ao mesmo tempo. O limite de chamadas ao ML é o do mlClient, comum a tudo. */
const CONTAS_EM_PARALELO = Math.min(8, Math.max(1, parseInt(process.env.ML_RETURNS_SYNC_CONCURRENCY || '4', 10) || 4));

const estado = {
  rodando: false,
  gatilho: null,
  inicio: null,
  fim: null,
  contas: 0,
  feitas: 0,
  resultado: null,
  erro: null,
};

/*
 * `falha` é o motivo que mais apareceu entre as contas que não foram lidas:
 *  - acesso: token recusado ou conta sem renovação (reconectar a conta);
 *  - consulta: o ML recusou a busca (ajuste no sistema, não na conta);
 *  - instavel: o ML não respondeu ou limitou as chamadas (tenta de novo sozinho);
 *  - outro: erro do próprio sistema (detalhe só no log do servidor).
 */
const estadoPublico = () => ({
  rodando: estado.rodando,
  gatilho: estado.gatilho,
  inicio: estado.inicio,
  fim: estado.fim,
  contas: estado.contas,
  feitas: estado.feitas,
  devolucoes: estado.resultado?.devolucoes ?? null,
  novas: estado.resultado?.novas ?? null,
  contasComFalha: estado.resultado?.falhas?.length ?? 0,
  falha: estado.resultado?.falhaPrincipal ?? null,
  reclamacoesComFalha: estado.resultado?.reclamacoesComFalha ?? 0,
  erro: estado.erro,
});

/** Que tipo de falha derrubou a conta, para a tela dizer o que fazer. */
function tipoDaFalha(erro) {
  if (erro?.tipoDaFalha) return erro.tipoDaFalha;
  const status = Number(erro?.status);
  if (erro?.code === 'conta_nao_encontrada' || status === 401 || status === 403) return 'acesso';
  if (status === 408 || status === 429 || status >= 500) return 'instavel';
  if (status >= 400) return 'consulta';
  if (erro?.name === 'FetchError' || erro?.name === 'AbortError') return 'instavel';
  return 'outro';
}

/**
 * Agrupa as contas que falharam pelo mesmo motivo: uma linha no log por
 * motivo (e não uma por conta) e o motivo principal para a tela.
 */
function agruparFalhas(falhas) {
  const grupos = new Map();
  for (const falha of falhas) {
    const texto = falha.erro.replace(/\d{5,}/g, '#');
    const chave = `${falha.tipo}|${texto}`;
    if (!grupos.has(chave)) grupos.set(chave, { tipo: falha.tipo, detalhe: falha.detalhe, erro: falha.erro, contas: [] });
    grupos.get(chave).contas.push(falha.sellerId);
  }
  const ordenados = [...grupos.values()].sort((a, b) => b.contas.length - a.contas.length);
  for (const g of ordenados) {
    const n = g.contas.length;
    const lista = `${g.contas.slice(0, 10).join(', ')}${n > 10 ? `, mais ${n - 10}` : ''}`;
    console.warn(`[DEVOLUCOES] ${n} ${n === 1 ? 'conta não sincronizada' : 'contas não sincronizadas'} (${g.tipo}): ${g.erro} Contas: ${lista}.`);
  }
  const principal = ordenados[0];
  return principal ? { tipo: principal.tipo, detalhe: principal.detalhe || null, contas: principal.contas.length } : null;
}

async function executarSincronizacao(gatilho) {
  if (estado.rodando) return false;
  Object.assign(estado, {
    rodando: true, gatilho, inicio: new Date().toISOString(), fim: null,
    contas: 0, feitas: 0, resultado: null, erro: null,
  });

  let trava;
  try {
    trava = await db.pool.connect();
    const ok = (await trava.query('SELECT pg_try_advisory_lock($1) AS ok', [CHAVE_DA_TRAVA])).rows[0]?.ok;
    if (!ok) {
      estado.erro = 'Outra sincronização de devoluções já está em andamento.';
      return true;
    }
    try {
      const contas = (await db.query(
        `SELECT DISTINCT user_id::text AS seller_id
           FROM public.ml_accounts
          WHERE status = 'active' AND access_token IS NOT NULL`
      )).rows;
      estado.contas = contas.length;
      const resumo = {
        devolucoes: 0, novas: 0, falhas: [], falhaPrincipal: null,
        reclamacoesComFalha: 0, falhaDeReclamacao: null, buscas: {},
      };
      let proxima = 0;
      const trabalhar = async () => {
        while (proxima < contas.length) {
          const { seller_id: sellerId } = contas[proxima];
          proxima += 1;
          try {
            const ml = await abrirSessao(sellerId);
            const r = await devolucoes.sincronizarConta({ db, ml, sellerId });
            resumo.devolucoes += r.devolucoes;
            resumo.novas += r.novas;
            if (r.busca) resumo.buscas[r.busca] = (resumo.buscas[r.busca] || 0) + 1;
            if (r.reclamacoesComFalha) {
              resumo.reclamacoesComFalha += r.reclamacoesComFalha;
              if (!resumo.falhaDeReclamacao) resumo.falhaDeReclamacao = { sellerId, ...r.falhaDeReclamacao };
            }
          } catch (erro) {
            const tipo = tipoDaFalha(erro);
            resumo.falhas.push({
              sellerId,
              tipo,
              detalhe: tipo === 'consulta' ? erro?.detalheMl || null : null,
              erro: String(erro?.message || erro),
            });
          } finally {
            estado.feitas += 1;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONTAS_EM_PARALELO, contas.length) }, () => trabalhar()));

      resumo.falhaPrincipal = agruparFalhas(resumo.falhas);
      if (resumo.reclamacoesComFalha) {
        const exemplo = resumo.falhaDeReclamacao;
        console.warn(`[DEVOLUCOES] ${resumo.reclamacoesComFalha} reclamação(ões) não lida(s); serão tentadas de novo. Exemplo (conta ${exemplo.sellerId}): ${exemplo.mensagem}`);
      }
      estado.resultado = resumo;
      const buscas = Object.entries(resumo.buscas).map(([nome, n]) => `${nome}=${n}`).join(', ');
      const qtd = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
      console.log(`[DEVOLUCOES] sincronização (${gatilho}): ${qtd(contas.length, 'conta', 'contas')}, ${qtd(resumo.devolucoes, 'devolução', 'devoluções')}, ${qtd(resumo.novas, 'nova', 'novas')}, ${qtd(resumo.falhas.length, 'conta com falha', 'contas com falha')}${buscas ? `, formato da busca: ${buscas}` : ''}`);
    } finally {
      await trava.query('SELECT pg_advisory_unlock($1)', [CHAVE_DA_TRAVA]).catch(() => {});
    }
  } catch (erro) {
    estado.erro = 'Não foi possível sincronizar com o Mercado Livre agora.';
    console.error('[DEVOLUCOES] falha na sincronização:', erro);
  } finally {
    trava?.release();
    estado.rodando = false;
    estado.fim = new Date().toISOString();
  }
  return true;
}

/* Rotina automática: a primeira leitura sai alguns minutos depois de subir o
 * servidor (o banco já foi preparado) e depois a cada 30 minutos. Desligável
 * com ML_RETURNS_AUTO_SYNC=off. */
const SINCRONIZACAO_AUTOMATICA = process.env.ML_RETURNS_AUTO_SYNC !== 'off' && process.env.NODE_ENV !== 'test';
if (SINCRONIZACAO_AUTOMATICA) {
  const minutos = Math.max(10, parseInt(process.env.ML_RETURNS_SYNC_MINUTES || '30', 10) || 30);
  const rodar = () => { executarSincronizacao('automatica').catch(() => {}); };
  const primeira = setTimeout(rodar, 3 * 60 * 1000);
  if (primeira.unref) primeira.unref();
  const periodica = setInterval(rodar, minutos * 60 * 1000);
  if (periodica.unref) periodica.unref();
}

/* ------------------------------------------------------------------------- */
/* Aviso do ML (webhook)                                                      */
/* ------------------------------------------------------------------------- */

const avisosRecentes = new Map();

function ehAvisoDeDevolucao(body) {
  const topico = String(body?.topic || '').toLowerCase();
  const recurso = String(body?.resource || '');
  return topico === 'post_purchase' || topico.startsWith('claims') || /(^|\/)claims\/\d+/.test(recurso);
}

/**
 * Montado antes do webhook de vendas. Aviso de reclamação/devolução é
 * respondido aqui (200 na hora, como o ML exige) e processado em seguida;
 * qualquer outro segue para o webhook de vendas sem mudança.
 */
function interceptarAvisoDoMl(req, res, next) {
  const body = req.body || {};
  if (!ehAvisoDeDevolucao(body)) return next();
  res.sendStatus(200);

  const claimId = /claims\/(\d+)/.exec(String(body.resource || ''))?.[1];
  const sellerId = devolucoes.idTexto(body.user_id);
  if (!claimId || !sellerId) return undefined;

  const chave = `${sellerId}:${claimId}`;
  const agora = Date.now();
  if ((avisosRecentes.get(chave) || 0) > agora - 10000) return undefined;
  avisosRecentes.set(chave, agora);
  if (avisosRecentes.size > 2000) avisosRecentes.clear();

  (async () => {
    try {
      const ml = await abrirSessao(sellerId);
      await devolucoes.processarReclamacao({ db, ml, sellerId, claimId });
    } catch (erro) {
      console.warn(`[DEVOLUCOES] aviso do ML (reclamação ${claimId}) não processado: ${erro?.message || erro}`);
    }
  })();
  return undefined;
}

/* ------------------------------------------------------------------------- */
/* Rotas da tela                                                              */
/* ------------------------------------------------------------------------- */

router.use(authenticateToken, requireMaster);

const PERIODOS = new Set(['7d', '30d', '90d', 'all']);

router.get('/', async (req, res) => {
  try {
    const q = req.query || {};
    const [dados, ultima] = await Promise.all([
      devolucoes.listarDevolucoes(db, {
        periodo: PERIODOS.has(q.periodo) ? q.periodo : '30d',
        situacao: q.situacao,
        resultado: q.resultado,
        uid: q.cliente || null,
        seller: q.conta || null,
        busca: q.busca,
        page: q.page,
        limit: q.limit,
        todas: q.todas === '1',
      }),
      db.query('SELECT MAX(last_ok_at) AS ultima FROM public.ml_return_sync'),
    ]);
    res.json({ ...dados, ultimaSincronizacao: ultima.rows[0]?.ultima || null, sync: estadoPublico() });
  } catch (erro) {
    responderErro(res, erro, 'Não foi possível carregar as devoluções.');
  }
});

router.get('/sync', (req, res) => {
  res.json(estadoPublico());
});

router.post('/sync', (req, res) => {
  if (!estado.rodando) executarSincronizacao('manual').catch(() => {});
  res.status(202).json(estadoPublico());
});

router.get('/:id(\\d+)', async (req, res) => {
  try {
    res.json(await devolucoes.detalharDevolucao(db, req.params.id));
  } catch (erro) {
    responderErro(res, erro, 'Não foi possível abrir a devolução.');
  }
});

router.post('/:id(\\d+)/chegada', async (req, res) => {
  try {
    await comCliente((client) => devolucoes.registrarChegada(client, req.params.id, autorDe(req)));
    res.json(await devolucoes.detalharDevolucao(db, req.params.id));
  } catch (erro) {
    responderErro(res, erro, 'Não foi possível registrar a chegada.');
  }
});

router.put('/:id(\\d+)/analise', async (req, res) => {
  try {
    const { checklist, observacao } = req.body || {};
    await comCliente((client) => devolucoes.salvarAnalise(client, req.params.id, { checklist, notes: observacao }, autorDe(req)));
    res.json(await devolucoes.detalharDevolucao(db, req.params.id));
  } catch (erro) {
    responderErro(res, erro, 'Não foi possível salvar a análise.');
  }
});

router.post('/:id(\\d+)/decisao', async (req, res) => {
  try {
    const { itens, motivo, destino, checklist, observacao } = req.body || {};
    const efeito = await comCliente((client) => devolucoes.concluirAnalise(
      client, req.params.id, { itens, motivo, destino, checklist, notes: observacao }, autorDe(req)
    ));
    const detalhe = await devolucoes.detalharDevolucao(db, req.params.id);
    res.json({ ...detalhe, efeito });
  } catch (erro) {
    responderErro(res, erro, 'Não foi possível concluir a análise.');
  }
});

router.post('/:id(\\d+)/fotos', async (req, res) => {
  try {
    const foto = await comCliente((client) => devolucoes.adicionarFoto(client, req.params.id, req.body?.imagem, autorDe(req)));
    res.status(201).json(foto);
  } catch (erro) {
    responderErro(res, erro, 'Não foi possível guardar a foto.');
  }
});

router.get('/:id(\\d+)/fotos/:fotoId(\\d+)', async (req, res) => {
  try {
    const r = await db.query(
      'SELECT content_type, data FROM public.ml_return_photos WHERE id = $1 AND return_id = $2',
      [req.params.fotoId, req.params.id]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'Foto não encontrada.', code: 'foto_nao_encontrada' });
    const { content_type: tipo, data } = r.rows[0];
    res.set('Content-Type', tipo);
    res.set('Cache-Control', 'private, max-age=86400');
    res.set('X-Content-Type-Options', 'nosniff');
    // Sempre Buffer: com outro tipo binário o Express responderia JSON no lugar da imagem.
    return res.send(Buffer.isBuffer(data) ? data : Buffer.from(data));
  } catch (erro) {
    return responderErro(res, erro, 'Não foi possível abrir a foto.');
  }
});

router.delete('/:id(\\d+)/fotos/:fotoId(\\d+)', async (req, res) => {
  try {
    await comCliente((client) => devolucoes.removerFoto(client, req.params.id, req.params.fotoId, autorDe(req)));
    res.status(204).end();
  } catch (erro) {
    responderErro(res, erro, 'Não foi possível remover a foto.');
  }
});

module.exports = router;
module.exports.interceptarAvisoDoMl = interceptarAvisoDoMl;
module.exports.ehAvisoDeDevolucao = ehAvisoDeDevolucao;
module.exports.executarSincronizacao = executarSincronizacao;
module.exports.tipoDaFalha = tipoDaFalha;
