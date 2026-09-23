// ============================================================================
// lib/meetings/intel_validate.js  (Ed 2026-09-23)
// ----------------------------------------------------------------------------
// Deterministic checks on Paige's meeting analysis. Pure function, no AI.
// Paige proposes; this code verifies. Anything that does not check out is
// marked NEEDS_REVIEW with the reason, never silently dropped or "fixed".
//
//   references     every item must cite real transcript lines (u12 ...) from
//                  the OPEN session. Items citing executive-session lines are
//                  WITHHELD from the public output.
//   quotes         the quoted words must actually be in the cited lines
//   people         named directors / movers / seconders must be on the board
//                  roster (or match a staff speaker mapping); a mover whose
//                  "I move" line was spoken by a DIFFERENT mapped person is
//                  flagged; a responsible person must be stated in (or be
//                  the speaker of) a cited line
//   due dates      must appear in a cited line
//   votes          counts cannot exceed the directors present; named votes
//                  must match the counts; the result must agree with the count
//   recording gaps anything within 20 s of a gap may be incomplete
//   executive      public text that repeats distinctive executive-session
//   session        wording is withheld
// Output: the same items, each with status OK | NEEDS_REVIEW, review_reasons,
// time_ref (audio + meeting time) and the supporting transcript lines.
// ============================================================================

const NEAR_GAP_MS = 20000;
const QUOTE_MIN_RATIO = 0.85;
const STOP = new Set(['the', 'a', 'an', 'by', 'on', 'of', 'to', 'and', 'at', 'for', 'in', 'mr', 'mrs', 'ms', 'dr']);

const norm = (s) => String(s || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^a-z0-9$'\s]/g, ' ').replace(/\s+/g, ' ').trim();
const toks = (s) => norm(s).split(' ').filter(Boolean);
const nameToks = (s) => toks(s).filter((t) => t.length > 1 && !STOP.has(t));
const hms = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(x).padStart(2, '0'); };

