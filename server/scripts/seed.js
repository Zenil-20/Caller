'use strict';

/**
 * Creates a handful of demo accounts so you can test calling without
 * registering twice by hand. Safe to re-run — existing users are skipped.
 *
 *   npm run seed
 */

const db = require('../config/db');
const User = require('../models/User');
const logger = require('../utils/logger');

const DEMO_PASSWORD = 'password123';

const DEMO_USERS = [
  { username: 'alice', displayName: 'Alice Kapoor', phone: '+919812345001', about: 'Testing the line' },
  { username: 'bob', displayName: 'Bob Mehta', phone: '+919812345002', about: 'Available' },
  { username: 'charlie', displayName: 'Charlie Rao', phone: '+919812345003', about: 'On the move' },
  { username: 'diana', displayName: 'Diana Shah', phone: '+919812345004', about: 'Busy' },
];

async function main() {
  await db.connect();

  const created = [];

  for (const spec of DEMO_USERS) {
    const existing = await User.findOne({ username: spec.username });
    if (existing) {
      logger.info(`Skipping ${spec.username} (already exists)`);
      created.push(existing);
      continue;
    }

    const user = new User(spec);
    await user.setPassword(DEMO_PASSWORD);
    await user.save();
    created.push(user);
    logger.info(`Created ${spec.username}`);
  }

  // Wire everyone into everyone else's contact list for convenience.
  for (const user of created) {
    const others = created.filter((u) => String(u._id) !== String(user._id)).map((u) => u._id);
    await User.updateOne({ _id: user._id }, { $addToSet: { contacts: { $each: others } } });
  }

  logger.info('---');
  logger.info(`Seed complete. Sign in with any username above / password: ${DEMO_PASSWORD}`);
  logger.info('Open two different browsers (or one normal + one private window) to place a call.');

  await db.disconnect();
  process.exit(0);
}

main().catch((err) => {
  logger.error('Seed failed', err);
  process.exit(1);
});
