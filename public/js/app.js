/* ==========================================================================
   Application controller. Wires REST + signalling + WebRTC + UI together and
   owns the call state machine on the client side.
   ========================================================================== */
'use strict';

(function app() {
  const { $, toast } = window.UI;

  const state = {
    iceServers: [],
    timerHandle: null,
    localVad: null,
    remoteVad: null,
    latestStats: null,
    statsVisible: false,
    searchDebounce: null,
    contactIds: new Set(),
    /** Set when the app was opened from a notification action. */
    pendingLaunch: null,
    /** True once this page has a live signed-in session (see startSession). */
    sessionActive: false,
    /** Cached location-sharing consent for this user. */
    sharing: null,
    /** userId whose location detail screen is currently open, if any. */
    viewingPerson: null,
    /** Deferred beforeinstallprompt event, if the browser offered one. */
    installPrompt: null,
    /** Guards against double-answering from two rapid taps. */
    answering: false,
  };

  const remoteAudio = $('#remote-audio');

  /* =======================================================================
     Bootstrap
     ======================================================================= */

  async function boot() {
    wireAuthForms();
    wireNavigation();
    wireDialer();
    wireCallControls();
    wireSettings();
    wireSetup();
    wirePerson();
    wireInstall();

    window.API.onUnauthorized(() => {
      toast('Your session expired. Please sign in again.', 'error');
      signOutLocal();
    });

    // Any tap unlocks the AudioContext so ringtones can play later.
    document.addEventListener('pointerdown', () => window.AudioKit.unlock(), { once: true });

    // Read the stored session BEFORE any await. Anything asynchronous here
    // opens a window in which the user can submit the login form, after which
    // this function would find that brand-new session and start a second one.
    const cached = window.API.loadSession();

    // Service worker registration is comparatively slow and nothing above
    // depends on it, so it must not gate the sign-in path.
    window.Push.registerWorker(onServiceWorkerMessage)
      .then(() => window.Push.loadKey())
      .catch(() => {});

    if (cached && window.API.hasSession()) {
      try {
        window.UI.setLoading(true);
        const { user } = await window.API.me();
        await startSession(user);
        return;
      } catch {
        window.API.clearSession();
      } finally {
        window.UI.setLoading(false);
      }
    }

    window.UI.showScreen('screen-auth');
  }

  /**
   * Brings the app online for a signed-in user. Guarded because two entry
   * points can reach it (restoring a stored session, and submitting the login
   * form); running it twice would open a second socket, and the older one
   * would then receive this user's own "handled elsewhere" events and tear
   * down a perfectly good call.
   */
  async function startSession(user) {
    if (state.sessionActive) return;
    state.sessionActive = true;

    window.Store.set({ user });
    window.UI.renderIdentity(user);
    window.UI.renderSettings(user);

    // First run: ask for consent rather than assuming any of it.
    if (!user.setupCompletedAt) {
      showSetup(user);
    } else {
      window.UI.showScreen('screen-app');
    }

    // Read the launch intent BEFORE connecting: the socket's resync runs as
    // soon as it connects and needs to know whether the user already tapped
    // "Answer" on the notification that opened this page.
    handleLaunchIntent();

    connectSignalling();
    await Promise.all([loadContacts(), loadRecents(), loadIceServers()]);

    // If permission was already granted on a previous visit, re-register
    // silently so this device keeps ringing.
    if (window.Push.permission() === 'granted') {
      await window.Push.subscribe();
    }

    await refreshPushUi();
    renderDiagnostics();

    // If this user already consented on a previous visit, resume reporting.
    try {
      const { sharing } = await window.API.getLocationSharing();
      state.sharing = sharing;
      renderSharingBar(sharing);
      if (sharing.enabled) startSharing();
    } catch { /* Non-fatal; the Family tab will retry. */ }
  }

  /**
   * The app can be opened straight from a notification ("Answer"). The call id
   * arrives either in the URL (cold start) or as a worker message (warm).
   */
  function handleLaunchIntent() {
    const params = new URLSearchParams(window.location.search);
    const callId = params.get('callId');
    const action = params.get('action');

    if (callId) {
      // Clean the URL so a refresh does not re-trigger the intent.
      window.history.replaceState({}, '', window.location.pathname);
      state.pendingLaunch = { callId, action };
    }
  }

  function onServiceWorkerMessage(message) {
    if (!message) return;

    if (message.type === 'notification-action') {
      // The incoming-call event may not have arrived over the socket yet
      // (the app is only just waking up), so remember the intent.
      state.pendingLaunch = { callId: message.callId, action: message.action };
      applyPendingLaunch();
    }
  }

  /**
   * Answers a call the user accepted from a notification, once the socket has
   * actually delivered it.
   */
  function applyPendingLaunch() {
    const pending = state.pendingLaunch;
    if (!pending) return;

    const call = window.Store.state.call;
    if (!call || call.callId !== pending.callId) return;

    state.pendingLaunch = null;
    if (pending.action === 'accept') acceptCall();
  }

  function signOutLocal() {
    state.sessionActive = false;

    // Release any call still open server-side before dropping the socket.
    const pending = window.Store.state.call;
    if (pending?.callId) {
      window.Signal.emit('call:end', { callId: pending.callId, reason: 'signed-out' });
    }

    teardownCall({ silent: true });

    // Stop the GPS watcher and clear the map — never keep reporting a position
    // for an account that is no longer signed in on this device.
    window.Geo.stop();
    window.FamilyMap.reset();
    state.sharing = null;

    window.Signal.disconnect();
    window.API.clearSession();
    window.Store.set({ user: null, contacts: [], recents: [], call: null });
    window.UI.showScreen('screen-auth');
  }

  /* =======================================================================
     Auth forms
     ======================================================================= */

  function wireAuthForms() {
    document.querySelectorAll('[data-auth-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.authTab;
        document.querySelectorAll('[data-auth-tab]').forEach((b) => b.classList.toggle('is-active', b === btn));
        $('#form-login').classList.toggle('is-active', tab === 'login');
        $('#form-register').classList.toggle('is-active', tab === 'register');
      });
    });

    $('#form-login').addEventListener('submit', async (e) => {
      e.preventDefault();
      window.UI.setFormError('form-login', '');

      const data = new FormData(e.target);
      const identifier = String(data.get('identifier') || '').trim();
      const password = String(data.get('password') || '');

      if (!identifier || !password) {
        window.UI.setFormError('form-login', 'Enter your username and password.');
        return;
      }

      try {
        window.UI.setLoading(true);
        const session = await window.API.login({ identifier, password });
        window.API.saveSession(session);
        e.target.reset();
        await startSession(session.user);
      } catch (err) {
        window.UI.setFormError('form-login', err.message);
      } finally {
        window.UI.setLoading(false);
      }
    });

    $('#form-register').addEventListener('submit', async (e) => {
      e.preventDefault();
      window.UI.setFormError('form-register', '');

      const data = new FormData(e.target);
      const payload = {
        username: String(data.get('username') || '').trim().toLowerCase(),
        password: String(data.get('password') || ''),
        displayName: String(data.get('displayName') || '').trim() || undefined,
        phone: String(data.get('phone') || '').replace(/[\s-]/g, '') || undefined,
      };

      if (payload.password.length < 8) {
        window.UI.setFormError('form-register', 'Password must be at least 8 characters.');
        return;
      }

      try {
        window.UI.setLoading(true);
        const session = await window.API.register(payload);
        window.API.saveSession(session);
        e.target.reset();
        await startSession(session.user);
        toast(`Welcome, ${session.user.displayName}!`, 'success');
      } catch (err) {
        const detail = err.details?.[0];
        window.UI.setFormError('form-register', detail ? `${detail.field}: ${detail.message}` : err.message);
      } finally {
        window.UI.setLoading(false);
      }
    });
  }

  /* =======================================================================
     Navigation
     ======================================================================= */

  function wireNavigation() {
    document.querySelectorAll('.tabbar__btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        window.UI.showPage(btn.dataset.page);
        if (btn.dataset.page === 'recents') loadRecents();
        if (btn.dataset.page === 'contacts') loadContacts();
        if (btn.dataset.page === 'family') {
          // Leaflet sized itself against a hidden container; re-measure now
          // that the tab is actually visible.
          window.FamilyMap.refresh();
          loadLocations();
        }
      });
    });

    $('#btn-recenter').addEventListener('click', () => window.FamilyMap.fitAll());
    $('#toggle-sharing').addEventListener('change', (e) => setSharing(e.target.checked));

    $('#btn-refresh-recents').addEventListener('click', loadRecents);

    $('#input-search').addEventListener('input', (e) => {
      const term = e.target.value.trim();
      clearTimeout(state.searchDebounce);

      if (term.length < 2) {
        window.Store.set({ searchResults: [] });
        window.UI.renderSearch(null, { contactIds: state.contactIds });
        return;
      }

      // Debounced so typing does not fire a request per keystroke.
      state.searchDebounce = setTimeout(() => runSearch(term), 320);
    });
  }

  async function runSearch(term) {
    try {
      const { users } = await window.API.searchUsers(term);
      window.Store.set({ searchResults: users });
      window.UI.renderSearch(users, {
        contactIds: state.contactIds,
        onCall: (user) => placeCall(user),
        onAdd: async (user) => {
          try {
            await window.API.addContact(user.id);
            toast(`${user.displayName} added to contacts`, 'success');
            await loadContacts();
            runSearch(term);
          } catch (err) {
            toast(err.message, 'error');
          }
        },
      });
      subscribePresence(users.map((u) => u.id));
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* =======================================================================
     Data loading
     ======================================================================= */

  async function loadContacts() {
    try {
      const { contacts } = await window.API.listContacts();
      state.contactIds = new Set(contacts.map((c) => c.id));
      window.Store.set({ contacts });

      window.UI.renderContacts(contacts, {
        onCall: (user) => placeCall(user),
        onRemove: async (user) => {
          try {
            await window.API.removeContact(user.id);
            toast(`${user.displayName} removed`);
            await loadContacts();
          } catch (err) {
            toast(err.message, 'error');
          }
        },
      });

      subscribePresence(contacts.map((c) => c.id));
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function loadRecents() {
    try {
      const [{ recents }, { stats }] = await Promise.all([window.API.recents(), window.API.callStats()]);

      window.Store.set({ recents, stats });
      window.UI.renderRecents(recents, { onCall: (peer) => placeCall(peer) });
      window.UI.renderStats(stats);
      window.UI.renderMissedBadge(recents.reduce((sum, r) => sum + (r.missed ? 1 : 0), 0));

      subscribePresence(recents.map((r) => r.peer.id));
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function loadIceServers() {
    try {
      const { iceServers } = await window.API.iceServers();
      state.iceServers = iceServers;
    } catch {
      // Fall back to a public STUN server; TURN-less calls still work on
      // most home networks.
      state.iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    }
  }

  function subscribePresence(userIds) {
    const ids = userIds.filter(Boolean);
    if (!ids.length || !window.Signal.isConnected()) return;

    window.Signal.request('presence:subscribe', { userIds: ids })
      .then((res) => {
        (res.presence || []).forEach((p) => window.Store.setPresence(p.userId, p));
        repaintLists();
      })
      .catch(() => {});
  }

  function repaintLists() {
    const { contacts, recents, searchResults } = window.Store.state;
    window.UI.renderContacts(contacts, {
      onCall: (user) => placeCall(user),
      onRemove: async (user) => {
        await window.API.removeContact(user.id).catch(() => {});
        loadContacts();
      },
    });
    window.UI.renderRecents(recents, { onCall: (peer) => placeCall(peer) });
    if (searchResults.length) {
      window.UI.renderSearch(searchResults, {
        contactIds: state.contactIds,
        onCall: (user) => placeCall(user),
        onAdd: async (user) => {
          await window.API.addContact(user.id).catch(() => {});
          loadContacts();
        },
      });
    }
  }

  /* =======================================================================
     First-run setup — consent is asked, never assumed
     ======================================================================= */

  function wireSetup() {
    $('#setup-location').addEventListener('change', (e) => {
      $('#setup-location-detail').hidden = !e.target.checked;
    });

    $('#btn-setup-skip').addEventListener('click', () => finishSetup({ skip: true }));
    $('#btn-setup-done').addEventListener('click', () => finishSetup({ skip: false }));
  }

  function showSetup(user) {
    $('#setup-name').textContent = user.displayName ? `, ${user.displayName.split(' ')[0]}` : '';
    $('#setup-location').checked = false;
    $('#setup-location-detail').hidden = true;
    $('#setup-ringing').checked = false;
    window.UI.showScreen('screen-setup');
  }

  async function finishSetup({ skip }) {
    const wantsLocation = !skip && $('#setup-location').checked;
    const wantsRinging = !skip && $('#setup-ringing').checked;
    const scope = document.querySelector('input[name="setup-scope"]:checked')?.value || 'contacts';

    try {
      window.UI.setLoading(true);

      if (wantsLocation) {
        const { sharing } = await window.API.setLocationSharing({ enabled: true, scope });
        state.sharing = sharing;
        startSharing();
      }

      if (wantsRinging) {
        // Must be inside this click for the browser to accept the prompt.
        const permission = await window.Push.requestPermission();
        if (permission === 'granted') {
          await window.Push.subscribe();
        } else {
          toast('Notifications were not enabled. You can turn them on in Settings.');
        }
      }

      // Record completion last, so a failure above leaves setup to be retried.
      const { user } = await window.API.updateProfile({ setupCompleted: true });
      window.Store.set({ user: { ...window.Store.state.user, ...user } });

      window.UI.showScreen('screen-app');
      await refreshPushUi();
    } catch (err) {
      toast(err.message, 'error');
      // Never trap the user on setup — let them in and retry from Settings.
      window.UI.showScreen('screen-app');
    } finally {
      window.UI.setLoading(false);
    }
  }

  /* =======================================================================
     Per-person location detail
     ======================================================================= */

  let personMap = null;
  let personMarker = null;

  function openPerson(entry) {
    const user = entry.user || {};
    state.viewingPerson = entry.userId;

    $('#person-avatar').textContent = window.UI.initials(user.displayName || user.username);
    $('#person-avatar').style.background = user.avatarColor || '#4f8ef7';
    $('#person-name').textContent = user.displayName || user.username || 'Unknown';
    $('#person-handle').textContent = user.username ? `@${user.username}` : '';

    renderPersonFacts(entry);

    const callBtn = $('#btn-person-call');
    callBtn.disabled = !user.isOnline;
    callBtn.textContent = user.isOnline ? '📞 Call' : 'Offline';
    callBtn.onclick = () => placeCall(user);

    // A plain OSM link works on every platform, unlike a geo: URI.
    $('#btn-person-external').href =
      `https://www.openstreetmap.org/?mlat=${entry.latitude}&mlon=${entry.longitude}#map=16/${entry.latitude}/${entry.longitude}`;

    window.UI.showScreen('screen-person');

    // Leaflet must measure the container after it becomes visible.
    setTimeout(() => {
      if (!personMap) {
        personMap = window.L.map('person-map', { zoomControl: true, attributionControl: true });
        window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '&copy; OpenStreetMap contributors',
        }).addTo(personMap);
      }

      const pos = [entry.latitude, entry.longitude];
      personMap.invalidateSize();
      personMap.setView(pos, 16);

      if (personMarker) personMap.removeLayer(personMarker);
      personMarker = window.L.circleMarker(pos, {
        radius: 10,
        color: user.avatarColor || '#4f8ef7',
        fillColor: user.avatarColor || '#4f8ef7',
        fillOpacity: 0.85,
        weight: 3,
      }).addTo(personMap);
    }, 60);
  }

  function renderPersonFacts(entry) {
    const facts = [
      ['Last update', window.FamilyMap.relativeAge(entry.recordedAt)],
      ['Accuracy', entry.accuracy ? `±${Math.round(entry.accuracy)} m` : 'unknown'],
      ['Source', entry.source === 'gps' ? 'GPS' : entry.source === 'network' ? 'Wi-Fi / mobile' : 'unknown'],
      ['Coordinates', `${entry.latitude.toFixed(5)}, ${entry.longitude.toFixed(5)}`],
    ];

    // Distance from me, when I have a fix of my own to compare against.
    const mine = window.Geo.getLastFix();
    if (mine) {
      const metres = window.Geo.distanceMetres(
        { lat: mine.lat, lng: mine.lng },
        { lat: entry.latitude, lng: entry.longitude },
      );
      facts.splice(1, 0, ['Distance from you', metres < 1000
        ? `${Math.round(metres)} m`
        : `${(metres / 1000).toFixed(1)} km`]);
    }

    if (entry.speed != null && entry.speed > 1) {
      facts.push(['Moving at', `${Math.round(entry.speed * 3.6)} km/h`]);
    }

    $('#person-facts').innerHTML = facts
      .map(([k, v]) => `<div><dt>${window.UI.esc(k)}</dt><dd>${window.UI.esc(v)}</dd></div>`)
      .join('');
  }

  function wirePerson() {
    $('#btn-person-back').addEventListener('click', () => {
      state.viewingPerson = null;
      window.UI.showScreen('screen-app');
      window.FamilyMap.refresh();
    });
  }

  /* =======================================================================
     Family location
     ======================================================================= */

  async function loadLocations() {
    try {
      const [{ locations }, { sharing }] = await Promise.all([
        window.API.listLocations(),
        window.API.getLocationSharing(),
      ]);

      state.sharing = sharing;
      renderSharingBar(sharing);

      window.FamilyMap.render(locations);
      renderLocationList(locations);

      // Watch everyone who is sharing, so their movement streams in live.
      const ids = locations.map((l) => l.userId);
      if (ids.length && window.Signal.isConnected()) {
        window.Signal.request('location:subscribe', { userIds: ids }).catch(() => {});
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function renderSharingBar(sharing) {
    const on = Boolean(sharing?.enabled);
    $('#share-bar').dataset.on = String(on);
    $('#toggle-sharing').checked = on;
    $('#share-title').textContent = on ? 'Sharing your location' : 'Location sharing is off';
    $('#share-sub').textContent = on
      ? (sharing.scope === 'selected'
        ? `Visible to ${sharing.sharedWith.length} chosen ${sharing.sharedWith.length === 1 ? 'person' : 'people'}`
        : 'Visible to your contacts')
      : 'Nobody can see where you are';

    $('#map-note').textContent = on
      ? 'Your position updates only while gians is open on screen.'
      : '';
  }

  function renderLocationList(locations) {
    const list = $('#list-locations');
    list.innerHTML = '';
    $('#empty-locations').hidden = locations.length > 0;

    locations.forEach((entry) => {
      const user = entry.user || {};
      const li = document.createElement('li');
      li.className = 'row';

      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      avatar.textContent = window.UI.initials(user.displayName || user.username);
      avatar.style.background = user.avatarColor || '#4f8ef7';
      avatar.dataset.online = String(Boolean(user.isOnline));
      li.appendChild(avatar);

      const stale = Date.now() - new Date(entry.recordedAt).getTime() > 10 * 60 * 1000;
      const body = document.createElement('div');
      body.className = 'row__body';
      body.innerHTML = `
        <div class="row__name">${window.UI.esc(user.displayName || user.username)}</div>
        <div class="row__meta"><span class="loc-age" data-stale="${stale}">
          ${window.UI.esc(window.FamilyMap.relativeAge(entry.recordedAt))}
          ${entry.accuracy ? `· ±${Math.round(entry.accuracy)} m` : ''}
        </span></div>`;
      body.style.cursor = 'pointer';
      body.addEventListener('click', () => openPerson(entry));
      li.appendChild(body);

      const actions = document.createElement('div');
      actions.className = 'row__actions';
      const callBtn = document.createElement('button');
      callBtn.className = 'icon-btn icon-btn--call';
      callBtn.textContent = '📞';
      callBtn.title = `Call ${user.displayName || user.username}`;
      callBtn.disabled = !user.isOnline;
      callBtn.addEventListener('click', () => placeCall(user));
      actions.appendChild(callBtn);
      li.appendChild(actions);

      list.appendChild(li);
    });
  }

  /**
   * Turning sharing on is what starts the GPS watcher — never before, and the
   * watcher stops the moment it is turned off.
   */
  async function setSharing(enabled) {
    try {
      if (enabled && !window.Geo.supported()) {
        toast('This browser cannot determine your location.', 'error');
        $('#toggle-sharing').checked = false;
        return;
      }

      const { sharing } = await window.API.setLocationSharing({ enabled });
      state.sharing = sharing;
      renderSharingBar(sharing);

      if (sharing.enabled) {
        startSharing();
      } else {
        window.Geo.stop();
        window.FamilyMap.remove(window.Store.state.user?.id);
        toast('Location sharing turned off');
      }
    } catch (err) {
      toast(err.message, 'error');
      $('#toggle-sharing').checked = Boolean(state.sharing?.enabled);
    }
  }

  function startSharing() {
    const started = window.Geo.start({
      onUpdate: (fix) => {
        // Show yourself on the map immediately, without waiting for the echo.
        const me = window.Store.state.user;
        if (!me) return;
        window.FamilyMap.upsert({
          userId: me.id,
          latitude: fix.lat,
          longitude: fix.lng,
          accuracy: fix.accuracy,
          recordedAt: new Date(fix.at).toISOString(),
          user: me,
        });
      },
      onError: (message, code) => {
        toast(message, 'error');
        if (code === 1) {
          // Permission denied is permanent until the user changes it, so do
          // not leave the toggle claiming we are sharing.
          window.API.setLocationSharing({ enabled: false }).catch(() => {});
          state.sharing = { ...(state.sharing || {}), enabled: false };
          renderSharingBar(state.sharing);
        }
      },
    });

    if (started) toast('Sharing your location with your contacts', 'success');
  }

  /* =======================================================================
     Signalling
     ======================================================================= */

  function connectSignalling() {
    const socket = window.Signal.connect(window.API.getAccessToken());

    socket.on('connect', () => {
      window.Store.set({ connection: 'online' });
      window.UI.renderConnection('online');

      // Re-arm presence subscriptions and recover any call that outlived the
      // socket drop.
      const { contacts, recents } = window.Store.state;
      subscribePresence([...contacts.map((c) => c.id), ...recents.map((r) => r.peer.id)]);
      resyncCall();
    });

    socket.on('disconnect', () => {
      window.Store.set({ connection: 'offline' });
      window.UI.renderConnection('offline');
    });

    socket.io.on('reconnect_attempt', () => {
      window.Store.set({ connection: 'connecting' });
      window.UI.renderConnection('connecting');
    });

    socket.on('connect_error', (err) => {
      window.Store.set({ connection: 'offline' });
      window.UI.renderConnection('offline');

      const code = err?.data?.code;
      if (code === 'NO_ACCOUNT' || code === 'NO_TOKEN') {
        toast('Please sign in again.', 'error');
        signOutLocal();
      }
    });

    window.Signal.on('presence:update', (payload) => {
      window.Store.setPresence(payload.userId, { isOnline: payload.isOnline, lastSeen: payload.lastSeen });
      repaintLists();
    });

    window.Signal.on('location:changed', (entry) => {
      window.FamilyMap.upsert(entry);

      // Keep an open person view tracking them live.
      if (state.viewingPerson && entry.userId === state.viewingPerson && personMap) {
        const pos = [entry.latitude, entry.longitude];
        personMap.setView(pos, personMap.getZoom());
        if (personMarker) personMarker.setLatLng(pos);
        renderPersonFacts(entry);
      }

      // Keep the "last seen" ages in the list honest as updates arrive.
      if (document.getElementById('page-family')?.classList.contains('is-active')) {
        window.API.listLocations().then(({ locations }) => renderLocationList(locations)).catch(() => {});
      }
    });

    window.Signal.on('call:incoming', onIncomingCall);
    window.Signal.on('call:accepted', onCallAccepted);
    window.Signal.on('call:rejected', onCallRejected);
    window.Signal.on('call:ended', onCallEnded);
    window.Signal.on('call:missed', () => loadRecents());
    window.Signal.on('call:handled-elsewhere', onHandledElsewhere);
    window.Signal.on('call:peer-media-state', onPeerMediaState);
    window.Signal.on('call:peer-quality', () => {});

    window.Signal.on('webrtc:offer', onRemoteOffer);
    window.Signal.on('webrtc:answer', onRemoteAnswer);
    window.Signal.on('webrtc:ice-candidate', ({ candidate }) => window.RTC.addIceCandidate(candidate));
    window.Signal.on('webrtc:restart', onRemoteRestart);
    window.Signal.on('webrtc:renegotiate', onRenegotiateRequest);
  }

  async function resyncCall() {
    try {
      const res = await window.Signal.request('call:resync');
      if (!res.call) {
        // Server says no live call — make sure we are not stuck on a call screen.
        if (window.Store.state.call) teardownCall({ silent: true });
        return;
      }
      if (window.Store.state.call) return; // Already tracking it.

      // A call exists server-side that this page knows nothing about — we were
      // launched from a notification, or reloaded mid-call.
      const remote = res.call;

      if (remote.status === 'ringing' && remote.direction === 'incoming') {
        // Still ringing: adopt it and present the incoming screen. Ending it
        // here would hang up on the user in the exact moment they tapped
        // "Answer" on the notification that opened this page.
        if (res.iceServers?.length) state.iceServers = res.iceServers;

        window.Store.setCall({
          callId: remote.callId,
          peer: remote.peer,
          direction: 'incoming',
          status: 'ringing',
          startedAt: remote.startedAt,
          muted: false,
          speaker: false,
        });

        window.UI.renderIncoming(remote.peer);
        window.UI.showScreen('screen-incoming');

        const settings = window.Store.state.user?.settings || {};
        if (settings.ringtoneEnabled !== false) window.AudioKit.startRingtone();

        // Honour an "Answer" tap that opened this page in the first place.
        applyPendingLaunch();
        return;
      }

      // An answered call cannot survive a page load — the peer connection and
      // its media are gone with the old document. Release it so neither side
      // is left on a dead call screen.
      window.Signal.emit('call:end', { callId: remote.callId, reason: 'client-lost-state' });
    } catch { /* Not connected yet; the next connect will retry. */ }
  }

  /* =======================================================================
     Outgoing call
     ======================================================================= */

  async function placeCall(peer) {
    if (window.Store.state.call) {
      toast('You are already on a call.', 'error');
      return;
    }
    if (!window.Signal.isConnected()) {
      toast('Not connected to the server.', 'error');
      return;
    }

    window.AudioKit.unlock();

    try {
      window.UI.setLoading(true);

      // Capture the mic BEFORE dialling: if permission is refused there is no
      // point ringing the other side.
      await window.RTC.getMicrophone(window.Store.state.user?.settings || {});

      const res = await window.Signal.request('call:initiate', { calleeId: peer.id });

      if (res.blocked) {
        window.UI.setLoading(false);
        window.RTC.stopLocalStream();

        const messages = {
          busy: `${peer.displayName} is on another call.`,
          unavailable: `${peer.displayName} is offline right now.`,
        };
        toast(messages[res.blocked] || 'Call could not be placed.', 'error');
        window.AudioKit.playBusy();
        loadRecents();
        return;
      }

      state.iceServers = res.iceServers?.length ? res.iceServers : state.iceServers;

      window.Store.setCall({
        callId: res.callId,
        peer,
        direction: 'outgoing',
        status: 'ringing',
        startedAt: Date.now(),
        muted: false,
        speaker: false,
      });

      window.UI.renderCallPeer(peer);
      window.UI.setCallStatus('Calling…');
      window.UI.setCallTimer(null);
      window.UI.setQuality(null);
      window.UI.setMuteButton(false);
      window.UI.setSpeakerButton(false);
      window.UI.setPeerState('');
      window.UI.hideVuMeter();
      window.UI.showScreen('screen-call');

      window.AudioKit.startRingback();

      // The caller is the offerer, and therefore the impolite peer.
      setupPeerConnection({ callId: res.callId, polite: false });
      const offer = await window.RTC.createOffer();
      window.Signal.emit('webrtc:offer', { callId: res.callId, sdp: offer });
    } catch (err) {
      toast(err.message, 'error');
      // If the server already started ringing the callee, tell it we failed.
      // Tearing down locally alone would leave their phone ringing for the
      // full timeout and keep this user marked busy the whole time.
      const pending = window.Store.state.call;
      if (pending?.callId) {
        window.Signal.emit('call:end', { callId: pending.callId, reason: 'setup-failed' });
      }
      teardownCall({ silent: true });
    } finally {
      window.UI.setLoading(false);
    }
  }

  /* =======================================================================
     Incoming call
     ======================================================================= */

  function onIncomingCall({ callId, from, iceServers }) {
    // Already busy locally — the server should have prevented this, but a race
    // is possible. Decline immediately rather than showing a second screen.
    if (window.Store.state.call) {
      window.Signal.emit('call:reject', { callId, reason: 'busy' });
      return;
    }

    if (iceServers?.length) state.iceServers = iceServers;

    window.Store.setCall({
      callId,
      peer: from,
      direction: 'incoming',
      status: 'ringing',
      startedAt: Date.now(),
      muted: false,
      speaker: false,
    });

    window.UI.renderIncoming(from);
    window.UI.showScreen('screen-incoming');

    // If the user already tapped "Answer" on the notification, honour it now
    // that the call has actually arrived. This must be decided BEFORE the
    // ringtone starts — acceptCall silences the ringer synchronously and then
    // suspends on getUserMedia, so starting the ringtone afterwards would ring
    // straight through the "Connecting…" screen.
    const autoAnswering = state.pendingLaunch?.callId === callId
      && state.pendingLaunch?.action === 'accept';

    if (autoAnswering) {
      applyPendingLaunch();
      return;
    }

    applyPendingLaunch();

    const settings = window.Store.state.user?.settings || {};
    if (settings.ringtoneEnabled !== false) window.AudioKit.startRingtone();
    if (settings.vibrationEnabled !== false) window.AudioKit.vibrate([400, 250, 400, 250, 400]);

    notifyIncoming(from);
  }

  function notifyIncoming(from) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (document.visibilityState === 'visible') return;

    try {
      const note = new Notification(`Incoming call from ${from.displayName}`, {
        body: `@${from.username}`,
        tag: 'gians-incoming',
        requireInteraction: true,
      });
      note.onclick = () => { window.focus(); note.close(); };
    } catch { /* Notification constructor is unavailable in some contexts. */ }
  }

  async function acceptCall() {
    const call = window.Store.state.call;
    if (!call || state.answering) return;

    // A stale "Answer" tap (the notification stays on screen until acted on)
    // must not re-run this for a call that is already connecting or live —
    // that would grab a second microphone stream, orphaning the first, and
    // then tear the live call down when the server refuses the late accept.
    if (call.status !== 'ringing') return;

    state.answering = true;

    try {
      window.AudioKit.stopRinging();
      window.AudioKit.vibrate(0);
      window.UI.setLoading(true);

      await window.RTC.getMicrophone(window.Store.state.user?.settings || {});
      const res = await window.Signal.request('call:accept', { callId: call.callId });
      if (res.iceServers?.length) state.iceServers = res.iceServers;

      window.Store.setCall({ status: 'connecting', answeredAt: Date.now() });

      window.UI.renderCallPeer(call.peer);
      window.UI.setCallStatus('Connecting…');
      window.UI.setMuteButton(false);
      window.UI.setSpeakerButton(false);
      window.UI.showScreen('screen-call');

      // The callee answers the offer, so it is the polite peer.
      setupPeerConnection({ callId: call.callId, polite: true });

      // The offer may already have arrived while we were getting the mic.
      if (pendingRemoteOffer && pendingRemoteOffer.callId === call.callId) {
        const offer = pendingRemoteOffer;
        pendingRemoteOffer = null;
        await applyRemoteOffer(offer);
      } else {
        // No offer is waiting. This page adopted a call that was already
        // ringing (a reload, or a cold start from the notification), so the
        // original offer was delivered to a document that no longer exists.
        // Ask the caller to send a fresh one.
        window.Signal.emit('webrtc:renegotiate', { callId: call.callId });
      }
    } catch (err) {
      toast(err.message, 'error');
      window.Signal.emit('call:reject', { callId: call.callId, reason: 'media-error' });
      teardownCall({ silent: true });
    } finally {
      state.answering = false;
      window.UI.setLoading(false);
    }
  }

  function rejectCall() {
    const call = window.Store.state.call;
    if (!call) return;

    window.AudioKit.stopRinging();
    window.AudioKit.vibrate(0);
    window.Signal.emit('call:reject', { callId: call.callId, reason: 'declined' });
    teardownCall({ silent: true });
    loadRecents();
  }

  function onHandledElsewhere({ callId }) {
    const call = window.Store.state.call;
    if (call && call.callId === callId && call.status === 'ringing' && call.direction === 'incoming') {
      toast('Answered on another device');
      teardownCall({ silent: true });
    }
  }

  /* =======================================================================
     WebRTC glue
     ======================================================================= */

  /** An offer that arrived before the user finished answering. */
  let pendingRemoteOffer = null;

  function setupPeerConnection({ callId, polite }) {
    window.RTC.configure({
      onIceCandidate: (candidate) => {
        window.Signal.emit('webrtc:ice-candidate', { callId, candidate });
      },

      onRemoteStream: (stream) => {
        remoteAudio.srcObject = stream;
        // Autoplay can be blocked until a gesture; retry quietly.
        remoteAudio.play().catch(() => {});
        startRemoteVad(stream);
      },

      onConnectionStateChange: (connState) => {
        const call = window.Store.state.call;
        if (!call) return;

        if (connState === 'connected' || connState === 'completed') {
          if (call.status !== 'active') onCallConnected();
          window.UI.setPeerState('');
        } else if (connState === 'disconnected') {
          window.UI.setPeerState('Connection unstable — reconnecting…');
        } else if (connState === 'failed') {
          window.UI.setPeerState('Reconnecting…');
        }
      },

      onStats: (sample) => {
        state.latestStats = sample;
        window.UI.setQuality(sample);
        window.UI.setStatsPanel(sample, state.statsVisible);

        const call = window.Store.state.call;
        if (call) window.Signal.emit('call:quality', { callId: call.callId, sample });
      },

      onNegotiationNeeded: (offer, isRestart) => {
        // Only forward offers produced by an explicit ICE restart; ordinary
        // renegotiation is not needed for a fixed audio-only session.
        if (isRestart && offer) {
          window.Signal.emit('webrtc:restart', { callId, sdp: offer });
        }
      },

      onFailed: () => {
        toast('Connection lost. Ending the call.', 'error');
        hangUp('connection-failed');
      },
    });

    window.RTC.createPeerConnection({ iceServers: state.iceServers, callId, polite });
    startLocalVad();
  }

  async function onRemoteOffer(payload) {
    const call = window.Store.state.call;

    // Offer landed before the user tapped accept — hold it.
    if (!call || call.callId !== payload.callId || !window.RTC.getPeerConnection()) {
      pendingRemoteOffer = payload;
      return;
    }
    await applyRemoteOffer(payload);
  }

  async function applyRemoteOffer({ callId, sdp }) {
    try {
      const applied = await window.RTC.setRemoteDescription(sdp);
      if (!applied) return; // Collision; we keep our own offer.

      const answer = await window.RTC.createAnswer();
      window.Signal.emit('webrtc:answer', { callId, sdp: answer });
    } catch (err) {
      console.error('Failed to apply remote offer', err);
      toast('Could not negotiate the call.', 'error');
      hangUp('negotiation-failed');
    }
  }

  /**
   * The peer answered but never got our offer (their page reloaded while
   * ringing). Produce a fresh one against the existing connection.
   */
  async function onRenegotiateRequest({ callId }) {
    const call = window.Store.state.call;
    if (!call || call.callId !== callId || call.direction !== 'outgoing') return;

    try {
      if (!window.RTC.getPeerConnection()) {
        setupPeerConnection({ callId, polite: false });
      }
      const offer = await window.RTC.createOffer();
      if (offer) window.Signal.emit('webrtc:offer', { callId, sdp: offer });
    } catch (err) {
      console.error('Failed to re-offer after peer reload', err);
      hangUp('negotiation-failed');
    }
  }

  async function onRemoteAnswer({ sdp }) {
    try {
      await window.RTC.setRemoteDescription(sdp);
    } catch (err) {
      console.error('Failed to apply remote answer', err);
    }
  }

  async function onRemoteRestart({ callId, sdp }) {
    try {
      const applied = await window.RTC.setRemoteDescription(sdp);
      if (!applied) return;
      const answer = await window.RTC.createAnswer();
      window.Signal.emit('webrtc:answer', { callId, sdp: answer });
    } catch (err) {
      console.error('ICE restart negotiation failed', err);
    }
  }

  /* =======================================================================
     Call lifecycle events
     ======================================================================= */

  function onCallAccepted() {
    const call = window.Store.state.call;
    if (!call) return;

    window.AudioKit.stopRinging();
    window.Store.setCall({ status: 'connecting' });
    window.UI.setCallStatus('Connecting…');
  }

  function onCallConnected() {
    const call = window.Store.state.call;
    if (!call) return;

    window.AudioKit.stopRinging();
    window.AudioKit.playConnected();

    const answeredAt = Date.now();
    window.Store.setCall({ status: 'active', answeredAt });

    window.UI.setCallStatus('Connected');
    startTimer(answeredAt);
    loadRecents();
  }

  function onCallRejected({ reason }) {
    window.AudioKit.stopRinging();
    window.AudioKit.playBusy();

    const messages = {
      declined: 'Call declined',
      busy: 'They are on another call',
      'media-error': 'They could not access their microphone',
    };
    toast(messages[reason] || 'Call declined');

    teardownCall({ silent: true });
    loadRecents();
  }

  function onCallEnded({ duration: seconds, reason }) {
    window.AudioKit.stopRinging();
    window.AudioKit.playEnded();

    const messages = {
      'no-answer': 'No answer',
      'peer-disconnected': 'The other person lost connection',
    };
    toast(messages[reason] || (seconds ? `Call ended · ${window.UI.duration(seconds)}` : 'Call ended'));

    teardownCall({ silent: true });
    loadRecents();
  }

  function onPeerMediaState({ muted }) {
    window.UI.setPeerState(muted ? 'They muted their microphone' : '');
  }

  /* =======================================================================
     Call controls
     ======================================================================= */

  function wireCallControls() {
    $('#btn-accept').addEventListener('click', acceptCall);
    $('#btn-reject').addEventListener('click', rejectCall);
    $('#btn-hangup').addEventListener('click', () => hangUp('hangup'));

    $('#btn-mute').addEventListener('click', () => {
      const call = window.Store.state.call;
      if (!call) return;

      const muted = !call.muted;
      window.RTC.setMuted(muted);
      window.Store.setCall({ muted });
      window.UI.setMuteButton(muted);
      window.Signal.emit('call:media-state', { callId: call.callId, muted, speaker: call.speaker });
    });

    $('#btn-speaker').addEventListener('click', async () => {
      const call = window.Store.state.call;
      if (!call) return;

      const speaker = !call.speaker;
      const applied = await window.RTC.setSpeaker(remoteAudio, speaker);

      window.Store.setCall({ speaker });
      window.UI.setSpeakerButton(speaker);

      if (!applied) {
        toast('This browser controls audio routing itself.');
      }
    });

    $('#btn-stats-toggle').addEventListener('click', () => {
      state.statsVisible = !state.statsVisible;
      window.UI.setStatsPanel(state.latestStats, state.statsVisible);
      document.getElementById('btn-stats-toggle').classList.toggle('is-on', state.statsVisible);
    });
  }

  function hangUp(reason = 'hangup') {
    const call = window.Store.state.call;
    if (!call) return;

    window.Signal.emit('call:end', { callId: call.callId, reason });
    window.AudioKit.playEnded();
    teardownCall({ silent: true });
    loadRecents();
  }

  /**
   * Returns the UI to the app shell and releases every call resource. Safe to
   * call more than once — every step tolerates already being torn down.
   */
  function teardownCall({ silent = false } = {}) {
    stopTimer();
    stopVad();

    window.AudioKit.stopRinging();
    window.AudioKit.vibrate(0);

    window.RTC.destroy();

    remoteAudio.srcObject = null;
    pendingRemoteOffer = null;
    state.latestStats = null;
    state.statsVisible = false;

    window.UI.setStatsPanel(null, false);
    // Clear the toggle's active styling too, or the next call opens with the
    // button lit while no panel is shown.
    document.getElementById('btn-stats-toggle')?.classList.remove('is-on');
    window.UI.setQuality(null);
    window.UI.setCallTimer(null);
    window.UI.setPeerState('');
    window.UI.hideVuMeter();

    window.Store.setCall(null);

    if (!silent) toast('Call ended');
    window.UI.showScreen('screen-app');
  }

  /* =======================================================================
     Timer & voice activity
     ======================================================================= */

  function startTimer(since) {
    stopTimer();
    const tick = () => window.UI.setCallTimer(Math.floor((Date.now() - since) / 1000));
    tick();
    state.timerHandle = setInterval(tick, 1000);
  }

  function stopTimer() {
    if (state.timerHandle) {
      clearInterval(state.timerHandle);
      state.timerHandle = null;
    }
  }

  function startLocalVad() {
    state.localVad?.stop();
    const stream = window.RTC.getLocalStream();
    if (!stream) return;

    state.localVad = window.AudioKit.createVoiceDetector(stream, {
      onLevel: (level, speaking) => {
        // A muted mic still produces samples; show zero instead of misleading bars.
        const muted = window.Store.state.call?.muted;
        window.UI.setVuMeter({ local: muted ? 0 : level, localSpeaking: !muted && speaking });
      },
    });
  }

  function startRemoteVad(stream) {
    state.remoteVad?.stop();
    state.remoteVad = window.AudioKit.createVoiceDetector(stream, {
      onLevel: (level, speaking) => window.UI.setVuMeter({ remote: level, remoteSpeaking: speaking }),
    });
  }

  function stopVad() {
    state.localVad?.stop();
    state.remoteVad?.stop();
    state.localVad = null;
    state.remoteVad = null;
  }

  /* =======================================================================
     Dialer
     ======================================================================= */

  function wireDialer() {
    const display = $('#dialer-display');
    const hint = $('#dialer-hint');

    document.querySelectorAll('#keypad .key').forEach((key) => {
      key.addEventListener('click', () => {
        const value = key.dataset.key;
        display.value += value;
        window.AudioKit.playKey(value);
        hint.classList.remove('is-error');
        hint.textContent = 'Enter a phone number or username';
      });
    });

    // Long-press 0 for "+", as on a real dialpad.
    const zero = document.querySelector('#keypad .key[data-key="0"]');
    let longPress = null;
    zero.addEventListener('pointerdown', () => {
      longPress = setTimeout(() => {
        display.value = `${display.value.slice(0, -1)}+`;
        longPress = null;
      }, 550);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((evt) => {
      zero.addEventListener(evt, () => { if (longPress) { clearTimeout(longPress); longPress = null; } });
    });

    $('#btn-backspace').addEventListener('click', () => {
      display.value = display.value.slice(0, -1);
    });

    $('#btn-dial').addEventListener('click', async () => {
      const input = display.value.trim();
      if (!input) return;

      hint.classList.remove('is-error');
      hint.textContent = 'Looking up…';

      try {
        // The dialer accepts either a number or a username — search covers both.
        const { users } = await window.API.searchUsers(input.replace(/[\s-]/g, ''));
        const match = users.find((u) => u.phone === input.replace(/[\s-]/g, ''))
          || users.find((u) => u.username === input.toLowerCase())
          || users[0];

        if (!match) {
          hint.classList.add('is-error');
          hint.textContent = 'No gians user found with that number or username.';
          return;
        }

        hint.textContent = `Calling ${match.displayName}…`;
        display.value = '';
        await placeCall(match);
        hint.textContent = 'Enter a phone number or username';
      } catch (err) {
        hint.classList.add('is-error');
        hint.textContent = err.message;
      }
    });
  }

  /* =======================================================================
     Settings
     ======================================================================= */

  /**
   * Reflects the real push state, and explains the platform caveats rather
   * than silently doing nothing when a browser cannot support this.
   */
  async function refreshPushUi() {
    // Registration runs in the background, so the key may not be loaded yet.
    await window.Push.loadKey().catch(() => {});
    const info = await window.Push.status();
    const label = $('#push-state-label');
    const dot = document.querySelector('#push-state .push-state__dot');
    const btn = $('#btn-enable-push');
    const hint = $('#push-hint');

    const isIos = /iP(hone|ad|od)/.test(navigator.userAgent);
    let text; let tone; let hintText = ''; let showButton = true;

    if (!info.supported) {
      text = 'Not supported by this browser';
      tone = 'off';
      showButton = false;
      hintText = isIos
        ? 'On iPhone, open this site in Safari, tap Share → Add to Home Screen, then launch it from the home screen.'
        : 'Try Chrome, Edge, Firefox or Safari 16.4+.';
    } else if (!info.enabled) {
      text = 'Not configured on the server';
      tone = 'off';
      showButton = false;
      hintText = 'The server has no VAPID keys set. See README → Ringing a closed device.';
    } else if (isIos && !info.standalone) {
      text = 'Add to Home Screen required';
      tone = 'warn';
      showButton = false;
      hintText = 'iOS only delivers call notifications to installed apps. Tap Share → Add to Home Screen, then open gians from there.';
    } else if (info.permission === 'denied') {
      text = 'Blocked in browser settings';
      tone = 'off';
      showButton = false;
      hintText = 'Notifications are blocked for this site. Re-enable them in your browser’s site settings, then reload.';
    } else if (info.subscribed && info.permission === 'granted') {
      text = 'This device will ring';
      tone = 'on';
      showButton = false;
      hintText = 'Calls will ring even with gians closed. Keep the app installed and battery optimisation off for reliable delivery.';
    } else {
      text = 'Off — calls only ring while the app is open';
      tone = 'warn';
    }

    label.textContent = text;
    dot.dataset.tone = tone;
    btn.hidden = !showButton;
    hint.textContent = hintText;
  }

  /**
   * Install prompt.
   *
   * Chromium fires `beforeinstallprompt` and lets us trigger the native
   * install sheet on demand. iOS has no such event — Safari only installs via
   * Share → Add to Home Screen — so there we show instructions instead of a
   * button that could not work.
   */
  function wireInstall() {
    const card = $('#card-install');
    const btn = $('#btn-install');
    const note = $('#install-note');

    const standalone = window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true;

    if (standalone) return; // Already installed; nothing to offer.

    const isIos = /iP(hone|ad|od)/.test(navigator.userAgent);
    if (isIos) {
      card.hidden = false;
      btn.hidden = true;
      note.textContent = 'On iPhone: tap the Share button, then "Add to Home Screen". '
        + 'This is also required for calls to ring when gians is closed.';
      return;
    }

    window.addEventListener('beforeinstallprompt', (e) => {
      // Chrome shows its own mini-bar unless we take over the prompt.
      e.preventDefault();
      state.installPrompt = e;
      card.hidden = false;
    });

    btn.addEventListener('click', async () => {
      const prompt = state.installPrompt;
      if (!prompt) {
        toast('Use your browser menu → "Install app" to add gians to this device.');
        return;
      }

      prompt.prompt();
      const { outcome } = await prompt.userChoice;
      state.installPrompt = null;

      if (outcome === 'accepted') {
        card.hidden = true;
        toast('gians installed', 'success');
      }
    });

    window.addEventListener('appinstalled', () => {
      card.hidden = true;
      state.installPrompt = null;
    });
  }

  function wireSettings() {
    $('#btn-enable-push').addEventListener('click', async () => {
      // Must run inside the click handler — browsers reject a permission
      // prompt that is not tied to a user gesture.
      const permission = await window.Push.requestPermission();

      if (permission !== 'granted') {
        toast(permission === 'denied'
          ? 'Notifications blocked. Enable them in site settings.'
          : 'Notification permission was not granted.', 'error');
        await refreshPushUi();
        return;
      }

      const result = await window.Push.subscribe();
      if (result.ok) {
        toast('This device will now ring for incoming calls.', 'success');
      } else {
        const reasons = {
          'not-configured': 'Push is not configured on the server.',
          unsupported: 'This browser does not support push notifications.',
          'no-worker': 'The service worker failed to register.',
          permission: 'Notification permission is required.',
        };
        toast(reasons[result.reason] || `Could not enable ringing: ${result.reason}`, 'error');
      }
      await refreshPushUi();
    });

    $('#btn-save-profile').addEventListener('click', async () => {
      try {
        const { user } = await window.API.updateProfile({
          displayName: $('#set-displayName').value.trim(),
          about: $('#set-about').value.trim(),
        });
        window.Store.set({ user });
        window.UI.renderIdentity(user);
        toast('Profile saved', 'success');
      } catch (err) {
        toast(err.message, 'error');
      }
    });

    ['echoCancellation', 'noiseSuppression', 'autoGainControl', 'ringtoneEnabled', 'vibrationEnabled']
      .forEach((key) => {
        document.getElementById(`set-${key}`).addEventListener('change', async (e) => {
          try {
            const { user } = await window.API.updateProfile({ settings: { [key]: e.target.checked } });
            window.Store.set({ user });
          } catch (err) {
            toast(err.message, 'error');
            e.target.checked = !e.target.checked;
          }
        });
      });

    $('#btn-mic-test').addEventListener('click', async () => {
      try {
        const stream = await window.RTC.getMicrophone(window.Store.state.user?.settings || {});
        const track = stream.getAudioTracks()[0];
        const settings = track.getSettings();

        toast(`Microphone OK — ${track.label || 'default device'}`, 'success');
        window.UI.renderDiagnostics([
          ...baseDiagnostics(),
          ['Microphone', track.label || 'default'],
          ['Sample rate', `${settings.sampleRate || 'n/a'} Hz`],
          ['Echo cancellation', String(settings.echoCancellation ?? 'n/a')],
          ['Noise suppression', String(settings.noiseSuppression ?? 'n/a')],
          ['Auto gain control', String(settings.autoGainControl ?? 'n/a')],
        ]);

      } catch (err) {
        toast(err.message, 'error');
      } finally {
        // Must run even if reading track settings threw, or the microphone
        // stays live with no call in progress.
        window.RTC.stopLocalStream();
      }
    });

    $('#btn-logout').addEventListener('click', async () => {
      // Stop this device ringing for an account that is no longer signed in.
      await window.Push.unsubscribe().catch(() => {});
      try { await window.API.logout(); } catch { /* Local sign-out proceeds regardless. */ }
      signOutLocal();
      toast('Signed out');
    });
  }

  function baseDiagnostics() {
    const turn = state.iceServers.some((s) => String(s.urls).includes('turn:'));
    return [
      ['Secure context', String(window.isSecureContext)],
      ['WebRTC', typeof RTCPeerConnection === 'function' ? 'supported' : 'unsupported'],
      ['getUserMedia', navigator.mediaDevices?.getUserMedia ? 'supported' : 'unsupported'],
      ['ICE servers', String(state.iceServers.length)],
      ['TURN relay', turn ? 'configured' : 'not configured'],
      ['Signalling', window.Signal.isConnected() ? 'connected' : 'disconnected'],
    ];
  }

  function renderDiagnostics() {
    window.UI.renderDiagnostics(baseDiagnostics());
  }

  /* =======================================================================
     Misc lifecycle
     ======================================================================= */

  // Notification permission is requested explicitly from Settings → "Enable
  // call ringing", never on load — an unprompted request is dismissed by most
  // users and can permanently block the site.

  // Warn before a reload drops an active call.
  window.addEventListener('beforeunload', (e) => {
    if (window.Store.state.call) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // Best-effort hang-up so the peer is not left listening to silence.
  //
  // `pagehide` cannot distinguish a reload from a close, so it must not cancel
  // an *incoming call that is still ringing* — the user may simply be
  // reloading, or answering from a notification that reopens the page, and the
  // reconnect will re-adopt it. An answered call is different: its media dies
  // with the document, so ending it is the honest outcome. An outgoing call is
  // ended too, otherwise the callee keeps ringing for a caller who has gone.
  window.addEventListener('pagehide', () => {
    const call = window.Store.state.call;
    if (!call) return;

    const stillJustRingingIn = call.status === 'ringing' && call.direction === 'incoming';
    if (stillJustRingingIn) return;

    window.Signal.emit('call:end', { callId: call.callId, reason: 'page-closed' });
  });

  // Whichever path fires first wins; the guard makes the other a no-op.
  let booted = false;
  const bootOnce = () => { if (!booted) { booted = true; boot(); } };

  document.addEventListener('DOMContentLoaded', bootOnce);
  if (document.readyState !== 'loading') bootOnce();
}());
