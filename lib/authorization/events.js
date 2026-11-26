// ============================================================================
// lib/authorization/events.js  (Ed 2026-11-25: Owner Authorization Service)
// ----------------------------------------------------------------------------
// The one ledger of authorization events (authorization_events, migration 577):
// requested, sent, authorized, declined, change_requested,
// clarification_requested, expired, revoked, executed, execution_failed,
// reported. Every path writes here: in-app approval, email reply, grants and
// standing authority, and future channels. The requesting teammate, the
// coordinator, the authorizing person and the executing teammate are separate
// fields; the evidence (email message id and excerpt, session, instruction) and
// the result travel with the event.
//
// Amanda (the coordinator) follows through from pendingFollowUps(): every
// executed / failed event she has not yet reported on.
//
// The ledger is ADDITIVE to each module's own audit (accounting_run_events, the
// conversion audit), which stays authoritative for that module. So a ledger
// write never undoes or blocks an action that already executed: a failure is
// logged loudly with its context, never swallowed silently. Before migration
// 577 is applied the table does not exist; writes are skipped with one warning.
// ============================================================================

const P = require('./policy');

const EVENTS = new Set(['requested', 'sent', 'authorized', 'declined', 'change_requested', 'clarification_requested', 'expired', 'revoked', 'executed', 'execution_failed', 'reported']);
const KINDS = new Set(['request', 'grant', 'standing', 'in_app']);
const MISSING = /authorization_events|does not exist|schema cache|relation .* does not exist/i;
let missingWarned = false;

/** PURE: the row for one event, validated. Throws on a malformed event (a programming error). */
function buildEvent(e) {
  if (!EVENTS.has(e.event)) throw new Error(`unknown authorization event ${e.event}`);
  if (!KINDS.has(e.authority_kind)) throw new Error(`unknown authority kind ${e.authority_kind}`);
  if (!String(e.action_type || '').trim()) throw new Error('an authorization event needs its action type');
  if (['executed', 'execution_failed'].includes(e.event) && !String(e.executed_by || '').trim()) throw new Error('an execution event names the executing teammate');
  if (e.event === 'authorized' && !String(e.authorized_by_email || '').trim()) throw new Error('an authorized event names the authorizing person');
  if (e.event === 'reported' && !e.related_event_id) throw new Error('a report names the event it answers');
  if (e.channel && !Object.keys(P.CHANNELS).concat(['system']).includes(e.channel)) throw new Error(`unknown channel ${e.channel}`);
  const s = (v) => (v === undefined || v === null || v === '' ? null : String(v));
  return {
    community_id: e.community_id || null, authority_kind: e.authority_kind, authorization_id: e.authorization_id || null, grant_id: e.grant_id || null,
    action_type: e.action_type, target_id: s(e.target_id), fingerprint: s(e.fingerprint), event: e.event, channel: e.channel || null,
    requested_by: s(e.requested_by), coordinator: s(e.coordinator) || P.COORDINATOR, authorized_by_user_id: s(e.authorized_by_user_id),
    authorized_by_email: s(e.authorized_by_email), executed_by: s(e.executed_by), related_event_id: e.related_event_id || null,
    evidence: e.evidence || null, result: e.result || null, note: s(e.note),
  };
}

/** Record events (one or many). Returns the inserted rows, [] when the ledger is not yet installed. */
async function recordEvents(supabase, events) {
  const rows = (Array.isArray(events) ? events : [events]).filter(Boolean).map(buildEvent);
  if (!rows.length) return [];
  const { data, error } = await supabase.from('authorization_events').insert(rows).select('id, event, action_type, target_id');
  if (error) {
    if (MISSING.test(error.message || '')) {
      if (!missingWarned) { missingWarned = true; console.warn('[authorization] authorization_events is not installed yet (migration 577); events are not recorded'); }
      return [];
    }
    console.error('[authorization] event not recorded', JSON.stringify({ error: error.message, events: rows.map((r) => ({ event: r.event, action_type: r.action_type, target_id: r.target_id, authorization_id: r.authorization_id, grant_id: r.grant_id })) }));
    return [];
  }
  return data || [];
}

/** Executed / failed events the coordinator has not yet reported on, oldest first. */
async function pendingFollowUps(supabase, { coordinator = P.COORDINATOR, limit = 100 } = {}) {
  const { data: done, error } = await supabase.from('authorization_events').select('*').eq('coordinator', coordinator).in('event', ['executed', 'execution_failed']).order('occurred_at', { ascending: true }).limit(limit);
  if (error) { if (MISSING.test(error.message || '')) return []; throw new Error(`authorization follow-ups: ${error.message}`); }
  if (!done || !done.length) return [];
  const { data: reps, error: rErr } = await supabase.from('authorization_events').select('related_event_id').eq('event', 'reported').in('related_event_id', done.map((d) => d.id));
  if (rErr) throw new Error(`authorization reports: ${rErr.message}`);
  const seen = new Set((reps || []).map((r) => r.related_event_id));
  return done.filter((d) => !seen.has(d.id));
}

/** The coordinator confirms she followed through on an executed / failed event. */
async function recordReport(supabase, { event, by = P.COORDINATOR, channel = 'system', note = null }) {
  return recordEvents(supabase, { ...pick(event), event: 'reported', related_event_id: event.id, coordinator: by, note, channel, evidence: null, result: null });
}
const pick = (e) => ({ community_id: e.community_id, authority_kind: e.authority_kind, authorization_id: e.authorization_id, grant_id: e.grant_id, action_type: e.action_type,
  target_id: e.target_id, fingerprint: e.fingerprint, requested_by: e.requested_by, authorized_by_user_id: e.authorized_by_user_id, authorized_by_email: e.authorized_by_email, executed_by: e.executed_by });

module.exports = { EVENTS, KINDS, buildEvent, recordEvents, pendingFollowUps, recordReport };
