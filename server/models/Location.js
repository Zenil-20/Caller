'use strict';

const mongoose = require('mongoose');

/**
 * Exactly one document per user, overwritten in place on every update.
 *
 * Storing only the current position (rather than a trail) keeps this
 * collection the same size as the user list forever — a handful of documents
 * for a family, with no growth over time and nothing to prune.
 */
const locationSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },

    // GeoJSON [longitude, latitude] — note the order, it is the opposite of
    // how the browser reports it and of how people say it out loud.
    coords: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: {
        type: [Number],
        required: true,
        validate: {
          validator: (v) => Array.isArray(v) && v.length === 2
            && v[0] >= -180 && v[0] <= 180
            && v[1] >= -90 && v[1] <= 90,
          message: 'coordinates must be [longitude, latitude] within valid ranges',
        },
      },
    },

    /** Radius of uncertainty in metres, as reported by the device. */
    accuracy: { type: Number, min: 0 },

    /** Metres per second; null when the device cannot determine it. */
    speed: { type: Number, min: 0, default: null },

    /** Degrees clockwise from true north; null when unknown. */
    heading: { type: Number, min: 0, max: 360, default: null },

    /** Whether the fix came from GPS or the cheaper wifi/cell estimate. */
    source: { type: String, enum: ['gps', 'network', 'unknown'], default: 'unknown' },

    /** When the device took the reading (not when the server stored it). */
    recordedAt: { type: Date, required: true },
  },
  { timestamps: true },
);

locationSchema.index({ coords: '2dsphere' });

locationSchema.methods.toClient = function toClient() {
  const [longitude, latitude] = this.coords.coordinates;
  return {
    userId: this.user._id ? this.user._id.toHexString() : String(this.user),
    latitude,
    longitude,
    accuracy: this.accuracy ?? null,
    speed: this.speed,
    heading: this.heading,
    source: this.source,
    recordedAt: this.recordedAt,
  };
};

module.exports = mongoose.model('Location', locationSchema);
