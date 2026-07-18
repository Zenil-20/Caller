'use strict';

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const BCRYPT_ROUNDS = 12;

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: [true, 'Username is required'],
      unique: true,
      trim: true,
      lowercase: true,
      minlength: [3, 'Username must be at least 3 characters'],
      maxlength: [30, 'Username must be at most 30 characters'],
      match: [/^[a-z0-9_.]+$/, 'Username may only contain letters, numbers, underscore and dot'],
    },

    // Stored in E.164 (+919812345678). Optional: a user may register with a
    // username alone, so `sparse` keeps the unique index from colliding on null.
    phone: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
      match: [/^\+[1-9]\d{7,14}$/, 'Phone must be in E.164 format, e.g. +919812345678'],
      default: undefined,
    },

    displayName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 60,
    },

    passwordHash: {
      type: String,
      required: true,
      select: false,
    },

    avatarColor: {
      type: String,
      default: () => {
        const palette = ['#5B8DEF', '#4CAF7D', '#E5744A', '#9B6BDF', '#3EA8B5', '#D4636F'];
        return palette[Math.floor(Math.random() * palette.length)];
      },
    },

    about: { type: String, maxlength: 140, default: 'Available' },

    // Presence is authoritative in memory (see services/presenceService) but
    // mirrored here so it survives a server restart and can be queried in bulk.
    isOnline: { type: Boolean, default: false, index: true },
    lastSeen: { type: Date, default: Date.now },

    contacts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

    /** Set once the user has been through first-run setup. */
    setupCompletedAt: { type: Date, default: null },

    /**
     * Location sharing is opt-in and off by default. Nothing is ever stored
     * or revealed until the user turns this on themselves.
     *
     *   scope 'contacts' — everyone in my contact list may see me
     *   scope 'selected' — only the people in `sharedWith` may see me
     */
    locationSharing: {
      enabled: { type: Boolean, default: false },
      scope: { type: String, enum: ['contacts', 'selected'], default: 'contacts' },
      sharedWith: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
      updatedAt: { type: Date },
    },

    settings: {
      ringtoneEnabled: { type: Boolean, default: true },
      vibrationEnabled: { type: Boolean, default: true },
      echoCancellation: { type: Boolean, default: true },
      noiseSuppression: { type: Boolean, default: true },
      autoGainControl: { type: Boolean, default: true },
    },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(_doc, ret) {
        delete ret.passwordHash;
        delete ret.__v;
        delete ret._id;
        return ret;
      },
    },
  },
);

// Backs the /users/search endpoint. Prefix-anchored regex queries use this too.
userSchema.index({ username: 'text', displayName: 'text' });

userSchema.virtual('id').get(function id() {
  return this._id.toHexString();
});

userSchema.methods.setPassword = async function setPassword(plain) {
  this.passwordHash = await bcrypt.hash(plain, BCRYPT_ROUNDS);
};

userSchema.methods.verifyPassword = function verifyPassword(plain) {
  if (!this.passwordHash) return Promise.resolve(false);
  return bcrypt.compare(plain, this.passwordHash);
};

/** Shape sent to other users — never includes contacts or settings. */
userSchema.methods.toPublic = function toPublic() {
  return {
    id: this._id.toHexString(),
    username: this.username,
    displayName: this.displayName,
    phone: this.phone || null,
    avatarColor: this.avatarColor,
    about: this.about,
    isOnline: this.isOnline,
    lastSeen: this.lastSeen,
    // Lets the client decide whether to run first-run setup on any sign-in,
    // not just immediately after registering.
    setupCompletedAt: this.setupCompletedAt || null,
  };
};

module.exports = mongoose.model('User', userSchema);
