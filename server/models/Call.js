'use strict';

const mongoose = require('mongoose');

const CALL_STATUS = Object.freeze({
  RINGING: 'ringing',
  ACTIVE: 'active',
  ENDED: 'ended',
  MISSED: 'missed',
  REJECTED: 'rejected',
  BUSY: 'busy',
  CANCELLED: 'cancelled',
  UNAVAILABLE: 'unavailable',
  FAILED: 'failed',
});

const TERMINAL_STATUSES = Object.freeze([
  CALL_STATUS.ENDED,
  CALL_STATUS.MISSED,
  CALL_STATUS.REJECTED,
  CALL_STATUS.BUSY,
  CALL_STATUS.CANCELLED,
  CALL_STATUS.UNAVAILABLE,
  CALL_STATUS.FAILED,
]);

const callSchema = new mongoose.Schema(
  {
    callId: { type: String, required: true, unique: true, index: true },

    caller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    callee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    status: {
      type: String,
      enum: Object.values(CALL_STATUS),
      default: CALL_STATUS.RINGING,
      index: true,
    },

    startedAt: { type: Date, default: Date.now },
    answeredAt: { type: Date },
    endedAt: { type: Date },

    /** Talk time in whole seconds; 0 for any call that was never answered. */
    duration: { type: Number, default: 0, min: 0 },

    endedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    endReason: { type: String },

    /** Last network-quality sample reported by each side, for diagnostics. */
    quality: {
      caller: {
        rating: { type: String, enum: ['excellent', 'good', 'fair', 'poor', 'unknown'] },
        rttMs: Number,
        jitterMs: Number,
        packetLossPct: Number,
      },
      callee: {
        rating: { type: String, enum: ['excellent', 'good', 'fair', 'poor', 'unknown'] },
        rttMs: Number,
        jitterMs: Number,
        packetLossPct: Number,
      },
    },

    /** Which ICE candidate type carried the media: host | srflx | relay. */
    connectionType: { type: String },
  },
  { timestamps: true },
);

// Serves the call-history feed: "every call involving me, newest first".
callSchema.index({ caller: 1, createdAt: -1 });
callSchema.index({ callee: 1, createdAt: -1 });

callSchema.methods.toClient = function toClient(viewerId) {
  const viewer = String(viewerId);
  const callerId = this.caller?._id ? this.caller._id.toHexString() : String(this.caller);
  const isOutgoing = callerId === viewer;
  const peerDoc = isOutgoing ? this.callee : this.caller;

  const peer = peerDoc && peerDoc.username
    ? {
      id: peerDoc._id.toHexString(),
      username: peerDoc.username,
      displayName: peerDoc.displayName,
      avatarColor: peerDoc.avatarColor,
      isOnline: peerDoc.isOnline,
    }
    : { id: String(peerDoc) };

  return {
    callId: this.callId,
    peer,
    direction: isOutgoing ? 'outgoing' : 'incoming',
    status: this.status,
    // "Missed" is a receiver-side concept: the caller sees the same row as a
    // plain unanswered outgoing call.
    missed: !isOutgoing && [CALL_STATUS.MISSED, CALL_STATUS.CANCELLED].includes(this.status),
    startedAt: this.startedAt,
    answeredAt: this.answeredAt || null,
    endedAt: this.endedAt || null,
    duration: this.duration,
    endReason: this.endReason || null,
  };
};

const Call = mongoose.model('Call', callSchema);

module.exports = Call;
module.exports.CALL_STATUS = CALL_STATUS;
module.exports.TERMINAL_STATUSES = TERMINAL_STATUSES;
