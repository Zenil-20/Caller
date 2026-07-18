'use strict';

const rateLimit = require('express-rate-limit');

const common = {
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down.' } },
};

/** Tight budget on credential endpoints to blunt password guessing. */
const authLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  limit: 20,
  skipSuccessfulRequests: true,
});

const apiLimiter = rateLimit({
  ...common,
  windowMs: 60 * 1000,
  limit: 240,
});

const searchLimiter = rateLimit({
  ...common,
  windowMs: 60 * 1000,
  limit: 60,
});

module.exports = { authLimiter, apiLimiter, searchLimiter };
