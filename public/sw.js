/* ==========================================================================
   Service worker — the only part of the app that runs while the browser is
   closed and the phone is locked. Its job is to turn a push message into a
   ringing, actionable incoming-call notification.
   ========================================================================== */
/* eslint-env serviceworker */
'use strict';

const CALL_TAG = 'gians-incoming-call';
// Bump this to force a fresh install and purge the previous cache.
const CACHE = 'gians-shell-v2';

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

  // If a window is already open AND showing this call, the in-app screen is
  // handling it; a notification on top would just be noise.
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const visible = clients.some((c) => c.visibilityState === 'visible');
  if (visible) {
    clients.forEach((c) => c.postMessage({ type: 'push-incoming-call', callId, from }));
    return;
  }

  await self.registration.showNotification(`${name} is calling`, {
    body: from?.username ? `@${from.username} · gians voice call` : 'gians voice call',
    tag: CALL_TAG,              // collapses duplicates across devices/retries
    renotify: true,
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

  // Ring for as long as the server will keep the call alive, then self-clear.
  if (expiresAt) {
    const remaining = Math.max(0, expiresAt - Date.now());
    setTimeout(() => clearCallNotification({ callId }).catch(() => {}), remaining);
  }
}

async function clearCallNotification({ callId }) {
  const notifications = await self.registration.getNotifications({ tag: CALL_TAG });
  notifications
    .filter((n) => !callId || n.data?.callId === callId)
    .forEach((n) => n.close());
}

async function showMissedCall({ callId, from }) {
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
