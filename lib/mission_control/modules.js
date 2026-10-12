// ============================================================================
// lib/mission_control/modules.js — Platform Buildout module registry + evidence
// ----------------------------------------------------------------------------
// Each module lists its REQUIRED capabilities. A capability's state is computed,
// never asserted:
//   coded     its files are in this build
//   merged    its linked pull requests are merged (GitHub snapshot)
//   deployed  its files are in the RUNNING build (this server is the deployment)
//   tested    its test files are in the build
//   verified  every production evidence check passes (real records, not code)
// Lifecycle: NOT STARTED -> IN PROGRESS -> MERGED -> DEPLOYED -> VERIFIED -> COMPLETE,
// plus BLOCKED (an open blocking issue) and NEEDS VERIFICATION (deployed, but
// production has not proven it works). A merged PR never makes a capability
// verified, and nothing here marks a module operational without evidence.
// Business priority (Now / Next / Later), owners, deadlines and acceptance
// criteria live on Platform work items (work_items, workspace 'platform').
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

// check kinds: rows (table + filters, min), column (exists), env (set), env_prefix, env_includes, env_equals
const rows = (label, table, where = [], min = 1) => ({ kind: 'rows', label, table, where, min });
const env = (label, name) => ({ kind: 'env', label, name });

const MODULES = [
  { key: 'homeowner_payments', name: 'Homeowner payments (Stripe)', owner: 'Engineering',
    blocks: ['Homeowner payment acceptance through TrustEd', 'Payment posting and reconciliation', 'Retirement of the Vantaca payment workflow', 'Full homeowner portal payment functionality'],
    capabilities: [
      { key: 'stripe_rails', name: 'Stripe Connect rails and webhook', files: ['lib/payments/stripe.js', 'api/payments.js'], checks: [env('Stripe key configured on the server', 'STRIPE_SECRET_KEY'), rows('Stripe webhook events received', 'stripe_events')] },
      { key: 'connected_accounts', name: 'Community connected accounts (onboarding)', files: ['api/payments.js'], checks: [rows('A community has a connected account', 'communities', [['stripe_connected_account_id', 'not_null']])] },
      { key: 'assessment_checkout', name: 'Homeowner assessment checkout (portal Pay now)', files: ['lib/payments/assessment_checkout.js', 'public/portal.html'], checks: [rows('A real assessment payment has succeeded', 'payments', [['product_type', 'eq', 'assessment_payment'], ['status', 'eq', 'succeeded']])] },
      { key: 'payment_posting', name: 'Payment posting to the GL and homeowner ledger', files: ['lib/payments/assessment_posting.js'], checks: [rows('A Stripe assessment payment is on the homeowner ledger', 'homeowner_transactions', [['raw_row_jsonb', 'contains', { source: 'stripe_assessment' }]])] },
      { key: 'live_mode', name: 'Live-mode Stripe keys', files: [], checks: [{ kind: 'env_prefix', label: 'The server uses a live Stripe key', name: 'STRIPE_SECRET_KEY', prefix: 'sk_live_' }] },
      { key: 'autopay', name: 'Autopay', required: false, files: ['lib/payments/autopay.js', 'lib/payments/autopay_jobs.js'], checks: [] },
    ] },
  { key: 'payment_migration', name: 'Payment migration and reconciliation', owner: 'Kat / Engineering', depends_on: ['homeowner_payments'],
    blocks: ['Vantaca used only as a payment portal until Stripe takes over', 'Homeowner receipts reconciled to the bank every month'],
    capabilities: [
      { key: 'receipts_posted', name: 'Vantaca Pay receipts posted to the trustEd homeowner ledger', files: ['api/ar.js'], checks: [rows('Homeowner payments are recorded in trustEd', 'homeowner_transactions', [['txn_type', 'eq', 'payment']])] },
      { key: 'bank_matching', name: 'Receipts matched to the bank (Kat)', files: ['lib/banking/monthly_rec.js'], tests: ['tests/test_bank_monthly_rec.js'], checks: [rows('A bank reconciliation is reconciled', 'bank_reconciliations', [['status', 'eq', 'reconciled']])] },
      { key: 'permanent_feed', name: 'Permanent homeowner billing and receipt feed', files: [], issues: [99], blocking_issues: [99], checks: [] },
    ] },
  { key: 'homeowner_portal', name: 'Homeowner portal', owner: 'Engineering', depends_on: ['homeowner_payments'],
    blocks: ['Self-service balance, payments, ARC and messages for homeowners'],
    capabilities: [
      { key: 'magic_link', name: 'Magic-link sign-in', files: ['public/portal.html'], checks: [rows('Homeowners have signed in by magic link', 'portal_magic_links')] },
      { key: 'balance', name: 'Balance and statement view', files: ['public/portal-balance.html'], checks: [] },
      { key: 'arc', name: 'ARC requests from the portal', files: ['public/portal-arc.html'], checks: [] },
      { key: 'messages', name: 'Homeowner messages reach staff', files: ['public/portal.html'], issues: [32], blocking_issues: [32], checks: [] },
      { key: 'pay_now', name: 'Pay now (depends on Stripe assessment checkout)', files: ['public/portal.html'], depends_on: ['homeowner_payments.assessment_checkout'], checks: [rows('A real assessment payment has succeeded', 'payments', [['product_type', 'eq', 'assessment_payment'], ['status', 'eq', 'succeeded']])] },
    ] },
  { key: 'board_portal', name: 'Board portal', owner: 'Engineering / Paige',
    blocks: ['Board self-service: property map, votes, discussion, Ask Amanda'],
    capabilities: [
      { key: 'portal', name: 'Board property portal', files: ['public/board-portal.html', 'api/board_portal.js'], checks: [rows('Board members are set up', 'board_members')] },
      { key: 'voting', name: 'Board motions and voting', files: ['public/board-vote.html'], checks: [rows('A board vote has been cast', 'board_motion_votes')] },
      { key: 'discussion', name: 'Board discussion', files: ['api/board_portal.js'], checks: [rows('A board message has been posted', 'board_messages')] },
      { key: 'ask_amanda', name: 'Ask Amanda (board assistant)', files: ['api/amanda.js'], checks: [] },
    ] },
  { key: 'budget', name: 'Budget preparation', owner: 'Kat / Engineering',
    blocks: ['Proposed budgets the board can adopt', 'Budget vs actual in the board package'],
    capabilities: [
      { key: 'editor', name: 'Living budget editor', files: ['api/books.js', 'public/accounting.html'], tests: ['tests/test_working_forecast.js'], checks: [rows('A budget is saved', 'community_budgets')] },
      { key: 'reserve_plan', name: 'Reserve budget from planned projects', files: ['public/js/reserve_plan_core.js', 'lib/accounting/reserve_plan.js'], tests: ['tests/test_reserve_plan.js'], checks: [{ kind: 'column', label: 'Migration 512 applied', table: 'reserve_budget_items', column: 'account_id' }, rows('A planned reserve project is saved', 'reserve_budget_items')] },
      { key: 'proposed_pdf', name: 'Proposed budget statement (PDF)', files: ['lib/statements/model.js', 'lib/statements/render.js'], tests: ['tests/test_statement_package.js'], checks: [rows('A draft budget exists to print', 'community_budgets', [['status', 'eq', 'draft']])] },
      { key: 'board_collaboration', name: 'Board budget collaboration', required: false, files: [], checks: [] },
    ] },
  { key: 'accounting', name: 'Financial accounting and reporting', owner: 'Kat',
    blocks: ['Monthly financial statements', 'Board financial packages'],
    capabilities: [
      { key: 'gl', name: 'General ledger posting', files: ['lib/accounting/posting.js'], checks: [rows('Journal entries are posted', 'journal_entries')] },
      { key: 'statements', name: 'Financial statements engine (board package)', files: ['lib/statements/model.js', 'lib/statements/render.js'], tests: ['tests/test_statement_package.js'], checks: [] },
      { key: 'recognition', name: 'Revenue recognition and amortization', files: ['lib/accounting/recognition_engine.js'], checks: [rows('Recognition has posted', 'recognition_postings')] },
      { key: 'close', name: 'Month-end close', files: ['lib/close/service.js'], checks: [rows('A close checklist has run', 'period_close_runs'), rows('A month has been closed', 'period_closes', [['status', 'eq', 'closed']])] },
      { key: 'kat_runs', name: 'Kat\'s controlled monthly runs (prepare, approve, post)', files: ['lib/accounting/monthly_runs.js'], checks: [rows('A Kat run has been approved and posted', 'accounting_runs', [['status', 'eq', 'posted']])] },
      { key: 'interest', name: 'Late interest', files: ['lib/ar/monthly_interest.js'], tests: ['tests/test_monthly_interest.js'], checks: [rows('An interest run has posted', 'accounting_runs', [['process', 'eq', 'interest'], ['status', 'eq', 'posted']])] },
    ] },
  { key: 'bank_reconciliation', name: 'Bank reconciliation', owner: 'Kat', depends_on: ['accounting'],
    blocks: ['Monthly close cash controls'],
    capabilities: [
      { key: 'statement_import', name: 'Bank statement import', files: ['lib/banking/extractors'], issues: [119], checks: [rows('Bank statements are imported', 'bank_statement_imports')] },
      { key: 'engine', name: 'Kat\'s reconciliation engine', files: ['lib/banking/monthly_rec.js'], tests: ['tests/test_bank_monthly_rec.js'], checks: [rows('A reconciliation is reconciled', 'bank_reconciliations', [['status', 'eq', 'reconciled']]), rows('A Kat reconciliation run has been approved', 'accounting_runs', [['process', 'eq', 'bank_reconciliation'], ['status', 'eq', 'posted']])] },
      { key: 'schedule', name: 'Monthly schedule (Kat runs on her own)', files: ['lib/scheduler.js'], checks: [{ kind: 'env_includes', label: 'kat_monthly_accounting is enabled on the server', name: 'SCHEDULER_ENABLED', value: 'kat_monthly_accounting' }] },
      { key: 'investments', name: 'Investment account (brokerage) reconciliation', files: [], checks: [] },
    ] },
  { key: 'ap_checks', name: 'Accounts payable and check processing', owner: 'Emma',
    blocks: ['Vendors paid on time from approved invoices'],
    capabilities: [
      { key: 'intake', name: 'Invoice intake (Emma)', files: ['api/ap.js'], issues: [14], checks: [rows('Invoices are in AP', 'ap_invoices')] },
      { key: 'checks', name: 'Check printing and register', files: ['api/checks.js'], checks: [rows('Checks are in the register', 'check_register')] },
      { key: 'reimbursements', name: 'Reimbursement requests become a reviewable check workflow', files: [], issues: [3], checks: [] },
    ] },
  { key: 'acc', name: 'ACC workflows', owner: 'Annie',
    blocks: ['Architectural applications decided within the governing-document deadline'],
    capabilities: [
      { key: 'decisions', name: 'ACC applications and decisions', files: ['api/applications.js', 'public/portal-acc-review.html'], checks: [rows('ACC decisions are recorded', 'acc_decisions')] },
      { key: 'finalization', name: 'Decision letters finalized', files: ['api/applications.js'], checks: [rows('An ACC decision has been finalized', 'acc_finalizations')] },
    ] },
  { key: 'drv', name: 'Deed restriction (DRV) workflows', owner: 'Miranda',
    blocks: ['Violations noticed and escalated under Chapter 209'],
    capabilities: [
      { key: 'violations', name: 'Inspections and violations', files: ['api/enforcement.js'], checks: [rows('Violations are recorded', 'violations')] },
      { key: 'print', name: 'Letter print batches', files: ['api/enforcement.js'], issues: [5], blocking_issues: [5], checks: [] },
    ] },
  { key: 'ai_community_mgmt', name: 'AI community management (Amanda)', owner: 'Amanda',
    blocks: ['Escalations owned without Ed in the loop'],
    capabilities: [
      { key: 'escalation', name: 'Escalation replies', files: ['lib/community/amanda_reply.js', 'api/amanda.js'], checks: [rows('Amanda has handled email', 'email_messages', [['persona', 'eq', 'amanda']])] },
      { key: 'orchestration', name: 'Event-driven wake / work / sleep orchestration', files: [], issues: [27], checks: [] },
    ] },
  { key: 'ai_email', name: 'AI communications and email', owner: 'Claire / Emma',
    blocks: ['Every inbound email read and answered without lag'],
    capabilities: [
      { key: 'ingest', name: 'Mailbox ingest and drafting', files: ['lib/email/graph_ingest.js', 'api/email_triage.js'], checks: [rows('Email is ingested', 'email_messages')] },
      { key: 'auto_ingest', name: 'Automatic ingest (no manual Pull inbox)', files: ['lib/scheduler.js'], issues: [4], checks: [{ kind: 'env_equals', label: 'EMAIL_INGEST_AUTO is on', name: 'EMAIL_INGEST_AUTO', value: 'true' }] },
    ] },
  { key: 'voice', name: 'Voice and telephone (Claire)', owner: 'Engineering',
    blocks: ['Homeowner calls answered by Claire'],
    capabilities: [
      { key: 'calls', name: 'Inbound calls and transcripts', files: ['lib/voice/bridge.js', 'api/voice.js'], checks: [rows('A homeowner call is logged', 'homeowner_calls')] },
      { key: 'socket_auth', name: 'Voice sockets and Twilio webhooks authenticate', files: [], prs: [34], checks: [] },
      { key: 'a2p', name: 'Carrier registration (A2P) for the production number', files: [], checks: [] },
    ] },
  { key: 'agent_orchestration', name: 'Agent orchestration and autonomy', owner: 'Engineering',
    blocks: ['Agents work on schedules and events with human approval gates'],
    capabilities: [
      { key: 'scheduler', name: 'Scheduler and cron runs', files: ['lib/scheduler.js'], checks: [rows('Scheduled jobs have run', 'cron_runs')] },
      { key: 'mission_control', name: 'Mission Control task and dependency ledger', files: ['lib/mission_control/graph.js', 'api/mission_control.js'], tests: ['tests/test_mission_control_graph.js'], checks: [{ kind: 'column', label: 'Migration 513 applied', table: 'work_items', column: 'horizon' }] },
    ] },
  { key: 'onboarding', name: 'Onboarding and data conversion', owner: 'Engineering / Kat',
    blocks: ['New communities converted without manual archaeology'],
    capabilities: [
      { key: 'engine', name: 'Onboarding pipeline', files: ['api/onboarding.js', 'lib/onboarding'], issues: [15], checks: [rows('Onboarding has written records', 'onboarding_execution_writes')] },
    ] },
  { key: 'documents', name: 'Document management', owner: 'Engineering',
    blocks: ['Governing documents and records retrievable in three clicks'],
    capabilities: [{ key: 'library', name: 'Document library', files: ['api/documents.js'], checks: [rows('Documents are in the library', 'library_documents')] }] },
  { key: 'team', name: 'HR and team', owner: 'Ed',
    blocks: ['Staff accounts, roles and access'],
    capabilities: [{ key: 'roster', name: 'Team roster and accounts', files: ['public/bedrock-team.html'], checks: [rows('Active staff accounts', 'user_profiles', [['is_active', 'eq', true]])] }] },
  { key: 'security', name: 'Authorization and audit', owner: 'Engineering',
    blocks: ['Every operational route checks who is calling'],
    capabilities: [{ key: 'routes', name: 'Operational route authorization', files: ['api/_require_admin.js'], issues: [7, 33], blocking_issues: [7, 33], checks: [] }] },
];

