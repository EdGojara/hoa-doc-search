// ============================================================================
// lib/ea/tessa_interview.js  (Ed 2026-10-06) — Tessa books interviews on her calendar
// ----------------------------------------------------------------------------
// Tessa is the Outlook ORGANIZER: the event is created in Tessa's own calendar and
// Exchange sends the invitation from her to the attendees (Ed and the candidate).
// The invitation itself is the confirmation email. It is a plain event (phone or
// in person), not a Teams meeting; lib/ea/tessa_meeting.js stays the Teams path.
//
// AUTHORITY (decideAuthority, pure). Ed's working hours are a DEFAULT for Tessa
// choosing or offering slots, not a prohibition (Ed 2026-10-06):
//   EXECUTE  Ed gave this exact time ("Schedule Neha Thursday at 5 PM") and the
//            calendars are free, whatever the hour; or Tessa chose an open slot
//            inside Ed's working hours
//   REVIEW   a conflict with an existing event; or a slot TESSA chose that falls
//            outside Ed's working hours / days
//   BLOCK    the slot would overwrite or move an existing commitment; this module
//            never moves or cancels anything
//
// IDEMPOTENT: the event carries a deterministic Graph transactionId
// (organizer + candidate + start), and before creating, Tessa's calendar is read
// for an event with that transactionId or the same candidate at the same time.
// The same reply can never create a second event. The created event's id is
// recorded on a tessa_outbox row (kind 'meeting'), linked to the inbox thread.
//
// TIME ZONES: wall time + Windows zone name, never a bare date or an offset
// (CLAUDE.md "date strings across system boundaries").
// ============================================================================
const crypto = require('crypto');

const DEFAULT_TZ = process.env.BEDROCK_TIMEZONE || 'Central Standard Time';
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const WALL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

function wall(v) {
  const s = String(v || '').trim();
  if (!WALL_RE.test(s)) throw new Error('interview start must be a local wall time like 2026-10-08T17:00, not "' + s + '"');
  return s.length === 16 ? s + ':00' : s;
}
/** Add minutes to a wall time without touching zones (pure string math). */
function addMinutes(wallTime, minutes) {
  const [d, t] = wall(wallTime).split('T');
  const [Y, M, D] = d.split('-').map(Number); const [h, m, s] = t.split(':').map(Number);
  const x = new Date(Date.UTC(Y, M - 1, D, h, m + Number(minutes), s || 0));
  return x.toISOString().slice(0, 19);
}
// Windows zone (what Graph event bodies take) -> IANA zone (what Intl knows).
const IANA = { 'Central Standard Time': 'America/Chicago', 'Eastern Standard Time': 'America/New_York', 'Mountain Standard Time': 'America/Denver', 'Pacific Standard Time': 'America/Los_Angeles', UTC: 'UTC' };
/**
 * A wall time in a zone as an ISO string WITH its offset ("2026-10-08T17:00:00-05:00").
 * Graph's calendarView reads an offset-less startDateTime as UTC (the Prefer
 * timezone header only shapes the response), so a bare wall time searches the
 * wrong hours. Scar 2026-10-06: the dedupe for Neha's 5:00 PM interview searched
 * 12:00 to 12:30 PM Central, found nothing, and only the conflict check stopped a
 * second event.
 */
function withOffset(wallTime, timeZone = DEFAULT_TZ) {
  const w = wall(wallTime); const iana = IANA[timeZone] || timeZone;
  const [d, t] = w.split('T'); const [Y, M, D] = d.split('-').map(Number); const [h, m, sec] = t.split(':').map(Number);
  const asUtc = Date.UTC(Y, M - 1, D, h, m, sec || 0);
  const offsetAt = (ms) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: iana, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms) / 60000;
  };
  let off = offsetAt(asUtc); off = offsetAt(asUtc - off * 60000);
  const a = Math.abs(off);
  const hms = w.length === 16 ? w + ':00' : w;
  return hms + (off < 0 ? '-' : '+') + String(Math.floor(a / 60)).padStart(2, '0') + ':' + String(a % 60).padStart(2, '0');
}
const hhmm = (w) => wall(w).slice(11, 16);
function fmt12(w) { const [h, m] = hhmm(w).split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; }
function fmtDay(w) { const [Y, M, D] = wall(w).slice(0, 10).split('-').map(Number); return new Date(Date.UTC(Y, M - 1, D)).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }); }

