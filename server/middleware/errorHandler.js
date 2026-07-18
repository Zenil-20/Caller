'use strict';

const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');

function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.originalUrl}` } });
}

// eslint-disable-next-line no-unused-vars -- Express identifies error middleware by arity.
function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
    });
  }

  // Duplicate key on a unique index — surface which field collided.
  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern || { field: 1 })[0];
    return res.status(409).json({
      error: { code: 'CONFLICT', message: `That ${field} is already taken`, details: [{ field }] },
    });
  }

  if (err.name === 'ValidationError') {
    const details = Object.values(err.errors).map((e) => ({ field: e.path, message: e.message }));
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Validation failed', details } });
  }

  if (err.name === 'CastError') {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: `Malformed ${err.path}` } });
  }

  logger.error('Unhandled error', err);
  return res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
}

module.exports = { notFoundHandler, errorHandler };
