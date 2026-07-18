'use strict';

const User = require('../models/User');
const logger = require('../utils/logger');

/**
 * In-memory presence registry.
 *
 * A user is "online" while at least one socket is connected — tracking a set
 * of socket ids rather than a boolean means opening a second tab does not make
 * the first tab's disconnect mark the user offline.
 *
 * `busy` is tracked separately: it is set the moment a call starts ringing so
 * a second caller gets a busy signal instead of a second incoming-call screen.
 *
 * Scaling note: this is per-process state. To run more than one instance,
 * attach @socket.io/redis-adapter and move these two maps into Redis.
 */
const sockets = new Map(); // userId -> Set<socketId>
const activeCall = new Map(); // userId -> callId

let io = null;

function bind(ioInstance) {
  io = ioInstance;
}

function isOnline(userId) {
  const set = sockets.get(String(userId));
  return Boolean(set && set.size > 0);
}

function isBusy(userId) {
  return activeCall.has(String(userId));
}

function getActiveCallId(userId) {
  return activeCall.get(String(userId)) || null;
}

function setBusy(userId, callId) {
  activeCall.set(String(userId), callId);
}

function clearBusy(userId, callId) {
  const id = String(userId);
  // Only clear if the call being torn down is the one we recorded, otherwise a
  // late "end" from a stale call would unlock a user who is on a newer one.
  if (!callId || activeCall.get(id) === callId) {
    activeCall.delete(id);
  }
}

function socketIdsFor(userId) {
  return Array.from(sockets.get(String(userId)) || []);
}

/** @returns {boolean} true when this connection brought the user online. */
async function addSocket(userId, socketId) {
  const id = String(userId);
  let set = sockets.get(id);
  const wasOffline = !set || set.size === 0;

  if (!set) {
    set = new Set();
    sockets.set(id, set);
  }
  set.add(socketId);

  if (wasOffline) {
    await User.updateOne({ _id: id }, { isOnline: true, lastSeen: new Date() }).catch((err) =>
      logger.error('Failed to persist online state', err));
    broadcastPresence(id, true);
  }
  return wasOffline;
}

/** @returns {boolean} true when the user's last connection just dropped. */
async function removeSocket(userId, socketId) {
  const id = String(userId);
  const set = sockets.get(id);
  if (!set) return false;

  set.delete(socketId);
  if (set.size > 0) return false;

  sockets.delete(id);
  const lastSeen = new Date();
  await User.updateOne({ _id: id }, { isOnline: false, lastSeen }).catch((err) =>
    logger.error('Failed to persist offline state', err));
  broadcastPresence(id, false, lastSeen);
  return true;
}

function broadcastPresence(userId, online, lastSeen = new Date()) {
  if (!io) return;
  // `presence:<userId>` is joined by anyone watching this user (contacts,
  // search results, an open call screen).
  io.to(`presence:${userId}`).emit('presence:update', {
    userId: String(userId),
    isOnline: online,
    lastSeen,
  });
}

function snapshot(userIds) {
  return userIds.map((userId) => ({
    userId: String(userId),
    isOnline: isOnline(userId),
    isBusy: isBusy(userId),
  }));
}

/**
 * Clears every in-memory flag. Called at boot so a crash mid-call does not
 * leave users permanently marked online in Mongo.
 */
async function resetPersistedPresence() {
  sockets.clear();
  activeCall.clear();
  const result = await User.updateMany({ isOnline: true }, { isOnline: false });
  if (result.modifiedCount) {
    logger.info(`Reset stale online flag for ${result.modifiedCount} user(s)`);
  }
}

module.exports = {
  bind,
  isOnline,
  isBusy,
  getActiveCallId,
  setBusy,
  clearBusy,
  addSocket,
  removeSocket,
  socketIdsFor,
  broadcastPresence,
  snapshot,
  resetPersistedPresence,
};
