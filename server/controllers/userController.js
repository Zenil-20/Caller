'use strict';

const userService = require('../services/userService');
const presence = require('../services/presenceService');
const asyncHandler = require('../utils/asyncHandler');

const search = asyncHandler(async (req, res) => {
  const users = await userService.search(req.query.q, req.userId, { limit: req.query.limit });
  res.json({ users });
});

const getOne = asyncHandler(async (req, res) => {
  res.json({ user: await userService.getById(req.params.userId) });
});

const listContacts = asyncHandler(async (req, res) => {
  res.json({ contacts: await userService.listContacts(req.userId) });
});

const addContact = asyncHandler(async (req, res) => {
  const contact = await userService.addContact(req.userId, req.body.userId);
  res.status(201).json({ contact });
});

const removeContact = asyncHandler(async (req, res) => {
  await userService.removeContact(req.userId, req.params.userId);
  res.status(204).end();
});

const updateProfile = asyncHandler(async (req, res) => {
  const user = await userService.updateProfile(req.userId, req.body);
  res.json({ user: { ...user.toPublic(), settings: user.settings } });
});

/** Bulk presence lookup so the client can paint a whole list in one round trip. */
const presenceLookup = asyncHandler(async (req, res) => {
  const ids = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean);
  res.json({ presence: presence.snapshot(ids.slice(0, 200)) });
});

module.exports = { search, getOne, listContacts, addContact, removeContact, updateProfile, presenceLookup };
