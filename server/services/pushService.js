'use strict';

const webpush = require('web-push');
const PushSubscription = require('../models/PushSubscription');
const env = require('../config/env');
const logger = require('../utils/logger');

let configured = false;

/**
 * Web Push is what lets a call reach a device whose browser is closed and
 * whose screen is locked. The browser vendor's push service (FCM for Chrome,
 * Mozilla autopush, Apple for Safari) holds the message and wakes our service
 * worker — no proprietary SDK and no cost.
 */
function init() {
  if (!env.push.publicKey || !env.push.privateKey) {
    logger.warn('VAPID keys not configured — calls will not ring on closed/locked devices.');
    return false;
  }

  webpush.setVapidDetails(env.push.subject, env.push.publicKey, env.push.privateKey);
  configured = true;
  logger.info('Web Push configured — offline devices can be woken.');
  return true;
}

const isConfigured = () => configured;

async function saveSubscription(userId, subscription, userAgent) {
  const { endpoint, keys } = subscription;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    const err = new Error('Malformed push subscription');
    err.expected = true;
    err.status = 400;
    throw err;
  }

  // Upsert on endpoint: the same device re-subscribing (after a key rotation
  // or cache clear) must not create a second row, and if the device now
  // belongs to a different signed-in user, ownership moves with it.
  await PushSubscription.findOneAndUpdate(
    { endpoint },
    {
      user: userId,
      endpoint,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
      userAgent: userAgent?.slice(0, 300),
      failureCount: 0,
      lastUsedAt: new Date(),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

async function removeSubscription(endpoint) {
  if (!endpoint) return;
  await PushSubscription.deleteOne({ endpoint });
}

async function countFor(userId) {
  return PushSubscription.countDocuments({ user: userId });
}

/**
 * Fans a payload out to every device a user has registered.
 *
 * `urgency: 'high'` and a short TTL matter here: an incoming call is only
 * useful while it is still ringing, so we ask the push service to deliver it
 * immediately and to discard it rather than deliver it late.
 */
async function sendToUser(userId, payload, { ttl = 45, urgency = 'high' } = {}) {
  if (!configured) return { sent: 0, failed: 0 };

  const subscriptions = await PushSubscription.find({ user: userId });
  if (!subscriptions.length) return { sent: 0, failed: 0 };

  const body = JSON.stringify(payload);
  let sent = 0;
  let failed = 0;
  const dead = [];

  await Promise.all(subscriptions.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
        body,
        { TTL: ttl, urgency },
      );
      sent += 1;

      // Bookkeeping only — a failed save here must not be counted as a failed
      // delivery, or the same push is tallied as both sent and failed.
      sub.lastUsedAt = new Date();
      sub.failureCount = 0;
      await sub.save().catch(() => {});
    } catch (err) {
      failed += 1;
      // 404/410 mean the subscription is permanently gone (uninstalled app,
      // cleared site data). Anything else may be transient.
      if (err.statusCode === 404 || err.statusCode === 410) {
        dead.push(sub.endpoint);
      } else {
        logger.warn(`Push send failed (${err.statusCode}): ${err.body || err.message}`);
        sub.failureCount += 1;
        await sub.save().catch(() => {});
      }
    }
  }));

  if (dead.length) {
    await PushSubscription.deleteMany({ endpoint: { $in: dead } });
    logger.debug(`Pruned ${dead.length} expired push subscription(s)`);
  }

  return { sent, failed };
}

/**
 * Wakes the callee's devices for an incoming call.
 *
 * `actionToken` is a short-lived credential embedded in the payload so the
 * service worker can decline the call without the user unlocking and opening
 * the app first.
 */
function sendIncomingCall(calleeId, { callId, from, actionToken, expiresAt }) {
  return sendToUser(calleeId, {
    type: 'incoming-call',
    callId,
    from,
    actionToken,
    expiresAt,
  }, { ttl: 45, urgency: 'high' });
}

/** Tells every device to dismiss the ringing notification. */
function sendCallCancelled(calleeId, { callId, reason }) {
  return sendToUser(calleeId, { type: 'call-cancelled', callId, reason }, { ttl: 30 });
}

function sendMissedCall(calleeId, { callId, from }) {
  return sendToUser(calleeId, { type: 'missed-call', callId, from }, { ttl: 3600, urgency: 'normal' });
}

module.exports = {
  init,
  isConfigured,
  saveSubscription,
  removeSubscription,
  countFor,
  sendToUser,
  sendIncomingCall,
  sendCallCancelled,
  sendMissedCall,
};
