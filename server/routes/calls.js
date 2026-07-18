'use strict';

const express = require('express');
const { param, query } = require('express-validator');
const controller = require('../controllers/callController');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

router.get('/ice-servers', controller.iceServers);
router.get('/recents', controller.recents);
router.get('/stats', controller.stats);

router.get(
  '/history',
  [
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('cursor').optional().isISO8601(),
  ],
  validate,
  controller.history,
);

router.get('/:callId', [param('callId').isUUID()], validate, controller.getOne);

module.exports = router;
