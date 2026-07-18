/* ==========================================================================
   DOM rendering. Reads from Store, writes to the page. No network calls here.
   ========================================================================== */
'use strict';

window.UI = (function ui() {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  /* ---------------------------------------------------------------------
     Formatting
     --------------------------------------------------------------------- */

  function initials(name) {
    if (!name) return '?';
    return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
  }

  function duration(seconds) {
    const total = Math.max(0, Math.floor(seconds || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  function relativeTime(value) {
    if (!value) return '';
    const then = new Date(value);
    const diff = Date.now() - then.getTime();

    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} min ago`;

    const isToday = then.toDateString() === new Date().toDateString();
    if (isToday) return then.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    if (then.toDateString() === yesterday.toDateString()) {
      return `Yesterday ${then.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }

    return then.toLocaleDateString([], { day: 'numeric', month: 'short' });
  }

  function lastSeenText(user) {
    if (user.isBusy) return 'On another call';
    if (user.isOnline) return 'Online';
    if (!user.lastSeen) return 'Offline';
    return `Last seen ${relativeTime(user.lastSeen)}`;
  }

  /** Escapes text before it goes anywhere near innerHTML. */
  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function callLabel(call) {
    const arrow = call.direction === 'outgoing' ? '↗' : '↙';
    const map = {
      ended: `${arrow} ${duration(call.duration)}`,
      missed: '↙ Missed',
      cancelled: call.direction === 'outgoing' ? '↗ Cancelled' : '↙ Missed',
      rejected: call.direction === 'outgoing' ? '↗ Declined' : '↙ Declined',
      busy: '↗ Busy',
      unavailable: '↗ Unavailable',
      failed: '⚠ Failed',
      ringing: '● Ringing',
      active: '● In progress',
    };
    return map[call.status] || `${arrow} ${call.status}`;
  }

  /* ---------------------------------------------------------------------
     Screens & navigation
     --------------------------------------------------------------------- */

  function showScreen(id) {
    $$('.screen').forEach((el) => el.classList.toggle('is-active', el.id === id));
  }

  function showPage(name) {
    $$('.page').forEach((el) => el.classList.toggle('is-active', el.id === `page-${name}`));
    $$('.tabbar__btn').forEach((el) => el.classList.toggle('is-active', el.dataset.page === name));
  }

  function setLoading(on) {
    $('#overlay-loading').hidden = !on;
  }

  function toast(message, kind = '') {
    const el = document.createElement('div');
    el.className = `toast${kind ? ` toast--${kind}` : ''}`;
    el.textContent = message;
    $('#toasts').appendChild(el);

    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity .25s';
      setTimeout(() => el.remove(), 260);
    }, 3600);
  }

  /* ---------------------------------------------------------------------
     Shared row builder
     --------------------------------------------------------------------- */

  function avatarNode(user, size = '') {
    const el = document.createElement('div');
    el.className = `avatar${size ? ` avatar--${size}` : ''}`;
    el.textContent = initials(user.displayName || user.username);
    el.style.background = user.avatarColor || '#4f8ef7';
    el.dataset.online = String(Boolean(user.isOnline));
    return el;
  }

  /**
   * Builds one list row. `actions` is a list of
   * { icon, title, className, onClick, disabled }.
   */
  function buildRow({ user, metaHtml, actions = [], onClick }) {
    const li = document.createElement('li');
    li.className = 'row';
    li.dataset.userId = user.id;

    li.appendChild(avatarNode(user));

    const body = document.createElement('div');
    body.className = 'row__body';
    body.innerHTML = `
      <div class="row__name">${esc(user.displayName || user.username)}</div>
      <div class="row__meta">${metaHtml}</div>`;
    li.appendChild(body);

    if (onClick) {
      body.style.cursor = 'pointer';
      body.addEventListener('click', () => onClick(user));
    }

    if (actions.length) {
      const wrap = document.createElement('div');
      wrap.className = 'row__actions';
      actions.forEach((action) => {
        const btn = document.createElement('button');
        btn.className = `icon-btn ${action.className || ''}`;
        btn.textContent = action.icon;
        btn.title = action.title || '';
        btn.disabled = Boolean(action.disabled);
        btn.addEventListener('click', (e) => { e.stopPropagation(); action.onClick(user); });
        wrap.appendChild(btn);
      });
      li.appendChild(wrap);
    }

    return li;
  }

  /* ---------------------------------------------------------------------
     Renderers
     --------------------------------------------------------------------- */

  function renderIdentity(user) {
    if (!user) return;
    const avatar = $('#my-avatar');
    avatar.textContent = initials(user.displayName || user.username);
    avatar.style.background = user.avatarColor || '#4f8ef7';
    $('#my-name').textContent = user.displayName || user.username;
    $('#my-handle').textContent = `@${user.username}`;
  }

  function renderConnection(state) {
    const pill = $('#conn-pill');
    pill.dataset.state = state;
    pill.querySelector('[data-label]').textContent = {
      connecting: 'Connecting…',
      online: 'Online',
      offline: 'Offline',
    }[state] || state;
  }

  function renderContacts(contacts, { onCall, onRemove }) {
    const list = $('#list-contacts');
    list.innerHTML = '';
    $('#empty-contacts').hidden = contacts.length > 0;

    contacts.forEach((user) => {
      list.appendChild(buildRow({
        user,
        metaHtml: `<span class="presence" data-online="${Boolean(user.isOnline)}" data-busy="${Boolean(user.isBusy)}">${esc(lastSeenText(user))}</span>`,
        actions: [
          { icon: '📞', title: 'Call', className: 'icon-btn--call', onClick: onCall, disabled: !user.isOnline },
          { icon: '✕', title: 'Remove contact', className: 'icon-btn--remove', onClick: onRemove },
        ],
      }));
    });
  }

  function renderSearch(results, { onCall, onAdd, contactIds }) {
    const wrap = $('#search-results-wrap');
    const list = $('#list-search');
    list.innerHTML = '';

    if (results === null) { wrap.hidden = true; return; }

    wrap.hidden = false;
    $('#empty-search').hidden = results.length > 0;

    results.forEach((user) => {
      const alreadyAdded = contactIds.has(user.id);
      list.appendChild(buildRow({
        user,
        metaHtml: `@${esc(user.username)} · <span class="presence" data-online="${Boolean(user.isOnline)}">${esc(lastSeenText(user))}</span>`,
        actions: [
          {
            icon: alreadyAdded ? '✓' : '＋',
            title: alreadyAdded ? 'Already in contacts' : 'Add to contacts',
            onClick: onAdd,
            disabled: alreadyAdded,
          },
          { icon: '📞', title: 'Call', className: 'icon-btn--call', onClick: onCall, disabled: !user.isOnline },
        ],
      }));
    });
  }

  function renderRecents(recents, { onCall }) {
    const list = $('#list-recents');
    list.innerHTML = '';
    $('#empty-recents').hidden = recents.length > 0;

    recents.forEach((entry) => {
      const missed = entry.missed;
      const meta = `<span class="${missed ? 'is-missed' : ''}">${esc(callLabel(entry))}</span> · ${esc(relativeTime(entry.startedAt))}`;

      list.appendChild(buildRow({
        user: entry.peer,
        metaHtml: meta,
        actions: [{ icon: '📞', title: 'Call back', className: 'icon-btn--call', onClick: () => onCall(entry.peer) }],
      }));
    });
  }

  function renderStats(stats) {
    const strip = $('#stats-strip');
    if (!stats) { strip.innerHTML = ''; return; }

    strip.innerHTML = `
      <div class="stats-strip__item"><b>${stats.totalCalls}</b><span>Calls</span></div>
      <div class="stats-strip__item"><b>${duration(stats.totalSeconds)}</b><span>Talk time</span></div>
      <div class="stats-strip__item"><b>${stats.missedCalls}</b><span>Missed</span></div>`;
  }

  function renderMissedBadge(count) {
    const badge = $('#badge-missed');
    badge.hidden = !count;
    badge.textContent = count > 99 ? '99+' : String(count);
  }

  /* ---------------------------------------------------------------------
     Call screens
     --------------------------------------------------------------------- */

  function renderIncoming(peer) {
    const avatar = $('#incoming-avatar');
    avatar.textContent = initials(peer.displayName || peer.username);
    avatar.style.background = peer.avatarColor || '#4f8ef7';
    $('#incoming-name').textContent = peer.displayName || peer.username;
    $('#incoming-handle').textContent = `@${peer.username}`;
  }

  function renderCallPeer(peer) {
    const avatar = $('#call-avatar');
    avatar.textContent = initials(peer.displayName || peer.username);
    avatar.style.background = peer.avatarColor || '#4f8ef7';
    $('#call-name').textContent = peer.displayName || peer.username;
  }

  function setCallStatus(text) {
    $('#call-status').textContent = text;
  }

  function setCallTimer(seconds) {
    const el = $('#call-timer');
    el.hidden = seconds === null;
    if (seconds !== null) el.textContent = duration(seconds);
  }

  function setQuality(sample) {
    const el = $('#call-quality');
    if (!sample) { el.hidden = true; return; }

    el.hidden = false;
    el.dataset.rating = sample.rating;

    const label = {
      excellent: 'Excellent',
      good: 'Good connection',
      fair: 'Fair connection',
      poor: 'Poor connection',
      unknown: 'Checking…',
    }[sample.rating] || 'Checking…';

    el.querySelector('[data-label]').textContent = sample.connectionType === 'relay'
      ? `${label} · relayed`
      : label;
  }

  function setStatsPanel(sample, visible) {
    const el = $('#stats-panel');
    el.hidden = !visible;
    if (!visible || !sample) return;

    el.textContent = [
      `codec        ${sample.codec || 'opus @ 48kHz'}`,
      `round trip   ${sample.rttMs} ms`,
      `jitter       ${sample.jitterMs} ms`,
      `packet loss  ${sample.packetLossPct}%`,
      `path         ${sample.connectionType || 'unknown'}`,
      `rating       ${sample.rating}`,
    ].join('\n');
  }

  function setVuMeter({ local, remote, localSpeaking, remoteSpeaking }) {
    $('#vu-meter').hidden = false;
    if (local !== undefined) {
      const bar = $('#vu-local');
      bar.style.width = `${local}%`;
      bar.classList.toggle('is-speaking', Boolean(localSpeaking));
    }
    if (remote !== undefined) {
      const bar = $('#vu-remote');
      bar.style.width = `${remote}%`;
      bar.classList.toggle('is-speaking', Boolean(remoteSpeaking));
    }
  }

  function hideVuMeter() { $('#vu-meter').hidden = true; }

  function setControlActive(id, active) {
    const btn = document.getElementById(id);
    if (btn) btn.classList.toggle('is-on', active);
  }

  function setMuteButton(muted) {
    setControlActive('btn-mute', muted);
    $('#btn-mute .ctrl__icon').textContent = muted ? '🔇' : '🎤';
    // Label reads as the action the button performs next.
    $('#btn-mute .ctrl__label').textContent = muted ? 'Unmute' : 'Mute';
  }

  function setSpeakerButton(on) {
    setControlActive('btn-speaker', on);
    $('#btn-speaker .ctrl__icon').textContent = on ? '🔊' : '🔈';
    $('#btn-speaker .ctrl__label').textContent = on ? 'Speaker on' : 'Speaker';
  }

  function setPeerState(text) {
    const el = $('#peer-state');
    el.hidden = !text;
    el.textContent = text || '';
  }

  function renderDiagnostics(entries) {
    const dl = $('#diagnostics');
    dl.innerHTML = entries
      .map(([key, value]) => `<div><dt>${esc(key)}</dt><dd>${esc(value)}</dd></div>`)
      .join('');
  }

  function renderSettings(user) {
    if (!user) return;
    $('#set-displayName').value = user.displayName || '';
    $('#set-about').value = user.about || '';

    const settings = user.settings || {};
    ['echoCancellation', 'noiseSuppression', 'autoGainControl', 'ringtoneEnabled', 'vibrationEnabled']
      .forEach((key) => {
        const el = document.getElementById(`set-${key}`);
        if (el) el.checked = settings[key] !== false;
      });
  }

  function setFormError(formId, message) {
    const el = document.querySelector(`#${formId} [data-error]`);
    if (el) el.textContent = message || '';
  }

  return {
    $, $$, esc, initials, duration, relativeTime, lastSeenText, callLabel,
    showScreen, showPage, setLoading, toast,
    renderIdentity, renderConnection, renderContacts, renderSearch, renderRecents,
    renderStats, renderMissedBadge, renderDiagnostics, renderSettings,
    renderIncoming, renderCallPeer, setCallStatus, setCallTimer, setQuality,
    setStatsPanel, setVuMeter, hideVuMeter, setMuteButton, setSpeakerButton,
    setPeerState, setFormError,
  };
}());
