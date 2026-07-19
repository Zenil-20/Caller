'use strict';

const Call = require('../models/Call');
const callService = require('../services/callService');
const presence = require('../services/presenceService');
const iceService = require('../services/iceService');
const callNotifier = require('../services/callNotifier');
const env = require('../config/env');
const { signCallActionToken } = require('../utils/jwt');
const logger = require('../utils/logger');

const { CALL_STATUS } = callService;

/**
 * Wraps a handler so any throw becomes a structured ack instead of an
 * unhandled rejection that silently strands the caller's UI.
 */
function guard(handler) {
  return async (payload, ack) => {
    try {
      const result = await handler(payload || {});
      if (typeof ack === 'function') ack({ ok: true, ...(result || {}) });
    } catch (err) {
      if (!err.expected) logger.error('Socket handler error', err);
      if (typeof ack === 'function') {
        ack({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message || 'Unexpected error' } });
      }
    }
  };
}

module.exports = function registerCallHandlers(io, socket) {
  const userId = socket.userId;

  /** Emits to every device the given user has connected. */
  const toUser = (targetId, event, payload) => {
    io.to(`user:${targetId}`).emit(event, payload);
  };

  /**
   * Emits to the peer's devices only. Once a call is answered we also stop
   * ringing the callee's *other* devices, mirroring how a real phone behaves.
   */
  const peerOf = (call) => (String(call.caller) === userId ? String(call.callee) : String(call.caller));

  // -------------------------------------------------------------------------
  // Call setup
  // -------------------------------------------------------------------------

  socket.on('call:initiate', guard(async ({ calleeId }) => {
    if (!calleeId) throw Object.assign(new Error('calleeId is required'), { code: 'BAD_REQUEST', expected: true });

    const { call, blocked, wakeByPush } = await callService.initiate({ callerId: userId, calleeId });

    if (blocked) {
      // Callee already talking, or offline with no way to reach them.
      return { callId: call.callId, status: blocked, blocked };
    }

    const iceServers = iceService.getIceServers(userId);

    // Arm the no-answer timeout FIRST. `initiate` has already reserved both
    // users as busy, and this timer is the only thing that releases them if
    // nobody acts. Anything below that threw before the timer existed would
    // strand both users as permanently busy for the process lifetime.
    callService.armRingTimeout(call.callId, async () => {
      try {
        const timedOut = await callService.end({ callId: call.callId, userId: null, reason: 'timeout' });
        if (timedOut.status === CALL_STATUS.MISSED) {
          toUser(String(timedOut.caller), 'call:ended', {
            callId: call.callId, reason: 'no-answer', status: timedOut.status, duration: 0,
          });
          toUser(String(timedOut.callee), 'call:missed', { callId: call.callId, from: socket.user });
          toUser(String(timedOut.callee), 'call:ended', {
            callId: call.callId, reason: 'no-answer', status: timedOut.status, duration: 0,
          });

          // Stop the phone ringing, then leave a missed-call notice behind.
          await callNotifier.sendCallCancelled(String(timedOut.callee), { callId: call.callId, reason: 'no-answer' });
          await callNotifier.sendMissedCall(String(timedOut.callee), { callId: call.callId, from: socket.user });
        }
      } catch (err) {
        logger.error('Ring timeout failed', err);
      }
    });

    try {
      // Live sockets (app open) get the in-page ringing screen immediately.
      toUser(calleeId, 'call:incoming', {
        callId: call.callId,
        from: socket.user,
        startedAt: call.startedAt,
        iceServers: iceService.getIceServers(calleeId),
      });

      // Every registered device also gets a push, so a phone with the screen
      // off, the browser closed, or the tab backgrounded still rings. Devices
      // already showing the in-app screen collapse this onto the same
      // notification tag, so the user never sees it twice.
      callNotifier.sendIncomingCall(calleeId, {
        callId: call.callId,
        from: socket.user,
        actionToken: signCallActionToken({ userId: calleeId, callId: call.callId }, 120),
        expiresAt: Date.now() + env.call.ringTimeoutMs,
      }).then((result) => {
        // Reaching the callee on either transport counts; a user with only the
        // Android app installed has no web-push subscription at all, and warning
        // about that would be noise.
        if (wakeByPush && result.web.sent + result.native.sent === 0) {
          logger.warn(`Call ${call.callId}: callee offline and no push reached them.`);
        }
      }).catch((err) => logger.error('Failed to send incoming-call push', err));
    } catch (err) {
      // Nobody can be ringing, so settle the call now rather than making both
      // users wait out the full ring timeout while marked busy.
      logger.error('Failed to ring callee; ending call', err);
      await callService.end({ callId: call.callId, userId, reason: 'failed' }).catch(() => {});
      throw err;
    }

    return { callId: call.callId, status: CALL_STATUS.RINGING, iceServers };
  }));

  socket.on('call:accept', guard(async ({ callId }) => {
    const call = await callService.accept({ callId, userId });

    toUser(String(call.caller), 'call:accepted', { callId, answeredAt: call.answeredAt });
    // Silence this user's other devices — both the in-app screen and any
    // notification still ringing on another phone.
    socket.to(`user:${userId}`).emit('call:handled-elsewhere', { callId });
    callNotifier.sendCallCancelled(userId, { callId, reason: 'answered' })
      .catch((err) => logger.error('Failed to clear call notification', err));

    return { callId, answeredAt: call.answeredAt, iceServers: iceService.getIceServers(userId) };
  }));

  socket.on('call:reject', guard(async ({ callId, reason }) => {
    const call = await callService.reject({ callId, userId, reason });

    toUser(String(call.caller), 'call:rejected', { callId, reason: call.endReason });
    socket.to(`user:${userId}`).emit('call:handled-elsewhere', { callId });
    callNotifier.sendCallCancelled(userId, { callId, reason: 'declined' })
      .catch((err) => logger.error('Failed to clear call notification', err));

    return { callId, status: call.status };
  }));

  socket.on('call:end', guard(async ({ callId, reason }) => {
    const call = await callService.end({ callId, userId, reason: reason || 'hangup' });

    const payload = {
      callId,
      status: call.status,
      duration: call.duration,
      reason: call.endReason,
      endedBy: userId,
    };

    toUser(peerOf(call), 'call:ended', payload);
    // Echo to the initiator's other tabs so every device leaves the call screen.
    socket.to(`user:${userId}`).emit('call:ended', payload);

    // Caller hung up mid-ring: stop the callee's phone ringing immediately.
    callNotifier.sendCallCancelled(String(call.callee), { callId, reason: call.endReason })
      .catch((err) => logger.error('Failed to clear call notification', err));

    if (call.status === CALL_STATUS.MISSED || call.status === CALL_STATUS.CANCELLED) {
      toUser(String(call.callee), 'call:missed', { callId, from: socket.user });
      callNotifier.sendMissedCall(String(call.callee), { callId, from: socket.user })
        .catch((err) => logger.error('Failed to send missed-call push', err));
    }

    return payload;
  }));

  // -------------------------------------------------------------------------
  // WebRTC signalling — the server never inspects SDP, it only relays it
  // between the two authenticated participants of an active call.
  // -------------------------------------------------------------------------

  const relay = (event, outgoing) => guard(async (payload) => {
    const { callId } = payload;
    if (!callId) throw Object.assign(new Error('callId is required'), { code: 'BAD_REQUEST', expected: true });

    const call = await Call.findOne({ callId });
    if (!call) throw Object.assign(new Error('Call not found'), { code: 'NOT_FOUND', expected: true });

    const participants = [String(call.caller), String(call.callee)];
    if (!participants.includes(userId)) {
      throw Object.assign(new Error('You are not part of this call'), { code: 'FORBIDDEN', expected: true });
    }
    if (callService.isTerminal(call.status)) {
      throw Object.assign(new Error('Call has ended'), { code: 'CALL_ENDED', expected: true });
    }

    toUser(peerOf(call), outgoing, { ...payload, from: userId });
    return {};
  });

  socket.on('webrtc:offer', relay('webrtc:offer', 'webrtc:offer'));
  socket.on('webrtc:answer', relay('webrtc:answer', 'webrtc:answer'));
  socket.on('webrtc:ice-candidate', relay('webrtc:ice-candidate', 'webrtc:ice-candidate'));
  // Sent when a side detects a dead ICE transport and restarts negotiation.
  socket.on('webrtc:restart', relay('webrtc:restart', 'webrtc:restart'));
  // Sent by a callee that answered without ever receiving an offer — e.g. it
  // reloaded while ringing, so the original offer died with the old document.
  socket.on('webrtc:renegotiate', relay('webrtc:renegotiate', 'webrtc:renegotiate'));

  // -------------------------------------------------------------------------
  // In-call side channels
  // -------------------------------------------------------------------------

  socket.on('call:media-state', guard(async ({ callId, muted, speaker }) => {
    const call = await Call.findOne({ callId });
    if (!call) return {};
    if (![String(call.caller), String(call.callee)].includes(userId)) return {};

    toUser(peerOf(call), 'call:peer-media-state', { callId, muted: Boolean(muted), speaker: Boolean(speaker) });
    return {};
  }));

  socket.on('call:quality', guard(async ({ callId, sample }) => {
    if (!callId || !sample) return {};

    // Without this check any authenticated user knowing a callId could write
    // diagnostics onto someone else's call — recordQuality attributes a
    // non-participant to the "callee" slot — and push a fabricated quality
    // warning to that call's caller.
    const call = await Call.findOne({ callId });
    if (!call) return {};
    if (![String(call.caller), String(call.callee)].includes(userId)) return {};

    const updated = await callService.recordQuality({ callId, userId, sample });
    if (updated) {
      toUser(peerOf(updated), 'call:peer-quality', { callId, rating: sample.rating });
    }
    return {};
  }));

  // -------------------------------------------------------------------------
  // Presence subscriptions
  // -------------------------------------------------------------------------

  socket.on('presence:subscribe', guard(async ({ userIds }) => {
    const ids = (Array.isArray(userIds) ? userIds : []).slice(0, 500).map(String);
    await Promise.all(ids.map((id) => socket.join(`presence:${id}`)));
    return { presence: presence.snapshot(ids) };
  }));

  socket.on('presence:unsubscribe', guard(async ({ userIds }) => {
    const ids = (Array.isArray(userIds) ? userIds : []).slice(0, 500).map(String);
    await Promise.all(ids.map((id) => socket.leave(`presence:${id}`)));
    return {};
  }));

  /**
   * Called by the client right after a reconnect: if a call survived the
   * network blip we hand back its current state so the UI can resume instead
   * of stranding the user on a dead call screen.
   */
  socket.on('call:resync', guard(async () => {
    const call = await callService.findActiveCallFor(userId);
    if (!call) return { call: null };
    return { call: call.toClient(userId), iceServers: iceService.getIceServers(userId) };
  }));
};
