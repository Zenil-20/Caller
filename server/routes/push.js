'use strict';

const express = require('express');
const { body } = require('express-validator');
const controller = require('../controllers/pushController');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Public: the browser needs this before it can even ask for permission.
router.get('/vapid-public-key', controller.publicKey);

/**
 * Called by the service worker from a notification on a locked device, so it
 * authenticates with the payload's action token rather than a Bearer session.
 */
router.post(
  '/call-action',
  [
    body('actionToken').isString().notEmpty(),
    body('action').isIn(['reject']),
  ],
  validate,
  controller.callAction,
);

router.post('/subscribe', requireAuth, controller.subscribe);
router.delete('/subscribe', requireAuth, controller.unsubscribe);

module.exports = router;
