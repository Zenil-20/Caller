'use strict';

const locationService = require('../services/locationService');
const logger = require('../utils/logger');

/**
 * Live location over the existing signalling socket.
 *
 * Reusing the already-open connection is the whole point: no extra TCP
 * handshake, no polling timer, no second auth path. A position update costs
 * one small frame on a connection that is open anyway, which is what keeps
 * this cheap enough to run on a phone.
 *
 * Rooms mirror the presence pattern: `loc:<userId>` is joined by everyone
 * watching that user, so a broadcast is a single emit regardless of audience.
 */
module.exports = function registerLocationHandlers(io, socket) {
  const userId = socket.userId;

  const guard = (handler) => async (payload, ack) => {
    try {
      const result = await handler(payload || {});
      if (typeof ack === 'function') ack({ ok: true, ...(result || {}) });
    } catch (err) {
      if (!err.expected) logger.error('Location handler error', err);
      if (typeof ack === 'function') {
        ack({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message || 'Unexpected error' } });
      }
    }
  };

  socket.on('location:update', guard(async (fix) => {
    // Throws if the user has sharing switched off, so a client that missed the
    // consent change cannot keep reporting.
    const stored = await locationService.update(userId, fix);

    io.to(`loc:${userId}`).emit('location:changed', {
      ...stored,
      userId,
    });

    return { recordedAt: stored.recordedAt };
  }));

  /**
   * Subscribes to a set of users. Only those who actually permit this viewer
   * are joined — the room membership itself enforces consent, so a later
   * broadcast cannot leak to someone who was never authorised.
   */
  socket.on('location:subscribe', guard(async ({ userIds }) => {
    const requested = (Array.isArray(userIds) ? userIds : []).slice(0, 100).map(String);
    const allowed = await locationService.filterViewable(requested, userId);

    await Promise.all(allowed.map((id) => socket.join(`loc:${id}`)));

    return {
      subscribed: allowed,
      denied: requested.filter((id) => !allowed.includes(id)),
    };
  }));

  socket.on('location:unsubscribe', guard(async ({ userIds }) => {
    const ids = (Array.isArray(userIds) ? userIds : []).slice(0, 100).map(String);
    await Promise.all(ids.map((id) => socket.leave(`loc:${id}`)));
    return {};
  }));

  /** Current positions of everyone sharing with this user. */
  socket.on('location:snapshot', guard(async () => ({
    locations: await locationService.visibleTo(userId),
  })));
};
