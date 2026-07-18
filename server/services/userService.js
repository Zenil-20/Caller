'use strict';

const User = require('../models/User');
const presence = require('./presenceService');
const { notFound, badRequest } = require('../utils/errors');

/** Escapes user input before it is embedded in a RegExp. */
function escapeRegex(input) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decorate(user) {
  const pub = user.toPublic();
  // The in-memory registry is more current than the mirrored DB column.
  pub.isOnline = presence.isOnline(pub.id);
  pub.isBusy = presence.isBusy(pub.id);
  return pub;
}

async function search(query, viewerId, { limit = 20 } = {}) {
  const term = (query || '').trim();
  if (term.length < 2) {
    throw badRequest('Search query must be at least 2 characters');
  }

  const safe = escapeRegex(term.toLowerCase());
  const users = await User.find({
    _id: { $ne: viewerId },
    $or: [
      { username: { $regex: `^${safe}`, $options: 'i' } },
      { displayName: { $regex: safe, $options: 'i' } },
      { phone: { $regex: `${escapeRegex(term)}$` } },
    ],
  })
    .limit(Math.min(Number(limit) || 20, 50))
    .sort({ isOnline: -1, username: 1 });

  return users.map(decorate);
}

async function getById(userId) {
  const user = await User.findById(userId);
  if (!user) throw notFound('User not found');
  return decorate(user);
}

async function listContacts(viewerId) {
  const viewer = await User.findById(viewerId).populate('contacts');
  if (!viewer) throw notFound('User not found');

  return viewer.contacts
    .map(decorate)
    .sort((a, b) => {
      if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
      return a.displayName.localeCompare(b.displayName);
    });
}

async function addContact(viewerId, contactId) {
  if (String(viewerId) === String(contactId)) {
    throw badRequest('You cannot add yourself as a contact');
  }

  const contact = await User.findById(contactId);
  if (!contact) throw notFound('User not found');

  // $addToSet keeps the operation idempotent — adding twice is a no-op.
  await User.updateOne({ _id: viewerId }, { $addToSet: { contacts: contact._id } });
  return decorate(contact);
}

async function removeContact(viewerId, contactId) {
  await User.updateOne({ _id: viewerId }, { $pull: { contacts: contactId } });
}

async function updateProfile(viewerId, patch) {
  const allowed = {};
  if (patch.displayName !== undefined) allowed.displayName = String(patch.displayName).trim();
  if (patch.about !== undefined) allowed.about = String(patch.about).trim();
  // Marks first-run setup as done; only ever set forward, never cleared.
  if (patch.setupCompleted === true) allowed.setupCompletedAt = new Date();
  if (patch.settings !== undefined) {
    for (const key of ['ringtoneEnabled', 'vibrationEnabled', 'echoCancellation', 'noiseSuppression', 'autoGainControl']) {
      if (patch.settings[key] !== undefined) {
        allowed[`settings.${key}`] = Boolean(patch.settings[key]);
      }
    }
  }

  if (Object.keys(allowed).length === 0) {
    throw badRequest('No updatable fields supplied');
  }

  const user = await User.findByIdAndUpdate(viewerId, { $set: allowed }, { new: true, runValidators: true });
  if (!user) throw notFound('User not found');
  return user;
}

module.exports = { search, getById, listContacts, addContact, removeContact, updateProfile, decorate };
