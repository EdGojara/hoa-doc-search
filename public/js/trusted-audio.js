// ============================================================================
// public/js/trusted-audio.js  (Ed 2026-09-22)
// ----------------------------------------------------------------------------
// Small shared helpers for Trusted's audio-capture pages
// (/meeting-recorder.html, /quick-note.html). Plain browser script, exposes
// window.TrustedAudio. No dependencies, no network calls.
// ============================================================================
(function () {
  'use strict';

  // Same candidate order as index.html quickPickAudioMime() and
  // ask-ed-chat pickAudioMime(): Chrome/Android -> webm/opus, iPhone -> mp4/aac.
  const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/mp4;codecs=mp4a.40.2', 'audio/ogg;codecs=opus'];

  function supportedMimes() {
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return [];
    return MIME_CANDIDATES.filter((m) => { try { return MediaRecorder.isTypeSupported(m); } catch (_) { return false; } });
  }
  function pickMime() { return supportedMimes()[0] || ''; }

  async function sha256Hex(buf) {
    const d = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function newId() {
    const a = new Uint8Array(12); crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 20);
  }

  const pad = (n, w = 2) => String(n).padStart(w, '0');
  function hms(ms) { const s = Math.max(0, Math.floor(ms / 1000)); return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`; }
  function ms2mmss(ms) { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${pad(s % 60)}`; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // IndexedDB wrapper. Persist ArrayBuffers + MIME type, never Blobs: iOS
  // WebKit intermittently fails to store Blobs in IndexedDB (same lesson as the
  // inspection-photo queue in index.html, Ed 2026-08-31).
  function openDb(name, version, upgrade) {
    let dbp = null;
    const open = () => dbp || (dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(name, version);
      req.onupgradeneeded = (e) => upgrade(e.target.result, e.oldVersion);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
    const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    async function tx(store, mode, fn) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        let out;
        Promise.resolve(fn(t.objectStore(store))).then((r) => { out = r; });
        t.oncomplete = () => resolve(out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('transaction aborted'));
      });
    }
    return {
      put: (store, row) => tx(store, 'readwrite', (s) => reqP(s.put(row))),
      get: (store, key) => tx(store, 'readonly', (s) => reqP(s.get(key))),
      all: (store) => tx(store, 'readonly', (s) => reqP(s.getAll())),
      byIndex: (store, index, value) => tx(store, 'readonly', (s) => reqP(s.index(index).getAll(value))),
      del: (store, key) => tx(store, 'readwrite', (s) => reqP(s.delete(key))),
    };
  }

  // Screen Wake Lock with automatic re-acquire when the page becomes visible.
  function wakeLocker(onEvent) {
    let lock = null, wanted = false;
    async function acquire() {
      if (!wanted || lock || !('wakeLock' in navigator)) return;
      try {
        lock = await navigator.wakeLock.request('screen');
        onEvent && onEvent('wakelock_acquired');
        lock.addEventListener('release', () => { lock = null; if (wanted) onEvent && onEvent('wakelock_released'); });
      } catch (e) { onEvent && onEvent('wakelock_failed', e.message); }
    }
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') acquire(); });
    return {
      supported: 'wakeLock' in navigator,
      on() { wanted = true; return acquire(); },
      async off() { wanted = false; if (lock) { try { await lock.release(); } catch (_) {} lock = null; } },
      get active() { return !!lock; },
    };
  }

  // Is this recording playable on its own on this device?
  async function checkPlayable(buf, mime) {
    let decode;
    try {
      const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const ctx = new Ctx(1, 44100, 44100);
      const ab = await new Promise((res, rej) => { const p = ctx.decodeAudioData(buf.slice(0), res, rej); if (p && p.then) p.then(res, rej); });
      decode = { ok: true, seconds: +ab.duration.toFixed(2) };
    } catch (e) { decode = { ok: false, error: (e && e.message) || String(e) }; }
    return decode;
  }

  async function loadCommunities() {
    const r = await fetch('/api/communities', { credentials: 'same-origin' });
    if (!r.ok) throw new Error(`communities HTTP ${r.status}`);
    const j = await r.json();
    return (j.communities || []).filter((c) => c.active !== false).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  window.TrustedAudio = { MIME_CANDIDATES, supportedMimes, pickMime, sha256Hex, newId, hms, ms2mmss, esc, openDb, wakeLocker, checkPlayable, loadCommunities };
})();
