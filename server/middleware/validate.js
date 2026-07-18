'use strict';

const { validationResult } = require('express-validator');
const { badRequest } = require('../utils/errors');

/** Turns express-validator's result into a single 400 with per-field details. */
function validate(req, _res, next) {
  const result = validationResult(req);
  if (result.isEmpty()) return next();

  const details = result.array().map((e) => ({ field: e.path, message: e.msg }));
  return next(badRequest('Validation failed', details));
}

module.exports = { validate };
