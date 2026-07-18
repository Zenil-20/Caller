/* ==========================================================================
   Tiny observable app state. Everything the UI renders lives here.
   ========================================================================== */
'use strict';

window.Store = (function store() {
  const state = {
    user: null,
    connection: 'connecting', // connecting | online | offline
    contacts: [],
    searchResults: [],
    recents: [],
    stats: null,
    presence: new Map(), // userId -> { isOnline, isBusy }

    /**
     * The single in-flight call, or null.
     * { callId, peer, direction, status, startedAt, answeredAt, muted, speaker,
     *   quality, peerMuted }
     */
    call: null,
  };

  const subscribers = new Set();

  function notify(reason) {
    subscribers.forEach((fn) => {
      try { fn(state, reason); } catch (err) { console.error('Store subscriber failed', err); }
    });
  }

  function subscribe(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }

  function set(patch, reason = 'set') {
    Object.assign(state, patch);
    notify(reason);
  }

  function setCall(patch, reason = 'call') {
    state.call = patch === null ? null : { ...(state.call || {}), ...patch };
    notify(reason);
  }

  function setPresence(userId, value) {
    state.presence.set(String(userId), value);

    // Mirror onto any already-rendered copy of this user so lists stay honest
    // without a full refetch.
    const apply = (u) => {
      if (u && String(u.id) === String(userId)) {
        u.isOnline = value.isOnline;
        if (value.isBusy !== undefined) u.isBusy = value.isBusy;
      }
    };
    state.contacts.forEach(apply);
    state.searchResults.forEach(apply);
    state.recents.forEach((r) => apply(r.peer));
    if (state.call?.peer) apply(state.call.peer);

    notify('presence');
  }

  function presenceOf(userId) {
    return state.presence.get(String(userId)) || { isOnline: false, isBusy: false };
  }

  return { state, subscribe, set, setCall, setPresence, presenceOf, notify };
}());
