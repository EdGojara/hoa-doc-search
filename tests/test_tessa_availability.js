// ============================================================================
// tests/test_tessa_availability.js  (Ed 2026-10-07)
// ----------------------------------------------------------------------------
// Tessa never books blind. Proves, with a fake calendar (no Graph, no database):
//   - exact time that is free -> booked as named;
//   - exact time that conflicts -> NOT booked; the conflict + 2-3 open alternatives;
//   - a broad window ("Friday afternoon") -> the earliest open 30-minute slot;
//   - the candidate offers 3 times -> the earliest one Ed is free for;
//   - two requests competing for one slot -> the second never gets it (the first
//     request's staged meeting is a HOLD; a true race is settled after the write:
//     the earlier hold keeps the slot, the later one is cancelled, not deleted);
//   - no opening in the window -> the best 2-3 alternatives, nothing booked;
//   - a thread stating Eastern times is converted to Central;
//   - a failed calendar read is never "free" (fail closed);
//   - "Tessa, set up Juanita Friday afternoon": her hiring thread -> an in-person
//     interview, an open slot read from Ed's calendar, a confirmation email naming
//     that slot, Ed's calendar only, no Teams, no invite (the #90 routing).
// ============================================================================
require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH || undefined, quiet: true });
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test';
const assert = require('assert');
const S = require('../lib/ea/tessa_slots');
const A = require('../lib/ea/tessa_availability');
const C = require('../lib/ea/tessa_calendar_intent');
const { runRequest } = require('../lib/ea/tessa_request');

const tests = []; const check = (n, fn) => tests.push([n, fn]);
const BASE = '2026-10-07'; const NOW = '2026-10-07T11:00:00';          // Wednesday, 11:00 AM Central
const NOW_DATE = new Date('2026-10-07T16:00:00Z');                       // the same instant
const ED = 'egojara@bedrocktx.com'; const TESSA = 'tmccall@bedrocktx.com';
const FRI = '2026-10-09';
const BUSY = [
  { start: `${FRI}T13:00:00`, end: `${FRI}T14:00:00`, subject: 'Board call' },
  { start: `${FRI}T15:00:00`, end: `${FRI}T15:30:00`, subject: 'Vendor walk' },
];
const pick = (spec, busy = BUSY, dur = 30) => S.pickSlot({ spec, busy, durationMinutes: dur, nowWall: NOW });
const clean = (res, busy = BUSY) => [res.slot, ...(res.alternatives || [])].filter(Boolean).every((s) => !busy.some((b) => S.overlaps(s.start, s.end, b.start, b.end)));

// ------------------------------------------------------------------ the five cases
check('exact time that is FREE: booked exactly as Ed named it', () => {
  const r = pick(S.parseSpec('Confirm Nicole Friday at 2 PM.', { date: 'friday', start_time: '2:00 PM' }, BASE));
  assert.deepStrictEqual([r.status, r.slot.start, r.slot.end], ['ok', `${FRI}T14:00:00`, `${FRI}T14:30:00`]);
});
check('exact time that CONFLICTS: not booked; the conflict is named; 2-3 open alternatives, none overlapping', () => {
  const r = pick(S.parseSpec('Confirm Nicole Friday at 1:30 PM.', { date: 'friday', start_time: '1:30 PM' }, BASE));
  assert.strictEqual(r.status, 'conflict'); assert.ok(!r.slot);
  assert.strictEqual(r.conflicts[0].subject, 'Board call');
  assert.ok(r.alternatives.length >= 2 && r.alternatives.length <= 3, JSON.stringify(r.alternatives));
  assert.ok(clean(r));
});
check('broad window ("Friday afternoon"): the earliest open 30-minute slot that afternoon, never over an event', () => {
  const r = pick(S.parseSpec('Tessa, set up Juanita Friday afternoon.', { date: 'friday' }, BASE));
  assert.deepStrictEqual([r.status, r.slot.start], ['ok', `${FRI}T14:00:00`]); assert.ok(clean(r));
  const r2 = pick(S.parseSpec('Call Dana tomorrow morning.', { date: 'tomorrow' }, BASE));
  assert.deepStrictEqual([r2.status, r2.slot.start], ['ok', '2026-10-08T09:00:00']);
  const r3 = pick(S.parseSpec('Find time with Dana sometime next week.', {}, BASE));
  assert.deepStrictEqual([r3.status, r3.slot.start.slice(0, 10)], ['ok', '2026-10-12']);
});
check('candidate offers 3 times: the earliest one Ed is free for; the busy ones are named as skipped', () => {
  const r = pick(S.parseSpec('Set up Juanita.', {}, BASE, 'Thanks! I can do Friday at 1, Friday at 3 PM, or Monday at 10 am.'));
  assert.deepStrictEqual([r.status, r.slot.start], ['ok', '2026-10-12T10:00:00']);
  assert.ok(r.reasons.some((x) => /Friday at 1: Ed is busy/.test(x)) && r.reasons.some((x) => /Friday at 3 PM: Ed is busy/.test(x)));
  const r2 = pick(S.parseSpec('Set up Juanita.', {}, BASE, 'Monday at 10 am, Friday at 2:30 pm or Friday at 4'));
  assert.deepStrictEqual([r2.status, r2.slot.start], ['ok', `${FRI}T14:30:00`], 'earliest free, not first listed');
});
check('two requests competing for the same open slot: the first request’s staged meeting is a HOLD, so the second gets the next opening', () => {
  const spec = S.parseSpec('Set up Juanita Friday afternoon.', { date: 'friday' }, BASE);
  const first = pick(spec);
  const hold = { start: first.slot.start, end: first.slot.end, subject: 'held by Tessa: In-Person Interview - Juanita Ramsey', source: 'hold' };
  const second = pick(S.parseSpec('Set up Marcus Friday afternoon.', { date: 'friday' }, BASE), [...BUSY, hold]);
  assert.strictEqual(second.status, 'ok'); assert.notStrictEqual(second.slot.start, first.slot.start);
  assert.ok(!S.overlaps(second.slot.start, second.slot.end, first.slot.start, first.slot.end));
});

