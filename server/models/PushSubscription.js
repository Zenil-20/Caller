'use strict';

const mongoose = require('mongoose');

/**
 * One row per browser/device that has granted notification permission.
 * A user typically has several (phone, laptop, tablet) and every one of them
 * should ring, exactly like a phone number registered on multiple devices.
 */
const pushSubscriptionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    // The push service URL is globally unique per subscription, so it doubles
    // as the natural key — re-subscribing the same browser updates in place
    // instead of piling up duplicates.
    endpoint: { type: String, required: true, unique: true },

    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true },
    },

    userAgent: { type: String },

    /** Bumped on every successful send; lets us spot dead-but-not-404 devices. */
    lastUsedAt: { type: Date, default: Date.now },
    failureCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

module.exports = mongoose.model('PushSubscription', pushSubscriptionSchema);
