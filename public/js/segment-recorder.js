// ============================================================================
// public/js/segment-recorder.js  (Ed 2026-09-22)
// ----------------------------------------------------------------------------
// Long-form, reliability-first recording engine for /meeting-recorder.html.
// Extracted from the Phase 0 spike (public/meeting-recorder-spike.html, left
// untouched as the diagnostic harness). Requires window.TrustedAudio.
//
//   - Rotating MediaRecorders: each ~segMs segment is a complete, independently
//     playable file. The next recorder starts overlapMs BEFORE the previous one
//     stops, so rotation never drops audio (measured: ~0.4s duplicated, 0 lost;
//     stop-then-start loses 80-220ms per boundary).
//   - The in-flight segment is re-saved every 5s, so a reload/crash loses <=5s.
//   - Everything is persisted to IndexedDB (ArrayBuffer + MIME) before any
//     upload; SHA-256 per segment.
//   - Interruptions (mic muted/ended, page hidden/frozen, timer stalls,
//     recorder death) become explicit events; a user Pause is recorded
//     separately from an interruption.
//   - Optional uploader (opts.uploadUrl): a 404 means "server side not enabled"
//     and everything simply stays on this device.
// ============================================================================
(function () {
  'use strict';
  const TA = window.TrustedAudio;
  const PARTIAL_MS = 5000;

  function createSegmentRecorder(opts) {
    const segMs = opts.segMs || 30000;
    const overlapMs = opts.overlapMs == null ? 500 : opts.overlapMs;
    const onChange = opts.onChange || (() => {});
    const onEvent = opts.onEvent || (() => {});
    const db = TA.openDb(opts.dbName || 'trusted_meeting_recorder', 1, (d) => {
      if (!d.objectStoreNames.contains('sessions')) d.createObjectStore('sessions', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('segments')) d.createObjectStore('segments', { keyPath: 'key' }).createIndex('session', 'session_id');
      if (!d.objectStoreNames.contains('partials')) d.createObjectStore('partials', { keyPath: 'key' }).createIndex('session', 'session_id');
      if (!d.objectStoreNames.contains('events')) d.createObjectStore('events', { keyPath: 'id', autoIncrement: true }).createIndex('session', 'session_id');
    });
    const segKey = (sid, seq) => `${sid}:${String(seq).padStart(6, '0')}`;
    const strip = (r) => { const { buf, ...rest } = r; return rest; };

    const S = { session: null, stream: null, track: null, active: null, recording: false, paused: false, pausedAt: null,
      interrupted: false, rotateTimer: null, tickTimer: null, lastTick: 0, uploadMode: 'unknown',
      meter: null, watch: null, micMuted: false, noSound: false };
    const deadMicMs = (opts.deadMicSeconds || TA.SILENCE.MEETING_DEAD_MIC_SECONDS) * 1000;
    // Meeting-recording mic settings: raw room sound (no echo cancel / noise suppression).
    const AUDIO = { echoCancellation: false, noiseSuppression: false, autoGainControl: true, channelCount: 1 };
    const wake = TA.wakeLocker((kind, err) => log(kind, err ? { error: err } : {}, kind === 'wakelock_released' ? 'warn' : 'info'));

    async function log(kind, detail = {}, level = 'info') {
      const ev = { session_id: S.session ? S.session.id : null, kind, level, wall_ms: Date.now(),
        elapsed_ms: S.session ? Date.now() - S.session.started_wall : null, ...detail };
      try { await db.put('events', ev); } catch (_) {}
      onEvent(ev);
    }
    const saveSession = () => (S.session ? db.put('sessions', S.session).catch(() => {}) : Promise.resolve());

    // ----------------------------------------------------------- segments
    async function savePartial(seg) {
      if (!S.session || !seg.startedAt) return;
      try {
        const buf = await new Blob(seg.chunks, { type: seg.rec.mimeType || S.session.mime }).arrayBuffer();
        await db.put('partials', { key: segKey(S.session.id, seg.seq), session_id: S.session.id, seq: seg.seq, started_wall: seg.startedAt, updated_wall: Date.now(), mime: seg.rec.mimeType || S.session.mime, buf });
      } catch (_) {}
    }
    function startSegment() {
      let rec;
      try { rec = S.session.mime ? new MediaRecorder(S.stream, { mimeType: S.session.mime, audioBitsPerSecond: 32000 }) : new MediaRecorder(S.stream); }
      catch (e) { log('recorder_create_failed', { error: e.message }, 'bad'); interrupt('could not start recorder'); return null; }
      const seg = { rec, seq: S.session.next_seq++, chunks: [], startedAt: null, perfStart: null };
      rec.ondataavailable = (e) => { if (e.data && e.data.size) { seg.chunks.push(e.data); if (rec.state === 'recording') savePartial(seg); } };
      rec.onstart = () => { seg.startedAt = Date.now(); seg.perfStart = performance.now(); };
      rec.onerror = (e) => log('recorder_error', { seq: seg.seq, error: (e.error && e.error.message) || 'unknown' }, 'bad');
      rec.onstop = () => finalize(seg).catch((err) => log('segment_save_failed', { seq: seg.seq, error: err.message }, 'bad'));
      try { rec.start(PARTIAL_MS); } catch (e) { log('recorder_start_failed', { error: e.message }, 'bad'); interrupt('recorder failed to start'); return null; }
      saveSession();
      return seg;
    }
    function scheduleRotation() { clearTimeout(S.rotateTimer); S.rotateTimer = setTimeout(rotate, segMs); }
    function rotate() {
      if (!S.recording || S.interrupted || S.paused) return;
      const prev = S.active;
      const next = startSegment();
      if (!next) return;
      S.active = next;
      setTimeout(() => { try { if (prev && prev.rec.state !== 'inactive') prev.rec.stop(); } catch (_) {} }, overlapMs);
      scheduleRotation();
    }
    async function finalize(seg) {
      const blob = new Blob(seg.chunks, { type: seg.rec.mimeType || S.session.mime || 'audio/webm' });
      if (!blob.size) { log('empty_segment', { seq: seg.seq }, 'bad'); return; }
      const buf = await blob.arrayBuffer();
      const row = { key: segKey(S.session.id, seg.seq), session_id: S.session.id, seq: seg.seq, started_wall: seg.startedAt, ended_wall: Date.now(),
        wall_ms: seg.perfStart != null ? Math.round(performance.now() - seg.perfStart) : null, mime: blob.type, bytes: buf.byteLength,
        sha256: await TA.sha256Hex(buf), buf, status: 'pending', attempts: 0, next_attempt_at: 0, decode: null };
      await db.put('segments', row);
      db.del('partials', row.key).catch(() => {});
      TA.checkPlayable(buf).then(async (decode) => {
        const cur = await db.get('segments', row.key); if (cur) { cur.decode = decode; await db.put('segments', cur); }
        if (!decode.ok) log('segment_not_playable', { seq: row.seq, error: decode.error }, 'bad');
        else if (row.wall_ms && decode.seconds * 1000 < row.wall_ms - 1500) log('audio_shorter_than_expected', { seq: row.seq, audio_s: decode.seconds, wall_s: +(row.wall_ms / 1000).toFixed(1) }, 'warn');
        onChange();
      });
      onChange(); pump();
    }

    // ------------------------------------------------------------ upload
    let pumping = false;
    async function pump() {
      if (!opts.uploadUrl || pumping) return; pumping = true;
      try {
        const rows = (await db.all('segments')).filter((r) => r.status === 'pending' && (r.next_attempt_at || 0) <= Date.now()).sort((a, b) => a.started_wall - b.started_wall);
        for (const r of rows) {
          if (!navigator.onLine) break;
          let res = null, body = {};
          try {
            res = await fetch(opts.uploadUrl, { method: 'POST', credentials: 'same-origin', body: r.buf,
              headers: { 'Content-Type': r.mime, 'x-spike-session': r.session_id, 'x-spike-seq': String(r.seq), 'x-spike-sha256': r.sha256 } });
            body = await res.json().catch(() => ({}));
          } catch (e) { body = { error: e.message }; }
          const cur = await db.get('segments', r.key); if (!cur) continue;
          if (res && res.ok) { S.uploadMode = 'uploading'; cur.status = 'uploaded'; cur.uploaded_at = Date.now(); }
          else if (res && res.status === 404) { S.uploadMode = 'local'; break; }
          else if (res && (res.status === 409 || res.status === 422)) { cur.status = 'rejected'; cur.error = body.error; log('upload_rejected', { seq: cur.seq, error: body.error }, 'bad'); }
          else { cur.attempts++; cur.next_attempt_at = Date.now() + Math.min(60000, 1000 * 2 ** cur.attempts) * (0.8 + Math.random() * 0.4); }
          await db.put('segments', cur);
          onChange();
        }
      } finally { pumping = false; }
    }
    if (opts.uploadUrl) { setInterval(pump, 4000); window.addEventListener('online', pump); } else { S.uploadMode = 'local'; }

    // --------------------------------------------------- interruptions
    function interrupt(reason) {
      if (S.interrupted) return;
      S.interrupted = true; clearTimeout(S.rotateTimer);
      try { if (S.active && S.active.rec.state !== 'inactive') S.active.rec.stop(); } catch (_) {}
      if (S.session) { S.session.status = 'interrupted'; saveSession(); }
      log('recording_interrupted', { reason }, 'bad');
      onChange();
    }
    function tick() {
      const now = Date.now();
      if (S.recording && now - S.lastTick > 3000) log('page_was_frozen', { frozen_ms: now - S.lastTick }, 'warn');
      S.lastTick = now;
      if (S.recording && !S.interrupted && !S.paused && S.watch) {
        const silentMs = S.watch.silentMs();
        if (!S.noSound && silentMs >= deadMicMs) { S.noSound = true; log('no_sound_detected', { silent_ms: silentMs, mic: S.session && S.session.mic && S.session.mic.name }, 'bad'); }
        else if (S.noSound && silentMs === 0) { S.noSound = false; log('sound_detected_again', {}, 'warn'); }
      }
      if (S.recording && !S.interrupted && !S.paused) {
        if (S.track && S.track.readyState !== 'live') interrupt('microphone stopped');
        else if (S.active && S.active.rec.state === 'inactive') { log('recorder_restarted', {}, 'warn'); S.active = startSegment(); scheduleRotation(); }
        if (S.session) { S.session.last_audio_wall = now; saveSession(); }
      }
      onChange();
    }
    document.addEventListener('visibilitychange', () => { if (S.recording) log(document.visibilityState === 'hidden' ? 'page_hidden' : 'page_visible', {}, document.visibilityState === 'hidden' ? 'warn' : 'info'); });
    window.addEventListener('pagehide', () => { if (S.recording) log('page_closed_or_hidden', {}, 'warn'); });
    document.addEventListener('freeze', () => { if (S.recording) log('page_frozen', {}, 'warn'); });
    window.addEventListener('beforeunload', (e) => { if (S.recording) { e.preventDefault(); e.returnValue = ''; } });

    // ----------------------------------------------------------- control
    // micOpts.mic: a mic already opened + preflight-checked by the page
    // (TrustedAudio.openMic). Without it (resume), reopen the session's mic.
    async function start(sessionFields, resumeSession, micOpts) {
      if (!window.MediaRecorder) throw new Error('This browser cannot record audio (no MediaRecorder).');
      let mic = micOpts && micOpts.mic;
      if (!mic) {
        const want = (resumeSession && resumeSession.mic && resumeSession.mic.deviceId) || (micOpts && micOpts.deviceId) || '';
        mic = await TA.openMic(want, AUDIO);
        if (mic.fellBack) log('mic_fallback_to_default', { wanted: resumeSession && resumeSession.mic && resumeSession.mic.name, using: mic.name }, 'warn');
      }
      S.stream = mic.stream;
      S.track = mic.track;
      S.micMuted = !!(S.track && S.track.muted); S.noSound = false;
      if (S.track) {
        S.track.onended = () => interrupt('microphone ended');
        S.track.onmute = () => { S.micMuted = true; log('mic_muted_by_device', { mic: mic.name }, 'bad'); onChange(); };
        S.track.onunmute = () => { S.micMuted = false; log('mic_unmuted', {}, 'info'); onChange(); };
      }
      try { if (S.watch) S.watch.stop(); if (S.meter) S.meter.close(); S.meter = TA.levelMeter(S.stream); S.watch = TA.deadMicWatch(S.meter); } catch (_) { S.meter = null; S.watch = null; }
      if (resumeSession) {
        S.session = resumeSession; S.session.status = 'recording';
        log('resumed_after_interruption', { gap_ms: Date.now() - (S.session.last_audio_wall || S.session.started_wall) }, 'warn');
      } else {
        S.session = { id: TA.newId(), started_wall: Date.now(), status: 'recording', next_seq: 0, mime: TA.pickMime(), ua: navigator.userAgent, pauses: [], ...sessionFields };
        log('recording_started', { mime: S.session.mime, mic: mic.name });
      }
      S.session.mic = { deviceId: mic.deviceId, name: mic.name };
      await saveSession();
      S.recording = true; S.interrupted = false; S.paused = false;
      S.active = startSegment(); scheduleRotation();
      clearInterval(S.tickTimer); S.lastTick = Date.now(); S.tickTimer = setInterval(tick, 1000);
      wake.on();
      onChange();
      return S.session;
    }
    async function pause() {
      if (!S.recording || S.paused || S.interrupted) return;
      S.paused = true; S.pausedAt = Date.now(); clearTimeout(S.rotateTimer);
      const cur = S.active; S.active = null;
      try { if (cur && cur.rec.state !== 'inactive') cur.rec.stop(); } catch (_) {}
      S.session.status = 'paused'; S.session.last_audio_wall = Date.now(); await saveSession();
      log('paused', {}, 'info'); onChange();
    }
    async function resume() {
      if (!S.paused) return;
      const ms = Date.now() - S.pausedAt;
      S.session.pauses = (S.session.pauses || []).concat([{ from: S.pausedAt, to: Date.now(), ms }]);
      S.paused = false; S.pausedAt = null; S.session.status = 'recording'; await saveSession();
      if (!S.track || S.track.readyState !== 'live') { interrupt('microphone ended while paused'); return; }
      log('resumed', { paused_ms: ms }, 'info');
      S.active = startSegment(); scheduleRotation(); onChange();
    }
    async function resumeAfterInterruption() {
      try { S.stream && S.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
      try { if (S.watch) S.watch.stop(); if (S.meter) S.meter.close(); } catch (_) {} S.meter = null; S.watch = null;
      S.recording = false; S.interrupted = false;
      return start(null, S.session);
    }
    async function stop() {
      if (S.paused) { S.session.pauses = (S.session.pauses || []).concat([{ from: S.pausedAt, to: Date.now(), ms: Date.now() - S.pausedAt }]); S.paused = false; }
      S.recording = false; clearTimeout(S.rotateTimer); clearInterval(S.tickTimer);
      const cur = S.active; S.active = null;
      if (cur && cur.rec.state !== 'inactive') await new Promise((res) => { cur.rec.addEventListener('stop', () => setTimeout(res, 300), { once: true }); try { cur.rec.stop(); } catch (_) { res(); } });
      try { S.stream && S.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
      try { if (S.watch) S.watch.stop(); if (S.meter) S.meter.close(); } catch (_) {} S.meter = null; S.watch = null;
      await wake.off();
      if (S.session) { S.session.status = 'stopped'; S.session.stopped_wall = Date.now(); S.session.last_audio_wall = Date.now(); await saveSession(); }
      log('recording_stopped', {}); onChange(); pump();
    }
    async function mark(kind, note) {
      if (!S.session) return;
      await log('marker', { marker: kind, note: note || null }, 'info');
      if (kind === 'exec_start') { S.session.exec_open = true; await saveSession(); }
      if (kind === 'exec_end') { S.session.exec_open = false; await saveSession(); }
      onChange();
    }

    // ----------------------------------------------------------- recovery
    async function recoverUnfinished() {
      const sessions = (await db.all('sessions')).filter((s) => ['recording', 'paused', 'interrupted'].includes(s.status));
      const out = [];
      for (const s of sessions) {
        for (const pr of await db.byIndex('partials', 'session', s.id)) {
          if (await db.get('segments', pr.key)) { await db.del('partials', pr.key); continue; }
          const row = { key: pr.key, session_id: s.id, seq: pr.seq, started_wall: pr.started_wall, ended_wall: pr.updated_wall, wall_ms: pr.updated_wall - pr.started_wall,
            mime: pr.mime, bytes: pr.buf.byteLength, sha256: await TA.sha256Hex(pr.buf), buf: pr.buf, status: 'pending', attempts: 0, next_attempt_at: 0, decode: null, partial: true };
          row.decode = await TA.checkPlayable(pr.buf);
          await db.put('segments', row); await db.del('partials', pr.key);
          await db.put('events', { session_id: s.id, kind: 'partial_segment_recovered', level: 'warn', wall_ms: Date.now(), seq: pr.seq, recovered_s: +((row.wall_ms) / 1000).toFixed(1) });
        }
        const segs = await db.byIndex('segments', 'session', s.id);
        const have = new Set(segs.map((x) => x.seq));
        for (let q = 0; q < (s.next_seq || 0); q++) if (!have.has(q)) await db.put('events', { session_id: s.id, kind: 'segment_lost_on_reload', level: 'bad', wall_ms: Date.now(), seq: q });
        await db.put('events', { session_id: s.id, kind: 'page_reloaded_during_recording', level: 'bad', wall_ms: Date.now(), gap_from: s.last_audio_wall || null });
        s.status = 'interrupted'; await db.put('sessions', s);
        out.push({ session: s, segments: segs.length, pending: segs.filter((x) => x.status === 'pending').length });
      }
      pump();
      return out;
    }
    function adopt(session) { S.session = session; S.recording = true; S.interrupted = true; onChange(); }
    async function finishRecovered(session) { session.status = 'stopped'; session.stopped_wall = session.last_audio_wall || Date.now(); await db.put('sessions', session); if (S.session && S.session.id === session.id) { S.recording = false; S.interrupted = false; } onChange(); }

    async function snapshot() {
      if (!S.session) return null;
      const segs = (await db.byIndex('segments', 'session', S.session.id)).map(strip).sort((a, b) => a.seq - b.seq);
      const events = (await db.byIndex('events', 'session', S.session.id)).sort((a, b) => a.wall_ms - b.wall_ms);
      return { session: S.session, segments: segs, events };
    }
    async function listSessions() { return (await db.all('sessions')).sort((a, b) => b.started_wall - a.started_wall); }
    async function sessionData(id) {
      const segs = (await db.byIndex('segments', 'session', id)).sort((a, b) => a.seq - b.seq);
      const events = (await db.byIndex('events', 'session', id)).sort((a, b) => a.wall_ms - b.wall_ms);
      return { segments: segs, events };
    }
    async function segmentAudio(sessionId, seq) { const r = await db.get('segments', segKey(sessionId, seq)); return r && r.buf ? new Blob([r.buf], { type: r.mime }) : null; }

    return {
      start, pause, resume, stop, mark, resumeAfterInterruption, recoverUnfinished, adopt, finishRecovered, snapshot, listSessions, sessionData, segmentAudio,
      get state() { return { recording: S.recording, paused: S.paused, pausedAt: S.pausedAt, interrupted: S.interrupted, session: S.session, uploadMode: S.uploadMode, wakeLock: wake.active, wakeSupported: wake.supported,
        micMuted: S.micMuted, noSound: S.noSound, micName: S.session && S.session.mic ? S.session.mic.name : null }; },
      level() { return S.watch && S.recording && !S.paused ? S.watch.level() : { peak: 0, rms: 0 }; },
      audio: AUDIO,
    };
  }

  window.createSegmentRecorder = createSegmentRecorder;
})();
