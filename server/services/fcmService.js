'use strict';

const jwt = require('jsonwebtoken');
const DeviceToken = require('../models/DeviceToken');
const env = require('../config/env');
const logger = require('../utils/logger');

/**
 * Firebase Cloud Messaging, used only by the native Android app.
 *
 * Web Push (pushService) can wake a closed browser but can only ever produce a
 * notification — a service worker has no way to draw over the lock screen. FCM
 * delivers to native code instead, which can raise a real full-screen call
 * screen with a ringtone. Both run side by side: browsers keep using Web Push.
 *
 * This talks to the HTTP v1 REST API directly rather than pulling in
 * firebase-admin. The whole integration is an OAuth2 token exchange plus one
 * POST, and jsonwebtoken (already a dependency, for our own auth) can sign the
 * assertion, so a multi-megabyte SDK would earn nothing here.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

let configured = false;

/** Cached OAuth access token: `{ value, expiresAt }`. Google issues them hourly. */
let accessToken = null;

/**
 * In-flight token request, shared by concurrent callers.
 *
 * Without this, a burst of simultaneous calls would each notice the expired
 * token and start its own exchange — a self-inflicted spike against Google's
 * endpoint at exactly the moment calls need to go out fast.
 */
let tokenInFlight = null;

function init() {
  const { projectId, clientEmail, privateKey } = env.fcm;

  if (!projectId || !clientEmail || !privateKey) {
    logger.warn('FCM not configured — the Android app will not ring full-screen. Web Push is unaffected.');
    return false;
  }

  configured = true;
  logger.info('FCM configured — the Android app can ring full-screen.');
  return true;
}

const isConfigured = () => configured;

/**
 * Exchanges the service-account key for a short-lived access token.
 * Refreshed a minute early so a token cannot expire mid-flight.
 */
async function getAccessToken() {
  if (accessToken && Date.now() < accessToken.expiresAt) return accessToken.value;
  if (tokenInFlight) return tokenInFlight;

  tokenInFlight = (async () => {
    const now = Math.floor(Date.now() / 1000);
    const assertion = jwt.sign(
      {
        iss: env.fcm.clientEmail,
        scope: SCOPE,
        aud: TOKEN_URL,
        iat: now,
        exp: now + 3600,
      },
      env.fcm.privateKey,
      { algorithm: 'RS256' },
    );

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`FCM auth failed (${res.status}): ${detail.slice(0, 300)}`);
    }

    const body = await res.json();
    accessToken = {
      value: body.access_token,
      expiresAt: Date.now() + (body.expires_in - 60) * 1000,
    };
    return accessToken.value;
  })();

  try {
    return await tokenInFlight;
  } catch (err) {
    // Never cache a failure: the next call must be free to retry immediately.
    accessToken = null;
    throw err;
  } finally {
    tokenInFlight = null;
  }
}

async function saveToken(userId, token, { platform = 'android', appVersion } = {}) {
  if (!token) {
    const err = new Error('Missing device token');
    err.expected = true;
    err.status = 400;
    throw err;
  }

  // Upsert on the token itself. If this device now belongs to a different
  // signed-in user, ownership moves with it — otherwise the previous user would
  // keep getting call screens on a phone that is no longer theirs.
  await DeviceToken.findOneAndUpdate(
    { token },
    {
      user: userId, token, platform, appVersion, failureCount: 0, lastUsedAt: new Date(),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

async function removeToken(token) {
  if (!token) return;
  await DeviceToken.deleteOne({ token });
}

async function countFor(userId) {
  return DeviceToken.countDocuments({ user: userId });
}

/**
 * Sends a data-only message to one device.
 *
 * Data-only is deliberate and load-bearing. A message carrying a `notification`
 * block is rendered by the system when the app is backgrounded, and our handler
 * never runs — which is exactly the case we care about. Data-only always goes to
 * onMessageReceived, so the app can raise the full-screen call screen itself.
 */
async function sendOne(token, data, { ttlSeconds = 45 } = {}) {
  const bearer = await getAccessToken();

  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${env.fcm.projectId}/messages:send`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          token,
          // Every value must be a string; FCM rejects other JSON types.
          data,
          android: {
            priority: 'high',   // wakes a Dozing device; normal priority would be batched
            ttl: `${ttlSeconds}s`,
          },
        },
      }),
    },
  );

  if (res.ok) return { ok: true };

  const detail = await res.text().catch(() => '');
  return { ok: false, status: res.status, detail };
}

/**
 * Fans a payload out to every Android device a user has installed.
 *
 * Values are stringified here rather than at each call site because FCM's data
 * map is string-to-string and silently rejects the whole message otherwise.
 */
async function sendToUser(userId, payload, { ttlSeconds = 45 } = {}) {
  if (!configured) return { sent: 0, failed: 0 };

  const devices = await DeviceToken.find({ user: userId });
  if (!devices.length) return { sent: 0, failed: 0 };

  const data = {};
  Object.entries(payload).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    data[key] = typeof value === 'string' ? value : JSON.stringify(value);
  });

  let sent = 0;
  let failed = 0;
  const dead = [];

  await Promise.all(devices.map(async (device) => {
    try {
      const result = await sendOne(device.token, data, { ttlSeconds });

      if (result.ok) {
        sent += 1;
        // Bookkeeping only — a failed save must not be counted as a failed
        // delivery, or one push is tallied as both sent and failed.
        device.lastUsedAt = new Date();
        device.failureCount = 0;
        await device.save().catch(() => {});
        return;
      }

      failed += 1;

      // 404 UNREGISTERED / 400 INVALID_ARGUMENT mean the token is permanently
      // gone — app uninstalled, or data cleared. Anything else may be transient.
      if (result.status === 404 || result.status === 400) {
        dead.push(device.token);
      } else {
        logger.warn(`FCM send failed (${result.status}): ${result.detail?.slice(0, 200)}`);
        device.failureCount += 1;
        await device.save().catch(() => {});
      }
    } catch (err) {
      // Auth or network failure — applies to every device, so do not blame the
      // token for it and do not delete anything.
      failed += 1;
      logger.warn(`FCM send error: ${err.message}`);
    }
  }));

  if (dead.length) {
    await DeviceToken.deleteMany({ token: { $in: dead } });
    logger.debug(`Pruned ${dead.length} expired device token(s)`);
  }

  return { sent, failed };
}

/** Wakes the callee's Android devices into a full-screen ringing call screen. */
function sendIncomingCall(calleeId, { callId, from, actionToken, expiresAt }) {
  return sendToUser(calleeId, {
    type: 'incoming-call',
    callId,
    actionToken,
    expiresAt,
    callerName: from?.displayName || from?.username || 'Unknown caller',
    callerUsername: from?.username || '',
  }, { ttlSeconds: 45 });
}

/** Tells every device to tear the call screen down. */
function sendCallCancelled(calleeId, { callId, reason }) {
  return sendToUser(calleeId, { type: 'call-cancelled', callId, reason }, { ttlSeconds: 30 });
}

function sendMissedCall(calleeId, { callId, from }) {
  return sendToUser(calleeId, {
    type: 'missed-call',
    callId,
    callerName: from?.displayName || from?.username || 'Someone',
  }, { ttlSeconds: 3600 });
}

module.exports = {
  init,
  isConfigured,
  saveToken,
  removeToken,
  countFor,
  sendToUser,
  sendIncomingCall,
  sendCallCancelled,
  sendMissedCall,
};