/** Deterministic idempotency key for one interview. Pure. */
function transactionIdFor({ organizer, candidateEmail, start }) {
  const raw = [String(organizer || '').toLowerCase(), String(candidateEmail || '').toLowerCase(), wall(start)].join('|');
  return 'tessa-interview-' + crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

/**
 * The Graph event for an interview, organized by Tessa. Pure.
 * candidate: { name, email, phone }, method: 'phone' | 'in_person' | 'teams'
 */
function buildInterviewEvent({ organizer, candidate = {}, role, start, durationMinutes = 30, timeZone = DEFAULT_TZ, method = 'phone', caller = 'Ed',
  interviewerEmail, inviteCandidate = true, applicationRef = null, location = null }) {
  if (!organizer || !EMAIL_RE.test(organizer)) throw new Error('organizer mailbox is required');
  if (!candidate.name) throw new Error('candidate name is required');
  if (!candidate.email || !EMAIL_RE.test(candidate.email)) throw new Error('candidate email is required');
  if (!interviewerEmail || !EMAIL_RE.test(interviewerEmail)) throw new Error('interviewer email is required');
  const startW = wall(start); const endW = addMinutes(startW, durationMinutes);
  const phone = candidate.phone ? String(candidate.phone).trim() : null;
  const how = method === 'phone' ? `Phone interview: ${caller} calls ${candidate.name}${phone ? ' at ' + phone : ''}` : method === 'teams' ? 'Microsoft Teams' : (location || 'In person');
  const subject = `${candidate.name}${phone ? ' (' + phone + ')' : ''} - ${role ? role + ' ' : ''}${method === 'phone' ? 'phone interview' : 'interview'}`;
  const lines = [
    `Interview: ${candidate.name}`,
    role ? `Role: ${role}` : null,
    `When: ${fmtDay(startW)}, ${fmt12(startW)} to ${fmt12(endW)} Central (${durationMinutes} minutes)`,
    `How: ${how}`,
    phone ? `Candidate phone: ${phone}` : 'Candidate phone: not on file',
    `Candidate email: ${candidate.email}`,
    applicationRef ? `Application: ${applicationRef}` : 'Application / resume: not on file',
    '',
    `Scheduled by Tessa McCall on behalf of Ed Gojara, Bedrock Association Management. Reply to this invitation if the time no longer works.`,
  ].filter((x) => x != null);
  const attendees = [{ emailAddress: { address: interviewerEmail, name: 'Ed Gojara' }, type: 'required' }];
  if (inviteCandidate) attendees.push({ emailAddress: { address: candidate.email, name: candidate.name }, type: 'required' });
  return {
    subject,
    body: { contentType: 'Text', content: lines.join('\n') },
    start: { dateTime: startW, timeZone },
    end: { dateTime: endW, timeZone },
    location: { displayName: method === 'phone' ? `Phone: ${caller} calls ${phone || candidate.name}` : how },
    attendees,
    isOnlineMeeting: method === 'teams',
    ...(method === 'teams' ? { onlineMeetingProvider: 'teamsForBusiness' } : {}),
    showAs: 'busy',
    responseRequested: true,
    allowNewTimeProposals: true,
    transactionId: transactionIdFor({ organizer, candidateEmail: candidate.email, start: startW }),
  };
}

/**
 * EXECUTE / REVIEW / BLOCK for a proposed slot. Pure.
 * explicitTime: Ed named this exact time; working hours then do not apply.
 */
function decideAuthority({ start, end, freeBusy = {}, workingHours = null, overwrites = false, explicitTime = false }) {
  if (overwrites) return { class: 'BLOCK', reasons: ['the slot would overwrite or move an existing commitment'] };
  const busy = Object.entries(freeBusy).filter(([, v]) => v && v !== 'free');
  if (busy.length) return { class: 'REVIEW', reasons: [`conflict: ${busy.map(([who, v]) => `${who} is ${v}`).join(', ')}`] };
  if (explicitTime) {
    const note = outsideHours(start, end, workingHours);
    // Ed's own instruction naming the time IS the approval; no second ask for hours.
    return { class: 'EXECUTE', approved: true, approved_by: 'Ed', reasons: ['Ed gave this exact time and the calendars are free' + (note ? ` (${note}; Ed's instruction overrides the default window)` : '')] };
  }
  const note = outsideHours(start, end, workingHours);
  if (note) return { class: 'REVIEW', reasons: [`a slot Tessa chose is outside the default window: ${note}`] };
  return { class: 'EXECUTE', reasons: ['open slot inside Ed\u2019s working hours'] };
}
function outsideHours(start, end, workingHours) {
  if (!workingHours) return null;
  const day = new Date(wall(start).slice(0, 10) + 'T00:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long' }).toLowerCase();
  if (!(workingHours.days || []).includes(day)) return `${day} is outside Ed's working days`;
  if (hhmm(start) < workingHours.start || hhmm(end) > workingHours.end) return `${fmt12(start)} to ${fmt12(end)} is outside Ed's working hours (${workingHours.start} to ${workingHours.end})`;
  return null;
}

