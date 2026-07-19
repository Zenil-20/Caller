'use strict';

const http = require('http');
const { createApp } = require('./app');
const { createSocketServer } = require('./socket');
const db = require('./config/db');
const env = require('./config/env');
const presence = require('./services/presenceService');
const pushService = require('./services/pushService');
const fcmService = require('./services/fcmService');
const logger = require('./utils/logger');

async function main() {
  await db.connect();

  // A previous process may have died mid-call, leaving users flagged online.
  await presence.resetPersistedPresence();

  // Web Push lets an incoming call ring a device whose browser is closed.
  pushService.init();

  // FCM reaches the native Android app, which — unlike a service worker — can
  // raise a full-screen ringing call screen over the lock screen.
  fcmService.init();

  const app = createApp();
  const server = http.createServer(app);
  const io = createSocketServer(server);

  // The push controller needs to emit on behalf of a locked device that
  // declined a call from its notification.
  app.set('io', io);

  server.listen(env.port, () => {
    logger.info(`gians VoIP server listening on http://localhost:${env.port} [${env.nodeEnv}]`);
    if (!env.ice.turnUrls.length) {
      logger.warn('No TURN server configured — calls will fail between peers behind symmetric NAT.');
    }
  });

  const shutdown = async (signal) => {
    logger.info(`${signal} received, shutting down gracefully`);
    // Stop accepting new work, then let in-flight sockets close.
    io.close();
    server.close(async () => {
      await db.disconnect().catch(() => {});
      process.exit(0);
    });
    // Hard limit: never hang forever waiting on a stuck connection.
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (err) => logger.error('Unhandled rejection', err));
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', err);
    process.exit(1);
  });
}

main().catch((err) => {
  logger.error('Fatal startup error', err);
  process.exit(1);
});