function fileExists(rel) { try { return fs.existsSync(path.join(ROOT, rel)); } catch (_) { return false; } }
function loadSnapshot() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'github_snapshot.json'), 'utf8')); } catch (_) { return { issues: {}, pulls: {}, generated_at: null }; }
}

async function runCheck(supabase, c, envv = process.env) {
  try {
    if (c.kind === 'env') return { ok: !!envv[c.name], detail: envv[c.name] ? 'set' : 'not set' };
    if (c.kind === 'env_prefix') return { ok: String(envv[c.name] || '').startsWith(c.prefix), detail: String(envv[c.name] || '').startsWith(c.prefix) ? 'yes' : 'no' };
    if (c.kind === 'env_includes') { const on = String(envv[c.name] || '').split(/[\s,]+/).includes(c.value); return { ok: on, detail: on ? 'enabled' : 'not enabled' }; }
    if (c.kind === 'env_equals') return { ok: envv[c.name] === c.value, detail: envv[c.name] === c.value ? 'on' : 'off' };
    if (c.kind === 'column') { const { error } = await supabase.from(c.table).select(c.column).limit(1); return { ok: !error, detail: error ? 'not applied' : 'applied' }; }
    if (c.kind === 'rows') {
      let q = supabase.from(c.table).select('*', { count: 'exact', head: true });
      for (const [col, op, val] of c.where || []) {
        if (op === 'eq') q = q.eq(col, val); else if (op === 'not_null') q = q.not(col, 'is', null); else if (op === 'contains') q = q.contains(col, val);
      }
      const { count, error } = await q;
      if (error) return { ok: false, detail: 'could not be checked', unknown: true };
      return { ok: (count || 0) >= c.min, detail: `${count || 0} record${count === 1 ? '' : 's'}` };
    }
    return { ok: false, detail: 'unknown check', unknown: true };
  } catch (e) { return { ok: false, detail: 'could not be checked', unknown: true }; }
}

