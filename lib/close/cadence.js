// ============================================================================
// lib/close/cadence.js  (Ed 2026-10-15: Amanda drives the close and the board package)
// ----------------------------------------------------------------------------
// Kat closes the books, Emma keeps the bills, Amanda keeps the calendar. Before
// this, the pieces existed but nothing tied them to a date: the close checklist
// re-ran only by hand, no meeting was on file, and close and packet work were not
// in Ed's queue. The daily sweep (scheduler job `close_cadence`, OFF unless in
// SCHEDULER_ENABLED) does, for each operational community whose close is in use:
//
//   1. Kat's review: for every open month since the cutover, gather + evaluate the
//      checklist (read-only) and record a new run as Kat ONLY when the books or the
//      evidence changed since the latest run (lib/close/service.reviewIfChanged).
//   2. Owned tasks: each unresolved BLOCK becomes ONE Mission Control task under the
//      derived key close:<cid>:<yyyy-mm>:<control> (owner by lib/close/ownership);
//      each open month is Amanda's close:<cid>:<yyyy-mm>; a task whose evidence
//      cleared is closed (closed_by_evidence). Unchanged tasks are not touched.
//   3. Deadlines from the next board meeting (meetings table, migration 447): the
//      months the packet reports (open months through the financial cutoff) get due
//      dates working back from the meeting by the package profile's business-day
//      offsets (collect inputs, close, review draft, approve distribution).
//      No meeting on file = Amanda's task to get the date.
//   4. The packet: once every reported month is closed, the packet for the meeting is
//      created and assembled (api/board_packets.assemblePackage). It stays DRAFT.
//
// Never: closing a period, approving, posting, distributing, or sending email. Ed's
// approvals stay where they are (close: owner only; distribution: packet finalization
// gate + a person). Ed sees "month ready to close" and "packet ready for approval" in
// /api/ed/pending (pendingSources below).
// ============================================================================
'use strict';

const { controlOwner, BOARD_OWNER } = require('./ownership');
const { centralMidnightIso } = require('../manager/subjects');

const ACTOR = 'Amanda (close cadence)';
// Kat records the review (the first word must be Kat: lib/close/policy isKatName).
const KAT_SWEEP = { name: 'Kat (AI accountant) cutoff review, daily close sweep', user_id: null, role: 'staff' };
const DEFAULT_OFFSETS = { create: -10, collect: -7, first_check: -5, review_draft: -3, lock: -1 };
const MEETING_TYPES = ['regular', 'annual', 'special', 'budget'];
const MAX_MONTHS = 12;

const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ym = (d) => String(d).slice(0, 7);
const monthLabel = (d) => `${MON[Number(String(d).slice(5, 7)) - 1]} ${String(d).slice(0, 4)}`;
const monthName = (d) => MON[Number(String(d).slice(5, 7)) - 1];
const dayLabel = (d) => { const [y, m, dd] = String(d).slice(0, 10).split('-').map(Number); return `${MON[m - 1].slice(0, 3)} ${dd}, ${y}`; };
const listJoin = (a) => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);

function centralToday(now = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
// Move n business days (Mon-Fri) from a calendar date; negative = earlier.
function addBusinessDays(dateStr, n) {
  const d = new Date(`${String(dateStr).slice(0, 10)}T12:00:00Z`);
  const step = n < 0 ? -1 : 1;
  let left = Math.abs(n);
  while (left > 0) { d.setUTCDate(d.getUTCDate() + step); const w = d.getUTCDay(); if (w !== 0 && w !== 6) left -= 1; }
  return d.toISOString().slice(0, 10);
}
// A deadline is the end of that Central business day (5:00 PM), as a full ISO instant.
const dueIso = (dateStr) => (dateStr ? new Date(Date.parse(centralMidnightIso(dateStr)) + 17 * 3600000).toISOString() : null);
function lastDayOfPriorMonth(dateStr) { const [y, m] = String(dateStr).slice(0, 7).split('-').map(Number); return new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10); }

