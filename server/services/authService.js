'use strict';

const bcrypt = require('bcryptjs');
const User = require('../models/User');
const RefreshToken = require('../models/RefreshToken');

// A real bcrypt hash (of a value nobody can present) used as the comparison
// target when the account lookup misses, keeping login timing uniform.
const DUMMY_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEe.9c1a3nNCEuUzLNS0eXFvXVLIQpCcJ5C';
const { signAccessToken, signRefreshToken, verifyRefreshToken, hashToken } = require('../utils/jwt');
const { conflict, unauthorized, badRequest } = require('../utils/errors');

/** Turns "30d" / "15m" / "3600" into milliseconds. */
function ttlToMs(ttl) {
  const match = /^(\d+)([smhd])?$/.exec(String(ttl));
  if (!match) return 30 * 24 * 60 * 60 * 1000;
  const value = Number(match[1]);
  const unit = match[2] || 's';
  const factor = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit];
  return value * factor;
}

const env = require('../config/env');

async function issueSession(user, { userAgent, ip } = {}) {
  const accessToken = signAccessToken(user);
  const { token: refreshToken, jti } = signRefreshToken(user);

  await RefreshToken.create({
    jti,
    user: user._id,
    tokenHash: hashToken(refreshToken),
    userAgent: userAgent?.slice(0, 300),
    ip,
    expiresAt: new Date(Date.now() + ttlToMs(env.jwt.refreshTtl)),
  });

  return { accessToken, refreshToken, user: user.toPublic() };
}

async function register({ username, phone, password, displayName }, context) {
  const normalizedUsername = username.trim().toLowerCase();

  const clash = await User.findOne({
    $or: [{ username: normalizedUsername }, ...(phone ? [{ phone }] : [])],
  });

  if (clash) {
    const field = clash.username === normalizedUsername ? 'username' : 'phone';
    throw conflict(`That ${field} is already registered`, [{ field }]);
  }

  const user = new User({
    username: normalizedUsername,
    phone: phone || undefined,
    displayName: displayName?.trim() || normalizedUsername,
  });
  await user.setPassword(password);
  await user.save();

  return issueSession(user, context);
}

/**
 * `identifier` accepts either a username or an E.164 phone number so one login
 * form serves both registration paths.
 */
async function login({ identifier, password }, context) {
  const value = identifier.trim();
  const query = value.startsWith('+') ? { phone: value } : { username: value.toLowerCase() };

  const user = await User.findOne(query).select('+passwordHash');

  // Always run a real bcrypt comparison, even on a miss, so response timing
  // does not reveal whether the account exists.
  const ok = await bcrypt.compare(password, user ? user.passwordHash : DUMMY_HASH);

  if (!user || !ok) {
    throw unauthorized('Incorrect username or password');
  }

  return issueSession(user, context);
}

/**
 * Rotates the refresh token: the presented one is revoked and a fresh pair is
 * issued. Reusing a revoked token revokes the whole family — that pattern only
 * appears when a token has been stolen and replayed.
 */
async function refresh(presentedToken, context) {
  if (!presentedToken) throw badRequest('refreshToken is required');

  let payload;
  try {
    payload = verifyRefreshToken(presentedToken);
  } catch {
    throw unauthorized('Invalid or expired refresh token');
  }

  const record = await RefreshToken.findOne({ jti: payload.jti });
  if (!record) throw unauthorized('Session not recognised');

  if (record.revokedAt) {
    await RefreshToken.updateMany({ user: record.user, revokedAt: null }, { revokedAt: new Date() });
    throw unauthorized('Session reuse detected; all sessions have been signed out');
  }

  if (record.tokenHash !== hashToken(presentedToken)) {
    throw unauthorized('Session not recognised');
  }

  const user = await User.findById(record.user);
  if (!user) throw unauthorized('Account no longer exists');

  record.revokedAt = new Date();
  await record.save();

  return issueSession(user, context);
}

async function logout(presentedToken) {
  if (!presentedToken) return;
  try {
    const payload = verifyRefreshToken(presentedToken);
    await RefreshToken.updateOne({ jti: payload.jti }, { revokedAt: new Date() });
  } catch {
    // An unparseable token is already useless — nothing to revoke.
  }
}

async function logoutAll(userId) {
  await RefreshToken.updateMany({ user: userId, revokedAt: null }, { revokedAt: new Date() });
}

module.exports = { register, login, refresh, logout, logoutAll, issueSession };
