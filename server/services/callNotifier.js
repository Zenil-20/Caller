'use strict';

const pushService = require('./pushService');
const fcmService = require('./fcmService');
const logger = require('../utils/logger');

/**
 * Fans call notifications out across every transport a user might be reachable
 * on: Web Push for browsers, FCM for the native Android app.
 *
 * The two are not interchangeable. Web Push reaches a closed browser but can
 * only ever raise a notification, because a service worker has no way to draw
 * over the lock screen. FCM reaches native code, which can show a real
 * full-screen ringing call screen. A user commonly has both — phone app and
 * desktop browser — and both should ring, exactly like a number registered on
 * several handsets.
 *
 * Delivery is best-effort by design: one transport failing must never suppress
 * the other, and neither may reject into a caller that is mid-call-setup.
 */
async function both(label, webCall, nativeCall) {
  const [web, native] = await Promise.allSettled([webCall, nativeCall]);

  if (web.status === 'rejected') logger.warn(`${label}: web push failed — ${web.reason?.message}`);
  if (native.status === 'rejected') logger.warn(`${label}: fcm failed — ${native.reason?.message}`);

  const tally = (result) => (result.status === 'fulfilled' ? result.value : { sent: 0, failed: 0 });
  return { web: tally(web), native: tally(native) };
}

function sendIncomingCall(calleeId, payload) {
  return both(
    'incoming-call',
    pushService.sendIncomingCall(calleeId, payload),
    fcmService.sendIncomingCall(calleeId, payload),
  );
}

function sendCallCancelled(calleeId, payload) {
  return both(
    'call-cancelled',
    pushService.sendCallCancelled(calleeId, payload),
    fcmService.sendCallCancelled(calleeId, payload),
  );
}

function sendMissedCall(calleeId, payload) {
  return both(
    'missed-call',
    pushService.sendMissedCall(calleeId, payload),
    fcmService.sendMissedCall(calleeId, payload),
  );
}

module.exports = { sendIncomingCall, sendCallCancelled, sendMissedCall };
