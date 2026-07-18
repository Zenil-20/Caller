/* ==========================================================================
   Family map: live positions of everyone who has chosen to share with you.
   ========================================================================== */
'use strict';

window.FamilyMap = (function familyMap() {
  let map = null;
  let markers = new Map();   // userId -> { marker, circle }
  let initialised = false;

  function ensureMap() {
    if (map) return map;

    map = window.L.map('map', {
      zoomControl: true,
      attributionControl: true,
      // Touch-friendly: let a one-finger drag scroll the page, not the map.
      dragging: !window.L.Browser.mobile,
      tap: false,
    }).setView([20.5937, 78.9629], 4); // India-centred default until a fix arrives

    window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);

    return map;
  }

  /** Coloured initials pin, matching the avatar used elsewhere in the app. */
  function pinFor(user) {
    const initials = (user.displayName || user.username || '?')
      .trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();

    return window.L.divIcon({
      className: '',
      html: `<div class="map-pin" style="background:${user.avatarColor || '#4f8ef7'}">${initials}</div>`,
      iconSize: [34, 34],
      iconAnchor: [17, 17],
    });
  }

  function relativeAge(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} min ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} h ago`;
    return `${Math.floor(diff / 86400000)} d ago`;
  }

  /** Adds or moves one person's marker. */
  function upsert(entry) {
    ensureMap();
    const id = entry.userId || entry.user?.id;
    if (!id || entry.latitude == null) return;

    const pos = [entry.latitude, entry.longitude];
    const user = entry.user || { displayName: 'Unknown' };
    const existing = markers.get(id);

    if (existing) {
      existing.marker.setLatLng(pos);
      existing.circle.setLatLng(pos).setRadius(entry.accuracy || 0);
    } else {
      const marker = window.L.marker(pos, { icon: pinFor(user) }).addTo(map);
      // The accuracy halo is honest about how precise the fix actually is.
      const circle = window.L.circle(pos, {
        radius: entry.accuracy || 0,
        color: user.avatarColor || '#4f8ef7',
        weight: 1,
        opacity: 0.5,
        fillOpacity: 0.12,
      }).addTo(map);
      markers.set(id, { marker, circle });
    }

    const m = markers.get(id);
    m.marker.bindPopup(
      `<strong>${escapeHtml(user.displayName || user.username)}</strong><br>`
      + `${relativeAge(entry.recordedAt)}`
      + (entry.accuracy ? `<br>±${Math.round(entry.accuracy)} m` : ''),
    );
  }

  function escapeHtml(v) {
    return String(v ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function remove(userId) {
    const m = markers.get(userId);
    if (!m) return;
    map.removeLayer(m.marker);
    map.removeLayer(m.circle);
    markers.delete(userId);
  }

  /** Replaces everything currently plotted. */
  function render(entries) {
    ensureMap();
    const seen = new Set();
    entries.forEach((e) => {
      const id = e.userId || e.user?.id;
      if (id) { seen.add(id); upsert(e); }
    });
    Array.from(markers.keys()).filter((id) => !seen.has(id)).forEach(remove);

    if (!initialised && entries.length) {
      initialised = true;
      fitAll();
    }
  }

  /** Zooms to include everyone currently on the map. */
  function fitAll() {
    if (!map || markers.size === 0) return;
    const group = window.L.featureGroup(Array.from(markers.values()).map((m) => m.marker));
    map.fitBounds(group.getBounds().pad(0.25), { maxZoom: 16 });
  }

  function focus(userId) {
    const m = markers.get(userId);
    if (!m) return;
    map.setView(m.marker.getLatLng(), 16);
    m.marker.openPopup();
  }

  /**
   * Leaflet measures the container when it is created. Because the map lives
   * on a hidden tab, it has zero height at that point and renders blank until
   * told to re-measure.
   */
  function refresh() {
    if (map) setTimeout(() => map.invalidateSize(), 60);
  }

  function reset() {
    markers.forEach(({ marker, circle }) => {
      map?.removeLayer(marker);
      map?.removeLayer(circle);
    });
    markers = new Map();
    initialised = false;
  }

  return { ensureMap, render, upsert, remove, fitAll, focus, refresh, reset, relativeAge };
}());
