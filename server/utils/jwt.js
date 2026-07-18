'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const env = require('../config/env');

function signAccessToken(user) {
  return jwt.sign(
    { sub: String(user._id), username: user.username, type: 'access' },
    env.jwt.accessSecret,
    { expiresIn: env.jwt.accessTtl },
  );
}

/**
 * Refresh tokens carry a random `jti` so a single session can be revoked
 * without invalidating every other device the user is signed in on.
 */
function signRefreshToken(user, jti = crypto.randomUUID()) {
  const token = jwt.sign(
    { sub: String(user._id), jti, type: 'refresh' },
    env.jwt.refreshSecret,
    { expiresIn: env.jwt.refreshTtl },
  );
  return { token, jti };
}

function verifyAccessToken(token) {
  const payload = jwt.verify(token, env.jwt.accessSecret);
  if (payload.type !== 'access') throw new jwt.JsonWebTokenError('Wrong token type');
  return payload;
}

function verifyRefreshToken(token) {
  const payload = jwt.verify(token, env.jwt.refreshSecret);
  if (payload.type !== 'refresh') throw new jwt.JsonWebTokenError('Wrong token type');
  return payload;
}

/**
 * A narrowly-scoped, short-lived token embedded in a push payload. It lets a
 * service worker decline one specific call straight from the lock screen
 * without ever holding the user's real session credentials.
 */
function signCallActionToken({ userId, callId }, ttlSeconds = 90) {
  return jwt.sign(
    { sub: String(userId), callId, type: 'call-action' },
    env.jwt.accessSecret,
    { expiresIn: ttlSeconds },
  );
}

function verifyCallActionToken(token) {
  const payload = jwt.verify(token, env.jwt.accessSecret);
  if (payload.type !== 'call-action') throw new jwt.JsonWebTokenError('Wrong token type');
  return payload;
}

/** Refresh tokens are stored as SHA-256 digests so a DB leak is not a session leak. */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  signCallActionToken,
  verifyCallActionToken,
  hashToken,
};
