'use strict';

const callService = require('../services/callService');
const iceService = require('../services/iceService');
const asyncHandler = require('../utils/asyncHandler');

const history = asyncHandler(async (req, res) => {
  const page = await callService.history(req.userId, {
    limit: req.query.limit,
    cursor: req.query.cursor,
    missedOnly: req.query.missed === 'true',
  });
  res.json(page);
});

const recents = asyncHandler(async (req, res) => {
  res.json({ recents: await callService.recents(req.userId, { limit: req.query.limit }) });
});

const stats = asyncHandler(async (req, res) => {
  res.json({ stats: await callService.stats(req.userId) });
});

const getOne = asyncHandler(async (req, res) => {
  res.json({ call: await callService.getByIdForUser(req.params.callId, req.userId) });
});

/**
 * ICE servers are fetched over authenticated REST rather than baked into the
 * page, so TURN credentials are never exposed to anonymous visitors and can be
 * rotated without a redeploy.
 */
const iceServers = asyncHandler(async (req, res) => {
  res.json({ iceServers: iceService.getIceServers(req.userId) });
});

module.exports = { history, recents, stats, getOne, iceServers };
