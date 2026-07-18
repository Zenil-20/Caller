'use strict';

const locationService = require('../services/locationService');
const asyncHandler = require('../utils/asyncHandler');

/** Everyone currently sharing their position with the caller. */
const list = asyncHandler(async (req, res) => {
  res.json({ locations: await locationService.visibleTo(req.userId) });
});

const getSharing = asyncHandler(async (req, res) => {
  res.json({ sharing: await locationService.getSharing(req.userId) });
});

const setSharing = asyncHandler(async (req, res) => {
  const sharing = await locationService.setSharing(req.userId, req.body);
  res.json({ sharing });
});

/**
 * REST fallback for a one-off position report. The live path is the
 * `location:update` socket event — this exists for clients without an open
 * socket, and for testing.
 */
const update = asyncHandler(async (req, res) => {
  const fix = await locationService.update(req.userId, req.body);
  const io = req.app.get('io');
  if (io) {
    const allowed = await locationService.filterViewable([req.userId], req.userId);
    if (allowed.length) io.to(`loc:${req.userId}`).emit('location:changed', fix);
  }
  res.status(201).json({ location: fix });
});

module.exports = { list, getSharing, setSharing, update };
