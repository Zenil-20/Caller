'use strict';

const crypto = require('crypto');
const env = require('../config/env');

/**
 * Builds the ICE server list handed to RTCPeerConnection.
 *
 * TURN credentials come in two flavours:
 *  - static  : TURN_USERNAME / TURN_CREDENTIAL, fine for a private deployment.
 *  - ephemeral: coturn's `use-auth-secret` REST mode. The username is
 *    "<unix-expiry>:<userId>" and the password is base64(HMAC-SHA1(secret,
 *    username)). Credentials expire, so a leaked one is useless within a day.
 */
function getIceServers(userId = 'anonymous') {
  const servers = [];

  if (env.ice.stunUrls.length) {
    servers.push({ urls: env.ice.stunUrls });
  }

  if (!env.ice.turnUrls.length) {
    return servers;
  }

  if (env.ice.turnStaticSecret) {
    const expiry = Math.floor(Date.now() / 1000) + env.ice.turnCredentialTtl;
    const username = `${expiry}:${userId}`;
    const credential = crypto
      .createHmac('sha1', env.ice.turnStaticSecret)
      .update(username)
      .digest('base64');

    servers.push({ urls: env.ice.turnUrls, username, credential });
  } else if (env.ice.turnUsername && env.ice.turnCredential) {
    servers.push({
      urls: env.ice.turnUrls,
      username: env.ice.turnUsername,
      credential: env.ice.turnCredential,
    });
  }

  return servers;
}

module.exports = { getIceServers };
