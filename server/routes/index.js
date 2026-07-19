'use strict';

const express = require('express');
const mongoose = require('mongoose');
const { apiLimiter } = require('../middleware/rateLimit');

const router = express.Router();

router.get('/health', (_req, res) => {
  const dbState = mongoose.connection.readyState; // 1 === connected
  res.status(dbState === 1 ? 200 : 503).json({
    status: dbState === 1 ? 'ok' : 'degraded',
    database: ['disconnected', 'connected', 'connecting', 'disconnecting'][dbState] || 'unknown',

    // Both wake-up transports report whether their credentials actually loaded.
    // Missing keys do not stop the server booting — by design, so a bad key
    // cannot take calling offline — which means the only other way to notice
    // is a call that silently fails to ring. Neither flag exposes a secret.
    push: {
      webPush: require('../services/pushService').isConfigured(),
      fcm: require('../services/fcmService').isConfigured(),
    },

    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

router.use(apiLimiter);
router.use('/auth', require('./auth'));
router.use('/users', require('./users'));
router.use('/calls', require('./calls'));
router.use('/push', require('./push'));
router.use('/location', require('./location'));

module.exports = router;
