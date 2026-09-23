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
//   - Optional server persistence (opts.server, meeting-uploader.js): while
//     /api/meetings is off (404) everything simply stays on this device.
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
    // Meeting-recording mic settings. Noise suppression defaults ON (Ed
    // 2026-09-23: a built-in mic's hiss sat ~5 dB under speech with it off);
    // the page can turn it off per recording. Echo cancellation stays off: in a
    // room there is no far-end speaker to cancel and it can thin out voices.
    const AUDIO = { echoCancellation: false, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
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
      const seg = { rec, seq: S.session.next_seq++, chunks: [], startedAt: null, perfStart: null, execAtStart: !!S.session.exec_open };
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
      S.active = next; S.prevSeg = prev;   // still recording during the overlap
      setTimeout(() => { try { if (prev && prev.rec.state !== 'inactive') prev.rec.stop(); } catch (_) {} if (S.prevSeg === prev) S.prevSeg = null; }, overlapMs);
      scheduleRotation();
    }
    async function finalize(seg) {
      const blob = new Blob(seg.chunks, { type: seg.rec.mimeType || S.session.mime || 'audio/webm' });
      if (!blob.size) { log('empty_segment', { seq: seg.seq }, 'bad'); return; }
      const buf = await blob.arrayBuffer();
      const row = { key: segKey(S.session.id, seg.seq), session_id: S.session.id, seq: seg.seq, started_wall: seg.startedAt, ended_wall: Date.now(),
        wall_ms: seg.perfStart != null ? Math.round(performance.now() - seg.perfStart) : null, mime: blob.type, bytes: buf.byteLength,
        sha256: await TA.sha256Hex(buf), buf, status: 'pending', attempts: 0, next_attempt_at: 0, decode: null,
        scope: seg.execAtStart || seg.execTouched || S.session.exec_open ? 'executive' : 'open' };
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
    // Server persistence (Step 1). opts.server = createMeetingServer(...) from
    // meeting-uploader.js; without it (or while MEETING_UPLOADS_ENABLED is off)
    // everything stays on this device exactly as before. Order per session:
    // register -> markers (so the server can classify gaps) -> segments ->
    // stop -> re-verify until the server confirms every piece arrived.
    // Local audio is never deleted here.
    const server = opts.server || null;
    S.uploadMode = server ? 'checking' : 'local';
    const backoff = (n) => Math.min(60000, 1000 * 2 ** Math.min(n, 6)) * (0.8 + Math.random() * 0.4);
    let pumping = false;
    async function ensureRegistered(sess) {
      if (sess.server && sess.server.session_id && sess.server.upload_token) return 'ok';
      if (sess.server_next_attempt_at && sess.server_next_attempt_at > Date.now()) return 'wait';
      const r = await server.register(sess);
      if (r.kind === 'ok') {
        sess.server = { session_id: r.body.session.id, meeting_id: r.body.meeting_id, upload_token: r.body.upload_token, upload_token_expires_at: r.body.upload_token_expires_at, registered_at: Date.now() };
        sess.server_attempts = 0; sess.server_next_attempt_at = 0; sess.server_error = null;
        await db.put('sessions', sess);
        if (S.session && S.session.id === sess.id) S.session.server = sess.server;
        return 'ok';
      }
      if (r.kind === 'disabled') return 'disabled';
      if (r.kind === 'signin') return 'signin';
      sess.server_attempts = (sess.server_attempts || 0) + 1; sess.server_next_attempt_at = Date.now() + backoff(sess.server_attempts);
      sess.server_error = (r.body && r.body.error) || r.kind;
      await db.put('sessions', sess);
      return r.kind === 'rejected' ? 'rejected' : 'wait';
    }
    async function renew(sess) {
      const r = await server.renewKey(sess);
      if (r.kind !== 'ok') return r.kind;
      sess.server.upload_token = r.body.upload_token; sess.server.upload_token_expires_at = r.body.upload_token_expires_at;
      await db.put('sessions', sess); if (S.session && S.session.id === sess.id) S.session.server = sess.server;
      return 'ok';
    }
    async function syncSession(sess) {
      const reg = await ensureRegistered(sess);
      if (reg !== 'ok') return reg;
      // 1) markers
      const evs = (await db.byIndex('events', 'session', sess.id)).filter((e) => !e.sent);
      const payload = server.markerPayload(sess, evs);
      if (payload.length) {
        const r = await server.sendMarkers(sess, payload.map((x) => x.m));
        if (r.kind === 'auth') { if ((await renew(sess)) !== 'ok') return 'signin'; return 'wait'; }
        if (r.kind === 'disabled') return 'disabled';
        if (r.kind === 'ok' || r.kind === 'rejected') for (const x of payload) { const e = evs.find((q) => q.id === x.id); if (e) { e.sent = true; await db.put('events', e); } }
      }
      // mark events that never map to a server marker as handled
      for (const e of evs) if (!e.sent && !payload.some((x) => x.id === e.id)) { e.sent = true; await db.put('events', e); }
      // 2) segments
      const segs = (await db.byIndex('segments', 'session', sess.id)).sort((a, b) => a.seq - b.seq);
      for (const r of segs) {
        if (r.status !== 'pending' || (r.next_attempt_at || 0) > Date.now()) continue;
        if (!navigator.onLine) return 'offline';
        const res = await server.putSegment(sess, r);
        const cur = await db.get('segments', r.key); if (!cur) continue;
        if (res.kind === 'ok') { cur.status = 'uploaded'; cur.uploaded_at = Date.now(); cur.duplicate = !!(res.body && res.body.duplicate); cur.attempts = 0; }
        else if (res.kind === 'auth') { if ((await renew(sess)) !== 'ok') return 'signin'; continue; }
        else if (res.kind === 'disabled') return 'disabled';
        else if (res.kind === 'rejected') { cur.status = 'rejected'; cur.error = (res.body && res.body.error) || String(res.status); log('upload_rejected', { seq: cur.seq, error: cur.error }, 'bad'); }
        else { cur.attempts = (cur.attempts || 0) + 1; cur.next_attempt_at = Date.now() + backoff(cur.attempts); cur.error = (res.body && res.body.error) || 'network'; }
        await db.put('segments', cur);
        onChange();
      }
      // 3) stop + verification (only for sessions that ended on this device)
      if (sess.status === 'stopped') {
        const all = await db.byIndex('segments', 'session', sess.id);
        const waiting = all.filter((x) => x.status === 'pending').length;
        if (!sess.server_stop_sent) {
          const r = await server.stop(sess);
          if (r.kind === 'auth') { if ((await renew(sess)) !== 'ok') return 'signin'; return 'wait'; }
          if (r.kind !== 'ok') return 'wait';
          sess.server_stop_sent = true; sess.server_verification = r.body.verification; await db.put('sessions', sess);
        } else if (!waiting && (!sess.server_verification || sess.server_verification.status !== 'verified')
                   && (!sess.server_verify_at || Date.now() - sess.server_verify_at > 5000)) {
          const r = await server.verification(sess);
          sess.server_verify_at = Date.now();
          if (r.kind === 'ok') sess.server_verification = r.body.verification;
          await db.put('sessions', sess);
        }
        if (sess.server_verification && sess.server_verification.status === 'verified' && !waiting) { sess.server_done = true; await db.put('sessions', sess); }
        if (S.session && S.session.id === sess.id) { S.session.server_verification = sess.server_verification; S.session.server_done = sess.server_done; S.session.server_stop_sent = sess.server_stop_sent; }
      }
      return 'ok';
    }
    async function pump() {
      if (!server || pumping) return; pumping = true;
      try {
        const on = await server.enabled();
        if (on === false) { S.uploadMode = 'local'; return; }
        if (on === 'signin') { S.uploadMode = 'signin'; return; }
        if (on === null || !navigator.onLine) { S.uploadMode = 'offline'; return; }
        let mode = 'ok';
        for (const sess of (await db.all('sessions')).sort((a, b) => a.started_wall - b.started_wall)) {
          if (sess.server_done) continue;
          const r = await syncSession(sess);
          if (r === 'disabled') { mode = 'local'; break; }
          if (r === 'signin') mode = 'signin';
          else if (r === 'offline') { mode = 'offline'; break; }
          else if ((r === 'wait' || r === 'rejected') && mode === 'ok') mode = 'retrying';
        }
        S.uploadMode = mode;
      } catch (e) { S.uploadMode = 'retrying'; } finally { pumping = false; onChange(); }
    }
    if (server) {
      setInterval(pump, 4000);
      window.addEventListener('online', pump);
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pump(); });
      setTimeout(pump, 500);
    }
    // Heartbeat every 15 s while recording so the server knows how many pieces
    // to expect even if this device dies before Stop.
    let lastBeat = 0;
    async function heartbeat() {
      if (!server || !S.recording || !S.session || !S.session.server || !S.session.server.upload_token) return;
      if (Date.now() - lastBeat < 15000) return;
      lastBeat = Date.now();
      const r = await server.heartbeat(S.session, Math.max(-1, (S.session.next_seq || 0) - 1), S.interrupted ? 'interrupted' : S.paused ? 'paused' : 'recording');
      if (r.kind === 'auth') renew(S.session).catch(() => {});
    }

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
      heartbeat().catch(() => {});
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
        mic = await TA.openMic(want, (resumeSession && resumeSession.audio) || (micOpts && micOpts.audio) || AUDIO);
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
        S.session = { id: TA.newId(), started_wall: Date.now(), status: 'recording', next_seq: 0, mime: TA.pickMime(), ua: navigator.userAgent, pauses: [], seg_ms: segMs, overlap_ms: overlapMs, recording_purpose: 'drafting_aid', ...sessionFields };
        log('recording_started', { mime: S.session.mime, mic: mic.name, noise_reduction: !!(mic.audio && mic.audio.noiseSuppression) });
      }
      S.session.mic = { deviceId: mic.deviceId, name: mic.name, noiseReduction: !!(mic.audio && mic.audio.noiseSuppression) };
      S.session.audio = mic.audio || AUDIO;   // resume reopens the mic with the same settings
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
      if (kind === 'exec_start') { S.session.exec_open = true; if (S.active) S.active.execTouched = true; if (S.prevSeg) S.prevSeg.execTouched = true; await saveSession(); }
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
        // The lost audio starts where the SAVED audio ends (last segment or 5 s
        // partial save), not at the last heartbeat; mark the interruption there
        // so the server classifies the whole hole as an interruption.
        const savedEnd = segs.reduce((mx, x) => Math.max(mx, (x.started_wall || 0) + (x.wall_ms || 0)), 0);
        const gapFrom = savedEnd ? Math.min(savedEnd, s.last_audio_wall || savedEnd) : (s.last_audio_wall || null);
        await db.put('events', { session_id: s.id, kind: 'page_reloaded_during_recording', level: 'bad', wall_ms: Date.now(), gap_from: gapFrom });
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
    async function uploadStats(id) {
      const segs = await db.byIndex('segments', 'session', id);
      const sess = await db.get('sessions', id);
      return { total: segs.length, uploaded: segs.filter((x) => x.status === 'uploaded').length, pending: segs.filter((x) => x.status === 'pending').length,
        rejected: segs.filter((x) => x.status === 'rejected').length, verification: sess && sess.server_verification || null, done: !!(sess && sess.server_done),
        registered: !!(sess && sess.server && sess.server.session_id), mode: S.uploadMode };
    }
    async function sessionData(id) {
      const segs = (await db.byIndex('segments', 'session', id)).sort((a, b) => a.seq - b.seq);
      const events = (await db.byIndex('events', 'session', id)).sort((a, b) => a.wall_ms - b.wall_ms);
      return { segments: segs, events };
    }
    async function segmentAudio(sessionId, seq) { const r = await db.get('segments', segKey(sessionId, seq)); return r && r.buf ? new Blob([r.buf], { type: r.mime }) : null; }

    return {
      start, pause, resume, stop, mark, resumeAfterInterruption, recoverUnfinished, adopt, finishRecovered, snapshot, listSessions, sessionData, segmentAudio, uploadStats, syncNow: () => pump(),
      get state() { return { recording: S.recording, paused: S.paused, pausedAt: S.pausedAt, interrupted: S.interrupted, session: S.session, uploadMode: S.uploadMode, wakeLock: wake.active, wakeSupported: wake.supported,
        micMuted: S.micMuted, noSound: S.noSound, micName: S.session && S.session.mic ? S.session.mic.name : null }; },
      level() { return S.watch && S.recording && !S.paused ? S.watch.level() : { peak: 0, rms: 0 }; },
      audio: AUDIO,
    };
  }

  window.createSegmentRecorder = createSegmentRecorder;
})();
