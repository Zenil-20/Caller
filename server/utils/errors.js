'use strict';

/**
 * Error carrying an HTTP status and a stable machine-readable code so the
 * client can branch on `code` rather than parsing English messages.
 */
class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expected = true;
    Error.captureStackTrace(this, AppError);
  }
}

const badRequest = (message, details) => new AppError(400, 'BAD_REQUEST', message, details);
const unauthorized = (message = 'Authentication required') => new AppError(401, 'UNAUTHORIZED', message);
const forbidden = (message = 'Not allowed') => new AppError(403, 'FORBIDDEN', message);
const notFound = (message = 'Resource not found') => new AppError(404, 'NOT_FOUND', message);
const conflict = (message, details) => new AppError(409, 'CONFLICT', message, details);
const tooMany = (message = 'Too many requests') => new AppError(429, 'RATE_LIMITED', message);

module.exports = { AppError, badRequest, unauthorized, forbidden, notFound, conflict, tooMany };
