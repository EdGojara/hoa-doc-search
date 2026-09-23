// ============================================================================
// public/js/meeting-intel-ui.js  (Ed 2026-09-23)
// ----------------------------------------------------------------------------
// Meeting Recorder's review tabs for a recording Trusted has VERIFIED:
//   Overview (processing status + start/retry), Transcript (speaker mapping),
//   Summary, Draft minutes, Motions & votes, Action items.
// Talks only to /api/meeting-intel (lib/meetings/*). Processing runs on the
// server in the background; this page just shows where it is:
//   Audio verified -> Joining audio -> Transcribing -> Analyzing -> Ready for review
// A failed stage names itself and can be retried without starting over.
// Nothing here finalizes minutes, emails anyone, or creates motions, projects,
// tasks or follow-ups in other modules.
// ============================================================================
(function () {
  'use strict';
  const API = '/api/meeting-intel';
  const hms = (ms) => { const s = Math.max(0, Math.round((ms || 0) / 1000)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(x).padStart(2, '0'); };
  const ROLE_LABEL = { board_member: 'Board member', manager: 'Manager', vendor: 'Vendor', homeowner: 'Homeowner', other: 'Other' };
  const RESULT_LABEL = { passed: 'Passed', failed: 'Failed', tabled: 'Tabled', withdrawn: 'Withdrawn', not_stated: 'Not stated' };

  function createMeetingIntelUI({ authFetch, esc, playJoined, stopPlayback, onBanner }) {
    let cur = { sid: null, status: null, poll: null, transcript: null, analysis: null, disabled: false };
    const j = async (method, path, body) => {
      const r = await authFetch(API + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
      let b = null; try { b = await r.json(); } catch (_) {}
      return { status: r.status, ok: r.ok, body: b || {} };
    };
    const alive = (el) => el && document.body.contains(el);
    const timeLink = (ms, label) => `<a href="#" class="mi-t" data-ms="${Math.round(ms)}" title="Play the recording from here">${esc(label || hms(ms))}</a>`;
    const badge = (st) => (st === 'OK' ? '<span class="mi-badge ok">✓ checked</span>' : '<span class="mi-badge rv">NEEDS REVIEW</span>');
    const reasons = (x) => (x.review_reasons && x.review_reasons.length ? `<ul class="mi-reasons">${x.review_reasons.map((r) => `<li>${esc(r.message)}</li>`).join('')}</ul>` : '');
    const support = (x) => (x.quote ? `<div class="mi-quote">“${esc(x.quote)}”${x.time_ref ? ` · ${timeLink(x.time_ref.audio_ms, x.time_ref.label)}` : ''}</div>` : x.time_ref ? `<div class="mi-quote">${timeLink(x.time_ref.audio_ms, x.time_ref.label)}</div>` : '');
    function wireTimes(root) {
      root.querySelectorAll('.mi-t').forEach((a) => { a.onclick = (e) => { e.preventDefault(); playAt(Number(a.dataset.ms)); }; });
    }
    async function playAt(ms) {
      const r = await j('GET', `/sessions/${cur.sid}/audio?json=1`);
      if (!r.ok || !r.body.url) { onBanner('bad', 'The joined recording is not available yet.'); return; }
      playJoined(r.body.url, ms);
    }

    // ------------------------------------------------------------ status
    async function loadStatus() {
      const r = await j('GET', `/sessions/${cur.sid}`);
      if (r.status === 404 && r.body.error === 'meeting_processing_disabled') { cur.disabled = true; return null; }
      if (!r.ok) throw new Error(r.body.error || 'HTTP ' + r.status);
      cur.disabled = false; cur.status = r.body;
      return r.body;
    }
    const active = (st) => st && st.job && ['queued', 'running'].includes(st.job.status);
    function stepsHtml(st) {
      const icon = { done: '✓', running: '●', queued: '…', retrying: '↻', failed: '✕', pending: '○' };
      return `<div class="mi-steps">${st.steps.map((x, i) => `${i ? '<span class="mi-arrow">→</span>' : ''}<span class="mi-step ${x.state}">${icon[x.state] || '○'} ${esc(x.label)}${x.state === 'retrying' ? ' (retrying)' : ''}</span>`).join('')}</div>`;
    }
    function statusPanelHtml(st) {
      if (cur.disabled) return '<div class="banner info">Transcription and Paige\'s review are not switched on for Trusted yet.</div>';
      if (!st) return '<div class="muted">Checking processing status…</div>';
      const job = st.job;
      let body = stepsHtml(st);
      if (!job) body += `<div class="ctl"><button class="primary" id="miStart">Create transcript, summary &amp; draft minutes</button></div><div class="muted">Runs on Trusted in the background (a few minutes for a long meeting). You can leave this page.</div>`;
      else if (job.status === 'failed') {
        const label = { assemble: 'Joining audio', transcribe: 'Transcribing', analyze: 'Analyzing' }[job.failed_stage] || job.failed_stage;
        body += `<div class="banner bad"><b>${esc(label)} failed.</b> ${esc(job.last_error || '')}<br>Earlier steps are kept; Retry continues from “${esc(label)}”.</div><div class="ctl"><button class="primary" id="miRetry">↻ Retry ${esc(label)}</button></div>`;
      } else if (active(st)) {
        const stage = { assemble: 'Joining the audio', transcribe: 'Transcribing', analyze: 'Paige is analyzing the transcript' }[job.current_stage] || 'Working';
        const retrying = job.stages && job.stages[job.current_stage] && job.stages[job.current_stage].status === 'retrying';
        body += `<div class="muted">${esc(stage)}…${retrying ? ` A temporary problem occurred (${esc(job.last_error || '')}); it will retry automatically.` : ''} This updates by itself.</div>`;
      } else if (job.status === 'ready') {
        body += `<div class="banner ok">Ready for review: see the Transcript, Summary, Motions &amp; votes, Action items and Draft minutes tabs.${st.assembly ? ` Joined recording ${hms(st.assembly.duration_ms)}${st.assembly.gaps && st.assembly.gaps.length ? ` · ${st.assembly.gaps.length} recording gap(s) marked` : ''}.` : ''}</div>`;
      }
      return `<div class="mi-panel"><b>Transcript &amp; minutes</b>${body}</div>`;
    }
    async function renderStatus(el) {
      try { await loadStatus(); } catch (e) { if (alive(el)) el.innerHTML = `<div class="banner bad">Could not load processing status: ${esc(e.message)}</div>`; return; }
      if (!alive(el)) return;
      el.innerHTML = statusPanelHtml(cur.status);
      const start = el.querySelector('#miStart');
      if (start) start.onclick = async () => {
        start.disabled = true;
        const r = await j('POST', `/sessions/${cur.sid}/process`);
        if (!r.ok) onBanner('bad', r.body.hint || r.body.error || 'Could not start processing.');
        renderStatus(el); schedule(el);
      };
      const retry = el.querySelector('#miRetry');
      if (retry) retry.onclick = async () => {
        retry.disabled = true;
        const r = await j('POST', `/jobs/${cur.status.job.id}/retry`);
        if (!r.ok) onBanner('bad', r.body.error || 'Retry failed to start.');
        renderStatus(el); schedule(el);
      };
      schedule(el);
    }
    function schedule(el) {
      clearTimeout(cur.poll);
      if (active(cur.status)) cur.poll = setTimeout(() => { if (alive(el)) renderStatus(el); }, 4000);
    }

    // ------------------------------------------------------------ transcript
    function mappingSelect(sp, roster) {
      const m = sp.mapping;
      const v = !m ? '' : m.role === 'board_member' ? 'b:' + m.board_member_id : 'r:' + m.role;
      const opts = ['<option value="">Not set</option>', `<optgroup label="Board member">${roster.map((r) => `<option value="b:${esc(r.id)}"${v === 'b:' + r.id ? ' selected' : ''}>${esc(r.name)}${r.position ? ` (${esc(r.position)})` : ''}</option>`).join('')}</optgroup>`,
        ...['manager', 'vendor', 'homeowner', 'other'].map((k) => `<option value="r:${k}"${v === 'r:' + k ? ' selected' : ''}>${ROLE_LABEL[k]}</option>`)].join('');
      return `<select class="mi-map" data-speaker="${sp.speaker}">${opts}</select>`;
    }
    async function renderTranscript(el) {
      const r = await j('GET', `/sessions/${cur.sid}/transcript`);
      if (!alive(el)) return;
      if (!r.ok) { el.innerHTML = notReady('The transcript'); return; }
      cur.transcript = r.body;
      const a = await j('GET', `/sessions/${cur.sid}/analysis`);
      const sugg = a.ok ? (a.body.checked.speaker_suggestions || []) : [];
      const T = r.body;
      const spk = T.speakers.map((sp) => {
        const sg = sugg.find((x) => x.speaker_index === sp.speaker && x.status === 'OK' && !sp.mapping);
        const nameVal = sp.mapping && sp.mapping.role !== 'board_member' && sp.mapping.display_name ? sp.mapping.display_name : '';
        return `<div class="mi-spk">
          <div><b>${esc(sp.default_label)}</b> <span class="muted">${sp.segments} lines · first at ${timeLink(sp.first_ms)}</span><div class="muted mi-sample">“${esc(sp.sample)}”</div></div>
          <div class="mi-spk-ctl">${mappingSelect(sp, T.roster)}<input class="mi-name" data-speaker="${sp.speaker}" placeholder="Name (optional)" value="${esc(nameVal)}" style="${sp.mapping && sp.mapping.role !== 'board_member' ? '' : 'display:none'}"></div>
          ${sg ? `<div class="mi-sugg">Paige suggests <b>${esc(sg.roster_name || sg.name)}</b> (${esc(ROLE_LABEL[sg.role])}): “${esc(sg.quote || '')}” ${sg.time_ref ? timeLink(sg.time_ref.audio_ms, sg.time_ref.label) : ''} <button class="mi-apply" data-speaker="${sp.speaker}" data-role="${esc(sg.role)}" data-bm="${esc(sg.board_member_id || '')}" data-name="${esc(sg.name)}">Apply</button></div>` : ''}
        </div>`;
      }).join('');
      // lines, with gaps and executive session shown in place
      const events = [...(T.gaps || []).map((g) => ({ at: g.at_audio_ms, html: `<div class="mi-gap">— ${Math.round(g.ms / 1000)} s not recorded (${esc(String(g.reason).replace(/_/g, ' '))}) —</div>` }))];
      let html = '', e = 0, execOpen = false, execBuf = [];
      const flushExec = () => { if (!execBuf.length) return; html += `<details class="mi-exec"><summary>🔒 Executive session (${hms(execBuf[0].start_ms)}–${hms(execBuf[execBuf.length - 1].end_ms)}) · ${execBuf.length} lines · hidden by default; never used for the summary or minutes</summary>${execBuf.map(line).join('')}</details>`; execBuf = []; };
      function line(x) { return `<div class="mi-line${x.confidence != null && x.confidence < 0.6 ? ' lowconf' : ''}">${timeLink(x.start_ms)} <b class="mi-who">${esc(x.label)}</b> ${esc(x.text)}</div>`; }
      for (const x of T.segments) {
        while (e < events.length && events[e].at <= x.start_ms) { flushExec(); html += events[e++].html; }
        if (x.scope === 'executive') { execBuf.push(x); execOpen = true; continue; }
        if (execOpen) { flushExec(); execOpen = false; }
        html += line(x);
      }
      flushExec();
      while (e < events.length) html += events[e++].html;
      el.innerHTML = `<div class="muted">Deepgram ${esc(T.transcript.model)} · ${T.transcript.speaker_count} speakers · ${T.transcript.word_count} words${T.transcript.avg_confidence != null ? ` · confidence ${Math.round(T.transcript.avg_confidence * 100)}%` : ''}. Click a time to listen from there.</div>
        <h3 class="mi-h">Who is speaking?</h3><div class="muted">Map each speaker once. The transcript updates immediately; nothing is re-transcribed. Paige's review re-checks names against these mappings.</div>
        <div class="mi-spks">${spk}</div>
        <h3 class="mi-h">Transcript</h3><div class="mi-lines">${html}</div>`;
      wireTimes(el);
      const save = async (speaker, body) => {
        const res = body ? await j('PUT', `/sessions/${cur.sid}/speakers/${speaker}`, body) : await j('DELETE', `/sessions/${cur.sid}/speakers/${speaker}`);
        if (!res.ok) onBanner('bad', res.body.detail || res.body.error || 'Could not save the speaker.');
        renderTranscript(el);
      };
      el.querySelectorAll('.mi-map').forEach((s) => { s.onchange = () => {
        const v = s.value, sp = Number(s.dataset.speaker);
        if (!v) return save(sp, null);
        if (v.startsWith('b:')) return save(sp, { role: 'board_member', board_member_id: v.slice(2) });
        const nameEl = el.querySelector(`.mi-name[data-speaker="${sp}"]`);
        return save(sp, { role: v.slice(2), display_name: nameEl ? nameEl.value : '' });
      }; });
      el.querySelectorAll('.mi-name').forEach((inp) => { inp.onchange = () => {
        const sp = Number(inp.dataset.speaker), sel = el.querySelector(`.mi-map[data-speaker="${sp}"]`);
        if (sel && sel.value.startsWith('r:')) save(sp, { role: sel.value.slice(2), display_name: inp.value });
      }; });
      el.querySelectorAll('.mi-apply').forEach((b) => { b.onclick = () => save(Number(b.dataset.speaker), b.dataset.role === 'board_member' ? { role: 'board_member', board_member_id: b.dataset.bm } : { role: b.dataset.role, display_name: b.dataset.name }); });
    }
    const notReady = (what) => {
      const st = cur.status;
      if (cur.disabled) return '<div class="placeholder">Transcription and Paige\'s review are not switched on for Trusted yet.</div>';
      if (!st || !st.job) return `<div class="placeholder">${what} will appear here after you start processing on the Overview tab.</div>`;
      if (st.job.status === 'failed') return `<div class="placeholder">${what} is not available: a processing step failed. See the Overview tab to retry.</div>`;
      return `<div class="placeholder">${what} is being prepared (${esc(st.steps.filter((x) => x.state === 'done').map((x) => x.label).pop() || 'queued')} done). This tab fills in when it is ready.</div>`;
    };

    // ------------------------------------------------------------ analysis tabs
    async function loadAnalysis() {
      const r = await j('GET', `/sessions/${cur.sid}/analysis`);
      cur.analysis = r.ok ? r.body : null;
      return cur.analysis;
    }
    function staleNote(A) {
      if (!A.mappings_changed) return '';
      return `<div class="banner warn">Speaker names changed after Paige's review. Names, votes and owners below are already re-checked against the new names; Paige's written summaries still use the old labels. <button id="miReanalyze">Re-run Paige with current names</button></div>`;
    }
    function wireReanalyze(el) {
      const b = el.querySelector('#miReanalyze');
      if (b) b.onclick = async () => { b.disabled = true; const r = await j('POST', `/sessions/${cur.sid}/reanalyze`); if (!r.ok) onBanner('bad', r.body.error || 'Could not start'); else onBanner('info', 'Paige is re-analyzing; the Overview shows progress.'); };
    }
    async function renderSummary(el) {
      const A = await loadAnalysis();
      if (!alive(el)) return;
      if (!A) { el.innerHTML = notReady('The summary'); return; }
      const C = A.checked, s = C.summary;
      const gaps = (C.recording.gaps || []);
      const att = C.attendance;
      el.innerHTML = `${staleNote(A)}
        <div class="mi-counts">${A.counts.needs_review ? `<span class="mi-badge rv">${A.counts.needs_review} item(s) need review</span>` : '<span class="mi-badge ok">Everything checked out</span>'}${A.counts.withheld ? ` <span class="mi-badge rv">${A.counts.withheld} withheld (executive session)</span>` : ''}</div>
        <h3 class="mi-h">Short summary</h3><p>${esc(s.short_summary)}</p>
        <h3 class="mi-h">Executive summary</h3><p class="muted" style="margin-top:-6px">An overview for the board (not the executive session).</p><p>${esc(s.executive_summary)}</p>
        <h3 class="mi-h">Attendance</h3><p>${att.directors_present.length ? `${att.directors_present_count} of ${att.roster_count} directors confirmed: ${att.directors_present.map((d) => esc(d.name)).join(', ')}.` : 'Directors present could not be confirmed.'} ${badge(att.status)}</p>${reasons(att)}
        ${(C.recording.exec_ranges || []).length ? `<h3 class="mi-h">Executive session</h3><p>${C.recording.exec_ranges.map((r) => `${hms(r.audio_from_ms)}–${hms(r.audio_to_ms)} in the recording`).join('; ')}. Its content is not summarized.</p>` : ''}
        ${gaps.length ? `<h3 class="mi-h">Recording gaps</h3><ul>${gaps.map((g) => `<li>${timeLink(g.at_audio_ms)}: ${Math.round(g.ms / 1000)} s not recorded (${esc(String(g.reason).replace(/_/g, ' '))})</li>`).join('')}</ul>` : ''}
        ${(C.next_agenda_items || []).filter((x) => !x.withheld).length ? `<h3 class="mi-h">Suggested for the next agenda</h3><ul>${C.next_agenda_items.filter((x) => !x.withheld).map((x) => `<li>${esc(x.text)} ${badge(x.status)}${support(x)}${reasons(x)}</li>`).join('')}</ul>` : ''}
        ${(C.uncertainties || []).length ? `<h3 class="mi-h">Paige was unsure about</h3><ul>${C.uncertainties.map((x) => `<li>${esc(x.note)}${support(x)}</li>`).join('')}</ul>` : ''}
        <div class="muted" style="margin-top:14px">Paige (${esc(A.analysis.model)}) · ${esc(new Date(A.analysis.created_at).toLocaleString())}</div>`;
      wireTimes(el); wireReanalyze(el);
    }
    async function renderMotions(el) {
      const A = await loadAnalysis();
      if (!alive(el)) return;
      if (!A) { el.innerHTML = notReady('Motions and votes'); return; }
      const ms = A.checked.motions.filter((m) => !m.withheld);
      const person = (r, raw) => esc(r && (r.kind === 'director' || r.kind === 'mapped') ? r.name : raw || '—');
      el.innerHTML = `${staleNote(A)}${ms.length ? ms.map((m) => {
        const v = m.vote || {};
        const counts = v.yes != null || v.no != null ? `${v.yes ?? 0} for · ${v.no ?? 0} against${v.abstain ? ` · ${v.abstain} abstain` : ''}` : v.method && v.method !== 'not_stated' ? v.method.replace(/_/g, ' ') + ' vote (no count stated)' : 'no vote stated';
        return `<div class="mi-card"><div class="mi-card-h"><b>${esc(m.motion_text)}</b> ${badge(m.status)}</div>
          <div class="mi-grid"><div><span class="muted">Moved by</span><br>${person(m.mover_resolved, m.mover)}</div><div><span class="muted">Seconded by</span><br>${person(m.seconder_resolved, m.seconder)}</div>
          <div><span class="muted">Vote</span><br>${esc(counts)}</div><div><span class="muted">Result</span><br><b class="mi-res ${esc(m.result)}">${esc(RESULT_LABEL[m.result] || m.result)}</b></div></div>
          ${support(m)}${reasons(m)}</div>`;
      }).join('') : '<div class="placeholder">No motions were found in the open session.</div>'}
      ${(A.checked.possible_missed_motions || []).map((x) => `<div class="mi-card"><div class="mi-card-h"><b>Possible motion not listed</b> ${badge(x.status)}</div><div class="mi-quote">${esc(x.speaker_label)}: “${esc(x.text)}” · ${timeLink(x.time_ref.audio_ms, x.time_ref.label)}</div>${reasons(x)}</div>`).join('')}
      ${A.checked.decisions.filter((d) => !d.withheld).length ? `<h3 class="mi-h">Other decisions</h3>${A.checked.decisions.filter((d) => !d.withheld).map((d) => `<div class="mi-card">${esc(d.text)} ${badge(d.status)}${support(d)}${reasons(d)}</div>`).join('')}` : ''}`;
      wireTimes(el); wireReanalyze(el);
    }
    async function renderActions(el) {
      const A = await loadAnalysis();
      if (!alive(el)) return;
      if (!A) { el.innerHTML = notReady('Action items'); return; }
      const acts = A.checked.action_items.filter((x) => !x.withheld), fus = A.checked.follow_ups.filter((x) => !x.withheld);
      const who = (x) => (x.responsible ? esc(x.responsible_resolved && (x.responsible_resolved.kind === 'director' || x.responsible_resolved.kind === 'mapped') ? x.responsible_resolved.name : x.responsible) : '<span class="muted">not stated</span>');
      el.innerHTML = `${staleNote(A)}<div class="muted">Listed for review only. Nothing is created in Tasks, Projects or email from here.</div>
        <h3 class="mi-h">Action items</h3>${acts.length ? acts.map((x) => `<div class="mi-card"><div class="mi-card-h"><b>${esc(x.task)}</b> ${badge(x.status)}</div>
          <div class="mi-grid"><div><span class="muted">Responsible</span><br>${who(x)}</div><div><span class="muted">Due</span><br>${x.due ? esc(x.due) : '<span class="muted">not stated</span>'}</div></div>${support(x)}${reasons(x)}</div>`).join('') : '<div class="placeholder">No action items were found.</div>'}
        <h3 class="mi-h">Follow-ups</h3>${fus.length ? fus.map((x) => `<div class="mi-card">${esc(x.text)} ${badge(x.status)}${support(x)}${reasons(x)}</div>`).join('') : '<div class="muted">None.</div>'}`;
      wireTimes(el); wireReanalyze(el);
    }
    async function renderMinutes(el) {
      const A = await loadAnalysis();
      if (!alive(el)) return;
      if (!A) { el.innerHTML = notReady('Draft minutes'); return; }
      const d = A.draft_minutes;
      el.innerHTML = `${staleNote(A)}
        ${d ? `<div class="banner ok">Draft minutes were created ${esc(new Date(d.created_at).toLocaleString())} and saved to the Minutes module as a <b>draft</b> (status: ${esc(d.status)}). Open them in Trusted: <b>Meetings → Monthly Board → 📝 Minutes</b>, then ${esc(A.community_name || 'this community')}.</div>`
          : `<div class="ctl"><button class="primary" id="miDraft">Create Draft Minutes</button></div><div class="muted">Saves a DRAFT into the Minutes module for editing. It is never finalized or emailed automatically.</div>`}
        <h3 class="mi-h">Preview</h3><div class="mi-minutes">${md(A.minutes_preview)}</div>`;
      const b = el.querySelector('#miDraft');
      if (b) b.onclick = async () => {
        b.disabled = true;
        const r = await j('POST', `/sessions/${cur.sid}/draft-minutes`);
        if (!r.ok) { onBanner('bad', r.body.error || 'Could not create the draft.'); b.disabled = false; return; }
        onBanner('ok', 'Draft minutes saved to the Minutes module (status: draft).');
        renderMinutes(el);
      };
      wireReanalyze(el);
    }
    function md(src) {
      const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/_(.+?)_/g, '<i>$1</i>').replace(/\[(NEEDS REVIEW:[^\]]*)\]/g, '<span class="mi-flag">[$1]</span>').replace(/\[([^\]]+)\]/g, '<span class="mi-ph">[$1]</span>');
      let out = '', ul = false;
      for (const raw of String(src || '').split('\n')) {
        const l = raw.trimEnd();
        if (/^##\s+/.test(l)) { if (ul) { out += '</ul>'; ul = false; } out += `<h4>${inline(l.slice(3))}</h4>`; continue; }
        if (/^-\s+/.test(l)) { if (!ul) { out += '<ul>'; ul = true; } out += `<li>${inline(l.slice(2))}</li>`; continue; }
        if (ul) { out += '</ul>'; ul = false; }
        if (l.trim()) out += `<p>${inline(l)}</p>`;
      }
      return out + (ul ? '</ul>' : '');
    }

    return {
      /** Called when a recording's detail opens. serverSid = Trusted's session id (or null). */
      attach(serverSid) { clearTimeout(cur.poll); cur = { sid: serverSid, status: null, poll: null, transcript: null, analysis: null, disabled: false }; },
      renderStatus, renderTranscript, renderSummary, renderMotions, renderActions, renderMinutes,
      detach() { clearTimeout(cur.poll); },
    };
  }
  window.createMeetingIntelUI = createMeetingIntelUI;
})();