/** Free/busy for a set of mailboxes over one slot (Graph getSchedule; a read). */
async function readFreeBusy({ organizer, mailboxes, start, end, timeZone = DEFAULT_TZ }, { token, fetchImpl = fetch }) {
  const r = await fetchImpl(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(organizer)}/calendar/getSchedule`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ schedules: mailboxes, startTime: { dateTime: wall(start), timeZone }, endTime: { dateTime: wall(end), timeZone }, availabilityViewInterval: 15 }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('free/busy read failed: ' + ((j.error && j.error.code) || r.status));
  const STATES = { 0: 'free', 1: 'tentative', 2: 'busy', 3: 'out of office', 4: 'working elsewhere' };
  const out = {}; let workingHours = null;
  for (const s of j.value || []) {
    if (s.error) { out[s.scheduleId] = 'unknown'; continue; }
    const worst = String(s.availabilityView || '').split('').map(Number).reduce((a, b) => Math.max(a, b), 0);
    out[s.scheduleId] = STATES[worst] || 'busy';
    if (s.workingHours && !workingHours && /egojara/i.test(s.scheduleId)) {
      workingHours = { days: s.workingHours.daysOfWeek || [], start: String(s.workingHours.startTime || '').slice(0, 5), end: String(s.workingHours.endTime || '').slice(0, 5) };
    }
  }
  return { freeBusy: out, workingHours };
}

/** An existing event for the same interview in the organizer's calendar (dedupe). */
async function findExisting({ organizer, start, end, transactionId, candidateEmail, candidateName, timeZone = DEFAULT_TZ }, { token, fetchImpl = fetch }) {
  const u = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(organizer)}/calendarView?startDateTime=${encodeURIComponent(withOffset(start, timeZone))}&endDateTime=${encodeURIComponent(withOffset(end, timeZone))}`
    + '&$select=id,subject,start,end,transactionId,attendees,isCancelled,webLink&$top=50';
  const r = await fetchImpl(u, { headers: { Authorization: 'Bearer ' + token, Prefer: `outlook.timezone="${timeZone}"` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('calendar read failed: ' + ((j.error && j.error.code) || r.status));
  const nm = String(candidateName || '').toLowerCase();
  return (j.value || []).find((e) => !e.isCancelled && (e.transactionId === transactionId
    || (e.attendees || []).some((a) => String((a.emailAddress || {}).address || '').toLowerCase() === String(candidateEmail).toLowerCase())
    || (nm && String(e.subject || '').toLowerCase().includes(nm)))) || null;
}

/**
 * Schedule one interview. dryRun returns the plan and payload and writes nothing.
 * @returns {{ status: 'dry_run'|'exists'|'created'|'needs_review'|'blocked', event?, payload, authority, freeBusy, existing? }}
 */
async function scheduleInterview(input, deps = {}) {
  const gs = deps.graphSend || require('../email/graph_send');
  const fetchImpl = deps.fetch || fetch;
  const organizer = input.organizer || gs.TESSA_MAILBOX;
  const interviewerEmail = input.interviewerEmail || gs.ED_MAILBOX;
  const payload = buildInterviewEvent({ ...input, organizer, interviewerEmail });
  const token = deps.token || await gs.getToken();
  const existing = await findExisting({ organizer, start: payload.start.dateTime, end: payload.end.dateTime, transactionId: payload.transactionId, candidateEmail: input.candidate.email, candidateName: input.candidate.name }, { token, fetchImpl });
  if (existing) return { status: 'exists', event: { id: existing.id, subject: existing.subject, webLink: existing.webLink }, payload, existing: true };
  const { freeBusy, workingHours } = await readFreeBusy({ organizer, mailboxes: [organizer, interviewerEmail], start: payload.start.dateTime, end: payload.end.dateTime }, { token, fetchImpl });
  const authority = decideAuthority({ start: payload.start.dateTime, end: payload.end.dateTime, freeBusy, workingHours, explicitTime: !!input.explicitTime });
  if (authority.class === 'BLOCK') return { status: 'blocked', payload, authority, freeBusy };
  if (authority.class === 'REVIEW') return { status: 'needs_review', payload, authority, freeBusy, workingHours };
  if (input.dryRun) return { status: 'dry_run', payload, authority, freeBusy, workingHours };
  const r = await fetchImpl(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(organizer)}/events`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Prefer: `outlook.timezone="${DEFAULT_TZ}"` }, body: JSON.stringify(payload),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('event create failed: ' + ((j.error && (j.error.code + ': ' + j.error.message)) || r.status));
  return { status: 'created', event: { id: j.id, iCalUId: j.iCalUId, subject: j.subject, webLink: j.webLink, transactionId: j.transactionId }, payload, authority, freeBusy };
}

/**
 * Record a booked (or found) interview on Tessa's outbox so the event id is linked
 * to the scheduling thread and visible in her history. Idempotent on the event's
 * transactionId (one row per interview).
 */
async function recordOnOutbox(supabase, { result, input, organizer, inboxId = null, createdBy = null }) {
  if (!result || !result.event || !result.event.id) return null;
  const txn = result.payload.transactionId;
  const { data: rows, error: qe } = await supabase.from('tessa_outbox').select('id, result').eq('kind', 'meeting').limit(500);
  if (qe) throw new Error('outbox read failed: ' + qe.message);
  const hit = (rows || []).find((r) => r.result && r.result.transaction_id === txn);
  if (hit) return { id: hit.id, existing: true };
  const p = result.payload;
  const { data, error } = await supabase.from('tessa_outbox').insert({
    kind: 'meeting', status: 'sent', title: p.subject, subject: p.subject,
    note: `Interview booked by Tessa (organizer ${organizer}).${inboxId ? ' Scheduling thread: ea_inbox ' + inboxId + '.' : ''}`,
    organizer, meeting_start: p.start.dateTime, meeting_end: p.end.dateTime, meeting_time_zone: p.start.timeZone,
    meeting_location: p.location && p.location.displayName, meeting_attendees: p.attendees.map((a) => a.emailAddress.address).join(', '),
    result: { event_id: result.event.id, ical_uid: result.event.iCalUId || null, web_link: result.event.webLink || null, transaction_id: txn,
      candidate: input.candidate, role: input.role || null, authority: result.authority ? result.authority.class : null, inbox_id: inboxId },
    created_by: createdBy, released_by: createdBy, sent_at: new Date().toISOString(),
  }).select('id').single();
  if (error) throw new Error('outbox record failed (event ' + result.event.id + ' WAS created): ' + error.message);
  return { id: data.id, existing: false };
}

module.exports = { withOffset, buildInterviewEvent, decideAuthority, transactionIdFor, addMinutes, readFreeBusy, findExisting, scheduleInterview, recordOnOutbox, DEFAULT_TZ };
