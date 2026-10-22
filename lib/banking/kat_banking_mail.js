// ============================================================================
// lib/banking/kat_banking_mail.js — Kat's banking mail is ingested automatically
// (Ed 2026-10-22)
// ----------------------------------------------------------------------------
// Scar: all email ingest is manual (EMAIL_INGEST_AUTO off since 2026-07-07), so
// kat@ mail reached trustEd a median 30 hours late (max 130) and NewFirst's 6:55 am
// Positive Pay exception notices, due 10:00 am, were often first seen after the
// deadline. Melody Hess's 10/19 email sat in kat@ for three days.
//
// This job ingests kat@ ONLY (every other mailbox stays manual) through the same
// ingestMailbox the Pull inbox button uses, then runs the Positive Pay watch at once
// so a new exception notice is reviewed, put on Kat's exception task and, when it
// needs a human, escalated in the same run. One job does both so the watch never
// races a second copy of itself (no duplicate texts).
//
// Cadence: the scheduler ticks every 15 minutes. On business days 6:00-10:00 am
// Central (NewFirst sends notices about 6:55 and reminders about 8:55; decisions are
// due 10:00) it polls every tick; at other times about once an hour. Worst case for a
// notice in the morning window: one tick (15 min) plus the ingest itself.
// OFF unless SCHEDULER_ENABLED names kat_banking_mail.
// ============================================================================
const KAT_MAILBOX = (process.env.KAT_MAILBOX || 'kat@bedrocktx.com').toLowerCase();
const WINDOW_START_HOUR = 6;   // Central
const WINDOW_END_HOUR = 10;    // Central, exclusive
const LOOKBACK_MS = 3 * 3600e3; // overlaps any missed tick; ingest is idempotent by message id

function central(now) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(now);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  return { weekday: get('weekday'), hour: Number(get('hour')) % 24, minute: Number(get('minute')) };
}

/** Pure: poll on this tick? Every tick in the business-day morning window, else hourly. */
function pollDue(now = new Date()) {
  const c = central(now);
  const businessDay = !['Sat', 'Sun'].includes(c.weekday);
  if (businessDay && c.hour >= WINDOW_START_HOUR && c.hour < WINDOW_END_HOUR) return { due: true, mode: 'morning_window' };
  return c.minute < 15 ? { due: true, mode: 'hourly' } : { due: false, mode: 'hourly' };
}

async function tick({ supabase, now = new Date(), logger = console, ingest = null, watch = null } = {}) {
  const gate = pollDue(now);
  if (!gate.due) return { fired: false, reason: 'not_due', mode: gate.mode };
  let run = ingest;
  if (!run) {
    const graphIngest = require('../email/graph_ingest');
    if (!graphIngest.isConfigured()) return { fired: false, reason: 'graph_not_configured' };
    run = (mbx, o) => graphIngest.ingestMailbox(mbx, o);
  }
  let ingested = null; let ingestError = null;
  try {
    ingested = await run(KAT_MAILBOX, { sinceISO: new Date(now.getTime() - LOOKBACK_MS).toISOString(), light: false, onlyLinked: false, fileBacklog: false, skipIfBusy: true });
  } catch (e) { ingestError = e.message; logger.warn(`[kat_banking_mail] ingest of ${KAT_MAILBOX} failed: ${e.message}`); }
  // The watch runs even when the ingest failed: notices already in trustEd still get their
  // deadline escalation.
  let watched = null; let watchError = null;
  try { watched = await (watch || require('./positive_pay_watch').tick)({ supabase, now, logger }); }
  catch (e) { watchError = e.message; logger.warn(`[kat_banking_mail] positive pay watch failed: ${e.message}`); }
  return { fired: true, mode: gate.mode, mailbox: KAT_MAILBOX, kept: ingested ? ingested.kept || 0 : 0, scanned: ingested ? ingested.scanned || 0 : 0, busy: !!(ingested && ingested.busy), watch: watched, errors: [ingestError, watchError].filter(Boolean) };
}

module.exports = { tick, pollDue, KAT_MAILBOX, WINDOW_START_HOUR, WINDOW_END_HOUR };
