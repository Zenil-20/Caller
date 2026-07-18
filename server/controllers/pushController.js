'use strict';

const pushService = require('../services/pushService');
const callService = require('../services/callService');
const asyncHandler = require('../utils/asyncHandler');
const { verifyCallActionToken } = require('../utils/jwt');
const { unauthorized, badRequest } = require('../utils/errors');
const logger = require('../utils/logger');

/**
 * The public VAPID key the browser needs to create a subscription. It is
 * public by design — the private half never leaves the server.
 */
const publicKey = asyncHandler(async (_req, res) => {
  res.json({
    publicKey: require('../config/env').push.publicKey || null,
    enabled: pushService.isConfigured(),
  });
});

const subscribe = asyncHandler(async (req, res) => {
  await pushService.saveSubscription(req.userId, req.body.subscription || req.body, req.get('user-agent'));
  res.status(201).json({ ok: true, devices: await pushService.countFor(req.userId) });
});

const unsubscribe = asyncHandler(async (req, res) => {
  await pushService.removeSubscription(req.body.endpoint);
  res.status(204).end();
});

/**
 * Lets the service worker act on a call straight from a notification, using
 * the short-lived token that arrived inside the push payload. Deliberately
 * NOT behind requireAuth — a locked device has no access token in memory.
 */
const callAction = asyncHandler(async (req, res) => {
  const { actionToken, action } = req.body;
  if (!actionToken || !action) throw badRequest('actionToken and action are required');

  let payload;
  try {
    payload = verifyCallActionToken(actionToken);
  } catch {
    throw unauthorized('Invalid or expired action token');
  }

  if (action !== 'reject') {
    // Answering needs the full WebRTC stack, so it can only happen in the page.
    throw badRequest('Only "reject" can be performed from a notification');
  }

  try {
    const call = await callService.reject({
      callId: payload.callId,
      userId: payload.sub,
      reason: 'declined',
    });

    // Tell the caller over Socket.IO, exactly as an in-app decline would.
    const io = req.app.get('io');
    if (io) {
      io.to(`user:${String(call.caller)}`).emit('call:rejected', {
        callId: call.callId,
        reason: 'declined',
      });
      io.to(`user:${String(call.callee)}`).emit('call:handled-elsewhere', { callId: call.callId });
    }

    res.json({ ok: true, status: call.status });
  } catch (err) {
    // The call may already have ended while the notification sat on screen.
    if (err.status === 404 || err.status === 400) {
      logger.debug(`Push reject ignored: ${err.message}`);
      res.json({ ok: true, status: 'already-resolved' });
      return;
    }
    throw err;
  }
});

module.exports = { publicKey, subscribe, unsubscribe, callAction };
