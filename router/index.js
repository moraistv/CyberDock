const express = require('express');
const router = express.Router();

const authRouter = require('./auth');
const mercadoLivreRouter = require('./mercadolivre');
const shopeeRouter = require('./shopee');
const tiktokRouter = require('./tiktok');
const salesRouter = require('./sales');
const usersRouter = require('./users');
const settingsRouter = require('./settings');
const servicesRouter = require('./services');
const storageRouter = require('./storage');
const billingRouter = require('./billing');
const historyRoutes = require('./history'); // Importa a nova rota
const kitParentRouter = require('./kit-parent');
const returnsRouter = require('./returns');

router.get('/', (req, res) => {
  res.send('API Cyberdock backend rodando.');
});

router.use('/auth', authRouter);
router.use('/ml', mercadoLivreRouter);
router.use('/shopee', shopeeRouter);
router.use('/tiktok', tiktokRouter);
// Avisos de reclamação/devolução do ML chegam na mesma URL do webhook de
// vendas. Este passo pega só esses avisos; o resto segue para /sales.
router.post('/sales/webhook/ml', returnsRouter.interceptarAvisoDoMl);
router.use('/sales', salesRouter);
router.use('/users', usersRouter);
router.use('/settings', settingsRouter);
router.use('/services', servicesRouter);
router.use('/storage', storageRouter);
router.use('/billing', billingRouter);
router.use('/history', historyRoutes); // Registra a nova rota
router.use('/kit-parent', kitParentRouter);
router.use('/returns', returnsRouter);

module.exports = router;