function lcsRatio(q, h) {
  if (!q.length) return 0;
  // longest common subsequence of tokens, O(q*h) with a rolling row (quotes are short)
  let prev = new Array(h.length + 1).fill(0);
  for (let i = 1; i <= q.length; i++) {
    const cur = new Array(h.length + 1).fill(0);
    for (let j = 1; j <= h.length; j++) cur[j] = q[i - 1] === h[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  return prev[h.length] / q.length;
}
function quoteSupported(quote, texts) {
  const q = norm(quote);
  if (!q) return false;
  const hay = norm(texts.join(' '));
  if (hay.includes(q)) return true;
  return lcsRatio(q.split(' '), hay.split(' ')) >= QUOTE_MIN_RATIO;
}

function validateAnalysis({ analysis, segments, mappings = [], roster = [], gaps = [], execRanges = [] }) {
  const byIdx = new Map(segments.map((s) => [s.idx, s]));
  const mapOf = (spk) => mappings.find((m) => m.speaker === spk) || null;
  const rosterById = new Map(roster.map((r) => [r.id, r]));
  const speakerName = (spk) => { const m = mapOf(spk); if (!m) return null; if (m.role === 'board_member') { const b = rosterById.get(m.board_member_id); return b ? b.name : m.display_name; } return m.display_name || null; };
  const labelOf = (spk) => { const m = mapOf(spk); const n = speakerName(spk); return m ? (n ? `${n}` : m.role) : spk == null ? 'Unknown speaker' : `Speaker ${spk + 1}`; };

  // ---- people
  function matchRoster(name) {
    const nt = nameToks(name);
    if (!nt.length) return { member: null, ambiguous: false };
    const full = roster.filter((r) => { const rt = new Set(nameToks(r.name)); return nt.every((t) => rt.has(t)); });
    if (full.length === 1) return { member: full[0], ambiguous: false };
    if (full.length > 1) return { member: null, ambiguous: true };
    return { member: null, ambiguous: false };
  }
  // "Speaker 3" -> speaker index 2
  const speakerRef = (name) => { const m = /^speaker\s+(\d+)$/i.exec(String(name || '').trim()); return m ? Number(m[1]) - 1 : null; };
  // Resolve a person string to { kind: 'director'|'mapped'|'speaker'|'unknown', name, roster_id }
  function resolvePerson(name) {
    if (name == null || !String(name).trim()) return { kind: 'none' };
    const sp = speakerRef(name);
    if (sp != null) {
      const m = mapOf(sp);
      if (!m) return { kind: 'speaker', speaker: sp, name };
      if (m.role === 'board_member' && rosterById.get(m.board_member_id)) { const b = rosterById.get(m.board_member_id); return { kind: 'director', name: b.name, roster_id: b.id, speaker: sp }; }
      return { kind: 'mapped', name: m.display_name || m.role, role: m.role, speaker: sp };
    }
    const r = matchRoster(name);
    if (r.member) return { kind: 'director', name: r.member.name, roster_id: r.member.id };
    if (r.ambiguous) return { kind: 'ambiguous', name };
    const nt = nameToks(name);
    const mm = mappings.find((m) => m.display_name && nt.length && nt.every((t) => nameToks(m.display_name).includes(t)));
    if (mm) return { kind: 'mapped', name: mm.display_name, role: mm.role, speaker: mm.speaker };
    return { kind: 'unknown', name };
  }

  // ---- executive-session wording (4-grams found ONLY in executive lines)
  const grams = (ts) => { const out = new Set(); for (let i = 0; i + 4 <= ts.length; i++) out.add(ts.slice(i, i + 4).join(' ')); return out; };
  const openGrams = new Set(); const execGrams = new Set();
  for (const s of segments) for (const g of grams(toks(s.text))) (s.scope === 'executive' ? execGrams : openGrams).add(g);
  for (const g of openGrams) execGrams.delete(g);
  const leaksExec = (text) => { const ts = toks(text); for (let i = 0; i + 4 <= ts.length; i++) if (execGrams.has(ts.slice(i, i + 4).join(' '))) return true; return false; };

  let withheld = 0;
  // ---- common checks for any item with refs (+ optional quote)
  function base(item, { requireQuote = true, textFields = [] } = {}) {
    const reasons = [];
    const add = (code, message) => { if (!reasons.some((r) => r.code === code)) reasons.push({ code, message }); };
    const refs = Array.isArray(item.refs) ? item.refs : [];
    const support = [];
    let execRef = false;
    for (const r of refs) {
      const n = Number(String(r).replace(/^u/i, ''));
      const s = Number.isInteger(n) ? byIdx.get(n) : null;
      if (!s) { add('unknown_reference', `cites ${r}, which is not a transcript line`); continue; }
      if (s.scope === 'executive') { execRef = true; continue; }
      support.push({ ref: `u${s.idx}`, idx: s.idx, speaker: s.speaker, speaker_label: labelOf(s.speaker), start_ms: s.start_ms, meeting_start_ms: s.meeting_start_ms, text: s.text });
    }
    support.sort((a, b) => a.start_ms - b.start_ms);
    if (!support.length && !execRef) add('no_supporting_transcript', 'no transcript line supports this');
    if (requireQuote && item.quote && support.length) {
      const near = support.flatMap((x) => [byIdx.get(x.idx - 1), byIdx.get(x.idx), byIdx.get(x.idx + 1)]).filter((x) => x && x.scope === 'open').map((x) => x.text);
      if (!quoteSupported(item.quote, near)) add('quote_not_in_transcript', `the quoted words were not found in the cited lines: "${String(item.quote).slice(0, 120)}"`);
    }
    if (requireQuote && !item.quote && support.length) add('no_quote', 'no supporting quote given');
    for (const g of gaps) {
      if (support.some((x) => Math.abs(x.start_ms - g.at_audio_ms) <= NEAR_GAP_MS)) add('near_recording_gap', `within 20 s of a ${Math.round(g.ms / 1000)} s recording gap (${String(g.reason).replace(/_/g, ' ')}) at ${hms(g.at_audio_ms)}; part of it may not have been recorded`);
    }
    const leaked = execRef || textFields.some((f) => leaksExec(f));
    if (leaked) { add('executive_session_content', 'draws on executive-session content; withheld from the public summary and minutes'); withheld++; }
    const t = support[0];
    return {
      reasons, add, support, withheld: leaked,
      time_ref: t ? { ref: t.ref, audio_ms: t.start_ms, meeting_ms: t.meeting_start_ms, label: hms(t.start_ms) } : null,
    };
  }
  const finish = (item, b, extra = {}) => ({ ...item, ...extra, status: b.reasons.length ? 'NEEDS_REVIEW' : 'OK', review_reasons: b.reasons, time_ref: b.time_ref, support: b.support, withheld: b.withheld });

  // ---- attendance (directors present) -> P
  const att = analysis.attendance || {};
  const attB = base({ refs: att.refs || (att.directors_present || []).flatMap((d) => d.refs || []) }, { requireQuote: false });
  const present = [];
  for (const d of att.directors_present || []) {
    const r = resolvePerson(d.name);
    if (r.kind === 'director') { if (!present.some((p) => p.roster_id === r.roster_id)) present.push({ name: r.name, roster_id: r.roster_id, as_said: d.name, refs: d.refs || [] }); }
    else attB.add('not_on_roster', `"${d.name}" was listed as a director present but is not on the current board roster`);
  }
  // directors known from staff speaker mappings who spoke in open session also count as present
  for (const m of mappings.filter((x) => x.role === 'board_member')) {
    const b = rosterById.get(m.board_member_id);
    if (b && segments.some((s) => s.speaker === m.speaker && s.scope === 'open') && !present.some((p) => p.roster_id === b.id)) present.push({ name: b.name, roster_id: b.id, as_said: null, from_mapping: true, refs: [] });
  }
  const P = present.length;
  const majority = Math.floor(roster.length / 2) + 1;
  if (!P) attB.add('attendance_not_confirmed', 'the directors present could not be confirmed from the transcript');
  else if (roster.length && P < majority) attB.add('quorum_not_confirmed', `${P} of ${roster.length} directors confirmed present; a quorum needs ${majority}`);
  const attendance = finish({ quorum_stated: !!att.quorum_stated, others_present: att.others_present || [] }, attB, { directors_present: present, directors_present_count: P, roster_count: roster.length });

  // ---- motions
  // First-person only: the chair ASKING "is there a motion to adjourn?" is not making one.
  const moveRe = /\b(i\s+move|i'll\s+move|i\s+would\s+move|so\s+moved|i\s+(?:make|made|'d\s+like\s+to\s+make)\s+a\s+motion)\b/i;
  const secondRe = /^\W*(i'll\s+)?second\b|\bi\s+second\b|\bi'll\s+second\b|\bseconded\b/i;
  const motions = (analysis.motions || []).map((m) => {
    const b = base(m, { textFields: [m.motion_text, m.quote] });
    const mover = resolvePerson(m.mover), seconder = resolvePerson(m.seconder);
    const personCheck = (p, role) => {
      if (p.kind === 'none') b.add(`${role}_not_stated`, role === 'mover' ? 'no mover recorded (minutes should name the maker of a motion)' : 'no second recorded');
      else if (p.kind === 'speaker') b.add(`${role}_not_identified`, `${role} is ${p.name}, not yet mapped to a person`);
      else if (p.kind === 'ambiguous') b.add(`${role}_ambiguous`, `"${p.name}" matches more than one board member`);
      else if (p.kind === 'unknown' || p.kind === 'mapped') b.add(`${role}_not_on_roster`, `${role} "${p.name}" is not a current director`);
    };
    personCheck(mover, 'mover'); personCheck(seconder, 'seconder');
    // cross-check against staff speaker mappings: who actually said "I move" / "second"
    for (const [p, re, role] of [[mover, moveRe, 'mover'], [seconder, secondRe, 'seconder']]) {
      if (p.kind !== 'director') continue;
      for (const s of b.support.filter((x) => re.test(x.text))) {
        const mm = mapOf(s.speaker);
        if (mm && mm.role === 'board_member' && mm.board_member_id !== p.roster_id) b.add(`${role}_differs_from_speaker`, `the ${role} is given as ${p.name}, but ${s.ref} ("${s.text.slice(0, 60)}") was spoken by ${labelOf(s.speaker)}`);
      }
    }
    const v = m.vote || {};
    const cnt = (x) => (Number.isInteger(x) ? x : null);
    const yes = cnt(v.yes), no = cnt(v.no), ab = cnt(v.abstain);
    const cast = [yes, no, ab].filter((x) => x != null).reduce((t, x) => t + x, 0);
    const vr = [];
    if (yes != null || no != null) {
      const cap = P || roster.length;
      if (cap && cast > cap) b.add('vote_exceeds_directors', `${cast} votes recorded but only ${cap} directors ${P ? 'present' : 'on the board'}`);
      if (!P) b.add('attendance_not_confirmed', 'vote counts cannot be checked against confirmed attendance');
      if (P && cast < P && v.method !== 'not_stated') b.add('not_all_directors_voted', `${cast} votes recorded for ${P} directors present; confirm abstentions or absences`);
      const names = [['yes', v.yes_names, yes], ['no', v.no_names, no], ['abstain', v.abstain_names, ab]];
      for (const [k, list, n] of names) {
        if (!Array.isArray(list) || !list.length) continue;
        if (n != null && list.length !== n) b.add('vote_names_count_mismatch', `${list.length} "${k}" names but a count of ${n}`);
        for (const nm of list) { const r = resolvePerson(nm); if (r.kind !== 'director') b.add('voter_not_on_roster', `"${nm}" voted ${k} but is not a confirmed director`); else if (P && !present.some((p) => p.roster_id === r.roster_id)) b.add('voter_not_present', `${r.name} voted but is not among the directors present`); vr.push({ vote: k, name: r.name || nm }); }
      }
      if (m.result === 'passed' && yes != null && no != null && yes <= no) b.add('result_inconsistent_with_vote', `marked passed with ${yes} yes / ${no} no`);
      if (m.result === 'failed' && yes != null && no != null && yes > no) b.add('result_inconsistent_with_vote', `marked failed with ${yes} yes / ${no} no`);
    }
    if (m.result === 'not_stated') b.add('result_not_stated', 'the outcome of this motion was not stated on the recording');
    // A result with no counts, no named votes and no voting language in the cited lines was inferred, not heard.
    const heardVote = b.support.some((x) => /(aye|ayes|nay|in favor|opposed|all those|vote|voted|unanimous|carries|carried|passes|passed|fails|failed|objection)/i.test(x.text));
    if (['passed', 'failed'].includes(m.result) && yes == null && no == null && !(v.yes_names || []).length && !heardVote) b.add('vote_not_heard', `marked ${m.result}, but no vote is heard in the cited lines`);
    return finish(m, b, { mover_resolved: mover, seconder_resolved: seconder, vote_check: { directors_present: P, votes_cast: cast || null } });
  });

  // ---- action items
  const action_items = (analysis.action_items || []).map((a) => {
    const b = base(a, { textFields: [a.task, a.quote] });
    const cited = b.support.map((x) => x.text).join(' ');
    if (a.responsible) {
      const nt = nameToks(a.responsible);
      const inText = nt.length && nt.some((t) => toks(cited).includes(t));
      const r = resolvePerson(a.responsible);
      const bySpeaker = b.support.some((x) => { const n = speakerName(x.speaker); return n && nt.length && nt.every((t) => nameToks(n).includes(t)); })
        || (r.speaker != null && b.support.some((x) => x.speaker === r.speaker));
      const bySuggestion = (analysis.speaker_suggestions || []).some((sg) => nt.length && nt.every((t) => nameToks(sg.name).includes(t)) && b.support.some((x) => x.speaker === Number(sg.speaker) - 1));
      if (!inText && !bySpeaker && !bySuggestion) b.add('responsible_not_stated', `"${a.responsible}" is not named in, and did not speak, the cited lines`);
      else if (!inText && !bySpeaker && bySuggestion) b.add('responsible_from_unconfirmed_speaker', `"${a.responsible}" rests on Paige's suggestion of who a speaker is; map the speaker to confirm`);
      if (r.kind === 'speaker') b.add('responsible_not_identified', `${a.responsible} is not yet mapped to a person`);
    }
    if (a.due) {
      const dt = toks(a.due).filter((t) => !STOP.has(t));
      const ct = new Set(toks(cited));
      if (!dt.length || !dt.every((t) => ct.has(t))) b.add('due_not_in_transcript', `the due date "${a.due}" is not in the cited lines`);
    }
    return finish(a, b, { responsible_resolved: a.responsible ? resolvePerson(a.responsible) : { kind: 'none' } });
  });

  const simple = (list, fields) => (list || []).map((x) => { const b = base(x, { requireQuote: fields.quote !== false, textFields: fields.text(x) }); return finish(x, b); });
  const decisions = simple(analysis.decisions, { text: (x) => [x.text, x.quote] });
  const follow_ups = simple(analysis.follow_ups, { text: (x) => [x.text, x.quote] });
  const next_agenda_items = simple(analysis.next_agenda_items, { quote: false, text: (x) => [x.text] });
  const discussion_topics = simple(analysis.discussion_topics, { quote: false, text: (x) => [x.topic, x.minutes_note] });
  const uncertainties = simple(analysis.uncertainties, { quote: false, text: (x) => [x.note] });

  const one = (x, opts) => { const b = base(x || {}, opts); return finish(x || {}, b); };
  const call_to_order = one(analysis.call_to_order, { textFields: [] });
  const cto = resolvePerson(analysis.call_to_order && analysis.call_to_order.by);
  if (cto.kind === 'mapped' && cto.role === 'manager') { call_to_order.status = 'NEEDS_REVIEW'; call_to_order.review_reasons.push({ code: 'officer_calls_to_order', message: 'minutes rule: only a board officer calls the meeting to order, not the manager' }); }
  call_to_order.by_resolved = cto;
  const adjournment = one(analysis.adjournment, { textFields: [] });

  // speaker suggestions (numbers shown to Paige are 1-based)
  const speaker_suggestions = (analysis.speaker_suggestions || []).map((sg) => {
    const b = base(sg, { textFields: [] });
    const spk = Number(sg.speaker) - 1;
    if (!segments.some((s) => s.speaker === spk)) b.add('speaker_not_in_transcript', `there is no Speaker ${sg.speaker}`);
    let member = null;
    if (sg.role === 'board_member') { const r = matchRoster(sg.name); member = r.member; if (!member) b.add('not_on_roster', `"${sg.name}" is not on the current board roster`); }
    return finish(sg, b, { speaker_index: spk, board_member_id: member ? member.id : null, roster_name: member ? member.name : null, already_mapped: !!mapOf(spk) });
  });

  // summaries: public text; check for executive wording
  const sumReasons = [];
  if (leaksExec(analysis.short_summary) || leaksExec(analysis.executive_summary)) { sumReasons.push({ code: 'executive_session_content', message: 'the summary repeats executive-session wording' }); withheld++; }
  if (gaps.length) sumReasons.push({ code: 'recording_gaps', message: `${gaps.length} recording gap(s): ${gaps.map((g) => `${hms(g.at_audio_ms)} (${Math.round(g.ms / 1000)} s, ${String(g.reason).replace(/_/g, ' ')})`).join(', ')}` });
  const summary = { short_summary: analysis.short_summary || '', executive_summary: analysis.executive_summary || '', status: sumReasons.some((r) => r.code === 'executive_session_content') ? 'NEEDS_REVIEW' : 'OK', review_reasons: sumReasons, withheld: sumReasons.some((r) => r.code === 'executive_session_content') };

  const all = [attendance, call_to_order, adjournment, ...motions, ...decisions, ...action_items, ...follow_ups, ...next_agenda_items, ...discussion_topics];
  return {
    summary, attendance, call_to_order, adjournment, motions, decisions, action_items, follow_ups, next_agenda_items, discussion_topics, speaker_suggestions, uncertainties,
    recording: { gaps, exec_ranges: execRanges.map((r) => ({ audio_from_ms: r.audio_from_ms, audio_to_ms: r.audio_to_ms, meeting_from_ms: r.meeting_from_ms, meeting_to_ms: r.meeting_to_ms })) },
    counts: { items: all.length, needs_review: all.filter((x) => x.status === 'NEEDS_REVIEW').length + (summary.status === 'NEEDS_REVIEW' ? 1 : 0), withheld },
  };
}

module.exports = { validateAnalysis, quoteSupported, norm, hms };
