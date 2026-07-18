'use strict';

const authService = require('../services/authService');
const asyncHandler = require('../utils/asyncHandler');

function context(req) {
  return { userAgent: req.get('user-agent'), ip: req.ip };
}

const register = asyncHandler(async (req, res) => {
  const { username, phone, password, displayName } = req.body;
  const session = await authService.register({ username, phone, password, displayName }, context(req));
  res.status(201).json(session);
});

const login = asyncHandler(async (req, res) => {
  const { identifier, password } = req.body;
  const session = await authService.login({ identifier, password }, context(req));
  res.json(session);
});

const refresh = asyncHandler(async (req, res) => {
  const session = await authService.refresh(req.body.refreshToken, context(req));
  res.json(session);
});

const logout = asyncHandler(async (req, res) => {
  await authService.logout(req.body.refreshToken);
  res.status(204).end();
});

const logoutAll = asyncHandler(async (req, res) => {
  await authService.logoutAll(req.userId);
  res.status(204).end();
});

const me = asyncHandler(async (req, res) => {
  res.json({
    user: {
      ...req.user.toPublic(),
      settings: req.user.settings,
      contactCount: req.user.contacts.length,
      setupCompletedAt: req.user.setupCompletedAt,
    },
  });
});

module.exports = { register, login, refresh, logout, logoutAll, me };