// Capability state from evidence (pure, given check results and the snapshot).
function capabilityState(cap, { checks, snapshot, exists = fileExists }) {
  const files = cap.files || [];
  const coded = files.length > 0 && files.every(exists);
  const tested = (cap.tests || []).length > 0 && cap.tests.every(exists);
  const prs = (cap.prs || []).map((n) => ({ number: n, ...(snapshot.pulls[n] || { state: 'unknown' }) }));
  const issues = (cap.issues || []).map((n) => ({ number: n, ...(snapshot.issues[n] || { state: 'unknown' }) }));
  const merged = prs.length ? prs.every((p) => p.state === 'merged') : coded;
  const openPr = prs.some((p) => p.state === 'open');
  const blockers = (cap.blocking_issues || []).map((n) => snapshot.issues[n] ? { number: n, ...snapshot.issues[n] } : null).filter((i) => i && i.state === 'open');
  const verified = coded && checks.length > 0 && checks.every((c) => c.result.ok);
  let state;
  if (!coded) state = openPr ? 'IN PROGRESS' : prs.some((p) => p.state === 'merged') ? 'MERGED' : 'NOT STARTED';
  else if (blockers.length) state = 'BLOCKED';
  else if (verified) state = 'VERIFIED';
  else if (openPr) state = 'IN PROGRESS';
  else state = 'NEEDS VERIFICATION';
  return { coded, merged: coded ? merged : prs.some((p) => p.state === 'merged'), deployed: coded, tested, verified, state, prs, issues, blockers };
}

