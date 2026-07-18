'use strict';

const express = require('express');
const { body } = require('express-validator');
const controller = require('../controllers/locationController');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

router.get('/', controller.list);
router.get('/sharing', controller.getSharing);

router.patch(
  '/sharing',
  [
    body('enabled').optional().isBoolean(),
    body('scope').optional().isIn(['contacts', 'selected']),
    body('sharedWith').optional().isArray({ max: 100 }),
    body('sharedWith.*').optional().isMongoId(),
  ],
  validate,
  controller.setSharing,
);

router.post(
  '/',
  [
    body('latitude').isFloat({ min: -90, max: 90 }),
    body('longitude').isFloat({ min: -180, max: 180 }),
    body('accuracy').optional().isFloat({ min: 0 }),
  ],
  validate,
  controller.update,
);

module.exports = router;
