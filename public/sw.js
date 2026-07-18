/* ==========================================================================
   Service worker — the only part of the app that runs while the browser is
   closed and the phone is locked. Its job is to turn a push message into a
   ringing, actionable incoming-call notification.
   ========================================================================== */
/* eslint-env serviceworker */
'use strict';

const CALL_TAG = 'gians-incoming-call';

/**
 * A closed app can only be reached through showNotification, and a notification
 * alerts once. Re-posting it under the same tag with `renotify` makes Android
 * sound and vibrate again, so repeating that on an interval is the only way to
 * approximate a ring that keeps going until it is answered.
 *
 * 3s is deliberate: Android rate-limits notifications that update faster than
 * about once a second by dropping the alert, which would leave the ring silent.
 */
const RING_REPEAT_MS = 3000;

/**
 * Chrome only keeps a service worker alive for a bounded time per push, even
 * with waitUntil pending, and killing it mid-loop is worse than stopping
 * cleanly. The server rings for 45s (RING_TIMEOUT_MS); we cover the first 30 of
 * it and leave the notification on screen for the rest.
 */
const RING_MAX_MS = 30000;

/**
 * Calls whose ring has been called off — answered on another device, or the
 * caller hung up. Module scope is the right lifetime here: it lives exactly as
 * long as the worker running the ring loop that reads it, and a worker restart
 * ends that loop anyway.
 */
const cancelledCalls = new Set();

/**
 * Entries can never be removed on completion — a cancel may arrive after the
 * ring loop has already finished, and must still be remembered — so the set is
 * capped instead. Insertion order makes the oldest entry the first one out, and
 * anything that old belongs to a call that ended long ago.
 */
function markCancelled(callId) {
  if (!callId) return;
  cancelledCalls.add(callId);
  while (cancelledCalls.size > 50) {
    cancelledCalls.delete(cancelledCalls.values().next().value);
  }
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
// Bump this to force a fresh install and purge the previous cache.
const CACHE = 'gians-shell-v3';

// The minimum needed to render the call screen when the app is opened from a
// notification while the network is slow or briefly unavailable.
const SHELL = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/js/api.js',
  '/js/store.js',
  '/js/audio.js',
  '/js/webrtc.js',
  '/js/socket.js',
  '/js/ui.js',
  '/js/app.js',
];

self.addEventListener('install', (event) => {
  // Take over as soon as possible so the first visit is already protected.
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/**
 * Network-first for everything we handle, with the cache as an offline
 * fallback only.
 *
 * Cache-first would be faster, but it is wrong here: this worker only
 * re-installs when sw.js itself changes, so a cache-first rule would pin every
 * existing user to the JS that was current when they first visited. Shipping a
 * fix to app.js without also editing sw.js would never reach them. A calling
 * client that is a version behind the server can mishandle signalling, so
 * always-correct beats always-instant.
 *
 * API and socket.io traffic is never touched — caching call state would be
 * actively harmful.
 */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;

  event.respondWith((async () => {
    try {
      const response = await fetch(request);

      // Refresh the offline copy whenever the network gives us a good one.
      if (response && response.ok) {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
      }
      return response;
    } catch {
      // Offline: serve the cached asset, or the app shell for a navigation.
      const cached = await caches.match(request);
      if (cached) return cached;

      if (request.mode === 'navigate') {
        const shell = await caches.match('/index.html');
        if (shell) return shell;
      }

      // Nothing cached — fail explicitly rather than rejecting respondWith.
      return new Response('Offline and no cached copy available', {
        status: 503,
        statusText: 'Offline',
        headers: { 'Content-Type': 'text/plain' },
      });
    }
  })());
});

/* ------------------------------------------------------------------------
   Push — the wake-up path
   ------------------------------------------------------------------------ */

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }

  if (payload.type === 'incoming-call') {
    event.waitUntil(showIncomingCall(payload));
  } else if (payload.type === 'call-cancelled') {
    event.waitUntil(clearCallNotification(payload));
  } else if (payload.type === 'missed-call') {
    event.waitUntil(showMissedCall(payload));
  }
});

