// ============================================================================
// public/js/meeting-uploader.js  (Ed 2026-09-23)
// ----------------------------------------------------------------------------
// Thin client for the Meeting Recorder Step 1 API (/api/meetings). Each call
// returns a normalized result so the engine (segment-recorder.js) can decide:
//   { kind: 'ok' | 'retry' | 'auth' | 'rejected' | 'disabled', ... }
//   retry    -> network error / 5xx / 502 storage: back off and try again
//   auth     -> upload key expired/invalid: renew with the staff login, retry
//   rejected -> the server refused this item for good (409 conflict / 422 / 400)
//   disabled -> MEETING_UPLOADS_ENABLED is off (404): stay device-only
// authFetch attaches the staff login (Supabase JWT); upload calls use the
// per-session upload key instead.
// ============================================================================
(function () {
  'use strict';
  const BASE = '/api/meetings';
  const MARKER_KIND = {   // engine event kind -> server marker kind
    paused: 'pause', resumed: 'resume', recording_interrupted: 'interrupted', page_reloaded_during_recording: 'interrupted',
    resumed_after_interruption: 'resumed_after_interruption', recording_started: 'recording_started', recording_stopped: 'recording_stopped',
    mic_muted_by_device: 'mic_muted', no_sound_detected: 'no_sound',
  };

  function createMeetingServer({ authFetch }) {
    let enabledCache = null, enabledAt = 0;

    async function classify(res) {
      let body = {};
      try { body = await res.json(); } catch (_) {}
      if (res.ok) return { kind: 'ok', status: res.status, body };
      if (res.status === 404 && body.error === 'meeting_uploads_disabled') return { kind: 'disabled', body };
      if (res.status === 401 && /^upload_key_/.test(body.error || '')) return { kind: 'auth', body };
      if (res.status === 403 && (body.error === 'sign_in_required' || body.error === 'staff_only')) return { kind: 'signin', body };
      if ([400, 403, 404, 409, 413, 422].includes(res.status)) return { kind: 'rejected', status: res.status, body };
      return { kind: 'retry', status: res.status, body };
    }
    async function send(url, init, withLogin) {
      try { return await classify(await (withLogin ? authFetch(url, init) : fetch(url, Object.assign({ credentials: 'same-origin' }, init)))); }
      catch (e) { return { kind: 'retry', body: { error: e.message } }; }
    }
    const json = (method, body, key) => ({ method, headers: Object.assign({ 'Content-Type': 'application/json' }, key ? { 'x-upload-token': key } : {}), body: JSON.stringify(body) });

    return {
      // Is server persistence switched on? true | false (404 = off) |
      // 'signin' (on, but no staff login) | null (unknown: offline). Cached 60 s.
      async enabled() {
        if (enabledCache !== null && Date.now() - enabledAt < 60000) return enabledCache;
        const r = await send(`${BASE}/config`, { method: 'GET' }, true);
        if (r.kind === 'retry') return enabledCache === null ? null : enabledCache;
        if (r.kind === 'signin') return 'signin';   // not cached: re-check as soon as the user signs in
        enabledCache = r.kind === 'ok'; enabledAt = Date.now();
        return enabledCache;
      },
      async register(sess) {
        const m = sess.meeting || {};
        const meeting = m.server_meeting_id ? null : {
          community_id: sess.community_id, title: m.title || 'Board meeting', meeting_type: m.type || 'regular',
          meeting_date: m.date, location: m.location || null, meeting_agenda_id: m.agenda_id || null,
        };
        return send(`${BASE}/sessions`, json('POST', {
          client_session_id: sess.id, client_started_at: new Date(sess.started_wall).toISOString(),
          meeting_id: m.server_meeting_id || undefined, meeting: meeting || undefined,
          recording_purpose: sess.recording_purpose || 'drafting_aid',
          mic_name: sess.mic ? sess.mic.name : null, noise_reduction: sess.mic ? sess.mic.noiseReduction : null,
          mime: sess.mime || null, audio_constraints: sess.audio || null, segment_target_ms: sess.seg_ms || null, overlap_ms: sess.overlap_ms || null,
          device_summary: (navigator.userAgent || '').slice(0, 300),
        }), true);
      },
      async renewKey(sess) { return send(`${BASE}/sessions/${sess.server.session_id}/token`, { method: 'POST' }, true); },
      async putSegment(sess, row) {
        const d = row.decode || {};
        const headers = {
          'Content-Type': row.mime || 'application/octet-stream', 'x-upload-token': sess.server.upload_token,
          'x-segment-sha256': row.sha256, 'x-segment-started-at': new Date(row.started_wall).toISOString(),
          'x-segment-duration-ms': String(Math.max(0, Math.round(row.wall_ms || 0))), 'x-segment-partial': row.partial ? 'true' : 'false',
          'x-segment-scope': row.scope === 'executive' ? 'executive' : 'open',
        };
        if (typeof d.audible === 'boolean') headers['x-segment-audible'] = String(d.audible);
        if (Number.isFinite(d.peak)) headers['x-segment-peak'] = String(d.peak);
        if (Number.isFinite(d.rms)) headers['x-segment-rms'] = String(d.rms);
        return send(`${BASE}/sessions/${sess.server.session_id}/segments/${row.seq}`, { method: 'PUT', headers, body: row.buf }, false);
      },
      async heartbeat(sess, highestSeq, status) {
        return send(`${BASE}/sessions/${sess.server.session_id}/heartbeat`, json('POST', { highest_seq: highestSeq, status }, sess.server.upload_token), false);
      },
      // events: engine event rows (with IndexedDB id). Returns ids that were accepted or permanently rejected.
      markerPayload(sess, events) {
        const out = [];
        for (const e of events) {
          const kind = e.kind === 'marker' ? e.marker : MARKER_KIND[e.kind];
          if (!kind) continue;
          const at = e.kind === 'page_reloaded_during_recording' && e.gap_from ? e.gap_from : e.wall_ms;   // a reload interruption began at the last audio
          out.push({ id: e.id, m: { client_marker_id: `${sess.id}:${e.id}`, kind, occurred_at: new Date(at).toISOString(), offset_ms: Math.max(0, Math.round(at - sess.started_wall)), note: e.note || null } });
        }
        return out;
      },
      async sendMarkers(sess, markers) {
        return send(`${BASE}/sessions/${sess.server.session_id}/markers`, json('POST', { markers }, sess.server.upload_token), false);
      },
      async stop(sess) {
        return send(`${BASE}/sessions/${sess.server.session_id}/stop`, json('POST', {
          expected_segment_count: sess.next_seq || 0, stopped_at: new Date(sess.stopped_wall || Date.now()).toISOString(),
          pauses: (sess.pauses || []).map((p) => ({ from: new Date(p.from).toISOString(), to: new Date(p.to).toISOString() })),
        }, sess.server.upload_token), false);
      },
      async verification(sess) { return send(`${BASE}/sessions/${sess.server.session_id}/verification`, { method: 'GET' }, true); },
      MARKER_KIND,
    };
  }
  window.createMeetingServer = createMeetingServer;
})();
