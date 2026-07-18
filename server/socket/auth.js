'use strict';

const User = require('../models/User');
const { verifyAccessToken } = require('../utils/jwt');
const logger = require('../utils/logger');

/**
 * Socket.IO handshake authentication.
 *
 * The token arrives in `handshake.auth.token` (set by the client before
 * connect). Rejecting here means an unauthenticated socket never reaches any
 * call handler, so individual events do not each re-check identity.
 */
module.exports = async function socketAuth(socket, next) {
  try {
    const token = socket.handshake.auth?.token
      || (socket.handshake.headers.authorization || '').replace(/^Bearer\s+/i, '');

    if (!token) {
      return next(Object.assign(new Error('Authentication required'), { data: { code: 'NO_TOKEN' } }));
    }

    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch (err) {
      const code = err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN';
      return next(Object.assign(new Error('Invalid or expired token'), { data: { code } }));
    }

    const user = await User.findById(payload.sub).select('username displayName avatarColor');
    if (!user) {
      return next(Object.assign(new Error('Account no longer exists'), { data: { code: 'NO_ACCOUNT' } }));
    }

    socket.userId = user._id.toHexString();
    socket.user = {
      id: socket.userId,
      username: user.username,
      displayName: user.displayName,
      avatarColor: user.avatarColor,
    };

    return next();
  } catch (err) {
    logger.error('Socket auth failure', err);
    return next(new Error('Authentication failed'));
  }
};
