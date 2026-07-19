'use strict';

const mongoose = require('mongoose');

/**
 * One row per install of the native Android app.
 *
 * Distinct from PushSubscription, which covers browsers. A browser gets a Web
 * Push endpoint and can only ever raise a notification; an Android install gets
 * an FCM token and can raise a full-screen ringing call screen. The same user
 * commonly has both — phone app plus desktop browser — and both should ring, so
 * these are stored side by side rather than one replacing the other.
 */
const deviceTokenSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    // FCM's registration token is unique per app install, so it is the natural
    // key: a reinstall or token rotation updates in place rather than leaving a
    // dead row behind that we would keep sending doomed pushes to.
    token: { type: String, required: true, unique: true },

    platform: { type: String, default: 'android' },
    appVersion: { type: String },

    lastUsedAt: { type: Date, default: Date.now },
    failureCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

module.exports = mongoose.model('DeviceToken', deviceTokenSchema);
