// ============================================================================
// lib/meetings/minutes_from_analysis.js  (Ed 2026-09-23)
// ----------------------------------------------------------------------------
// Builds DRAFT minutes (Markdown for meeting_minutes.body_markdown) from the
// CHECKED analysis (lib/meetings/intel_validate.js). Deterministic: no model
// writes the minutes, so nothing can be added that the checked analysis does
// not contain. It follows the house rules in lib/minutes/standards.js:
//   - only an officer calls the meeting to order (flagged if not)
//   - motions record the maker and seconder
//   - no adjudication: discussion is recorded as discussed (Paige's
//     minutes_note is already written to that rule)
//   - executive session is minimal: when it convened and reconvened, never
//     its substance (none of it ever reached Paige)
// Anything NEEDS_REVIEW is shown inline as [NEEDS REVIEW: reason] (brackets
// render as highlighted placeholders in the minutes editor and PDF preview).
// Withheld items (executive-session content) are left out entirely.
// ============================================================================

const TZ = 'America/Chicago';
const clock = (startedAtIso, meetingMs) => new Date(Date.parse(startedAtIso) + meetingMs).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const flag = (item) => (item && item.status === 'NEEDS_REVIEW' && item.review_reasons.length ? ` [NEEDS REVIEW: ${item.review_reasons.map((r) => r.message).join('; ')}]` : '');
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const sentence = (s) => { const t = String(s || '').trim(); return t && !/[.!?]$/.test(t) ? t + '.' : t; };

function personText(resolved, raw) {
  if (!resolved || resolved.kind === 'none') return null;
  if (resolved.kind === 'director' || resolved.kind === 'mapped') return resolved.name;
  return raw || resolved.name || null;
}

/**
 * checked: validateAnalysis() output
 * ctx: { communityName, meeting:{title, meeting_type, meeting_date, location}, sessionStartedAt, roster }
 * Returns { body_markdown, attendees, called_to_order_at, adjourned_at, review_count }
 */
