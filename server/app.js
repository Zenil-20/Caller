'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const routes = require('./routes');
const env = require('./config/env');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

function createApp() {
  const app = express();

  // Behind nginx/Heroku/Render, trust the proxy so req.ip and the rate limiter
  // see the real client address rather than the load balancer's.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        // OpenStreetMap tile servers. Leaflet itself is vendored locally, so
        // no third-party script is ever loaded — only map imagery.
        imgSrc: ["'self'", 'data:', 'blob:', 'https://*.tile.openstreetmap.org'],
        mediaSrc: ["'self'", 'blob:', 'data:'],
        // Socket.IO needs both the polling fallback and the websocket upgrade.
        connectSrc: ["'self'", 'ws:', 'wss:'],
        // The service worker is what rings a closed browser; without this it
        // is blocked from registering.
        workerSrc: ["'self'"],
        manifestSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    // getUserMedia is blocked unless the page is same-origin isolated-safe;
    // the default COEP header breaks nothing here but is unnecessary.
    crossOriginEmbedderPolicy: false,
  }));

  app.use(cors({
    origin: env.clientOrigins.includes('*') ? true : env.clientOrigins,
    credentials: true,
  }));

  app.use(compression());
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));

  app.use('/api', routes);

  /**
   * Digital Asset Links: proves this domain and the Android app belong to the
   * same owner. Chrome refuses to run a Trusted Web Activity full-screen without
   * it and falls back to showing a URL bar, which gives the game away that the
   * "app" is a web page.
   *
   * Generated rather than served as a static file so the fingerprints come from
   * the environment — a debug build and a release build sign differently, and
   * committing either one to the repo invites shipping the wrong one.
   *
   * Registered ahead of the SPA catch-all, which would otherwise answer this
   * with index.html and leave verification failing for a reason nothing logs.
   */
  app.get('/.well-known/assetlinks.json', (_req, res) => {
    const { packageName, certFingerprints } = env.android;

    if (!packageName || !certFingerprints.length) {
      res.status(404).json({ error: 'Android app link is not configured' });
      return;
    }

    res.json([{
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: packageName,
        sha256_cert_fingerprints: certFingerprints,
      },
    }]);
  });

  app.use(express.static(path.join(__dirname, '..', 'public'), {
    maxAge: env.isProduction ? '1h' : 0,
    etag: true,
  }));

  // Single-page app: any non-API path falls through to index.html.
  app.get(/^\/(?!api).*/, (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
