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

  // ---------------------------------------------------------- silence
  // Thresholds (full-scale = 1.0). Chosen from measurements on real hardware
  // (Ed's PC, 2026-09-23): a device-muted webcam mic delivers exact digital
  // zeros (peak 0); a live laptop mic in a QUIET room idles at peak ~0.02 /
  // RMS ~0.005; normal speech runs RMS 0.03-0.3.
  //  - PREFLIGHT_PEAK 0.001 (-60 dBFS): a live mic's noise floor never falls
  //    below this, so a ~1 s window under it means muted/dead hardware, not a
  //    quiet room. No false alarm for a quiet but working mic.
  //  - A recording is "audible" when at least ACTIVE_MIN_FRACTION of its 50 ms
  //    windows reach RMS 0.01 (-40 dBFS): above quiet-room noise (~0.005),
  //    well below speech. 1% of a 36 s note = ~0.4 s of sound.
  //  - DEAD_MIC_SECONDS: while recording, input continuously under
  //    PREFLIGHT_PEAK (sampled every 50 ms, not spot-checked) this long means
  //    the mic went dead/muted mid-recording. Quick Note uses 5 s; meetings use
  //    15 s because boards pause and some USB mics noise-gate to true silence.
  const SILENCE = { PREFLIGHT_PEAK: 0.001, PREFLIGHT_MS: 1200, WINDOW_S: 0.05, ACTIVE_WINDOW_RMS: 0.01, ACTIVE_MIN_FRACTION: 0.01, DEAD_MIC_SECONDS: 5, MEETING_DEAD_MIC_SECONDS: 15 };

  // Energy of decoded audio: peak, RMS and the fraction of 50 ms windows with
  // audible sound (loudest channel).
  function audioStats(ab) {
    let peak = 0, sumsq = 0, n = 0, bestActive = 0, windows = 0;
    const win = Math.max(1, Math.round(ab.sampleRate * SILENCE.WINDOW_S));
    for (let c = 0; c < ab.numberOfChannels; c++) {
      const d = ab.getChannelData(c);
      let active = 0, count = 0;
      for (let s = 0; s < d.length; s += win) {
        let q = 0; const e = Math.min(d.length, s + win);
        for (let i = s; i < e; i++) { const v = d[i]; q += v * v; const a = v < 0 ? -v : v; if (a > peak) peak = a; }
        sumsq += q; n += e - s; count++;
        if (Math.sqrt(q / (e - s)) >= SILENCE.ACTIVE_WINDOW_RMS) active++;
      }
      windows = count;
      if (active > bestActive) bestActive = active;
    }
    const activeFraction = windows ? bestActive / windows : 0;
    return { peak: +peak.toFixed(5), rms: +Math.sqrt(sumsq / Math.max(1, n)).toFixed(5), activeFraction: +activeFraction.toFixed(4), audible: activeFraction >= SILENCE.ACTIVE_MIN_FRACTION };
  }

  // Is this recording playable on its own on this device, and does it contain
  // audible sound? Decoding alone is not enough: a muted mic produces a file
  // that decodes and plays perfectly, in total silence (Ed 2026-09-23).
  async function checkPlayable(buf) {
    let decode;
    try {
      const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const ctx = new Ctx(1, 44100, 44100);
      const ab = await new Promise((res, rej) => { const p = ctx.decodeAudioData(buf.slice(0), res, rej); if (p && p.then) p.then(res, rej); });
      decode = { ok: true, seconds: +ab.duration.toFixed(2), ...audioStats(ab) };
    } catch (e) { decode = { ok: false, error: (e && e.message) || String(e) }; }
    return decode;
  }

  // ------------------------------------------------------ microphones
  // "Default - Microphone (EMEET SmartCam Nova 4K) (328f:00af)" -> "EMEET SmartCam Nova 4K"
  function friendlyMicName(label) {
    let s = String(label || '').replace(/^(Default|Communications)\s*-\s*/i, '').replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '').trim();
    const m = s.match(/^Microphone(?: Array)?\s*\((.+)\)$/i);
    if (m) s = m[1].trim();
    return s || 'Default microphone';
  }
  async function listMics() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
    const devs = await navigator.mediaDevices.enumerateDevices();
    return devs.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications')
      .map((d) => ({ deviceId: d.deviceId, label: d.label, name: d.deviceId === 'default' ? `System default${d.label ? ' (' + friendlyMicName(d.label) + ')' : ''}` : friendlyMicName(d.label) }));
  }
  function savedMic(key) { try { return localStorage.getItem(key) || ''; } catch (_) { return ''; } }
  function rememberMic(key, deviceId) { try { if (deviceId) localStorage.setItem(key, deviceId); else localStorage.removeItem(key); } catch (_) {} }

  // Open the chosen mic. If that device is gone, fall back to the system
  // default and report it (fellBack), never silently.
  async function openMic(deviceId, audio) {
    const specific = deviceId && deviceId !== 'default';
    let stream, fellBack = false;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: specific ? { ...audio, deviceId: { exact: deviceId } } : { ...audio } }); }
    catch (e) {
      if (!(specific && /Overconstrained|NotFound/i.test(e.name || ''))) throw e;
      stream = await navigator.mediaDevices.getUserMedia({ audio: { ...audio } }); fellBack = true;
    }
    const track = stream.getAudioTracks()[0];
    const settings = (track && track.getSettings && track.getSettings()) || {};
    return { stream, track, label: track ? track.label : '', name: friendlyMicName(track && track.label), deviceId: settings.deviceId || deviceId || 'default', fellBack };
  }

  // Live input level from a MediaStream. Records nothing, plays nothing.
  function levelMeter(stream) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser(); an.fftSize = 2048;
    const sink = ctx.createGain(); sink.gain.value = 0;   // keeps Safari pulling audio; outputs silence
    src.connect(an); an.connect(sink); sink.connect(ctx.destination);
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const buf = new Float32Array(an.fftSize);
    return {
      read() { an.getFloatTimeDomainData(buf); let p = 0, q = 0; for (let i = 0; i < buf.length; i++) { const v = buf[i]; q += v * v; const a = v < 0 ? -v : v; if (a > p) p = a; } return { peak: p, rms: Math.sqrt(q / buf.length) }; },
      close() { try { src.disconnect(); ctx.close(); } catch (_) {} },
    };
  }

  // ~1 s check BEFORE recording: muted, not live, or dead silent?
  async function preflightMic(mic, ms) {
    const t = mic.track;
    const out = { name: mic.name, muted: !!(t && t.muted), readyState: t ? t.readyState : 'none', peak: 0, rms: 0, ok: false, reason: null };
    if (!t || t.readyState !== 'live') { out.reason = 'not_live'; return out; }
    const meter = levelMeter(mic.stream);
    let sumsq = 0, n = 0;
    const end = Date.now() + (ms || SILENCE.PREFLIGHT_MS);
    while (Date.now() < end) { const r = meter.read(); if (r.peak > out.peak) out.peak = r.peak; sumsq += r.rms * r.rms; n++; await new Promise((res) => setTimeout(res, 40)); }
    meter.close();
    out.rms = +Math.sqrt(sumsq / Math.max(1, n)).toFixed(5);
    out.peak = +out.peak.toFixed(5);
    out.muted = !!t.muted;
    if (out.muted) out.reason = 'muted';
    else if (out.peak < SILENCE.PREFLIGHT_PEAK) out.reason = 'no_signal';
    else out.ok = true;
    return out;
  }
  function micProblemMessage(name) { return `${name || 'The selected microphone'} is muted or no sound is being detected. Choose another microphone or unmute it.`; }
  const MIC_RETRY_HINT = 'If this microphone is working, say a few words and try again.';

  // Continuous dead-mic watch: samples the meter every 50 ms and reports how
  // long the input has stayed under PREFLIGHT_PEAK (0 when sound is present).
  function deadMicWatch(meter) {
    let since = null, lastLevel = { peak: 0, rms: 0 };
    const t = setInterval(() => {
      lastLevel = meter.read();
      if (lastLevel.peak < SILENCE.PREFLIGHT_PEAK) { if (!since) since = Date.now(); } else since = null;
    }, 50);
    return { silentMs() { return since ? Date.now() - since : 0; }, level() { return lastLevel; }, stop() { clearInterval(t); } };
  }
  const NO_SOUND_MESSAGE = 'No audible sound was detected in this recording.';

  async function loadCommunities() {
    const r = await fetch('/api/communities', { credentials: 'same-origin' });
    if (!r.ok) throw new Error(`communities HTTP ${r.status}`);
    const j = await r.json();
    return (j.communities || []).filter((c) => c.active !== false).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  window.TrustedAudio = { MIME_CANDIDATES, supportedMimes, pickMime, sha256Hex, newId, hms, ms2mmss, esc, openDb, wakeLocker, checkPlayable, loadCommunities,
    SILENCE, audioStats, friendlyMicName, listMics, savedMic, rememberMic, openMic, levelMeter, preflightMic, micProblemMessage, MIC_RETRY_HINT, NO_SOUND_MESSAGE, deadMicWatch };
})();
