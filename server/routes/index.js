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
