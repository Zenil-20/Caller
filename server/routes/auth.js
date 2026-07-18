'use strict';

const express = require('express');
const { body } = require('express-validator');
const controller = require('../controllers/authController');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimit');

const router = express.Router();

router.post(
  '/register',
  authLimiter,
  [
    body('username')
      .isString().trim().toLowerCase()
      .isLength({ min: 3, max: 30 }).withMessage('Username must be 3-30 characters')
      .matches(/^[a-z0-9_.]+$/).withMessage('Username may only contain letters, numbers, underscore and dot'),
    body('phone')
      .optional({ values: 'falsy' })
      .isString().trim()
      .matches(/^\+[1-9]\d{7,14}$/).withMessage('Phone must be in E.164 format, e.g. +919812345678'),
    body('password')
      .isString()
      .isLength({ min: 8, max: 128 }).withMessage('Password must be at least 8 characters'),
    body('displayName')
      .optional({ values: 'falsy' })
      .isString().trim().isLength({ max: 60 }),
  ],
  validate,
  controller.register,
);

router.post(
  '/login',
  authLimiter,
  [
    body('identifier').isString().trim().notEmpty().withMessage('Username or phone is required'),
    body('password').isString().notEmpty().withMessage('Password is required'),
  ],
  validate,
  controller.login,
);

router.post(
  '/refresh',
  [body('refreshToken').isString().notEmpty()],
  validate,
  controller.refresh,
);

router.post('/logout', controller.logout);
router.post('/logout-all', requireAuth, controller.logoutAll);
router.get('/me', requireAuth, controller.me);

module.exports = router;
