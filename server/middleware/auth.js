'use strict';

const User = require('../models/User');
const { verifyAccessToken } = require('../utils/jwt');
const { unauthorized } = require('../utils/errors');

/**
 * Verifies the Bearer access token and attaches the live user document.
 * We reload the user rather than trusting the token body so a deleted or
 * renamed account cannot keep acting on a still-valid token.
 */
async function requireAuth(req, _res, next) {
  try {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) {
      throw unauthorized('Missing Bearer token');
    }

    let payload;
    try {
      payload = verifyAccessToken(header.slice(7).trim());
    } catch (err) {
      throw unauthorized(err.name === 'TokenExpiredError' ? 'Access token expired' : 'Invalid access token');
    }

    const user = await User.findById(payload.sub);
    if (!user) throw unauthorized('Account no longer exists');

    req.user = user;
    req.userId = user._id.toHexString();
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireAuth };
