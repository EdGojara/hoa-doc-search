// ============================================================================
// tests/test_tessa_confirm_intent.js  (Ed 2026-10-07)
// ----------------------------------------------------------------------------
// SCAR: "confirm a phone interview ... it is not a Teams interview" staged a TEAMS
// INVITE. The negation knew only "do not / don't / never / without", so "not a
// Teams interview" kept the word Teams; and nothing told a CONFIRMATION (time
// agreed: email the person + put it on Ed's calendar) apart from an INVITATION.
//
// Proves, by rule (no model), for Ed's four phrases and the negation forms:
//   - phone / in-person confirmations and interviews are CALENDAR-ONLY entries on
//     Ed's calendar (no attendees, no Teams), located "Phone call" / the address,
//     30 minutes for an interview, titled "Phone Interview - <name>";
//   - "confirm" drafts a separate confirmation EMAIL in Tessa's voice arranging it
//     for Ed (never as the interviewer, never promising an invite or Teams link);
//   - Teams only when Ed says Teams / video; an attendee invite only when he asks;
//   - "no Teams", "not a Teams interview", "don't create a Teams meeting",
//     "calendar only", "don't send a calendar invite" always win.
// ============================================================================
require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH || undefined, quiet: true });
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';   // module-load only; nothing here calls the database
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test';
const assert = require('assert');
const C = require('../lib/ea/tessa_calendar_intent');
const { runRequest } = require('../lib/ea/tessa_request');

const tests = []; const check = (n, fn) => tests.push([n, fn]);
const ED = 'egojara@bedrocktx.com'; const TESSA = 'tmccall@bedrocktx.com';
const WT = (start, mins) => { const [h, m] = start.split(':').map(Number); const e = h * 60 + m + mins; return { start: `2026-10-08T${start}:00`, end: `2026-10-08T${String(Math.floor(e / 60)).padStart(2, '0')}:${String(e % 60).padStart(2, '0')}:00`, tz: 'Central Standard Time' }; };

const P = {
  juanita: 'Confirm Juanita Friday at 3 PM in person at 12808 W Airport Blvd, Suite 253.',
  nicole: "Confirm Nicole tomorrow at 3:30. It's a phone interview.",
  nicoleScar: "Please confirm Nicole Hill's phone interview tomorrow at 3:30. It is not a Teams interview.",
  alexandra: 'Schedule Alexandra for a Teams interview Friday at 1 PM.',
  sipra: 'Put my call with Sipra on my calendar only. No invite and no Teams.',
};

// ------------------------------------------------------------------ routing
check('Nicole (phone interview, confirm): calendar-only on Ed’s calendar, phone, interview, confirmation email', () => {
  const i = C.classifyCalendarIntent(P.nicole);
  assert.deepStrictEqual([i.mode, i.method, i.interview, i.confirm, C.asksForEmail(P.nicole)], ['calendar_only', 'phone', true, true, true]);
});
check('SCAR: "It is not a Teams interview" can never produce Teams or an invite', () => {
  const i = C.classifyCalendarIntent(P.nicoleScar);
  assert.strictEqual(i.mode, 'calendar_only'); assert.notStrictEqual(i.method, 'teams');
});
check('Juanita (in person, confirm): calendar-only, located at the address Ed gave, confirmation email', () => {
  const i = C.classifyCalendarIntent(P.juanita);
  assert.deepStrictEqual([i.mode, i.method, C.asksForEmail(P.juanita), C.addressFrom(P.juanita)], ['calendar_only', 'in_person', true, '12808 W Airport Blvd, Suite 253']);
});
check('Alexandra (Teams interview, said explicitly): a Teams meeting (online), no separate confirmation email', () => {
  const i = C.classifyCalendarIntent(P.alexandra);
  assert.deepStrictEqual([i.mode, i.method, i.interview, C.asksForEmail(P.alexandra)], ['online', 'teams', true, false]);
});
check('Sipra (calendar only, no invite, no Teams): calendar-only, no email', () => {
  const i = C.classifyCalendarIntent(P.sipra);
  assert.deepStrictEqual([i.mode, C.asksForEmail(P.sipra)], ['calendar_only', false]);
});
check('negations always win over the interview / meeting defaults', () => {
  for (const t of [
    'Set up a call with Dana Friday at 2 PM. No Teams.',
    'Book Dana Friday at 2 PM, it is not a Teams meeting.',
    "Schedule Dana Friday at 2 PM and don't create a Teams meeting.",
    'Meeting with Dana Friday at 2 PM, calendar only.',
    "Interview Dana Friday at 2 PM; don't send a calendar invite.",
    'Confirm Dana Friday at 2 PM, not a video call, by phone.',
  ]) {
    const i = C.classifyCalendarIntent(t);
    assert.notStrictEqual(i.mode, 'online', t); assert.notStrictEqual(i.method, 'teams', t);
  }
  assert.strictEqual(C.classifyCalendarIntent("Interview Dana Friday at 2 PM; don't send a calendar invite.").mode, 'calendar_only');
  assert.strictEqual(C.asksForEmail('Confirm Dana Friday at 2 PM. No email, just my calendar.'), false, '"no email" wins over the implied confirmation email');
});
check('a candidate invite only when Ed asks for one; Teams only when he says so', () => {
  assert.strictEqual(C.classifyCalendarIntent("Confirm Nicole tomorrow at 3:30, phone interview, and send her an invite.").mode, 'invite');
  assert.strictEqual(C.classifyCalendarIntent('Schedule a video interview with Alexandra Friday at 1 PM.').mode, 'online');
  assert.strictEqual(C.classifyCalendarIntent('Confirm Alexandra Friday at 1 PM on Zoom.').mode, 'invite', 'Zoom: a plain event, the other side owns the link');
});
check('an address is never a time ("at 3 PM", "at 10:30", "at 10 AM")', () => {
  assert.strictEqual(C.addressFrom('Confirm Juanita Friday at 3 PM in person.'), null);
  assert.strictEqual(C.addressFrom('Lunch at 10:30 in person'), null);
  assert.strictEqual(C.addressFrom('Meet at 10 AM in person at 5110 Waterview Estates Trail.'), '5110 Waterview Estates Trail');
});

// ------------------------------------------------------------- staged rows
check('staged row (Nicole): "Phone Interview - Nicole Hill" on Ed’s calendar, 30 min, Phone call, NO attendees, NO Teams', () => {
  const row = C.buildStagedMeetingRow({ mode: 'calendar_only', method: 'phone', meeting: { interview: true, confirm: true }, people: [{ name: 'Nicole Hill', email: 'nicole@example.com' }],
    phones: ['281-555-0142'], wt: WT('15:30', 30), edMailbox: ED, tessaMailbox: TESSA });
  assert.deepStrictEqual([row.meeting_mode, row.subject, row.organizer, row.meeting_location, row.meeting_attendees, row.meeting_start, row.meeting_end],
    ['calendar_only', 'Phone Interview - Nicole Hill', ED, 'Phone call', '', '2026-10-08T15:30:00', '2026-10-08T16:00:00']);
  assert.ok(/Email: nicole@example\.com/.test(row.body_text) && /281-555-0142/.test(row.body_text) && /No invitation was sent/.test(row.body_text));
  assert.ok(!/teams/i.test(JSON.stringify(row)), 'no Teams anywhere on the entry');
});
check('staged row (Juanita): "In-Person Meeting - Juanita ..." at the street address, NO attendees', () => {
  const row = C.buildStagedMeetingRow({ mode: 'calendar_only', method: 'in_person', meeting: { confirm: true, address: '12808 W Airport Blvd, Suite 253' }, people: [{ name: 'Juanita Lopez', email: 'jl@example.com' }],
    wt: WT('15:00', 30), edMailbox: ED, tessaMailbox: TESSA });
  assert.deepStrictEqual([row.meeting_mode, row.subject, row.meeting_location, row.meeting_attendees, row.organizer], ['calendar_only', 'In-Person Meeting - Juanita Lopez', '12808 W Airport Blvd, Suite 253', '', ED]);
});
check('staged row (Alexandra, Teams interview): Tessa organizes a Teams meeting with Alexandra and Ed', () => {
  const row = C.buildStagedMeetingRow({ mode: 'online', method: 'teams', meeting: { interview: true }, people: [{ name: 'Alexandra Reyes', email: 'ar@example.com' }],
    wt: WT('13:00', 30), edMailbox: ED, tessaMailbox: TESSA, inviteBody: 'Hi Alexandra' });
  assert.deepStrictEqual([row.meeting_mode, row.subject, row.organizer, row.meeting_location, row.meeting_attendees], ['online', 'Teams Interview - Alexandra Reyes', TESSA, 'Microsoft Teams', `ar@example.com, ${ED}`]);
});
check('staged row (Sipra, calendar only): on Ed’s calendar, no attendees, no Teams', () => {
  const row = C.buildStagedMeetingRow({ mode: 'calendar_only', method: 'phone', meeting: {}, people: [], names: ['Sipra'], wt: WT('16:00', 15), edMailbox: ED, tessaMailbox: TESSA });
  assert.deepStrictEqual([row.meeting_mode, row.meeting_attendees, row.organizer, row.meeting_location], ['calendar_only', '', ED, 'Phone call']);
});

// ----------------------------------------------- the whole request (model faked)
// The fake model output is deliberately WRONG where the scar was (it says Teams) to
// prove the rules decide, not the model.
const people = { nicole: { name: 'Nicole Hill', email: 'nicole@example.com' }, juanita: { name: 'Juanita Lopez', email: 'jl@example.com' }, alexandra: { name: 'Alexandra Reyes', email: 'ar@example.com' }, sipra: { name: 'Sipra Boyd', email: 'sboyd@example.com' } };
const parsed = (hint, extra = {}) => ({ action: 'email_and_meeting', to_hints: [hint], cc_hints: [], mention_hints: [], provided_emails: {}, create_contacts: [], search_terms: [], unclear: [],
  instruction: `Handle the request about ${hint}`, meeting: { direct_invite: true, date: 'tomorrow', start_time: '3:30 PM', end_time: null, title: 'Teams meeting', topic: null, message: null, wants_intro: false, location: 'Microsoft Teams', ...extra } });
async function run(text, hint, extra) {
  const thoughts = [];
  const out = await runRequest(text, {
    parser: async () => parsed(hint, extra),
    resolveRecipient: async (h) => ({ best: { ...people[String(h).toLowerCase()], source: 'test' } }),
    searchMailbox: async () => ({ messages: [] }), mailboxes: [],
    drafter: async ({ thought }) => { thoughts.push(thought); return { subject: 'Confirming', body: 'Hi' }; },
  });
  return { out, thought: thoughts[0] || null };
}
check('Nicole end to end: calendar-only meeting (30 min, phone) + ONE confirmation email draft, Tessa arranging for Ed, no invite/Teams promised', async () => {
  const { out, thought } = await run(P.nicole, 'nicole');
  assert.deepStrictEqual([out.meeting.mode, out.meeting.method, out.meeting.duration_minutes, out.meeting.interview, !!out.draft], ['calendar_only', 'phone', 30, true, true]);
  assert.ok(/arranging this on Ed Gojara's behalf/.test(thought) && /Ed is the one interviewing them, not Tessa/.test(thought) && /phone interview/.test(thought), thought);
  assert.ok(/Do not mention a calendar invitation, a Teams or video link/.test(thought));
});
check('Juanita end to end: calendar-only at the address + confirmation email naming the address', async () => {
  const { out, thought } = await run(P.juanita, 'juanita', { date: 'friday', start_time: '3:00 PM' });
  assert.deepStrictEqual([out.meeting.mode, out.meeting.method, out.meeting.address, !!out.draft], ['calendar_only', 'in_person', '12808 W Airport Blvd, Suite 253', true]);
  assert.ok(/the address is 12808 W Airport Blvd, Suite 253/.test(thought));
});
check('Alexandra end to end: a Teams meeting (online, direct invite), no separate email draft', async () => {
  const { out } = await run(P.alexandra, 'alexandra', { date: 'friday', start_time: '1:00 PM' });
  assert.deepStrictEqual([out.meeting.mode, out.meeting.method, out.meeting.direct_invite, out.draft], ['online', 'teams', true, null]);
});
check('Sipra end to end: calendar-only, NO email; a model title saying "Teams meeting" never reaches the entry', async () => {
  const { out } = await run(P.sipra, 'sipra', { start_time: '4:00 PM' });
  assert.deepStrictEqual([out.meeting.mode, out.draft], ['calendar_only', null]);
  const row = C.buildStagedMeetingRow({ mode: out.meeting.mode, method: out.meeting.method, meeting: out.meeting, people: out.to, phones: [], wt: WT('16:00', 15), edMailbox: ED, tessaMailbox: TESSA });
  assert.ok(!/teams/i.test(`${row.subject} ${row.body_text} ${row.meeting_location}`), row.subject);
});

// --------------------- CONTEXT: an existing interview thread keeps it an interview (Ed 2026-10-07)
const juanitaR = { name: 'Juanita Ramsey', email: 'jramsey@example.com' };
async function runWithThreads(text, threads) {
  const thoughts = [];
  const out = await runRequest(text, {
    parser: async () => ({ ...parsed('juanita', { date: 'friday', start_time: '3:00 PM' }), search_terms: ['Juanita'] }),
    resolveRecipient: async () => ({ best: { ...juanitaR, source: 'contacts' } }),
    searchMailbox: async () => ({ messages: threads.map((t, i) => ({ id: 'm' + i, conversation_id: 'c' + i, subject: t.subject, from: { name: t.from_name || null, email: t.from_email || null }, received_at: '2026-10-01T15:00:00Z', preview: t.preview || '' })) }),
    mailboxes: [ED],
    drafter: async ({ thought }) => { thoughts.push(thought); return { subject: 'Confirming', body: 'Hi' }; },
  });
  return { out, thought: thoughts[0] || null };
}
const row = (out) => C.buildStagedMeetingRow({ mode: out.meeting.mode, method: out.meeting.method, meeting: out.meeting, people: out.to, phones: [], wt: WT('15:00', out.meeting.duration_minutes || 30), edMailbox: ED, tessaMailbox: TESSA });
check('CONTEXT: Juanita is an interview candidate (her scheduling thread) -> "In-Person Interview - Juanita Ramsey", Ed’s calendar at the address, 30 min, confirmation email names the interview', async () => {
  const { out, thought } = await runWithThreads(P.juanita, [{ subject: 'Re: Interview - Community Operations Assistant', from_email: juanitaR.email, from_name: 'Juanita Ramsey', preview: 'Friday at 3 works for me.' }]);
  const r = row(out);
  assert.deepStrictEqual([out.meeting.mode, out.meeting.interview, r.subject, r.meeting_location, r.meeting_attendees, r.organizer, out.meeting.duration_minutes, !!out.draft],
    ['calendar_only', true, 'In-Person Interview - Juanita Ramsey', '12808 W Airport Blvd, Suite 253', '', ED, 30, true]);
  assert.ok(/Ed is the one interviewing them, not Tessa/.test(thought) && /in-person interview/.test(thought), thought);
});
check('CONTEXT: the same confirmation with NO hiring thread stays a meeting ("In-Person Meeting - Juanita Ramsey")', async () => {
  const { out } = await runWithThreads(P.juanita, [{ subject: 'Pool party volunteers', from_email: juanitaR.email, preview: 'Happy to help Friday.' }]);
  assert.deepStrictEqual([out.meeting.interview, row(out).subject], [false, 'In-Person Meeting - Juanita Ramsey']);
});
check('CONTEXT: an interview thread about SOMEONE ELSE never makes Juanita’s meeting an interview', async () => {
  const { out } = await runWithThreads(P.juanita, [{ subject: 'Interview - Maintenance Tech', from_email: 'other@example.com', preview: 'Marcus confirmed Thursday.' }]);
  assert.deepStrictEqual([out.meeting.interview, row(out).subject], [false, 'In-Person Meeting - Juanita Ramsey']);
});
check('CONTEXT never changes the routing: an interview from context is still calendar-only, no attendees, no Teams', async () => {
  const { out } = await runWithThreads(P.juanita, [{ subject: 'Your application - Community Operations Assistant', from_email: juanitaR.email }]);
  const r = row(out);
  assert.deepStrictEqual([out.meeting.mode, r.meeting_attendees, /teams/i.test(`${r.subject} ${r.body_text} ${r.meeting_location}`)], ['calendar_only', '', false]);
});

(async () => {
  let pass = 0, fail = 0;
  console.log('Tessa: confirmations and interviews route by rule (Ed 2026-10-07)');
  for (const [n, fn] of tests) { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n      ')); } }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
