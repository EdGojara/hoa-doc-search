// ============================================================================
// lib/ea/tessa_availability.js  (Ed 2026-10-07) — read Ed's time, hold the slot
// ----------------------------------------------------------------------------
// The I/O half of lib/ea/tessa_slots.js:
//   loadBusy     Ed's calendar over the range (Graph calendarView with OFFSET
//                times, every page; free / cancelled events are not busy) PLUS
//                every meeting Tessa has staged and Ed has not released yet:
//                a staged meeting is a HOLD on its slot, so a second request can
//                never be offered the same time. A failed read is never "free":
//                it throws and nothing is staged (fail closed).
//   chooseSlot   parse what Ed asked for, read busy time, pick the slot.
//   settleHold   after a meeting row is written: if another hold for an
//                overlapping slot was written first (two requests raced), this
//                one loses: it is cancelled (not deleted) with the reason, so the
//                slot is reserved exactly once.
// Release still re-checks Ed's calendar (lib/ea/calendar_conflicts.js), so even a
// slot that filled after staging is never double-booked.
// ============================================================================
const S = require('./tessa_slots');
const { withOffset } = require('./tessa_interview');
const { centralTodayUTC } = require('./tessa_calendar_intent');

const TZ = 'Central Standard Time';

/** Now as a Central wall time 'YYYY-MM-DDTHH:MM:SS'. */
function centralNowWall(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(now).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

async function loadBusy({ edMailbox, from, to, supabase }, { token, fetchImpl = fetch }) {
  const busy = [];
  let url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(edMailbox)}/calendarView?startDateTime=${encodeURIComponent(withOffset(from, TZ))}&endDateTime=${encodeURIComponent(withOffset(to, TZ))}`
    + '&$select=subject,start,end,showAs,isCancelled&$orderby=start/dateTime&$top=200';
  for (let page = 0; url && page < 20; page++) {
    const r = await fetchImpl(url, { headers: { Authorization: 'Bearer ' + token, Prefer: `outlook.timezone="${TZ}"` } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(`could not read Ed's calendar (${(j.error && j.error.code) || r.status}); nothing was scheduled`); e.code = 'calendar_read_failed'; throw e; }
    for (const ev of j.value || []) {
      if (ev.isCancelled || ev.showAs === 'free') continue;
      busy.push({ start: String((ev.start && ev.start.dateTime) || '').slice(0, 19), end: String((ev.end && ev.end.dateTime) || '').slice(0, 19), subject: ev.subject || '(busy)', source: 'calendar' });
    }
    url = j['@odata.nextLink'] || null;
  }
  if (supabase) {
    const { data, error } = await supabase.from('tessa_outbox').select('id, subject, meeting_start, meeting_end, created_at')
      .eq('kind', 'meeting').eq('status', 'queued').lt('meeting_start', to).gt('meeting_end', from).order('created_at').limit(500);
    if (error) { const e = new Error('could not read Tessa’s held slots: ' + error.message); e.code = 'holds_read_failed'; throw e; }
    for (const h of data || []) busy.push({ start: String(h.meeting_start).slice(0, 19), end: String(h.meeting_end).slice(0, 19), subject: `held by Tessa: ${h.subject || 'meeting'}`, source: 'hold', id: h.id });
  }
  return busy;
}

/**
 * @param text, meeting (after the rule layer), proposalText (what the person offered), durationMinutes
 * @returns { spec, result } — result from tessa_slots.pickSlot; spec null when Ed gave no time at all
 */
async function chooseSlot({ text, meeting = {}, proposalText = '', durationMinutes = 30 }, { token, fetchImpl = fetch, supabase = null, edMailbox, now = new Date() }) {
  const baseIso = new Date(centralTodayUTC(now)).toISOString().slice(0, 10);
  const spec = S.parseSpec(text, meeting, baseIso, proposalText);
  if (!spec) return { spec: null, result: null };
  const starts = spec.kind === 'exact' ? [spec.start] : spec.kind === 'options' ? spec.options.map((o) => o.start) : spec.days.map((d) => `${d}T00:00:00`);
  const first = starts.slice().sort()[0].slice(0, 10); const last = starts.slice().sort().slice(-1)[0].slice(0, 10);
  const to = new Date(Date.parse(last + 'T00:00:00Z') + 12 * 86400000).toISOString().slice(0, 10);   // alternatives look up to 10 business-ish days ahead
  const busy = await loadBusy({ edMailbox, from: `${first}T00:00:00`, to: `${to}T00:00:00`, supabase }, { token, fetchImpl });
  const result = S.pickSlot({ spec, busy, durationMinutes, nowWall: centralNowWall(now) });
  return { spec, result };
}

/**
 * Two requests raced for one slot: the hold written FIRST keeps it. Call after
 * inserting a queued meeting row. Returns { kept: true } or { kept: false, by } and
 * cancels the losing row (with the reason; never deleted).
 */
async function settleHold(supabase, row) {
  const { data, error } = await supabase.from('tessa_outbox').select('id, subject, meeting_start, meeting_end, created_at')
    .eq('kind', 'meeting').eq('status', 'queued').lt('meeting_start', row.meeting_end).gt('meeting_end', row.meeting_start).order('created_at').order('id').limit(50);
  if (error) throw new Error('could not re-check the slot: ' + error.message);
  const others = (data || []).filter((h) => h.id !== row.id);
  const mine = (data || []).find((h) => h.id === row.id) || row;
  const earlier = others.find((h) => String(h.created_at) < String(mine.created_at) || (String(h.created_at) === String(mine.created_at) && String(h.id) < String(row.id)));
  if (!earlier) return { kept: true };
  const why = `Slot taken by an earlier request ("${earlier.subject || 'meeting'}"); not double-booked.`;
  const { error: ue } = await supabase.from('tessa_outbox').update({ status: 'cancelled', send_error: why }).eq('id', row.id).eq('status', 'queued');
  if (ue) throw new Error('could not release the losing hold: ' + ue.message);
  return { kept: false, by: earlier, reason: why };
}

module.exports = { loadBusy, chooseSlot, settleHold, centralNowWall };
