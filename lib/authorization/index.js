// ============================================================================
// lib/authorization/index.js  (Ed 2026-11-25: Owner Authorization Service)
// ----------------------------------------------------------------------------
// ONE authorization service for every AI teammate, module and channel. It
// consolidates what already existed instead of adding a competing system:
//   * individual approvals   owner_authorizations (migrations 554-556, 566):
//                            exact items + fingerprints, verified email reply
//   * time-limited grants    owner_execution_grants (567), kind 'time_limited'
//   * standing authority     owner_execution_grants (577), kind 'standing'
//   * in-app approval        the signed-in owner (unchanged)
//   * one event ledger       authorization_events (577)
// and adds the shared pieces every module uses:
//   policy   teammates, sensitivity tiers, which channels may authorize what
//   actions  the registry of authorizable actions and their module adapters
//   events   the ledger, and Amanda's follow-up feed
//
// Amanda coordinates by default (requests can name another coordinator); any
// teammate may request. The requesting teammate, coordinator, authorizing person
// and executing teammate are always recorded separately.
// ============================================================================

const policy = require('./policy');
const actions = require('./actions');
const events = require('./events');

/**
 * PURE: the ledger events for one Kat-run approval through monthly_runs.approveAndPost,
 * whichever channel authorized it. `approval` is the normalized approval approveAndPost holds
 * after authorization ({ channel: in_app | owner_authorization | owner_grant, user_id, email,
 * authorization_id?, grant_id?, executed_by? }). Returns [] for an unknown channel.
 */
function runApprovalEvents({ run, approval = {}, include = [], fingerprint = null, outcome, result = null, error = null, instruction = null }) {
  const kind = approval.channel === 'owner_authorization' ? 'request' : approval.channel === 'owner_grant' ? (approval.grant_kind === 'standing' ? 'standing' : 'grant') : approval.channel === 'in_app' ? 'in_app' : null;
  if (!kind) return [];
  const channel = kind === 'request' ? 'email' : kind === 'in_app' ? 'in_app' : kind;
  const base = { community_id: run.community_id, authority_kind: kind, authorization_id: approval.authorization_id || null, grant_id: approval.grant_id || null,
    action_type: 'accounting_run', target_id: run.id, fingerprint, channel, requested_by: run.prepared_by && /kat/i.test(run.prepared_by) ? policy.TEAMMATES.kat.id : (run.prepared_by || null),
    authorized_by_user_id: approval.user_id || null, authorized_by_email: approval.email || null };
  const executor = approval.executed_by || (kind === 'in_app' ? 'trusted:posting' : policy.TEAMMATES.kat.id);
  const evidence = { process: run.process, period_month: run.period_month, include, ...(instruction ? { instruction } : {}) };
  const out = [];
  // An in-app click and a grant instruction are themselves the authorization; record it with the execution.
  if (kind !== 'request') out.push({ ...base, event: 'authorized', evidence });
  if (outcome === 'posted') out.push({ ...base, event: 'executed', executed_by: executor, result: summarizeResult(result) });
  else if (outcome === 'failed') out.push({ ...base, event: 'execution_failed', executed_by: executor, result: { error: String(error || 'failed').slice(0, 1000) } });
  return out;
}

function summarizeResult(result) {
  if (!result) return null;
  const posted = Array.isArray(result.posted_entries) ? result.posted_entries.length : (Array.isArray(result.posted) ? result.posted.length : undefined);
  return { posted_entries: posted, status: result.status || result.standing || undefined, reviewed: result.reviewed || undefined };
}

module.exports = { ...policy, ...actions, ...events, policy, actions, events, runApprovalEvents };
