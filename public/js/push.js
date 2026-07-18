/* ==========================================================================
   Service-worker registration and Web Push subscription.
   This is what allows a call to ring a closed browser / locked phone.
   ========================================================================== */
'use strict';

window.Push = (function push() {
  let registration = null;
  let publicKey = null;
  let enabled = false;

  const supported = () => (
    'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window
  );

  /** VAPID keys travel as base64url but the API wants a Uint8Array. */
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const output = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
    return output;
  }

  async function registerWorker(onMessage) {
    if (!('serviceWorker' in navigator)) return null;

    try {
      registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      await navigator.serviceWorker.ready;

      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data && onMessage) onMessage(event.data);
      });

      return registration;
    } catch (err) {
      console.warn('Service worker registration failed', err);
      return null;
    }
  }

  async function loadKey() {
    try {
      const res = await fetch('/api/push/vapid-public-key');
      const body = await res.json();
      publicKey = body.publicKey;
      enabled = body.enabled && Boolean(publicKey);
      return enabled;
    } catch {
      enabled = false;
      return false;
    }
  }

  const permission = () => (('Notification' in window) ? Notification.permission : 'unsupported');

  /**
   * Asks for notification permission. Must be called from a user gesture —
   * browsers reject (and some permanently block) a bare on-load prompt.
   */
  async function requestPermission() {
    if (!('Notification' in window)) return 'unsupported';
    if (Notification.permission !== 'default') return Notification.permission;
    try {
      return await Notification.requestPermission();
    } catch {
      return 'denied';
    }
  }

  /**
   * Creates (or reuses) the push subscription and registers it server-side.
   * Safe to call repeatedly — the server upserts on endpoint.
   */
  async function subscribe() {
    if (!supported()) return { ok: false, reason: 'unsupported' };
    if (!enabled && !(await loadKey())) return { ok: false, reason: 'not-configured' };
    if (!registration) return { ok: false, reason: 'no-worker' };
    if (Notification.permission !== 'granted') return { ok: false, reason: 'permission' };

    try {
      let subscription = await registration.pushManager.getSubscription();

      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          // Chrome requires this; a subscription that cannot show UI is rejected.
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });
      }

      await window.API.subscribePush(subscription.toJSON());
      return { ok: true, subscription };
    } catch (err) {
      console.warn('Push subscription failed', err);
      return { ok: false, reason: err.message };
    }
  }

  async function unsubscribe() {
    if (!registration) return;
    try {
      const subscription = await registration.pushManager.getSubscription();
      if (!subscription) return;
      await window.API.unsubscribePush(subscription.endpoint).catch(() => {});
      await subscription.unsubscribe();
    } catch (err) {
      console.warn('Push unsubscribe failed', err);
    }
  }

  async function status() {
    if (!supported()) return { supported: false, permission: 'unsupported', subscribed: false, enabled: false };

    let subscribed = false;
    if (registration) {
      subscribed = Boolean(await registration.pushManager.getSubscription().catch(() => null));
    }

    return {
      supported: true,
      permission: permission(),
      subscribed,
      enabled,
      // iOS only exposes push to a PWA launched from the home screen.
      standalone: window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true,
    };
  }

  return { supported, registerWorker, loadKey, requestPermission, subscribe, unsubscribe, status, permission };
}());
