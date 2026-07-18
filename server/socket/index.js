'use strict';

const { Server } = require('socket.io');
const socketAuth = require('./auth');
const registerCallHandlers = require('./callHandlers');
const registerLocationHandlers = require('./locationHandlers');
const presence = require('../services/presenceService');
const callService = require('../services/callService');
const pushService = require('../services/pushService');
const env = require('../config/env');
const logger = require('../utils/logger');

/**
 * How long a user may be fully disconnected before an in-progress call is torn
 * down. Mobile browsers routinely drop the websocket when switching networks
 * (wifi -> LTE); WebRTC media often survives that, so ending the call the
 * instant the socket closes would be far too aggressive.
 */
const RECONNECT_GRACE_MS = 20000;

const graceTimers = new Map(); // userId -> Timeout

function cancelGrace(userId) {
  const timer = graceTimers.get(String(userId));
  if (timer) {
    clearTimeout(timer);
    graceTimers.delete(String(userId));
  }
}

function createSocketServer(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: env.clientOrigins.includes('*') ? true : env.clientOrigins,
      credentials: true,
    },
    // Slightly aggressive heartbeat so a dead peer is noticed quickly, which
    // matters more for calling than for a chat app.
    pingInterval: 20000,
    pingTimeout: 20000,
    maxHttpBufferSize: 1e6,
  });

  presence.bind(io);
  io.use(socketAuth);

  io.on('connection', async (socket) => {
    const { userId } = socket;
    logger.debug(`Socket connected: ${socket.id} (user ${socket.user.username})`);

    // Personal room: every device of this user. All targeted emits use it.
    socket.join(`user:${userId}`);
    // Own presence room, so a user sees their own status echoed across devices.
    socket.join(`presence:${userId}`);

    // Register every handler BEFORE anything is emitted or awaited. Clients
    // act the instant they see `ready` — if a listener is not attached yet,
    // Socket.IO drops that first event and its ack never fires, leaving the
    // caller hanging. Handler registration is synchronous, so doing it first
    // closes that window entirely.
    registerCallHandlers(io, socket);
    registerLocationHandlers(io, socket);

    socket.on('disconnect', async (reason) => {
      logger.debug(`Socket disconnected: ${socket.id} (${reason})`);
      const wentOffline = await presence.removeSocket(userId, socket.id);
      if (!wentOffline) return; // Another tab is still connected.

      const callId = presence.getActiveCallId(userId);
      if (!callId) return;

      const timer = setTimeout(async () => {
        // Only clear the map if this timer is still the registered one; a
        // newer disconnect may have replaced it.
        if (graceTimers.get(String(userId)) === timer) graceTimers.delete(String(userId));

        // Reconnected in the meantime — leave the call alone.
        if (presence.isOnline(userId)) return;

        try {
          const call = await callService.end({ callId, userId, reason: 'peer-disconnected' });
          const callerId = String(call.caller);
          const calleeId = String(call.callee);
          const peerId = callerId === String(userId) ? calleeId : callerId;

          io.to(`user:${peerId}`).emit('call:ended', {
            callId,
            status: call.status,
            duration: call.duration,
            reason: 'peer-disconnected',
          });

          // The callee may still have a ringing notification on a locked
          // phone. Every other termination path clears it; this one must too,
          // or the device rings on with no way to dismiss it.
          await pushService.sendCallCancelled(calleeId, { callId, reason: 'peer-disconnected' })
            .catch((err) => logger.error('Failed to clear call notification', err));

          const { MISSED, CANCELLED } = callService.CALL_STATUS;
          if (call.status === MISSED || call.status === CANCELLED) {
            io.to(`user:${calleeId}`).emit('call:missed', { callId });
            await pushService.sendMissedCall(calleeId, { callId })
              .catch((err) => logger.error('Failed to send missed-call push', err));
          }
        } catch (err) {
          logger.error('Failed to tear down call after disconnect', err);
        }
      }, RECONNECT_GRACE_MS);

      if (typeof timer.unref === 'function') timer.unref();
      // Replace any timer left over from an earlier disconnect, so a stale one
      // cannot fire early and tear down a call that is currently fine.
      cancelGrace(userId);
      graceTimers.set(String(userId), timer);
    });

    socket.on('error', (err) => logger.error('Socket error', err));

    // Handlers are live from here on, so it is safe to announce readiness.
    cancelGrace(userId);
    await presence.addSocket(userId, socket.id);

    socket.emit('ready', {
      user: socket.user,
      serverTime: Date.now(),
      ringTimeoutMs: env.call.ringTimeoutMs,
    });

    // If a call was live when this user dropped, resume it rather than
    // silently leaving both sides on a stale screen.
    try {
      const active = await callService.findActiveCallFor(userId);
      if (active) {
        socket.emit('call:resumed', { call: active.toClient(userId) });
      }
    } catch (err) {
      logger.error('Failed to resume active call', err);
    }
  });

  return io;
}

module.exports = { createSocketServer };
