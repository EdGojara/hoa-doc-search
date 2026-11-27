// ============================================================================
// lib/authorization/actions.js  (Ed 2026-11-25: Owner Authorization Service)
// ----------------------------------------------------------------------------
// The ACTION REGISTRY: every kind of action the owner can authorize, with the
// teammate that executes it, its sensitivity tier, and an adapter that executes
// it ONLY through the module's own functions (which keep every module control:
// validation, fingerprints, duplicate protection, the module's own audit).
// Adding a module = adding an adapter here; no module gets its own approval system.
//
//   adapter = {
//     type, scope            scope = owner_authorizations.scope for reply-based requests
//     label, executor, tier  tier: number, or (item) => number
//     executable             false: declared so the policy knows its tier, but no
//                            conversational execution exists (money movement)
//     describe(item)         one line the owner sees
//     execute(ctx, authorization) -> { ok, results: [{ target_id, ok, ... }], summary }
//   }
// ============================================================================

const P = require('./policy');

const ACTIONS = {
  // Kat's accounting runs (migration 566): journal entries, cutoff accruals, reclassifications,
  // bank and account reconciliations. Posting goes through monthly_runs.approveAndPost.
  accounting_run: {
    type: 'accounting_run', scope: 'accounting_runs', label: 'Accounting run', executor: P.TEAMMATES.kat.id, tier: 1, executable: true,
    recordsOwnExecution: true,   // monthly_runs.approveAndPost writes each run's executed / failed event
    describe: (i) => `${i.process || 'run'} ${String(i.period_month || '').slice(0, 7)} (run ${String(i.run_id || '').slice(0, 8)})`,
    targetOf: (i) => i.run_id,
    async execute(ctx, authorization) {
      const ORA = require('../accounting/owner_run_authorization');
      const out = await ORA.executePackage({ supabase: ctx.supabase, rpc: ctx.rpc, authorization, approveAndPost: ctx.approveAndPost || require('../accounting/monthly_runs').approveAndPost });
      return { ok: !out.failed, results: out.results.map((r) => ({ target_id: r.run_id, ok: r.ok, detail: r.error || r.detail || null, posted_entries: r.posted_entries || 0 })), summary: `${out.posted} posted, ${out.failed} not posted`, raw: out };
    },
  },
  // Conversion approvals (migrations 554-556): each item through conversion_decide_object_delegated.
  conversion_object: {
    type: 'conversion_object', scope: 'conversion_objects', label: 'Conversion item', executor: P.TEAMMATES.claude.id, tier: 1, executable: true,
    describe: (i) => `${i.object_type || 'item'} ${String(i.object_id || '').slice(0, 8)}`,
    targetOf: (i) => i.object_id,
    async execute(ctx, authorization) {
      const OA = require('../onboarding/owner_authorization');
      const out = await OA.executeAuthorization({ rpc: ctx.rpc, operate: ctx.operate, authorization });
      return { ok: !out.failed, results: out.results.map((r) => ({ target_id: r.object_id, ok: r.ok, detail: r.error || null })), summary: `${out.approved} approved, ${out.failed} failed`, raw: out };
    },
  },
  // ARC/ACC (migration 582): builder lot decisions, resident ACC decisions and requests for
  // information, and the correspondence that carries them, each through its module's own path
  // (lib/authorization/arc_acc). The owner may leave numbered items out ("approved except 3").
  arc_acc_decision: {
    type: 'arc_acc_decision', scope: 'arc_acc_decisions', label: 'Architectural decision', executor: P.TEAMMATES.annie.id, executable: true,
    tier: (i) => (/den/.test(String(i.decision_type || i.decision || '')) ? 2 : 1),
    recordsOwnExecution: true,   // arc_acc records each item when it is done, held, or (for a scheduled email) sent
    supportsExclusions: true,
    parseReply: (text, items) => require('./arc_acc').parseReply(text, items),
    describe: (i) => `${i.n}. ${i.title}`,
    targetOf: (i) => i.target_id,
    async execute(ctx, authorization) {
      const out = await require('./arc_acc').executePackage(ctx, authorization);
      return { ok: out.ok, results: out.results.map((r) => ({ target_id: r.target_id, ok: r.ok, detail: r.detail })), summary: out.summary, raw: out };
    },
  },
  // Closing packages (migration 583): Ownership Review's package of completed builder closings
  // (lib/home_sales/transfer_package). Each transfer through the existing Ownership Review path,
  // then the buyers' capitalization fees through Kat's journal-entry run. Approved whole or not at all.
  closing_package: {
    type: 'closing_package', scope: 'closing_packages', label: 'Closing package', executor: P.TEAMMATES.kat.id, tier: 1, executable: true,
    describe: (i) => `${i.n}. ${i.address} settled ${i.settlement_date}`,
    targetOf: (i) => i.proposal_id,
    async execute(ctx, authorization) {
      const out = await require('../home_sales/transfer_package').executeAuthorized(ctx, authorization);
      const capFailed = !!out.capitalization.error || (out.capitalization.prepared > 0 && out.capitalization.status !== 'posted');
      return { ok: out.ok, results: out.results.map((r) => ({ target_id: r.proposal_id, ok: !!r.transferred && !capFailed, detail: r.error || r.proration_error || (capFailed ? 'capitalization fee not posted: ' + (out.capitalization.error || out.capitalization.status) : null) })),
        summary: `${out.transferred} transferred, ${out.failed} not; capitalization ${out.capitalization.posted || 0} of ${out.capitalization.prepared || 0} posted`, raw: out };
    },
  },
  // Split checks (migration 584): recording prepared check allocations through Check Receipts
  // (lib/authorization/check_allocations). Recording is accounting, not a deposit or refund.
  check_allocation: {
    type: 'check_allocation', scope: 'check_receipt_allocations', label: 'Check allocation', executor: P.TEAMMATES.kat.id, tier: 1, executable: true,
    describe: (i) => `${i.n}. check #${i.check_number}`,
    targetOf: (i) => i.receipt_id,
    async execute(ctx, authorization) {
      const out = await require('./check_allocations').executeAuthorized(ctx, authorization);
      return { ok: out.ok, results: out.results.map((r) => ({ target_id: r.receipt_id, ok: r.ok, detail: r.error || r.journal_reference || null })), summary: `${out.recorded} recorded, ${out.failed} not`, raw: out };
    },
  },
  // Declared, tier 3, never executed conversationally: the movement of money stays separate from
  // accounting authorization (an entry or interfund payable is tier 1; moving the cash is not).
  cash_transfer: { type: 'cash_transfer', label: 'Transfer of funds between bank accounts', executor: null, tier: 3, executable: false },
  payment_release: { type: 'payment_release', label: 'Release of a vendor payment', executor: null, tier: 3, executable: false },
  vendor_bank_change: { type: 'vendor_bank_change', label: 'Change of vendor bank details', executor: null, tier: 3, executable: false },
};

