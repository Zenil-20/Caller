/* ==========================================================================
   REST client with transparent access-token refresh.
   ========================================================================== */
'use strict';

window.API = (function api() {
  const BASE = '/api';
  const STORAGE_KEY = 'gians.session';

  let accessToken = null;
  let refreshToken = null;

  /**
   * Concurrent 401s must not each fire their own refresh — that would burn the
   * single-use refresh token and log the user out. The first caller creates the
   * promise, everyone else awaits it.
   */
  let refreshInFlight = null;

  const listeners = { unauthorized: [] };

  function loadSession() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      accessToken = parsed.accessToken || null;
      refreshToken = parsed.refreshToken || null;
      return parsed.user || null;
    } catch {
      return null;
    }
  }

  function saveSession(session) {
    accessToken = session.accessToken;
    refreshToken = session.refreshToken;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  }

  function clearSession() {
    accessToken = null;
    refreshToken = null;
    refreshInFlight = null;
    localStorage.removeItem(STORAGE_KEY);
  }

  const getAccessToken = () => accessToken;
  const hasSession = () => Boolean(accessToken && refreshToken);

  function onUnauthorized(fn) { listeners.unauthorized.push(fn); }
  function emitUnauthorized() { listeners.unauthorized.forEach((fn) => fn()); }

  async function parse(response) {
    if (response.status === 204) return null;
    const text = await response.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch { return { raw: text }; }
  }

  function toError(body, response) {
    const err = new Error(body?.error?.message || `Request failed (${response.status})`);
    err.code = body?.error?.code || 'HTTP_ERROR';
    err.status = response.status;
    err.details = body?.error?.details;
    return err;
  }

  async function doRefresh() {
    const response = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });

    if (!response.ok) throw toError(await parse(response), response);

    const session = await parse(response);
    saveSession(session);
    return session;
  }

  async function request(path, { method = 'GET', body, auth = true, retry = true } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth && accessToken) headers.Authorization = `Bearer ${accessToken}`;

    const response = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (response.status === 401 && auth && retry && refreshToken) {
      try {
        if (!refreshInFlight) {
          refreshInFlight = doRefresh().finally(() => { refreshInFlight = null; });
        }
        await refreshInFlight;
      } catch {
        clearSession();
        emitUnauthorized();
        throw toError(null, response);
      }
      // Retry once with the new token; `retry: false` prevents a loop.
      return request(path, { method, body, auth, retry: false });
    }

    const parsed = await parse(response);
    if (!response.ok) throw toError(parsed, response);
    return parsed;
  }

  return {
    loadSession,
    saveSession,
    clearSession,
    getAccessToken,
    hasSession,
    onUnauthorized,
    refreshAccessToken: () => {
      if (!refreshInFlight) {
        refreshInFlight = doRefresh().finally(() => { refreshInFlight = null; });
      }
      return refreshInFlight;
    },

    // --- auth -------------------------------------------------------------
    register: (payload) => request('/auth/register', { method: 'POST', body: payload, auth: false }),
    login: (payload) => request('/auth/login', { method: 'POST', body: payload, auth: false }),
    logout: () => request('/auth/logout', { method: 'POST', body: { refreshToken }, auth: false }),
    me: () => request('/auth/me'),

    // --- users ------------------------------------------------------------
    searchUsers: (q) => request(`/users/search?q=${encodeURIComponent(q)}`),
    getUser: (id) => request(`/users/${id}`),
    listContacts: () => request('/users/contacts'),
    addContact: (userId) => request('/users/contacts', { method: 'POST', body: { userId } }),
    removeContact: (userId) => request(`/users/contacts/${userId}`, { method: 'DELETE' }),
    updateProfile: (patch) => request('/users/me', { method: 'PATCH', body: patch }),

    // --- push -------------------------------------------------------------
    subscribePush: (subscription) => request('/push/subscribe', { method: 'POST', body: { subscription } }),
    unsubscribePush: (endpoint) => request('/push/subscribe', { method: 'DELETE', body: { endpoint } }),

    // The native Android shell hands its FCM token to this page on launch; the
    // page registers it, so the shell never needs a session of its own.
    registerDevice: (token, appVersion) => request('/push/device', { method: 'POST', body: { token, platform: 'android', appVersion } }),

    // --- location ---------------------------------------------------------
    listLocations: () => request('/location'),
    getLocationSharing: () => request('/location/sharing'),
    setLocationSharing: (patch) => request('/location/sharing', { method: 'PATCH', body: patch }),
    postLocation: (fix) => request('/location', { method: 'POST', body: fix }),

    // --- calls ------------------------------------------------------------
    iceServers: () => request('/calls/ice-servers'),
    recents: () => request('/calls/recents'),
    history: (cursor) => request(`/calls/history${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`),
    callStats: () => request('/calls/stats'),
  };
}());
