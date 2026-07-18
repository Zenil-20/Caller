/* ==========================================================================
   Socket.IO client wrapper: authenticated connect, auto-reconnect with token
   refresh, and promise-style emits.
   ========================================================================== */
'use strict';

window.Signal = (function signal() {
  let socket = null;
  const listeners = new Map(); // event -> Set<handler>

  function on(event, handler) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(handler);

    // Late subscription after connect still needs wiring up.
    if (socket) socket.on(event, handler);

    return () => {
      listeners.get(event)?.delete(handler);
      if (socket) socket.off(event, handler);
    };
  }

  function attachAll() {
    listeners.forEach((handlers, event) => {
      handlers.forEach((handler) => socket.on(event, handler));
    });
  }

  function connect(token) {
    disconnect();

    let currentToken = token;
    // The token we were handed is fresh; only later attempts need refreshing.
    let isFirstAttempt = true;

    socket = window.io({
      /**
       * A callback form is used deliberately: socket.io awaits it before every
       * connection attempt, whereas the `reconnect_attempt` event fires in the
       * same tick as the handshake and cannot gate it. Refreshing there raced
       * the transport and usually lost, so the first reconnect after the access
       * token expired went out stale and was rejected — costing a whole backoff
       * interval of signalling downtime at exactly the moment a call needs it.
       */
      auth: async (cb) => {
        if (isFirstAttempt) {
          isFirstAttempt = false;
          cb({ token: currentToken });
          return;
        }

        try {
          if (window.API.hasSession()) {
            await window.API.refreshAccessToken();
            currentToken = window.API.getAccessToken();
          }
        } catch {
          // Fall through with whatever token we have; the server decides.
        }
        cb({ token: currentToken });
      },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      // Backoff with jitter so a server restart does not get a thundering herd.
      reconnectionDelay: 800,
      reconnectionDelayMax: 8000,
      randomizationFactor: 0.5,
      timeout: 12000,
    });

    // Token refresh happens in the `auth` callback above, which socket.io
    // actually awaits before each handshake.

    attachAll();
    return socket;
  }

  function disconnect() {
    if (socket) {
      socket.removeAllListeners();
      socket.disconnect();
      socket = null;
    }

    // Drop the subscription registry too. Callers re-register their handlers
    // after each connect(), and the handlers are fresh closures every time, so
    // keeping the old ones would accumulate a second (then third) copy on every
    // sign-out/sign-in cycle and process every incoming event that many times.
    // Socket.IO's own reconnects reuse this socket and never come through here,
    // so live subscriptions survive a dropped network as intended.
    listeners.clear();
  }

  /** Emits and resolves with the server's ack, rejecting on `{ ok: false }`. */
  function request(event, payload = {}, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      if (!socket || !socket.connected) {
        reject(new Error('Not connected to the server'));
        return;
      }

      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('The server did not respond in time'));
      }, timeoutMs);

      socket.emit(event, payload, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        if (!response) { resolve({}); return; }
        if (response.ok === false) {
          const err = new Error(response.error?.message || 'Request failed');
          err.code = response.error?.code;
          reject(err);
          return;
        }
        resolve(response);
      });
    });
  }

  /** Fire-and-forget; used for high-frequency signalling like ICE candidates. */
  function emit(event, payload) {
    if (socket?.connected) socket.emit(event, payload);
  }

  const isConnected = () => Boolean(socket && socket.connected);
  const raw = () => socket;

  return { connect, disconnect, on, request, emit, isConnected, raw };
}());
