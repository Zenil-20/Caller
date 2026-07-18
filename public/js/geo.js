/* ==========================================================================
   Battery-conscious location reporting.

   The naive version — watchPosition with enableHighAccuracy and an upload per
   callback — is what drains a phone. Three things keep this cheap:

     1. GPS is only powered up while actually moving. Standing still falls back
        to the wifi/cell estimate, which costs roughly a tenth as much.
     2. Updates are gated on distance AND time, so a stationary phone sends
        nothing at all rather than the same coordinate every few seconds.
     3. Reports go over the Socket.IO connection that is already open for
        calls — no extra handshake, no polling.

   Location only runs while the page is visible; browsers suspend geolocation
   in the background, and this stops cleanly rather than pretending otherwise.
   ========================================================================== */
'use strict';

window.Geo = (function geo() {
  let watchId = null;
  let running = false;
  let lastSent = null;      // { lat, lng, at }
  let lastFix = null;
  let highAccuracy = false;
  let idleSince = Date.now();
  let onUpdate = null;
  let onError = null;

  // Send if the user moved this far, regardless of how recently we sent.
  const MOVE_THRESHOLD_M = 25;
  // ...or if this long has passed, so a stationary phone still checks in.
  const HEARTBEAT_MS = 5 * 60 * 1000;
  // Never send more often than this, however fast they are moving.
  const MIN_INTERVAL_MS = 12 * 1000;
  // Drop to the cheap network fix after this long without meaningful movement.
  const IDLE_BEFORE_LOW_POWER_MS = 90 * 1000;
  // Ignore wildly imprecise fixes; they move the map without telling us anything.
  const MAX_ACCEPTABLE_ACCURACY_M = 200;

  const supported = () => 'geolocation' in navigator;

  /** Great-circle distance in metres. */
  function distanceMetres(a, b) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function shouldSend(fix) {
    if (!lastSent) return true;

    const since = Date.now() - lastSent.at;
    if (since < MIN_INTERVAL_MS) return false;
    if (since >= HEARTBEAT_MS) return true;

    return distanceMetres(lastSent, fix) >= MOVE_THRESHOLD_M;
  }

  /**
   * Restarts the watcher in the other power mode. There is no way to change
   * accuracy on a live watch, so it has to be torn down and re-established.
   */
  function setAccuracyMode(wantHigh) {
    if (wantHigh === highAccuracy || !running) return;
    highAccuracy = wantHigh;
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    beginWatch();
  }

  function handlePosition(position) {
    const { latitude, longitude, accuracy, speed, heading } = position.coords;

    // A fix this vague is usually a coarse IP estimate; reporting it would
    // teleport the marker across town.
    if (accuracy != null && accuracy > MAX_ACCEPTABLE_ACCURACY_M) return;

    const fix = {
      lat: latitude,
      lng: longitude,
      accuracy: accuracy ?? null,
      speed: Number.isFinite(speed) ? speed : null,
      heading: Number.isFinite(heading) ? heading : null,
      // Below ~1 m/s the speed reading is mostly noise, so treat it as still.
      source: highAccuracy ? 'gps' : 'network',
      at: position.timestamp || Date.now(),
    };

    const moving = (fix.speed != null && fix.speed > 1)
      || (lastFix && distanceMetres(lastFix, fix) >= MOVE_THRESHOLD_M);

    if (moving) {
      idleSince = Date.now();
      setAccuracyMode(true);
    } else if (Date.now() - idleSince > IDLE_BEFORE_LOW_POWER_MS) {
      // Standing still: power the GPS down and coast on the cheap estimate.
      setAccuracyMode(false);
    }

    lastFix = fix;
    if (!shouldSend(fix)) return;

    lastSent = { lat: fix.lat, lng: fix.lng, at: Date.now() };
    report(fix);
  }

  function report(fix) {
    const payload = {
      latitude: fix.lat,
      longitude: fix.lng,
      accuracy: fix.accuracy,
      speed: fix.speed,
      heading: fix.heading,
      source: fix.source,
      recordedAt: new Date(fix.at).toISOString(),
    };

    // Prefer the open socket; fall back to REST if signalling is down so a
    // position is not simply lost.
    if (window.Signal.isConnected()) {
      window.Signal.emit('location:update', payload);
    } else {
      window.API.postLocation(payload).catch(() => {});
    }

    if (onUpdate) onUpdate(fix);
  }

  function handleError(err) {
    const messages = {
      1: 'Location permission was denied.',
      2: 'Your position is currently unavailable.',
      3: 'Timed out while getting your position.',
    };
    if (onError) onError(messages[err.code] || 'Could not determine your location.', err.code);

    // A denial is permanent until the user changes it; stop burning cycles.
    if (err.code === 1) stop();
  }

  function beginWatch() {
    watchId = navigator.geolocation.watchPosition(handlePosition, handleError, {
      enableHighAccuracy: highAccuracy,
      // Accept a recent cached fix rather than waking the radio for a new one.
      maximumAge: highAccuracy ? 5000 : 60000,
      timeout: highAccuracy ? 20000 : 45000,
    });
  }

  function start(handlers = {}) {
    if (!supported()) {
      if (handlers.onError) handlers.onError('This browser cannot determine your location.');
      return false;
    }
    if (running) return true;

    onUpdate = handlers.onUpdate || null;
    onError = handlers.onError || null;

    running = true;
    highAccuracy = true;      // Start precise, then back off once settled.
    idleSince = Date.now();
    lastSent = null;
    beginWatch();

    document.addEventListener('visibilitychange', onVisibilityChange);
    return true;
  }

  function stop() {
    running = false;
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
    document.removeEventListener('visibilitychange', onVisibilityChange);
    lastSent = null;
    lastFix = null;
  }

  /**
   * Browsers throttle or suspend geolocation for hidden pages anyway. Stopping
   * explicitly makes the behaviour predictable and avoids a burst of stale
   * readings when the user comes back.
   */
  function onVisibilityChange() {
    if (!running) return;
    if (document.visibilityState === 'hidden') {
      if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
      }
    } else if (watchId === null) {
      highAccuracy = true;
      idleSince = Date.now();
      beginWatch();
    }
  }

  /** One-off reading, for "share my position once" without starting a watch. */
  function once() {
    return new Promise((resolve, reject) => {
      if (!supported()) { reject(new Error('Geolocation is not supported.')); return; }
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({
          lat: p.coords.latitude,
          lng: p.coords.longitude,
          accuracy: p.coords.accuracy,
          at: p.timestamp,
        }),
        (err) => reject(new Error(err.code === 1 ? 'Location permission was denied.' : 'Could not get your position.')),
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
      );
    });
  }

  const isRunning = () => running;
  const getLastFix = () => lastFix;

  return { supported, start, stop, once, isRunning, getLastFix, distanceMetres };
}());