const BY_SCOPE = Object.fromEntries(Object.values(ACTIONS).filter((a) => a.scope).map((a) => [a.scope, a]));

function actionForScope(scope) { return BY_SCOPE[scope] || null; }
function tierOf(action, item) { return typeof action.tier === 'function' ? Number(action.tier(item)) : Number(action.tier); }

/**
 * Execute an AUTHORIZED owner_authorizations request through its adapter. Refuses an unknown
 * scope, a non-executable action and any tier the authorizing channel may not authorize.
 */
async function executeAuthorized(ctx, authorization, { channel = 'email' } = {}) {
  const action = actionForScope(authorization.scope);
  if (!action) throw Object.assign(new Error(`no action adapter for scope ${authorization.scope}`), { code: 'unknown_action' });
  if (!action.executable) throw Object.assign(new Error(`${action.label} is never executed through a conversational channel`), { code: 'not_executable' });
  const tier = Math.max(...(authorization.items || []).map((i) => tierOf(action, i)), Number(authorization.sensitivity_tier || 1));
  if (!P.channelAllowed(tier, channel)) throw Object.assign(new Error(`a tier-${tier} ${action.label.toLowerCase()} cannot be authorized by ${channel}`), { code: 'channel_not_allowed' });
  const E = require('./events');
  const kindOf = { email: 'request' }[channel] || channel;
  const base = (i) => ({ community_id: i.community_id || null, authority_kind: ['request', 'grant', 'standing', 'in_app'].includes(kindOf) ? kindOf : 'request', authorization_id: authorization.id,
    action_type: action.type, target_id: action.targetOf ? action.targetOf(i) : null, fingerprint: i.fingerprint || null, channel, requested_by: authorization.requested_by || null,
    coordinator: authorization.coordinator || P.COORDINATOR, authorized_by_user_id: authorization.authorized_by_user_id || null, authorized_by_email: authorization.authorized_by_email || null });
  if (ctx.supabase) await E.recordEvents(ctx.supabase, (authorization.items || []).map((i) => ({ ...base(i), event: 'authorized', evidence: authorization.evidence || null })));
  const out = await action.execute(ctx, authorization);
  if (ctx.supabase && !action.recordsOwnExecution) {
    const byTarget = new Map((authorization.items || []).map((i) => [String(action.targetOf ? action.targetOf(i) : ''), i]));
    await E.recordEvents(ctx.supabase, out.results.map((r) => { const i = byTarget.get(String(r.target_id)) || {};
      return { ...base(i), target_id: r.target_id, event: r.ok ? 'executed' : 'execution_failed', executed_by: authorization.executor || action.executor || P.TEAMMATES.claude.id, result: { ok: r.ok, detail: r.detail || null } }; }));
  }
  return { action, tier, ...out };
}

module.exports = { ACTIONS, actionForScope, tierOf, executeAuthorized };
