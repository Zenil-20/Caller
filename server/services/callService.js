'use strict';

const crypto = require('crypto');
const Call = require('../models/Call');
const User = require('../models/User');
const presence = require('./presenceService');
const pushService = require('./pushService');
const env = require('../config/env');
const logger = require('../utils/logger');
const { notFound, badRequest, forbidden } = require('../utils/errors');

const { CALL_STATUS, TERMINAL_STATUSES } = Call;

/**
 * Ring timers, keyed by callId. A call that is never answered must resolve to
 * "missed" on its own — neither client can be trusted to still be connected
 * when the timeout elapses.
 */
const ringTimers = new Map();

function clearRingTimer(callId) {
  const timer = ringTimers.get(callId);
  if (timer) {
    clearTimeout(timer);
    ringTimers.delete(callId);
  }
}

function isTerminal(status) {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Whether the callee can be reached at all, or null if they can.
 *
 * Deliberately does NOT consider "busy": `initiate` claims both parties
 * synchronously before awaiting anything, so by the time this runs the callee
 * is already flagged busy by this very call and a busy check here would refuse
 * every call outright. Busy is decided before the claim.
 *
 * A callee with no open socket is NOT automatically unavailable: if they have
 * a push subscription we can wake the device and ring it, exactly like a real
 * phone call to a phone with the screen off. Only a user who is both offline
 * and unreachable by push is genuinely unavailable.
 */
async function checkReachability(calleeId) {
  if (presence.isOnline(calleeId)) return null;

  const reachableByPush = pushService.isConfigured() && (await pushService.countFor(calleeId)) > 0;
  return reachableByPush ? null : CALL_STATUS.UNAVAILABLE;
}

async function initiate({ callerId, calleeId }) {
  if (String(callerId) === String(calleeId)) {
    throw badRequest('You cannot call yourself');
  }

  const callId = crypto.randomUUID();

  // Claim both parties BEFORE the first await. Node is single-threaded, so a
  // claim taken in one synchronous run cannot interleave with another
  // initiate; checking availability first and reserving after a DB round-trip
  // would let two simultaneous calls both pass the busy check, ring the callee
  // twice, and leave the presence map pointing at the wrong call.
  if (presence.isBusy(callerId)) {
    throw badRequest('You are already on a call');
  }
  if (presence.isBusy(calleeId)) {
    const call = await recordBlockedAttempt({ callId, callerId, calleeId, blocked: CALL_STATUS.BUSY });
    return { call, blocked: CALL_STATUS.BUSY };
  }

  presence.setBusy(callerId, callId);
  presence.setBusy(calleeId, callId);

  // From here on every exit path must release the claim, or both users are
  // permanently stuck as "busy" for the lifetime of the process.
  try {
    const callee = await User.findById(calleeId);
    if (!callee) throw notFound('User not found');

    const blocked = await checkReachability(calleeId);
    if (blocked) {
      presence.clearBusy(callerId, callId);
      presence.clearBusy(calleeId, callId);
      const call = await recordBlockedAttempt({ callId, callerId, calleeId, blocked });
      return { call, blocked };
    }

    // Ringing a device that has no live socket yet — the push wake-up is the
    // only thing that will surface this call.
    const wakeByPush = !presence.isOnline(calleeId);

    const call = await Call.create({
      callId,
      caller: callerId,
      callee: calleeId,
      status: CALL_STATUS.RINGING,
      startedAt: new Date(),
    });

    return { call, blocked: null, wakeByPush, callee };
  } catch (err) {
    presence.clearBusy(callerId, callId);
    presence.clearBusy(calleeId, callId);
    throw err;
  }
}

/** Logs an attempt that never rang, for call history. Nobody is left busy. */
function recordBlockedAttempt({ callId, callerId, calleeId, blocked }) {
  const now = new Date();
  return Call.create({
    callId,
    caller: callerId,
    callee: calleeId,
    status: blocked,
    startedAt: now,
    endedAt: now,
    endReason: blocked,
  });
}

/**
 * Arms the no-answer timeout. `onTimeout` is supplied by the socket layer so
 * this service stays free of transport concerns.
 */
function armRingTimeout(callId, onTimeout) {
  clearRingTimer(callId);
  const timer = setTimeout(() => {
    ringTimers.delete(callId);
    Promise.resolve(onTimeout()).catch((err) => logger.error('Ring timeout handler failed', err));
  }, env.call.ringTimeoutMs);

  // Do not hold the event loop open purely for a ringing call.
  if (typeof timer.unref === 'function') timer.unref();
  ringTimers.set(callId, timer);
}

/**
 * Explains why a conditional transition matched nothing, so the caller gets a
 * meaningful error instead of a bare "not found".
 */
async function explainFailedTransition(callId, userId, verb) {
  const call = await Call.findOne({ callId });
  if (!call) throw notFound('Call not found');
  if (String(call.callee) !== String(userId)) throw forbidden(`Only the callee can ${verb} this call`);
  throw badRequest(`Call is no longer ringing (status: ${call.status})`);
}

/**
 * Answering, declining and the no-answer timeout all race each other: two of
 * the callee's devices, plus a server timer, can act within milliseconds. Each
 * transition is therefore a single conditional update predicated on the call
 * still being `ringing`, so exactly one of them can win. A read-then-write
 * would let a decline land on an already-answered call and tear down live
 * audio.
 */
async function accept({ callId, userId }) {
  const call = await Call.findOneAndUpdate(
    { callId, callee: userId, status: CALL_STATUS.RINGING },
    { $set: { status: CALL_STATUS.ACTIVE, answeredAt: new Date() } },
    { new: true },
  );

  if (!call) await explainFailedTransition(callId, userId, 'accept');

  clearRingTimer(callId);
  return call;
}

async function reject({ callId, userId, reason = 'declined' }) {
  const call = await Call.findOneAndUpdate(
    { callId, callee: userId, status: CALL_STATUS.RINGING },
    {
      $set: {
        status: CALL_STATUS.REJECTED,
        endedAt: new Date(),
        endedBy: userId,
        endReason: reason,
      },
    },
    { new: true },
  );

  if (!call) {
    // Losing this race is normal — the call was answered on another device, or
    // the caller hung up first. Report the settled call rather than erroring.
    const existing = await Call.findOne({ callId });
    if (!existing) throw notFound('Call not found');
    if (String(existing.callee) !== String(userId)) throw forbidden('Only the callee can reject this call');
    return existing;
  }

  clearRingTimer(callId);
  releaseParticipants(call);
  return call;
}

/**
 * Terminates a call from any state.
 *
 * The resulting status depends on when it happened: hanging up while the phone
 * is still ringing is a "cancelled" call for the caller and a "missed" call for
 * the callee, whereas hanging up after answer is a normal "ended" call.
 */
async function end({ callId, userId, reason = 'hangup' }) {
  const call = await Call.findOne({ callId });
  if (!call) throw notFound('Call not found');

  const isParticipant = [String(call.caller), String(call.callee)].includes(String(userId));
  if (userId && !isParticipant) throw forbidden('You are not part of this call');

  if (isTerminal(call.status)) return call;

  // The no-answer timer must never close a call that was answered in the
  // meantime — that would strand an active call with nobody marked busy.
  if (reason === 'timeout' && call.status !== CALL_STATUS.RINGING) {
    return call;
  }

  const now = new Date();
  const update = { endedAt: now, endReason: reason };
  if (userId) update.endedBy = userId;

  if (call.status === CALL_STATUS.ACTIVE && call.answeredAt) {
    update.status = CALL_STATUS.ENDED;
    update.duration = Math.max(0, Math.round((now - call.answeredAt) / 1000));
  } else if (reason === 'timeout') {
    update.status = CALL_STATUS.MISSED;
  } else {
    // Unanswered hang-up: cancelled by the caller, missed by the callee.
    update.status = String(userId) === String(call.caller) ? CALL_STATUS.CANCELLED : CALL_STATUS.MISSED;
  }

  // Compare-and-swap on the status we based the decision on. If it changed
  // underneath us, another path (accept, reject, a second hang-up) already
  // settled this call and owns the teardown.
  const updated = await Call.findOneAndUpdate(
    { callId, status: call.status },
    { $set: update },
    { new: true },
  );

  if (!updated) {
    return Call.findOne({ callId });
  }

  clearRingTimer(callId);
  releaseParticipants(updated);
  return updated;
}

function releaseParticipants(call) {
  presence.clearBusy(call.caller, call.callId);
  presence.clearBusy(call.callee, call.callId);
}

async function recordQuality({ callId, userId, sample }) {
  const call = await Call.findOne({ callId });
  if (!call) return null;

  const side = String(call.caller) === String(userId) ? 'caller' : 'callee';
  call.quality = call.quality || {};
  call.quality[side] = {
    rating: sample.rating || 'unknown',
    rttMs: sample.rttMs,
    jitterMs: sample.jitterMs,
    packetLossPct: sample.packetLossPct,
  };
  if (sample.connectionType) call.connectionType = sample.connectionType;

  await call.save();
  return call;
}

/** Any non-terminal call this user is part of — used to resync after reconnect. */
async function findActiveCallFor(userId) {
  return Call.findOne({
    $or: [{ caller: userId }, { callee: userId }],
    status: { $in: [CALL_STATUS.RINGING, CALL_STATUS.ACTIVE] },
  })
    .populate('caller callee', 'username displayName avatarColor isOnline')
    .sort({ createdAt: -1 });
}

async function history(userId, { limit = 50, cursor, missedOnly = false } = {}) {
  const query = {
    $or: [{ caller: userId }, { callee: userId }],
  };

  if (missedOnly) {
    query.callee = userId;
    query.status = { $in: [CALL_STATUS.MISSED, CALL_STATUS.CANCELLED] };
    delete query.$or;
  }

  if (cursor) {
    const at = new Date(cursor);
    if (!Number.isNaN(at.getTime())) query.createdAt = { $lt: at };
  }

  const capped = Math.min(Number(limit) || 50, 100);
  const calls = await Call.find(query)
    .populate('caller callee', 'username displayName avatarColor isOnline')
    .sort({ createdAt: -1 })
    .limit(capped + 1);

  const hasMore = calls.length > capped;
  const page = hasMore ? calls.slice(0, capped) : calls;

  return {
    items: page.map((call) => call.toClient(userId)),
    nextCursor: hasMore ? page[page.length - 1].createdAt.toISOString() : null,
  };
}

/**
 * Recent-calls feed: the newest call per distinct peer, WhatsApp-style.
 */
async function recents(userId, { limit = 30 } = {}) {
  const { Types } = require('mongoose');
  const me = new Types.ObjectId(String(userId));

  const rows = await Call.aggregate([
    { $match: { $or: [{ caller: me }, { callee: me }] } },
    { $sort: { createdAt: -1 } },
    {
      $addFields: {
        peerId: { $cond: [{ $eq: ['$caller', me] }, '$callee', '$caller'] },
      },
    },
    {
      $group: {
        _id: '$peerId',
        latest: { $first: '$$ROOT' },
        totalCalls: { $sum: 1 },
        missedCount: {
          $sum: {
            $cond: [
              { $and: [{ $eq: ['$callee', me] }, { $in: ['$status', [CALL_STATUS.MISSED, CALL_STATUS.CANCELLED]] }] },
              1,
              0,
            ],
          },
        },
      },
    },
    { $sort: { 'latest.createdAt': -1 } },
    { $limit: Math.min(Number(limit) || 30, 100) },
    {
      $lookup: {
        from: 'users',
        localField: '_id',
        foreignField: '_id',
        as: 'peer',
      },
    },
    { $unwind: '$peer' },
  ]);

  return rows.map((row) => {
    const call = Call.hydrate(row.latest);
    call.caller = row.latest.caller;
    call.callee = row.latest.callee;
    const client = call.toClient(userId);

    return {
      ...client,
      peer: {
        id: row.peer._id.toHexString(),
        username: row.peer.username,
        displayName: row.peer.displayName,
        avatarColor: row.peer.avatarColor,
        isOnline: presence.isOnline(row.peer._id),
        isBusy: presence.isBusy(row.peer._id),
      },
      totalCalls: row.totalCalls,
      missedCount: row.missedCount,
    };
  });
}

async function stats(userId) {
  const { Types } = require('mongoose');
  const me = new Types.ObjectId(String(userId));

  const [row] = await Call.aggregate([
    { $match: { $or: [{ caller: me }, { callee: me }] } },
    {
      $group: {
        _id: null,
        totalCalls: { $sum: 1 },
        answeredCalls: { $sum: { $cond: [{ $eq: ['$status', CALL_STATUS.ENDED] }, 1, 0] } },
        totalSeconds: { $sum: '$duration' },
        missedCalls: {
          $sum: {
            $cond: [
              { $and: [{ $eq: ['$callee', me] }, { $in: ['$status', [CALL_STATUS.MISSED, CALL_STATUS.CANCELLED]] }] },
              1,
              0,
            ],
          },
        },
      },
    },
  ]);

  return row
    ? {
      totalCalls: row.totalCalls,
      answeredCalls: row.answeredCalls,
      missedCalls: row.missedCalls,
      totalSeconds: row.totalSeconds,
      averageSeconds: row.answeredCalls ? Math.round(row.totalSeconds / row.answeredCalls) : 0,
    }
    : { totalCalls: 0, answeredCalls: 0, missedCalls: 0, totalSeconds: 0, averageSeconds: 0 };
}

async function getByIdForUser(callId, userId) {
  const call = await Call.findOne({ callId }).populate('caller callee', 'username displayName avatarColor isOnline');
  if (!call) throw notFound('Call not found');

  const participants = [call.caller._id, call.callee._id].map(String);
  if (!participants.includes(String(userId))) throw forbidden('You are not part of this call');

  return call.toClient(userId);
}

module.exports = {
  initiate,
  accept,
  reject,
  end,
  armRingTimeout,
  clearRingTimer,
  recordQuality,
  findActiveCallFor,
  history,
  recents,
  stats,
  getByIdForUser,
  checkReachability,
  isTerminal,
  CALL_STATUS,
};
