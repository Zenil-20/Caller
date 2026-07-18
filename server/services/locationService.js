'use strict';

const Location = require('../models/Location');
const User = require('../models/User');
const { badRequest, forbidden, notFound } = require('../utils/errors');

/**
 * The single authorization rule for location data.
 *
 * `target` decides who may see them — never the viewer, and never the client.
 * Every read path in this service goes through here, so there is one place to
 * audit and one place to get right.
 */
function canView(target, viewerId) {
  const sharing = target.locationSharing;
  if (!sharing || !sharing.enabled) return false;

  const viewer = String(viewerId);

  // A user can always see their own position.
  if (String(target._id) === viewer) return true;

  if (sharing.scope === 'selected') {
    return (sharing.sharedWith || []).some((id) => String(id) === viewer);
  }

  // 'contacts': the target must have the viewer in their own contact list.
  // Deliberately the target's list, not the viewer's — adding someone to your
  // contacts must not grant you sight of them.
  return (target.contacts || []).some((id) => String(id) === viewer);
}

/** Everyone who has chosen to share with this viewer, and is currently known. */
async function visibleTo(viewerId) {
  const sharers = await User.find({ 'locationSharing.enabled': true })
    .select('username displayName avatarColor contacts locationSharing isOnline');

  const allowed = sharers.filter((u) => canView(u, viewerId));
  if (!allowed.length) return [];

  const ids = allowed.map((u) => u._id);
  const fixes = await Location.find({ user: { $in: ids } });
  const byUser = new Map(fixes.map((f) => [String(f.user), f]));

  return allowed
    .map((u) => {
      const fix = byUser.get(String(u._id));
      if (!fix) return null;
      return {
        ...fix.toClient(),
        user: {
          id: u._id.toHexString(),
          username: u.username,
          displayName: u.displayName,
          avatarColor: u.avatarColor,
          isOnline: u.isOnline,
        },
      };
    })
    .filter(Boolean);
}

/** The subset of `userIds` that currently permit this viewer to see them. */
async function filterViewable(userIds, viewerId) {
  if (!userIds.length) return [];
  const targets = await User.find({ _id: { $in: userIds } })
    .select('contacts locationSharing');
  return targets.filter((t) => canView(t, viewerId)).map((t) => String(t._id));
}

function validateFix({ latitude, longitude, accuracy, speed, heading, recordedAt, source }) {
  const lat = Number(latitude);
  const lng = Number(longitude);

  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw badRequest('latitude must be between -90 and 90');
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) throw badRequest('longitude must be between -180 and 180');

  const at = recordedAt ? new Date(recordedAt) : new Date();
  if (Number.isNaN(at.getTime())) throw badRequest('recordedAt is not a valid date');

  // A clock-skewed device must not be able to plant a position in the future.
  const now = Date.now();
  const clamped = at.getTime() > now + 60_000 ? new Date(now) : at;

  return {
    lat,
    lng,
    accuracy: Number.isFinite(Number(accuracy)) ? Math.max(0, Number(accuracy)) : undefined,
    speed: Number.isFinite(Number(speed)) ? Math.max(0, Number(speed)) : null,
    heading: Number.isFinite(Number(heading)) ? ((Number(heading) % 360) + 360) % 360 : null,
    source: ['gps', 'network'].includes(source) ? source : 'unknown',
    recordedAt: clamped,
  };
}

/**
 * Records a position. Refuses unless the user has sharing switched on, so a
 * stale client cannot keep uploading after consent is withdrawn.
 */
async function update(userId, fix) {
  const user = await User.findById(userId).select('locationSharing');
  if (!user) throw notFound('User not found');
  if (!user.locationSharing?.enabled) {
    throw forbidden('Location sharing is turned off');
  }

  const v = validateFix(fix);

  const doc = await Location.findOneAndUpdate(
    { user: userId },
    {
      $set: {
        user: userId,
        coords: { type: 'Point', coordinates: [v.lng, v.lat] },
        accuracy: v.accuracy,
        speed: v.speed,
        heading: v.heading,
        source: v.source,
        recordedAt: v.recordedAt,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  return doc.toClient();
}

async function getSharing(userId) {
  const user = await User.findById(userId).select('locationSharing').populate('locationSharing.sharedWith', 'username displayName avatarColor');
  if (!user) throw notFound('User not found');

  const s = user.locationSharing || {};
  return {
    enabled: Boolean(s.enabled),
    scope: s.scope || 'contacts',
    sharedWith: (s.sharedWith || []).map((u) => (u.username
      ? { id: u._id.toHexString(), username: u.username, displayName: u.displayName, avatarColor: u.avatarColor }
      : { id: String(u) })),
    updatedAt: s.updatedAt || null,
  };
}

/**
 * Turning sharing off deletes the stored position outright. Leaving a last
 * known location behind after someone opts out would defeat the point.
 */
async function setSharing(userId, { enabled, scope, sharedWith }) {
  const update$ = { 'locationSharing.updatedAt': new Date() };

  if (enabled !== undefined) update$['locationSharing.enabled'] = Boolean(enabled);
  if (scope !== undefined) {
    if (!['contacts', 'selected'].includes(scope)) throw badRequest("scope must be 'contacts' or 'selected'");
    update$['locationSharing.scope'] = scope;
  }
  if (sharedWith !== undefined) {
    if (!Array.isArray(sharedWith)) throw badRequest('sharedWith must be an array of user ids');
    update$['locationSharing.sharedWith'] = sharedWith.slice(0, 100);
  }

  const user = await User.findByIdAndUpdate(userId, { $set: update$ }, { new: true, runValidators: true });
  if (!user) throw notFound('User not found');

  if (user.locationSharing?.enabled === false) {
    await Location.deleteOne({ user: userId });
  }

  return getSharing(userId);
}

async function clear(userId) {
  await Location.deleteOne({ user: userId });
}

module.exports = { canView, visibleTo, filterViewable, update, getSharing, setSharing, clear };