check('a time Ed names loosely ("Friday 4") is exact, never silently replaced by the window’s earliest slot', () => {
  const r = pick(S.parseSpec('Call Dana Friday 4.', { date: 'friday', start_time: '4:00 PM' }, BASE));
  assert.deepStrictEqual([r.status, r.slot.start], ['ok', `${FRI}T16:00:00`]);
});

// ------------------------------------------------------------------ edges
check('no opening in the window: nothing booked; the best 2-3 alternatives', () => {
  const full = [{ start: `${FRI}T13:00:00`, end: `${FRI}T17:00:00`, subject: 'Offsite' }];
  const r = pick(S.parseSpec('Set up Juanita Friday afternoon.', { date: 'friday' }, BASE), full);
  assert.strictEqual(r.status, 'none'); assert.ok(!r.slot);
  assert.ok(r.alternatives.length >= 2 && r.alternatives.length <= 3 && clean(r, full), JSON.stringify(r.alternatives));
});
check('a thread stating Eastern times is converted to Central (3 PM ET = 2 PM Central)', () => {
  const r = pick(S.parseSpec('Set up Juanita.', {}, BASE, 'Friday at 3 PM ET or Friday at 4 PM ET works'));
  assert.strictEqual(r.slot.start, `${FRI}T14:00:00`);
});
check('never in the past, never a weekend for a chosen slot, an exact time in the past is refused', () => {
  const r = pick(S.parseSpec('Confirm Dana today at 9 AM.', { date: 'today', start_time: '9:00 AM' }, BASE));
  assert.strictEqual(r.status, 'conflict'); assert.ok(r.reasons.some((x) => /already passed/.test(x)));
  const sat = pick(S.parseSpec('Set up Dana Saturday afternoon.', { date: 'saturday' }, BASE));
  assert.strictEqual(sat.status, 'none', 'Saturday is outside working days');
});