// Module state: VERIFIED when every required capability is verified by production
// evidence. COMPLETE only when it is verified, no linked GitHub issue is open, no open
// Platform work item for the module is in Now or Next, AND the owner has accepted it
// (Mission Control "decide" with key module:<key>:complete). Evidence alone never
// makes a module complete.
function moduleState(caps, openItems, { accepted = false } = {}) {
  const req = caps.filter((c) => c.required !== false);
  if (!req.length) return 'NEEDS VERIFICATION';
  if (req.every((c) => c.state === 'NOT STARTED')) return 'NOT STARTED';
  if (req.some((c) => c.state === 'BLOCKED')) return 'BLOCKED';
  if (req.every((c) => c.state === 'VERIFIED')) {
    const openIssue = caps.some((c) => (c.issues || []).some((i) => i.state === 'open'));
    return accepted && !openIssue && !openItems.some((w) => ['now', 'next'].includes(w.horizon)) ? 'COMPLETE' : 'VERIFIED';
  }
  if (req.some((c) => c.state === 'NOT STARTED' || c.state === 'IN PROGRESS' || c.state === 'MERGED')) return 'IN PROGRESS';
  return 'NEEDS VERIFICATION';
}

async function evaluateModules(supabase, { platformItems = [], cache = null, envv = process.env, accepted = new Set() } = {}) {
  const snapshot = loadSnapshot();
  const ck = 'modules:checks';
  let results = cache && cache.get(ck);
  if (!results) {
    results = {};
    const jobs = [];
    for (const m of MODULES) for (const c of m.capabilities) (c.checks || []).forEach((chk, i) => jobs.push(runCheck(supabase, chk, envv).then((r) => { results[`${m.key}.${c.key}.${i}`] = r; })));
    await Promise.all(jobs);
    if (cache) cache.set(ck, results);
  }
  return {
    snapshot: { generated_at: snapshot.generated_at, repo: snapshot.repo },
    deployed_commit: envv.RENDER_GIT_COMMIT || null,
    modules: MODULES.map((m) => {
      const items = platformItems.filter((w) => w.module_key === m.key);
      const caps = m.capabilities.map((c) => {
        const checks = (c.checks || []).map((chk, i) => ({ label: chk.label, result: results[`${m.key}.${c.key}.${i}`] || { ok: false, detail: 'not checked', unknown: true } }));
        return { key: c.key, name: c.name, required: c.required !== false, files: c.files || [], tests: c.tests || [], depends_on: c.depends_on || [], checks, ...capabilityState(c, { checks, snapshot }) };
      });
      const req = caps.filter((c) => c.required);
      return { key: m.key, name: m.name, owner: m.owner, depends_on: m.depends_on || [], blocks: m.blocks || [], state: moduleState(caps, items.filter((w) => w.state !== 'done'), { accepted: accepted.has(m.key) }), accepted: accepted.has(m.key),
        readiness: { verified: req.filter((c) => c.state === 'VERIFIED').length, required: req.length }, capabilities: caps };
    }),
  };
}

module.exports = { MODULES, evaluateModules, capabilityState, moduleState, runCheck, loadSnapshot };
