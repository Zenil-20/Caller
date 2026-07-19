'use strict';

const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

/**
 * Reads an environment variable, falling back to `fallback`.
 * Throws when the variable is required and missing so the process fails fast
 * at boot instead of at the first request.
 */
function read(name, { fallback, required = false } = {}) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    if (required) {
      throw new Error(`Missing required environment variable: ${name}`);
    }
    return fallback;
  }
  return value;
}

function list(name, fallback = '') {
  return read(name, { fallback })
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

const nodeEnv = read('NODE_ENV', { fallback: 'development' });
const isProduction = nodeEnv === 'production';

// In production we refuse to boot on the placeholder secrets shipped in
// .env.example — a predictable signing key means anyone can mint tokens.
const accessSecret = read('JWT_ACCESS_SECRET', { required: isProduction, fallback: 'dev_access_secret' });
const refreshSecret = read('JWT_REFRESH_SECRET', { required: isProduction, fallback: 'dev_refresh_secret' });

if (isProduction) {
  for (const [name, value] of Object.entries({ JWT_ACCESS_SECRET: accessSecret, JWT_REFRESH_SECRET: refreshSecret })) {
    if (value.startsWith('change_me') || value.startsWith('dev_')) {
      throw new Error(`${name} still holds a placeholder value; set a real secret before running in production.`);
    }
  }
}

module.exports = {
  nodeEnv,
  isProduction,
  port: Number(read('PORT', { fallback: '4000' })),
  clientOrigins: list('CLIENT_ORIGIN', 'http://localhost:4000'),

  mongoUri: read('MONGODB_URI', { fallback: 'mongodb://127.0.0.1:27017/gians_voip' }),

  jwt: {
    accessSecret,
    refreshSecret,
    accessTtl: read('JWT_ACCESS_TTL', { fallback: '15m' }),
    refreshTtl: read('JWT_REFRESH_TTL', { fallback: '30d' }),
  },

  ice: {
    stunUrls: list('STUN_URLS', 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302'),
    turnUrls: list('TURN_URLS'),
    turnUsername: read('TURN_USERNAME', { fallback: '' }),
    turnCredential: read('TURN_CREDENTIAL', { fallback: '' }),
    turnStaticSecret: read('TURN_STATIC_SECRET', { fallback: '' }),
    turnCredentialTtl: Number(read('TURN_CREDENTIAL_TTL', { fallback: '86400' })),
  },

  push: {
    publicKey: read('VAPID_PUBLIC_KEY', { fallback: '' }),
    privateKey: read('VAPID_PRIVATE_KEY', { fallback: '' }),
    subject: read('VAPID_SUBJECT', { fallback: 'mailto:admin@example.com' }),
  },

  /**
   * Firebase service-account credentials, used to reach the native Android app.
   * Optional: without them the app still runs and browsers still ring, they just
   * do not get the full-screen call screen.
   */
  fcm: {
    projectId: read('FCM_PROJECT_ID', { fallback: '' }),
    clientEmail: read('FCM_CLIENT_EMAIL', { fallback: '' }),
    // A PEM key cannot survive a single-line .env intact, so it is stored with
    // escaped newlines and restored here. Without this the RS256 signature fails
    // with an opaque error that looks nothing like "your key is malformed".
    privateKey: read('FCM_PRIVATE_KEY', { fallback: '' }).replace(/\\n/g, '\n'),
  },

  /**
   * SHA-256 fingerprints of the Android signing certificate, published at
   * /.well-known/assetlinks.json so Chrome trusts the app to open this domain
   * without a URL bar. Comma-separated — a release and a debug build have
   * different fingerprints and both are usually wanted during development.
   */
  android: {
    packageName: read('ANDROID_PACKAGE_NAME', { fallback: '' }),
    certFingerprints: list('ANDROID_CERT_FINGERPRINTS'),
  },

  call: {
    ringTimeoutMs: Number(read('RING_TIMEOUT_MS', { fallback: '45000' })),
  },
};