async function showIncomingCall({ callId, from, actionToken, expiresAt }) {
  // The call may already have been answered on another device by the time the
  // push lands — a stale ring is worse than a missed one.
  if (expiresAt && Date.now() > expiresAt) return;

  const name = from?.displayName || from?.username || 'Unknown caller';

  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

  // Tell every open client, not only the visible one. A backgrounded page — app
  // switched away, or the screen locked with it still loaded — is the only
  // thing that can play the actual ringtone, because a service worker has no
  // audio API of any kind. Its socket may also have been throttled into missing
  // `call:incoming` entirely, so this doubles as a nudge to reconnect.
  clients.forEach((c) => c.postMessage({
    type: 'push-incoming-call', callId, from, expiresAt,
  }));

  // A visible client is already showing the call screen and ringing; a
  // notification stacked on top of it would just be noise.
  if (clients.some((c) => c.visibilityState === 'visible')) return;

  cancelledCalls.delete(callId);

  const ring = () => self.registration.showNotification(`${name} is calling`, {
    body: from?.username ? `@${from.username} · gians voice call` : 'gians voice call',
    tag: CALL_TAG,              // collapses duplicates across devices/retries
    renotify: true,             // re-alert on every repost rather than update silently
    requireInteraction: true,   // stays on screen until acted on
    silent: false,
    // Long buzz pattern, closer to a ringtone than a message alert.
    vibrate: [500, 250, 500, 250, 500, 250, 500],
    timestamp: Date.now(),
    data: { callId, actionToken, from, type: 'incoming-call' },
    actions: [
      { action: 'accept', title: '✅ Answer' },
      { action: 'reject', title: '❌ Decline' },
    ],
  });

  await ring();

  // Keep re-alerting until the call dies, the worker's budget runs out, or the
  // user gets there first.
  const expiry = expiresAt || (Date.now() + RING_MAX_MS);
  const ringUntil = Math.min(Date.now() + RING_MAX_MS, expiry);

  while (Date.now() + RING_REPEAT_MS < ringUntil) {
    await sleep(RING_REPEAT_MS);

    // Answered elsewhere or cancelled by the caller — a cancel push landed and
    // set this while we were sleeping.
    if (cancelledCalls.has(callId)) return;

    // The user opened the app: the in-app call screen owns the ring from here,
    // and a notification re-alerting over it would fight with the ringtone.
    const live = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (live.some((c) => c.visibilityState === 'visible')) return;

    await ring();
  }

  // Only tidy up if the call itself is actually over. Stopping because we hit
  // the worker budget is not the same thing — the call may still have seconds
  // left, and dismissing a live call's notification would strip the user's only
  // way to answer it.
  if (Date.now() >= expiry) await clearCallNotification({ callId });
}

async function clearCallNotification({ callId }) {
  // Break any ring loop still re-alerting for this call. Without this the loop
  // would keep re-posting the notification it is being asked to dismiss, and
  // win, because it reposts faster than a single close can take effect.
  if (callId) cancelledCalls.add(callId);

  const notifications = await self.registration.getNotifications({ tag: CALL_TAG });
  notifications
    .filter((n) => !callId || n.data?.callId === callId)
    .forEach((n) => n.close());

  // A backgrounded page may be ringing off the back of the earlier push, with a
  // socket too throttled to have heard the cancellation. Dismissing only the
  // notification would leave it ringing for a call the caller already gave up
  // on. The client ignores this unless that push-driven ring is what is playing.
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clients.forEach((c) => c.postMessage({ type: 'push-call-cancelled', callId }));
}

async function showMissedCall({ callId, from }) {
  // A missed-call notice alongside a still-ringing one is contradictory, and on
  // a timeout the server sends this without a preceding cancel.
  await clearCallNotification({ callId });

  const name = from?.displayName || from?.username || 'Someone';
  await self.registration.showNotification(`Missed call from ${name}`, {
    body: 'Tap to call back',
    tag: `gians-missed-${callId}`,
    vibrate: [200, 100, 200],
    data: { callId, from, type: 'missed-call' },
  });
}

/* ------------------------------------------------------------------------
   Notification interaction
   ------------------------------------------------------------------------ */

self.addEventListener('notificationclick', (event) => {
  const { notification, action } = event;
  const data = notification.data || {};
  notification.close();

  // The ring loop is very likely still running and would repost this
  // notification within seconds — re-alerting over a call the user has just
  // answered, or one they have explicitly declined. Closing alone does not stop
  // it; the loop has to be told.
  if (data.callId) cancelledCalls.add(data.callId);

  if (action === 'reject' && data.actionToken) {
    // Decline without ever opening the app — the token in the payload is
    // scoped to exactly this one call.
    event.waitUntil(
      fetch('/api/push/call-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionToken: data.actionToken, action: 'reject' }),
      }).catch(() => {}),
    );
    return;
  }

  // Answer, or a plain tap: bring the app forward and hand it the call id.
  event.waitUntil(openApp(data, action));
});

async function openApp(data, action) {
  const target = data.callId
    ? `/?callId=${encodeURIComponent(data.callId)}&action=${action === 'accept' ? 'accept' : 'open'}`
    : '/';

  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

  // Reuse an existing window rather than stacking up new tabs.
  for (const client of clients) {
    if ('focus' in client) {
      await client.focus();
      client.postMessage({
        type: 'notification-action',
        action: action === 'accept' ? 'accept' : 'open',
        callId: data.callId,
        from: data.from,
      });
      return;
    }
  }

  if (self.clients.openWindow) {
    await self.clients.openWindow(target);
  }
}

self.addEventListener('notificationclose', () => {
  // Dismissing the notification is not a decline — the call keeps ringing in
  // the app and will resolve as missed on timeout, like a real phone.
});