function buildDraftMinutes(checked, ctx) {
  const L = [];
  let review = 0;
  const f = (item) => { const x = flag(item); if (x) review++; return x; };
  const visible = (list) => (list || []).filter((x) => !x.withheld);

  L.push(`_Draft prepared from the meeting recording for staff review. Nothing here is final until reviewed, edited and approved by the Board. Items marked [NEEDS REVIEW] could not be confirmed from the recording._`);
  L.push('');

  // Call to order
  const cto = checked.call_to_order || {};
  const ctoTime = cto.time_stated || (cto.time_ref ? `${clock(ctx.sessionStartedAt, cto.time_ref.meeting_ms)} (per the recording clock)` : null);
  const ctoBy = personText(cto.by_resolved, cto.by);
  const ctoPos = cto.by_resolved && cto.by_resolved.roster_id ? (ctx.roster.find((r) => r.id === cto.by_resolved.roster_id) || {}).position : null;
  L.push('## Call to Order');
  L.push(`The meeting was called to order${ctoTime ? ` at ${ctoTime}` : ' at [time]'}${ctoBy ? ` by ${ctoBy}${ctoPos ? `, ${ctoPos}` : ''}` : ' by [presiding officer]'}.${f(cto)}`);
  L.push('');

  // Roll call / quorum
  const a = checked.attendance || {};
  L.push('## Roll Call / Establishment of Quorum');
  const dirs = (a.directors_present || []).map((d) => { const r = ctx.roster.find((x) => x.id === d.roster_id); return `${d.name}${r && r.position ? `, ${r.position}` : ''}`; });
  L.push(dirs.length ? `Directors present: ${dirs.join('; ')}.` : 'Directors present: [not confirmed from the recording].');
  const absent = ctx.roster.filter((r) => !(a.directors_present || []).some((d) => d.roster_id === r.id));
  if (dirs.length && absent.length) L.push(`Directors not confirmed present: ${absent.map((r) => r.name).join('; ')} [confirm absent or present].`);
  const staff = (a.others_present || []).filter((o) => o.role === 'manager').map((o) => `${o.name}${o.affiliation ? `, ${o.affiliation}` : ''}`);
  const vendors = (a.others_present || []).filter((o) => o.role === 'vendor').map((o) => `${o.name}${o.affiliation ? `, ${o.affiliation}` : ''}`);
  if (staff.length || vendors.length) L.push(`Also present: ${[...staff.map((s) => `${s} (management)`), ...vendors.map((v) => `${v} (vendor)`)].join('; ')}.`);
  if ((a.others_present || []).some((o) => o.role === 'homeowner')) L.push('Homeowners were in attendance.');
  const P = a.directors_present_count || 0, R = a.roster_count || ctx.roster.length;
  if (P && R && P >= Math.floor(R / 2) + 1) L.push(`A quorum was ${a.quorum_stated ? 'declared' : 'present'} (${P} of ${R} directors).${f(a)}`);
  else L.push(`Quorum: [confirm].${f(a)}`);
  L.push('');

  // Discussion
  // Executive session has its own minimal section below; a discussion note about it is never used.
  const topics = visible(checked.discussion_topics).filter((t) => !/executive session/i.test(`${t.topic} ${t.minutes_note}`));
  if (topics.length) {
    L.push('## Reports and Discussion');
    for (const t of topics) L.push(`- **${sentence(cap(t.topic)).replace(/\.$/, '')}.** ${sentence(t.minutes_note)}${f(t)}`);
    L.push('');
  }

  // Motions
  const motions = visible(checked.motions);
  L.push('## Motions and Actions');
  if (!motions.length) L.push('No motions were recorded.');
  for (const m of motions) {
    const mover = personText(m.mover_resolved, m.mover), second = personText(m.seconder_resolved, m.seconder);
    const v = m.vote || {};
    const counts = v.yes != null || v.no != null ? ` Vote: ${v.yes ?? 0} in favor, ${v.no ?? 0} opposed${v.abstain ? `, ${v.abstain} abstaining` : ''}.` : v.method && v.method !== 'not_stated' ? ` Vote: by ${v.method.replace(/_/g, ' ')}.` : '';
    const result = { passed: 'The motion passed.', failed: 'The motion failed.', tabled: 'The motion was tabled.', withdrawn: 'The motion was withdrawn.' }[m.result] || 'Outcome: [not stated on the recording].';
    L.push(`- **Motion:** ${sentence(m.motion_text)} Moved by ${mover || '[mover]'}; seconded by ${second || '[no second recorded]'}.${counts} **${result}**${f(m)}`);
  }
  L.push('');

  // Decisions (not already a motion)
  const decisions = visible(checked.decisions);
  if (decisions.length) {
    L.push('## Decisions');
    for (const d of decisions) L.push(`- ${sentence(d.text)}${f(d)}`);
    L.push('');
  }

  // Homeowner forum / follow-ups are in discussion notes; action items:
  const actions = visible(checked.action_items);
  L.push('## Action Items');
  if (!actions.length) L.push('None recorded.');
  for (const x of actions) L.push(`- ${sentence(x.task).replace(/\.$/, '')}${x.responsible ? ` (${personText(x.responsible_resolved, x.responsible)})` : ''}${x.due ? `, due ${x.due}` : ''}.${f(x)}`);
  L.push('');

  const fu = visible(checked.follow_ups);
  if (fu.length) {
    L.push('## Follow-Up');
    for (const x of fu) L.push(`- ${sentence(x.text)}${f(x)}`);
    L.push('');
  }

  // Executive session: minimal by rule
  const ex = (checked.recording && checked.recording.exec_ranges) || [];
  L.push('## Executive Session');
  if (!ex.length) L.push('None.');
  for (const r of ex) {
    const from = r.meeting_from_ms != null ? clock(ctx.sessionStartedAt, r.meeting_from_ms) : '[time]';
    const to = r.meeting_to_ms != null ? clock(ctx.sessionStartedAt, r.meeting_to_ms) : '[time]';
    L.push(`The Board convened in executive session at ${from} (per the recording clock) and reconvened in open session at ${to}. [Staff: record any action taken in executive session according to the Association's practice. Its content is intentionally not drafted from the recording.]`);
  }
  L.push('');

  // Adjournment
  const adj = checked.adjournment || {};
  const adjTime = adj.time_stated || (adj.time_ref ? `${clock(ctx.sessionStartedAt, adj.time_ref.meeting_ms)} (per the recording clock)` : null);
  L.push('## Adjournment');
  L.push(`There being no further business, the meeting was adjourned${adjTime ? ` at ${adjTime}` : ' at [time]'}.${f(adj)}`);

  const gaps = (checked.recording && checked.recording.gaps) || [];
  if (gaps.length) {
    L.push('');
    L.push(`[NEEDS REVIEW: the recording has ${gaps.length} gap(s) (${gaps.map((g) => `${Math.round(g.ms / 1000)} s, ${String(g.reason).replace(/_/g, ' ')}`).join('; ')}). Anything said during a gap is not reflected above.]`);
    review++;
  }

  const attendees = [
    ...ctx.roster.map((r) => ({ name: r.name, role: r.position || 'Director', present: (a.directors_present || []).some((d) => d.roster_id === r.id) })),
    ...(a.others_present || []).filter((o) => o.role === 'manager' || o.role === 'vendor').map((o) => ({ name: o.name, role: o.role === 'manager' ? 'Management' : 'Vendor', present: true })),
  ];
  return { body_markdown: L.join('\n'), attendees, called_to_order_at: cto.time_stated || null, adjourned_at: adj.time_stated || null, review_count: review };
}

module.exports = { buildDraftMinutes, clock };