// ------------------------------------------------------------------ calendar read + holds (fakes)
function fakeSupabase(rows = []) {
  const state = { rows: rows.map((r) => ({ ...r })) };
  const q = (filters = []) => ({
    select() { return q(filters); }, order() { return q(filters); },
    eq(c, v) { return q([...filters, (r) => r[c] === v]); },
    lt(c, v) { return q([...filters, (r) => String(r[c]) < String(v)]); },
    gt(c, v) { return q([...filters, (r) => String(r[c]) > String(v)]); },
    limit() { const d = state.rows.filter((r) => filters.every((f) => f(r))).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id))); return Promise.resolve({ data: d, error: null }); },
    update(patch) { return { eq: (c1, v1) => ({ eq: (c2, v2) => { for (const r of state.rows) if (r[c1] === v1 && r[c2] === v2) Object.assign(r, patch); return Promise.resolve({ error: null }); } }) }; },
  });
  return { state, from: () => q() };
}
const graph = (pages, { failWith } = {}) => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); if (failWith) return { ok: false, status: failWith, json: async () => ({ error: { code: 'ErrorAccessDenied' } }) }; const i = calls.length - 1; return { ok: true, json: async () => ({ value: pages[i] || [], ...(i + 1 < pages.length ? { '@odata.nextLink': 'https://graph/next' + i } : {}) }) }; };
  return { fetchImpl, calls };
};
const ev = (s, e, subject, extra = {}) => ({ subject, start: { dateTime: s + '.0000000' }, end: { dateTime: e + '.0000000' }, showAs: 'busy', isCancelled: false, ...extra });
check('the calendar read: every page, free / cancelled are not busy, queued Tessa meetings are holds; offset times (never bare)', async () => {
  const g = graph([[ev(`${FRI}T13:00:00`, `${FRI}T14:00:00`, 'Board call'), ev(`${FRI}T09:00:00`, `${FRI}T10:00:00`, 'Tentative lunch', { showAs: 'free' })], [ev(`${FRI}T15:00:00`, `${FRI}T15:30:00`, 'Vendor walk'), ev(`${FRI}T16:00:00`, `${FRI}T16:30:00`, 'Cancelled', { isCancelled: true })]]);
  const sb = fakeSupabase([{ id: 'h1', kind: 'meeting', status: 'queued', subject: 'Phone Interview - Nicole Hill', meeting_start: `${FRI}T14:00:00`, meeting_end: `${FRI}T14:30:00`, created_at: '2026-10-07T15:00:00Z' }]);
  const busy = await A.loadBusy({ edMailbox: ED, from: `${FRI}T00:00:00`, to: '2026-10-10T00:00:00', supabase: sb }, { token: 't', fetchImpl: g.fetchImpl });
  assert.deepStrictEqual(busy.map((b) => [b.subject, b.source]), [['Board call', 'calendar'], ['Vendor walk', 'calendar'], ['held by Tessa: Phone Interview - Nicole Hill', 'hold']]);
  assert.ok(/startDateTime=2026-10-09T00%3A00%3A00-05%3A00/.test(g.calls[0]), g.calls[0]);
});
check('a failed calendar read is never "free": it throws and nothing is scheduled', async () => {
  const g = graph([], { failWith: 403 });
  await assert.rejects(() => A.chooseSlot({ text: 'Set up Juanita Friday afternoon.', meeting: { date: 'friday' } }, { token: 't', fetchImpl: g.fetchImpl, edMailbox: ED, now: NOW_DATE }), /could not read Ed's calendar/);
});
check('chooseSlot end to end with the hold: the slot after Board call (2 PM) is held, so Friday afternoon gives 2:30', async () => {
  const g = graph([[ev(`${FRI}T13:00:00`, `${FRI}T14:00:00`, 'Board call'), ev(`${FRI}T15:00:00`, `${FRI}T15:30:00`, 'Vendor walk')]]);
  const sb = fakeSupabase([{ id: 'h1', kind: 'meeting', status: 'queued', subject: 'Interview - Juanita', meeting_start: `${FRI}T14:00:00`, meeting_end: `${FRI}T14:30:00`, created_at: '2026-10-07T15:00:00Z' }]);
  const { result } = await A.chooseSlot({ text: 'Set up Marcus Friday afternoon.', meeting: { date: 'friday' } }, { token: 't', fetchImpl: g.fetchImpl, supabase: sb, edMailbox: ED, now: NOW_DATE });
  assert.deepStrictEqual([result.status, result.slot.start], ['ok', `${FRI}T14:30:00`]);
});
check('a true race (both read before either wrote): the EARLIER hold keeps the slot; the later is cancelled with the reason, never deleted', async () => {
  const sb = fakeSupabase([
    { id: 'aaa', kind: 'meeting', status: 'queued', subject: 'In-Person Interview - Juanita Ramsey', meeting_start: `${FRI}T14:00:00`, meeting_end: `${FRI}T14:30:00`, created_at: '2026-10-07T16:00:00.100Z' },
    { id: 'bbb', kind: 'meeting', status: 'queued', subject: 'Phone Call - Marcus', meeting_start: `${FRI}T14:00:00`, meeting_end: `${FRI}T14:30:00`, created_at: '2026-10-07T16:00:00.200Z' },
  ]);
  const later = await A.settleHold(sb, { id: 'bbb', meeting_start: `${FRI}T14:00:00`, meeting_end: `${FRI}T14:30:00` });
  const earlier = await A.settleHold(sb, { id: 'aaa', meeting_start: `${FRI}T14:00:00`, meeting_end: `${FRI}T14:30:00` });
  assert.deepStrictEqual([later.kept, earlier.kept], [false, true]);
  const b = sb.state.rows.find((r) => r.id === 'bbb');
  assert.deepStrictEqual([b.status, /earlier request/.test(b.send_error)], ['cancelled', true]);
  assert.strictEqual(sb.state.rows.length, 2, 'nothing deleted');
});

// ------------------------------------------------------------------ the target UX, end to end
const juanita = { name: 'Juanita Ramsey', email: 'jramsey@example.com' };
async function request(text, { busy = BUSY, holds = [], thread = null, meetingExtra = {} } = {}) {
  const thoughts = [];
  const g = graph([busy.map((b) => ev(b.start, b.end, b.subject))]);
  const sb = fakeSupabase(holds);
  const out = await runRequest(text, {
    parser: async () => ({ action: 'meeting', to_hints: ['Juanita'], cc_hints: [], mention_hints: [], provided_emails: {}, create_contacts: [], search_terms: ['Juanita'], unclear: [], instruction: `Set up a meeting with Juanita`,
      meeting: { direct_invite: true, date: 'friday', start_time: null, end_time: null, title: 'Meeting with Juanita', topic: null, message: null, wants_intro: false, location: null, ...meetingExtra } }),
    resolveRecipient: async () => ({ best: { ...juanita, source: 'contacts' } }),
    searchMailbox: async () => ({ messages: thread ? [{ id: 'm1', conversation_id: 'c1', subject: thread.subject, from: { name: juanita.name, email: juanita.email }, received_at: '2026-10-05T15:00:00Z', preview: thread.preview }] : [] }),
    mailboxes: [ED],
    drafter: async ({ thought }) => { thoughts.push(thought); return { subject: 'Confirming your interview', body: 'Hi Juanita' }; },
    schedule: (args) => A.chooseSlot(args, { token: 't', fetchImpl: g.fetchImpl, supabase: sb, edMailbox: ED, now: NOW_DATE }),
  });
  return { out, thought: thoughts[0] || null };
}
const HIRING = { subject: 'Re: Interview - Community Operations Assistant', preview: 'Thank you! I am glad to come in person to your office at 12808 W Airport Blvd, Suite 253. Friday works.' };
check('TARGET: "Tessa, set up Juanita Friday afternoon." -> in-person interview from her thread, an open 30-min slot from Ed’s Friday, a confirmation naming that slot, Ed’s calendar only, no Teams, no invite', async () => {
  const { out, thought } = await request('Tessa, set up Juanita Friday afternoon.', { thread: HIRING });
  const m = out.meeting;
  assert.deepStrictEqual([m.mode, m.method, m.interview, m.schedule.status, m.date, m.start_time, m.duration_minutes], ['calendar_only', 'in_person', true, 'ok', FRI, '14:00', 30]);
  const row = C.buildStagedMeetingRow({ mode: m.mode, method: m.method, meeting: m, people: out.to, phones: [], wt: { start: `${FRI}T14:00:00`, end: `${FRI}T14:30:00`, tz: 'Central Standard Time' }, edMailbox: ED, tessaMailbox: TESSA });
  assert.deepStrictEqual([row.subject, row.organizer, row.meeting_attendees, row.meeting_location], ['In-Person Interview - Juanita Ramsey', ED, '', '12808 W Airport Blvd, Suite 253']);
  assert.ok(!/teams/i.test(`${row.subject} ${row.body_text} ${row.meeting_location}`));
  assert.ok(out.draft && /Friday, October 9 at 2:00 PM/.test(thought) && /arranging this on Ed Gojara's behalf/.test(thought) && /in-person interview/.test(thought), thought);
});
check('exact time that conflicts, end to end: no draft, nothing to stage, the conflict and alternatives come back', async () => {
  const { out } = await request('Confirm Juanita Friday at 1:30 PM in person.', { thread: HIRING, meetingExtra: { start_time: '1:30 PM' } });
  assert.deepStrictEqual([out.meeting.schedule.status, out.draft], ['conflict', null]);
  assert.ok(out.meeting.schedule.alternatives.length >= 2);
});
check('the candidate’s own email offers 3 times: the earliest Ed is free for is booked and confirmed', async () => {
  const thread = { subject: 'Re: Interview - Community Operations Assistant', preview: 'I can do Friday at 1, Friday at 3 PM, or Monday at 10 am. In person is fine.' };
  const { out, thought } = await request('Tessa, set up Juanita.', { thread, meetingExtra: { date: null } });
  assert.deepStrictEqual([out.meeting.schedule.kind, out.meeting.schedule.status, out.meeting.date, out.meeting.start_time], ['options', 'ok', '2026-10-12', '10:00']);
  assert.ok(/Monday, October 12 at 10:00 AM/.test(thought), thought);
});
check('#90 routing kept: an explicit Teams interview in a window gets a slot and stays a Teams meeting (online)', async () => {
  const { out } = await request('Schedule Juanita for a Teams interview Friday afternoon.', { thread: HIRING });
  assert.deepStrictEqual([out.meeting.mode, out.meeting.method, out.meeting.schedule.status, out.meeting.start_time], ['online', 'teams', 'ok', '14:00']);
});

(async () => {
  let pass = 0, fail = 0;
  console.log('Tessa: availability-aware scheduling (Ed 2026-10-07)');
  for (const [n, fn] of tests) { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n      ')); } }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