function meetingDeadlines(meetingDate, offsets = DEFAULT_OFFSETS) {
  const o = { ...DEFAULT_OFFSETS, ...(offsets || {}) };
  const at = (k) => addBusinessDays(meetingDate, Number(o[k]));
  return { meeting: String(meetingDate).slice(0, 10), create: at('create'), collect: at('collect'), close: at('first_check'), review_draft: at('review_draft'), approve: at('lock') };
}
function urgencyFor(dueDate, today) {
  if (!dueDate) return 'normal';
  const days = Math.round((Date.parse(`${dueDate}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86400000);
  return days < 0 ? 'critical' : days <= 3 ? 'high' : 'normal';
}

// ---- hand-made close tasks are adopted, never duplicated or dismissed ------------------
// Before the cadence, close work was tracked by hand under refs like
// cg-close-2026-08-09:bank-recs (community prefix, the month or months, a topic). When such an
// open task already covers a planned item (same community, its month(s), the same subject),
// the sweep adopts it: it creates nothing for that item and never edits or closes the hand-made
// task. Subjects are matched on the control code or its usual words in the ref and title.
const HANDMADE_REF = /^[a-z0-9]+-close-(\d{4})-(\d{2})(?:-(\d{2}))?:/i;
const COVERS = {
  'CASH-01': /cash-?01|bank.?rec/i, 'CASH-02': /cash-?02|bank.?rec/i, 'AR-02': /ar-?02|owner credits/i, 'AR-01': /ar-?01/i,
  'DATA-02': /data-?02|statement/i, 'DATA-03': /data-?03|prepaid|deferred/i, 'DATA-04': /data-?04|not booked|intake exception/i,
  'CUT-01': /cut-?01|missing .*bills|not posted|late.?arriving/i, meeting: /meeting date|board.?package|board reporting/i,
};
// The months a hand-made task covers: those in its ref, plus months its title names
// ("DATA-03 Aug/Sep"), in the ref's year.
const MONTH_WORD = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/gi;
function handmadeMonths(ref, title = '') {
  const m = HANDMADE_REF.exec(String(ref || ''));
  if (!m) return null;
  const out = new Set(m[3] ? [`${m[1]}-${m[2]}`, `${m[1]}-${m[3]}`] : [`${m[1]}-${m[2]}`]);
  for (const w of String(title || '').match(MONTH_WORD) || []) {
    const i = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(w.slice(0, 3).toLowerCase());
    if (i >= 0) out.add(`${m[1]}-${String(i + 1).padStart(2, '0')}`);
  }
  return [...out];
}
function adoptingTask(t, handmade) {
  const re = t.kind === 'block' ? (COVERS[t.control] || new RegExp(String(t.control).replace('-', '-?'), 'i')) : t.kind === 'meeting' ? COVERS.meeting : null;
  if (!re) return null;
  return (handmade || []).find((w) => {
    const months = handmadeMonths(w.source_ref, w.title);
    if (!months) return false;
    if (t.kind === 'block' && !months.includes(t.period)) return false;
    return re.test(`${w.source_ref} ${w.title || ''}`);
  }) || null;
}

// ---- the plan (pure) -------------------------------------------------------------
// state: { community:{id,name}, today, periods:[{id, period_start, period_end, closed, review:{results, run_id, error}, overrides:Set<code|hash>}],
//          meeting:{id, title, meeting_date, meeting_type}|null, offsets, packet:{id, status, period_label}|null, packet_ready:{ok, reasons[]}|null }
function planCommunity(state) {
  const c = state.community; const today = state.today;
  const tasks = []; const notes = [];
  const open = (state.periods || []).filter((p) => !p.closed).sort((a, b) => String(a.period_start).localeCompare(String(b.period_start)));
  const meeting = state.meeting || null;
  const cutoff = meeting ? lastDayOfPriorMonth(meeting.meeting_date) : null;
  const dl = meeting ? meetingDeadlines(meeting.meeting_date, state.offsets) : null;
  const covered = meeting ? open.filter((p) => String(p.period_end) <= cutoff) : [];
  const coveredIds = new Set(covered.map((p) => p.id));
  const when = meeting ? `the ${dayLabel(meeting.meeting_date)} board meeting` : null;
  const meetingUrl = '/#tab=agenda';
  const closeUrl = `/admin/accounting?community_id=${c.id}&view=close`;

  const blockersByPeriod = new Map();
  for (const p of open) {
    if (p.not_ended) { blockersByPeriod.set(p.id, 'not_ended'); continue; }
    if (!p.review || p.review.error) {
      notes.push(`${monthLabel(p.period_start)}: Kat's review could not be read (${(p.review && p.review.error) || 'no review'}); its blockers are unknown and nothing was cleared.`);
      blockersByPeriod.set(p.id, null);
      continue;
    }
    const overrides = p.overrides || new Set();
    const blocks = (p.review.results || []).filter((r) => r.status === 'BLOCK' && !overrides.has(`${r.code}|${r.evidence_hash || ''}`));
    blockersByPeriod.set(p.id, blocks);
    const inMeeting = coveredIds.has(p.id);
    for (const r of blocks) {
      const owner = controlOwner(r.code);
      const due = inMeeting ? dl.collect : null;
      tasks.push({
        source_ref: `close:${c.id}:${ym(p.period_start)}:${r.code}`, kind: 'block', period: ym(p.period_start), control: r.code,
        title: `${c.name}: ${monthLabel(p.period_start)} close: ${r.label}`.slice(0, 300), assigned_to: owner, requested_by: 'Amanda',
        urgency: due ? urgencyFor(due, today) : 'high', sla_due_at: dueIso(due), due_date: due,
        why: String(r.explanation || '').slice(0, 1000) || null,
        next_step: String(r.action || 'Clear the blocker; Kat\'s next review re-checks it.').slice(0, 500),
        evidence_required: `Close control ${r.code} passes on Kat's next review (or Ed overrides it with a written reason).`,
        action_url: (r.drill && r.drill.href ? String(r.drill.href).replace('/accounting.html', '/admin/accounting') : closeUrl),
        blocks: [`close:${c.id}:${ym(p.period_start)}`], community_id: c.id, community_name: c.name,
      });
    }
  }

  // One coordination task per open month (Amanda), due by the close deadline when the meeting reports it.
  open.forEach((p, i) => {
    const blocks = blockersByPeriod.get(p.id);
    const inMeeting = coveredIds.has(p.id);
    const due = inMeeting ? dl.close : null;
    const earlier = open.slice(0, i).map((x) => monthName(x.period_start));
    let next;
    if (blocks === 'not_ended') next = `The month ends ${dayLabel(p.period_end)}; Kat reviews it the next business day and Amanda tracks its blockers to the deadline.`;
    else if (blocks == null) next = 'Kat\'s review could not be read; re-run it in Month-End Close.';
    else if (blocks.length) next = `${blocks.length} blocker${blocks.length === 1 ? '' : 's'} open: ${blocks.map((r) => `${r.code} (${controlOwner(r.code)})`).join(', ')}. Amanda follows each owner until it clears.`;
    else if (earlier.length) next = `Kat's review is clear. It closes after ${listJoin(earlier)} (months close in order); then Ed approves the close.`;
    else next = 'Kat\'s review is clear: Ed approves and closes the month in Month-End Close.';
    tasks.push({
      source_ref: `close:${c.id}:${ym(p.period_start)}`, kind: 'month', period: ym(p.period_start),
      title: `${c.name}: close ${monthLabel(p.period_start)}${inMeeting ? ` by ${dayLabel(due)} for ${when}` : ''}`.slice(0, 300),
      assigned_to: BOARD_OWNER, requested_by: 'Amanda', urgency: due ? urgencyFor(due, today) : 'normal', sla_due_at: dueIso(due), due_date: due,
      why: inMeeting ? `The packet for ${when} reports financials through ${dayLabel(cutoff)}; it is final only once ${monthLabel(p.period_start)} is closed.` : 'Every month closes in order; a later packet cannot be final until this one closes.',
      next_step: next.slice(0, 500), evidence_required: 'The month is closed by Ed in Month-End Close (period_closes.status = closed).',
      action_url: closeUrl, blocks: inMeeting ? [`package:${c.id}:${ym(cutoff)}`] : [], community_id: c.id, community_name: c.name,
      ready_to_close: Array.isArray(blocks) && blocks.length === 0 && !earlier.length,
    });
  });

  let packetAction = null;
  if (!meeting) {
    tasks.push({
      source_ref: `meeting:${c.id}:next`, kind: 'meeting', title: `${c.name}: get the next board meeting date`, assigned_to: BOARD_OWNER, requested_by: 'Amanda',
      urgency: open.length ? 'high' : 'normal', sla_due_at: null, due_date: null,
      why: 'No upcoming board meeting is on file, so the close and the board packet have no deadline.',
      next_step: 'Get the date from the board or the manager and save the agenda with that date in the Agenda Generator (or record the meeting); the close deadlines and the packet are scheduled from it.',
      evidence_required: 'A scheduled meeting (or a saved agenda) with a future date for this community.', action_url: meetingUrl, blocks: [], community_id: c.id, community_name: c.name,
    });
  } else if (!(state.packet && ['final', 'distributed', 'archived'].includes(state.packet.status))) {
    let next;
    const cutoffOnFile = (state.periods || []).some((p) => String(p.period_end) === cutoff);
    if (!cutoffOnFile) { next = `No accounting period is on file for ${monthLabel(cutoff)}, so the packet's financials cannot close; Kat opens the period first.`; notes.push(`No accounting period for ${monthLabel(cutoff)} (the packet's financial cutoff).`); }
    else if (covered.length) next = `Waits on the close of ${listJoin(covered.map((p) => monthName(p.period_start)))} (due ${dayLabel(dl.close)}); then Amanda builds the packet as a draft.`;
    else if (!state.packet) { packetAction = 'create_and_assemble'; next = `Every reported month is closed: Amanda creates and assembles the packet as a DRAFT; Ed reviews it by ${dayLabel(dl.review_draft)} and approves distribution by ${dayLabel(dl.approve)}.`; }
    else if (state.packet_ready && state.packet_ready.ok) next = `The draft packet passes the finalization gate: Ed reviews and approves distribution by ${dayLabel(dl.approve)}.`;
    else next = `The draft packet is not ready: ${((state.packet_ready && state.packet_ready.reasons) || ['readiness unknown']).join(' ')}`.slice(0, 500);
    tasks.push({
      source_ref: `package:${c.id}:${ym(cutoff)}`, kind: 'packet', title: `${c.name}: board packet for ${when}`.slice(0, 300), assigned_to: BOARD_OWNER, requested_by: 'Amanda',
      urgency: urgencyFor(dl.approve, today), sla_due_at: dueIso(dl.approve), due_date: dl.approve,
      why: `Financials through ${dayLabel(cutoff)}. Deadlines work back from the meeting: inputs ${dayLabel(dl.collect)}, months closed ${dayLabel(dl.close)}, draft reviewed ${dayLabel(dl.review_draft)}, distribution approved ${dayLabel(dl.approve)}.`,
      next_step: next.slice(0, 500), evidence_required: 'Ed approves the packet; it is marked final and distributed only through the finalization gate.',
      action_url: '/#tab=packets', blocks: [], community_id: c.id, community_name: c.name,
    });
  }
  // Adopt hand-made tasks that already cover an item (see HANDMADE_REF above).
  const adopted = [];
  const kept = tasks.filter((t) => { const w = adoptingTask(t, state.handmade); if (!w) return true; adopted.push({ source_ref: t.source_ref, adopted_by: w.source_ref, title: w.title }); return false; });
  return { community: c, meeting, cutoff, deadlines: dl, adopted, tasks: kept, covered_months: covered.map((p) => ym(p.period_start)), open_months: open.map((p) => ym(p.period_start)), packet_action: packetAction, notes };
}

// ---- loading (read-only unless the review records) ---------------------------------
async function must(q, what) { const { data, error } = await q; if (error) throw new Error(`${what}: ${error.message}`); return data; }

async function overridesFor(supabase, periodId) {
  const ev = await must(supabase.from('period_close_events').select('event, control_code, evidence_hash, created_at').eq('period_id', periodId).in('event', ['block_overridden', 'reopened']).order('created_at').limit(500), 'period_close_events');
  const lastReopen = ev.filter((e) => e.event === 'reopened').map((e) => e.created_at).sort().pop() || null;
  return new Set(ev.filter((e) => e.event === 'block_overridden' && (!lastReopen || e.created_at > lastReopen)).map((e) => `${e.control_code}|${e.evidence_hash || ''}`));
}

// The next board meeting: a scheduled meetings row (migration 447); else a saved agenda with a
// future date (the Agenda Generator), which becomes the meeting record linked to that agenda.
async function nextMeeting(supabase, cid, today, { dryRun = false } = {}) {
  const rows = await must(supabase.from('meetings').select('id, title, meeting_date, meeting_type, status').eq('community_id', cid).eq('status', 'scheduled')
    .in('meeting_type', MEETING_TYPES).gte('meeting_date', today).order('meeting_date', { ascending: true }).limit(1), 'meetings');
  if (rows[0]) return { ...rows[0], source: 'meetings' };
  const ag = (await must(supabase.from('meeting_agendas').select('id, title, meeting_date, meeting_type').eq('community_id', cid).in('meeting_type', MEETING_TYPES)
    .gte('meeting_date', today).order('meeting_date', { ascending: true }).limit(1), 'meeting_agendas'))[0];
  if (!ag) return null;
  const linked = await must(supabase.from('meetings').select('id, title, meeting_date, meeting_type, status').eq('community_id', cid).eq('meeting_agenda_id', ag.id).limit(1), 'meetings');
  if (linked[0]) return linked[0].status === 'canceled' ? null : { ...linked[0], source: 'meetings' };
  const row = { community_id: cid, title: String(ag.title || 'Board Meeting').slice(0, 200), meeting_type: ag.meeting_type, meeting_date: ag.meeting_date, meeting_agenda_id: ag.id };
  if (dryRun) return { id: null, ...row, status: 'scheduled', source: 'agenda', would_create: true };
  const { data, error } = await supabase.from('meetings').insert(row).select('id, title, meeting_date, meeting_type, status').single();
  if (error) throw new Error(`meetings insert: ${error.message}`);
  return { ...data, source: 'agenda', created: true };
}

// "Ready for Ed's approval" = both statements pulled from closed books and the finalization gate passes.
async function packetReadiness(supabase, packetId) {
  const { packetFinalizationGate, isSnapshot, STATEMENT_SECTIONS } = require('../statements/snapshot');
  const secs = await must(supabase.from('board_packet_sections').select('section_key, input_data').eq('packet_id', packetId).in('section_key', STATEMENT_SECTIONS).limit(10), 'board_packet_sections');
  const missing = STATEMENT_SECTIONS.filter((k) => !secs.some((s) => s.section_key === k && isSnapshot(s.input_data)));
  const gate = await packetFinalizationGate(supabase, packetId);
  const reasons = [];
  if (missing.length) reasons.push(`Not pulled from the books yet: ${missing.join(', ').replace(/_/g, ' ')}.`);
  for (const b of gate.open) reasons.push(b.period_label ? `${b.period_label}: ${String(b.problem).replace(/_/g, ' ')}.` : `${String(b.section_key || '').replace(/_/g, ' ')}: ${String(b.problem).replace(/_/g, ' ')}.`);
  return { ok: !missing.length && gate.ok, reasons };
}

async function findPacket(supabase, cid, meeting) {
  const byDate = await must(supabase.from('board_packets').select('id, status, period_label, meeting_date').eq('community_id', cid).eq('meeting_date', meeting.meeting_date).order('created_at', { ascending: false }).limit(1), 'board_packets');
  if (byDate[0]) return byDate[0];
  const byLabel = await must(supabase.from('board_packets').select('id, status, period_label, meeting_date').eq('community_id', cid).eq('period_label', packetLabel(meeting)).limit(1), 'board_packets');
  return byLabel[0] || null;
}
const packetLabel = (meeting) => `${monthLabel(meeting.meeting_date)} Board Meeting`;

async function loadCommunityState(supabase, community, { today, dryRun = false, review, meeting: assumed = null } = {}) {
  const cid = community.id;
  const com = await must(supabase.from('communities').select('id, name, gl_cutover_date').eq('id', cid).single(), 'communities');
  let offsets = DEFAULT_OFFSETS;
  const cfg = await supabase.from('communities').select('board_package_config').eq('id', cid).maybeSingle();
  if (!cfg.error && cfg.data && cfg.data.board_package_config && cfg.data.board_package_config.due_offsets) offsets = { ...DEFAULT_OFFSETS, ...cfg.data.board_package_config.due_offsets };
  const from = com.gl_cutover_date ? `${String(com.gl_cutover_date).slice(0, 7)}-01` : '1900-01-01';
  // A dry run may assume a meeting ("what if the board meets on X"); nothing is written either way.
  const meeting = assumed && dryRun ? { id: null, title: 'Assumed meeting (dry run)', meeting_type: 'regular', status: 'scheduled', source: 'assumed', ...assumed } : await nextMeeting(supabase, cid, today, { dryRun });
  // Every month the packet reports is loaded, including one not over yet (it must close too).
  const cutoff = meeting ? lastDayOfPriorMonth(meeting.meeting_date) : null;
  let pq = supabase.from('accounting_periods').select('id, period_start, period_end, status, period_type').eq('community_id', cid).gte('period_start', from);
  pq = cutoff && cutoff >= today ? pq.lte('period_end', cutoff) : pq.lt('period_end', today);
  const periods = await must(pq.order('period_start', { ascending: true }).limit(60), 'accounting_periods');
  const closes = await must(supabase.from('period_closes').select('period_id, status').eq('community_id', cid).limit(500), 'period_closes');
  const closeBy = new Map(closes.map((x) => [x.period_id, x.status]));
  const monthly = periods.filter((p) => (p.period_type || 'monthly') === 'monthly').map((p) => ({ ...p, closed: ['closed', 'locked'].includes(p.status) || closeBy.get(p.id) === 'closed', not_ended: String(p.period_end) >= today }));
  const openOnes = monthly.filter((p) => !p.closed).slice(0, MAX_MONTHS);
  const runReview = review || ((pid) => require('./service').reviewIfChanged(supabase, cid, pid, KAT_SWEEP, { dryRun }));
  for (const p of openOnes) {
    if (p.not_ended) continue;   // Kat reviews a month once it is over
    try {
      const r = await runReview(p.id);
      if (r && r.skipped === 'period_closed') { p.closed = true; continue; }
      p.review = r; p.overrides = await overridesFor(supabase, p.id);
    } catch (e) { p.review = { error: e.message }; console.warn('[close.cadence] review failed', JSON.stringify({ community: cid, period: p.id, error: e.message })); }
  }
  let packet = null; let ready = null;
  if (meeting) {
    packet = await findPacket(supabase, cid, meeting);
    if (packet && !['final', 'distributed', 'archived'].includes(packet.status)) ready = await packetReadiness(supabase, packet.id);
  }
  // Open hand-made close tasks for this community (adopted, never touched).
  const hm = await must(supabase.from('work_items').select('source_ref, title, status, community_id').eq('community_id', cid).like('source_ref', '%-close-%').in('status', ['new', 'in_progress', 'waiting']).limit(200), 'work_items');
  const handmade = hm.filter((w) => HANDMADE_REF.test(String(w.source_ref || '')));
  return { community: { id: cid, name: com.name }, today, handmade, periods: [...monthly.filter((p) => p.closed), ...openOnes], meeting, offsets, packet, packet_ready: ready };
}

// ---- applying the plan --------------------------------------------------------------
const OPEN = ['new', 'in_progress', 'waiting'];
const FIELDS = ['title', 'assigned_to', 'urgency', 'next_step', 'why'];
const sameDue = (a, b) => (a ? Date.parse(a) : null) === (b ? Date.parse(b) : null);
function taskChanged(row, t) { return FIELDS.some((k) => String(row[k] ?? '') !== String(t[k] ?? '')) || !sameDue(row.sla_due_at, t.sla_due_at); }

async function openCadenceTasks(supabase, cid) {
  const out = [];
  for (const pre of [`close:${cid}:`, `package:${cid}:`, `meeting:${cid}:`]) {
    out.push(...(await must(supabase.from('work_items').select('id, source_ref, title, assigned_to, urgency, sla_due_at, next_step, why, status').eq('source_type', 'agent').like('source_ref', `${pre}%`).in('status', OPEN).limit(500), 'work_items')));
  }
  return out;
}

async function applyPlan(supabase, plan, deps = {}) {
  const MC = (deps.upsertAgentTask && deps.resolveAgentTask) ? deps : require('../../api/mission_control');
  const res = { created: 0, updated: 0, unchanged: 0, resolved: 0, failed: 0 };
  const open = await openCadenceTasks(supabase, plan.community.id);
  const byRef = new Map(open.map((w) => [w.source_ref, w]));
  const planned = new Set(plan.tasks.map((t) => t.source_ref));
  for (const t of plan.tasks) {
    const row = byRef.get(t.source_ref);
    if (row && !taskChanged(row, t)) { res.unchanged += 1; continue; }
    const r = await MC.upsertAgentTask({ source_ref: t.source_ref, title: t.title, assigned_to: t.assigned_to, requested_by: t.requested_by, urgency: t.urgency, sla_due_at: t.sla_due_at,
      why: t.why, next_step: t.next_step, evidence_required: t.evidence_required, action_url: t.action_url, blocks: t.blocks, community_id: t.community_id, community_name: t.community_name, item_type: 'task' });
    if (!r) res.failed += 1; else if (r.created) res.created += 1; else res.updated += 1;
  }
  for (const w of open) {
    if (planned.has(w.source_ref)) continue;
    const r = await MC.resolveAgentTask(w.source_ref, { actor: ACTOR, note: 'Cleared on the daily close sweep: the control passed, the month closed, or the packet is final.' });
    if (r) res.resolved += r.resolved; else res.failed += 1;
  }
  return res;
}

// Communities the cadence covers: operational, not demo, with the month-end close in use.
async function cadenceCommunities(supabase, { only = null } = {}) {
  const ops = await require('../community/lifecycle').operationalCommunities(supabase);
  const used = new Set((await must(supabase.from('period_closes').select('community_id').limit(1000), 'period_closes')).map((r) => r.community_id));
  return ops.filter((c) => !c.is_demo && used.has(c.id) && (!only || only.includes(c.id)));
}

async function runCadence({ supabase, now = Date.now(), env = process.env, dryRun = false, only = null, assumeMeeting = null, deps = {} } = {}) {
  const today = centralToday(now);
  const s = { ok: true, dry_run: dryRun, today, communities: 0, reviews_recorded: 0, tasks_created: 0, tasks_updated: 0, tasks_resolved: 0, packets_created: 0, failed: 0, errors: [], plans: [] };
  if (String(env.AMANDA_MANAGER || '').trim().toLowerCase() === 'off') return { ...s, fired: false, skipped: 'AMANDA_MANAGER=off' };
  const comms = await (deps.communities ? deps.communities() : cadenceCommunities(supabase, { only }));
  for (const c of comms) {
    s.communities += 1;
    try {
      const state = await (deps.loadState || loadCommunityState)(supabase, c, { today, dryRun, meeting: assumeMeeting });
      s.reviews_recorded += state.periods.filter((p) => p.review && p.review.recorded).length;
      let plan = planCommunity(state);
      if (plan.packet_action === 'create_and_assemble' && !dryRun) {
        const assemble = deps.assemblePackage || require('../../api/board_packets').assemblePackage;
        const a = await assemble({ community_id: c.id, meeting_date: state.meeting.meeting_date, period_label: packetLabel(state.meeting) });
        s.packets_created += 1;
        state.packet = { id: a.packet_id, status: 'draft', period_label: a.period_label };
        state.packet_ready = await (deps.packetReadiness || packetReadiness)(supabase, a.packet_id);
        plan = { ...planCommunity(state), packet_action: 'created', packet_id: a.packet_id, packet_needs: a.needs };
      }
      if (!dryRun) {
        const r = await applyPlan(supabase, plan, deps);
        s.tasks_created += r.created; s.tasks_updated += r.updated; s.tasks_resolved += r.resolved; s.failed += r.failed;
        plan.applied = r;
      } else {
        const open = await openCadenceTasks(supabase, c.id);
        const byRef = new Map(open.map((w) => [w.source_ref, w]));
        const planned = new Set(plan.tasks.map((t) => t.source_ref));
        plan.would = { create: plan.tasks.filter((t) => !byRef.has(t.source_ref)).map((t) => t.source_ref), update: plan.tasks.filter((t) => byRef.has(t.source_ref) && taskChanged(byRef.get(t.source_ref), t)).map((t) => t.source_ref), resolve: open.filter((w) => !planned.has(w.source_ref)).map((w) => w.source_ref) };
      }
      plan.reviews = state.periods.filter((p) => p.review).map((p) => ({ month: ym(p.period_start), changed: !!p.review.changed, recorded: !!p.review.recorded, run_id: p.review.run_id || null, summary: p.review.summary || null, error: p.review.error || null }));
      s.plans.push(plan);
    } catch (e) {
      s.failed += 1; s.ok = false; s.errors.push({ community_id: c.id, error: e.message });
      console.error('[close.cadence] community failed', JSON.stringify({ community: c.id, error: e.message }));
    }
  }
  return s;
}

// ---- Ed's queue (api/ed.js /pending) ---------------------------------------------------
// Two sources: months whose close is ready for Ed (Kat's review clear, earliest open month),
// and draft packets for an upcoming meeting that pass the finalization gate.
async function pendingSources(supabase, { now = Date.now() } = {}) {
  const today = centralToday(now);
  const out = [];
  const svc = require('./service');
  const ready = await must(supabase.from('period_closes').select('community_id, period_id, period_start, period_end').eq('status', 'ready_to_close').order('period_end').limit(200), 'period_closes');
  const months = [];
  for (const r of ready) {
    const st = await svc.status(supabase, r.community_id, r.period_id);
    if (!st.can_close) continue;
    const com = await must(supabase.from('communities').select('name, gl_cutover_date').eq('id', r.community_id).single(), 'communities');
    const from = com.gl_cutover_date ? `${String(com.gl_cutover_date).slice(0, 7)}-01` : '1900-01-01';
    const earlier = await must(supabase.from('accounting_periods').select('id, period_type').eq('community_id', r.community_id).gte('period_start', from)
      .lt('period_end', r.period_end).not('status', 'in', '(closed,locked)').limit(50), 'accounting_periods');
    if (earlier.some((p) => (p.period_type || 'monthly') === 'monthly')) continue;   // months close in order
    months.push({ community_id: r.community_id, name: com.name, month: monthLabel(r.period_start) });
  }
  if (months.length) out.push({ key: 'close_ready', icon: '📗', label: `Months ready for you to close: ${months.map((m) => `${m.name} ${m.month}`).join('; ')}`.slice(0, 300), count: months.length, action: `/admin/accounting?community_id=${months[0].community_id}&view=close` });

  const packets = await must(supabase.from('board_packets').select('id, community_id, period_label, meeting_date, status').in('status', ['draft', 'in_review']).gte('meeting_date', today).order('meeting_date').limit(50), 'board_packets');
  const readyPackets = [];
  for (const p of packets) { const r = await packetReadiness(supabase, p.id); if (r.ok) readyPackets.push(p); }
  if (readyPackets.length) out.push({ key: 'packets_ready', icon: '📘', label: `Board packets ready for your approval: ${readyPackets.map((p) => `${p.period_label} (meeting ${dayLabel(p.meeting_date)})`).join('; ')}`.slice(0, 300), count: readyPackets.length, action: '/#tab=packets' });
  return out;
}

module.exports = { runCadence, planCommunity, adoptingTask, handmadeMonths, loadCommunityState, applyPlan, pendingSources, packetReadiness, cadenceCommunities, meetingDeadlines, addBusinessDays, centralToday, urgencyFor, taskChanged, packetLabel, KAT_SWEEP, ACTOR, DEFAULT_OFFSETS };
