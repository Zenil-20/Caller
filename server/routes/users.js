'use strict';

const express = require('express');
const { body, param, query } = require('express-validator');
const controller = require('../controllers/userController');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const { searchLimiter } = require('../middleware/rateLimit');

const router = express.Router();

router.use(requireAuth);

router.get(
  '/search',
  searchLimiter,
  [query('q').isString().trim().isLength({ min: 2 }).withMessage('Query must be at least 2 characters')],
  validate,
  controller.search,
);

router.get('/presence', controller.presenceLookup);

router.get('/contacts', controller.listContacts);

router.post(
  '/contacts',
  [body('userId').isMongoId().withMessage('userId must be a valid id')],
  validate,
  controller.addContact,
);

router.delete(
  '/contacts/:userId',
  [param('userId').isMongoId()],
  validate,
  controller.removeContact,
);

router.patch(
  '/me',
  [
    body('displayName').optional().isString().trim().isLength({ min: 1, max: 60 }),
    body('about').optional().isString().trim().isLength({ max: 140 }),
    body('settings').optional().isObject(),
    body('setupCompleted').optional().isBoolean(),
  ],
  validate,
  controller.updateProfile,
);

router.get('/:userId', [param('userId').isMongoId()], validate, controller.getOne);

module.exports = router;
