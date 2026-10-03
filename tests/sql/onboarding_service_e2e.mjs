// tests/sql/onboarding_service_e2e.mjs — Issue #15 Milestone 2. The persisted
// onboarding workflow (lib/onboarding/service.js) end to end on the REAL
// 452 + 481 + 482 SQL, with the synthetic Vantaca fixture (no client data):
// create -> register artifacts -> run intake / normalize / source controls ->
// waive -> advance, read back through the view, plus every bypass we can think
// of: wrong role, agent outside its stage, forged body identity, stale result,
// tampered artifact bytes, snapshot (stage 3) incl. stale replay, no runner for
// later stages, EXECUTE, direct table
// writes. Postgres 17 (PGlite 0.3.x). Skips without PGlite.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { onboardingWorld, COMM } from './onboarding_world.mjs';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  onboarding service e2e (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const { createOnboardingService } = require(`${REPO}/lib/onboarding/service.js`);
const FX = path.join(REPO, 'tests', 'fixtures', 'onboarding', 'synthetic-vantaca');
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const code = async (fn) => { try { await fn(); return null; } catch (e) { return e.code || e.message; } };

const OWNER = { kind: 'human', id: 'ed', role: 'owner' };
const ADMIN = { kind: 'human', id: 'staffer', role: 'admin' };
function memoryStorage() { const m = new Map(); return { m, async putOnce(p, b) { if (!m.has(p)) m.set(p, Buffer.from(b)); }, async get(p) { if (!m.has(p)) throw new Error('missing'); return Buffer.from(m.get(p)); } }; }

const world = await onboardingWorld(PGlite, { through: 484 });
const storage = memoryStorage();
let rpcCalls = [];
// Synthetic Trusted financial activity for the bridge (no client data). Mutable so a test can change it.
const je = (id, d, mod, amt, extra = {}) => ({ id, posting_date: d, source_module: mod, status: 'posted', total_debits_cents: amt, total_credits_cents: amt, description: '', ...extra });
const trustedRows = {
  journal_entries: [je('t-legacy', '2026-02-01', 'vantaca_import', 61000), je('t-inv-src', '2026-04-05', 'ap_invoice', 15000, { description: 'AP invoice EX-0001 — Example Landscaping LLC' }),
    je('t-inv-new', '2026-08-25', 'ap_invoice', 55000, { description: 'AP invoice 2608EX — Manager' }), je('t-ach', '2026-03-05', 'payment_intake', 15000, { description: 'AP payment ach' })],
  journal_entry_lines: [{ id: 'l1', journal_entry_id: 't-inv-new', account_id: 'x5810', debit_cents: 55000, credit_cents: 0 }, { id: 'l2', journal_entry_id: 't-inv-new', account_id: 'x2000', debit_cents: 0, credit_cents: 55000 }],
  ap_invoices: [{ id: 'i-src', vendor_invoice_number: 'EX-0001', invoice_date: '2026-04-05', total_cents: 15000, posting_journal_entry_id: 't-inv-src' }, { id: 'i-new', vendor_invoice_number: '2608EX', invoice_date: '2026-08-25', total_cents: 55000, posting_journal_entry_id: 't-inv-new' }],
  ap_payments: [], ar_charges: [], ar_payments: [], payments: [{ id: 't-pay', amount_cents: 100, status: 'pending', livemode: null, journal_entry_id: null, created_at: '2026-03-20T00:00:00Z' }], homeowner_transactions: [],
};
const trustedRecordCount = () => Object.entries(trustedRows).filter(([k]) => k !== 'journal_entry_lines').reduce((n, [, v]) => n + v.length, 0);
const readerCalls = [];
const trustedReader = async (communityId) => { readerCalls.push(communityId); return { trusted: JSON.parse(JSON.stringify(trustedRows)), accountNumber: (id) => ({ x5810: '5810', x2000: '2000' }[id] || null), accountOfProperty: () => null }; };
const svc = createOnboardingService({ rpc: async (n, a) => { rpcCalls.push(n); return world.rpc(n, a); }, storage, trustedReader });

check('schema status: ready when 481/482 are applied', (await svc.schemaStatus()).ready === true);
{
  const bare = await onboardingWorld(PGlite, { through: 0 });
  const s2 = createOnboardingService({ rpc: bare.rpc, storage: memoryStorage() });
  const st = await s2.schemaStatus();
  check('schema status: NOT ready (names 481 + 482) when they are not applied; reads refuse with 503', st.ready === false && st.needs.join() === '481_onboarding_engine.sql,482_onboarding_service.sql' && (await code(() => s2.listBatches())) === 'SCHEMA_NOT_APPLIED');
}

check('create: an agent (or any non-staff actor) cannot create a batch', (await code(() => svc.createBatch({ kind: 'agent', id: 'claude', assigned_stage: 'intake' }, { community_id: COMM, batch_code: 'X', as_of_date: '2026-03-31', source_system: 'vantaca' }))) === 'STAFF_ONLY');
const B = await svc.createBatch(ADMIN, { community_id: COMM, batch_code: 'CONV-EX-20260331', as_of_date: '2026-03-31', source_system: 'vantaca' });
const TYPES = ['gl_trial_balance', 'balance_sheet', 'ar_aging', 'homeowner_transactions', 'prepaid_homeowners'];
for (const t of TYPES) await svc.registerArtifact(ADMIN, B, { buffer: fs.readFileSync(path.join(FX, `${t}.txt`)), filename: `${t}.txt`, artifact_type: t });
let v = await svc.getBatch(B, OWNER);
check('artifacts: 5 registered, hashed, stored write-once by content hash', v.artifacts.length === 5 && v.artifacts.every((a) => a.sha256.length === 64 && a.storage_path.endsWith(a.sha256)) && storage.m.size === 5);
check('view: intake has no result yet -> staff must run it; owner sees no advance yet', v.derived.required_action.who === 'staff' && !v.derived.permitted_actions.some((x) => x.action === 'advance'));

check('run: an agent assigned to another stage cannot run intake', /AGENT_OUTSIDE_ASSIGNED_STAGE/.test((await code(() => svc.runStage({ kind: 'agent', id: 'claude', assigned_stage: 'normalize' }, B))) || ''));
const r0 = await svc.runStage({ kind: 'agent', id: 'claude', assigned_stage: 'intake' }, B);
check('run intake (agent in its own stage): PASS recorded', r0.status === 'PASS');
check('advance: an admin (not owner) cannot advance', (await code(() => svc.advance(ADMIN, B, { completion_id: r0.completion_id, to: 'normalize' }))) === 'OWNER_ONLY');
check('advance: an agent cannot advance', (await code(() => svc.advance({ kind: 'agent', id: 'claude', assigned_stage: 'intake', role: 'owner' }, B, { completion_id: r0.completion_id, to: 'normalize' }))) === 'OWNER_ONLY');
v = await svc.getBatch(B, OWNER);
const advIntake = v.derived.permitted_actions.find((x) => x.action === 'advance');
check('view: after a PASS the owner is offered exactly one action: advance to normalize', advIntake && advIntake.to === 'normalize' && /advance to normalize/.test(v.derived.required_action.text));
await svc.advance(OWNER, B, { completion_id: r0.completion_id, to: 'normalize' });
check('artifacts: cannot be added after intake', (await code(() => svc.registerArtifact(ADMIN, B, { buffer: Buffer.from('late'), filename: 'late.txt', artifact_type: 'other' }))) === 'NOT_IN_INTAKE');

const r1 = await svc.runStage(ADMIN, B);
check('run normalize: PASS (every line read, every printed total reproduced)', r1.status === 'PASS', JSON.stringify(r1));
await svc.advance(OWNER, B, { completion_id: r1.completion_id, to: 'source_controls' });

// Source controls with an authoritative AR that is deliberately wrong -> FAIL, then waived.
const spec = { ar: { label: 'AR = 510.00', cents: 51000, derive: { kind: 'gl_ending', account: '1300' } }, wrong_cash: { label: 'Cash = 1,400.00 (deliberately wrong)', cents: 140000, derive: { kind: 'gl_ending', account: '1000' } } };
const r2 = await svc.runStage(ADMIN, B, { roles: { ar_account: '1300', prepaid_account: '2400' }, authoritative: spec });
v = await svc.getBatch(B, OWNER);
const cash = v.current.controls.find((c) => c.code === 'authoritative.wrong_cash');
check('run source controls: FAIL recorded with the exact difference (1,435.00 vs 1,400.00); every other control PASS', r2.status === 'FAIL' && cash.status === 'FAIL' && Number(cash.difference_cents) === 3500 && v.current.controls.filter((c) => c.status !== 'PASS').length === 1);
check('view: owner offered a waiver for the open control, NOT an advance; required action names it', v.derived.permitted_actions.some((x) => x.action === 'waive' && x.code === 'authoritative.wrong_cash') && !v.derived.permitted_actions.some((x) => x.action === 'advance') && /authoritative\.wrong_cash/.test(v.derived.required_action.text));
check('view: an admin sees the batch but is offered no waive/advance', !(await svc.getBatch(B, ADMIN)).derived.permitted_actions.some((x) => x.action === 'waive' || x.action === 'advance'));
check('advance without the waiver: refused by the DATABASE even if this layer is bypassed', /REFUSED_BY_DATABASE/.test((await code(() => svc.advance(OWNER, B, { completion_id: r2.completion_id, to: 'snapshot' }))) || ''));
check('waive: admin refused; weak reason refused', (await code(() => svc.waive(ADMIN, B, { completion_id: r2.completion_id, code: 'authoritative.wrong_cash', reason: 'reviewed and documented' }))) === 'OWNER_ONLY'
  && (await code(() => svc.waive(OWNER, B, { completion_id: r2.completion_id, code: 'authoritative.wrong_cash', reason: 'ok' }))) === 'WAIVER_REASON_REQUIRED');

// Re-run the stage: the first result becomes stale; a waiver against it is refused.
const r2b = await svc.runStage(ADMIN, B, { roles: { ar_account: '1300', prepaid_account: '2400' }, authoritative: spec });
check('replay: waiving the OLD (stale) result after a re-run is refused by the database', /REFUSED_BY_DATABASE/.test((await code(() => svc.waive(OWNER, B, { completion_id: r2.completion_id, code: 'authoritative.wrong_cash', reason: 'reviewed against the old result' }))) || ''));
await svc.waive(OWNER, B, { completion_id: r2b.completion_id, code: 'authoritative.wrong_cash', reason: 'authoritative figure was a typo in the request; reviewed' });
v = await svc.getBatch(B, OWNER);
const waived = v.current.controls.find((c) => c.code === 'authoritative.wrong_cash');
check('waived: still FAIL with its difference; disposition WAIVED by ed with the reason; summary FAIL "eligible_with_waiver"', waived.status === 'FAIL' && Number(waived.difference_cents) === 3500 && waived.disposition.disposition === 'WAIVED' && waived.disposition.waived_by === 'ed' && /typo/.test(waived.disposition.reason)
  && v.derived.summary.overall === 'FAIL' && v.derived.eligibility === 'eligible_with_waiver');
check('advance on the OLD result id is refused (stale), on the current one accepted', /REFUSED_BY_DATABASE/.test((await code(() => svc.advance(OWNER, B, { completion_id: r2.completion_id, to: 'snapshot' }))) || '')
  && (await code(() => svc.advance(OWNER, B, { completion_id: r2b.completion_id, to: 'snapshot' }))) === null);
v = await svc.getBatch(B, OWNER);
check('audit trail: every human action is an event with the server-side identity', v.events.filter((e) => e.type === 'stage_advanced').every((e) => e.actor_kind === 'human' && e.actor_id === 'ed') && v.events.some((e) => e.type === 'control_waived' && e.actor_id === 'ed'));
// ---- Stage 3: conversion snapshot (read-only proposed opening position)
check('snapshot: the stage now has a runner; an agent assigned elsewhere cannot build it', v.derived.runner_available === true && /AGENT_OUTSIDE_ASSIGNED_STAGE/.test((await code(() => svc.runStage({ kind: 'agent', id: 'claude', assigned_stage: 'source_controls' }, B))) || ''));
const sn1 = await svc.runStage({ kind: 'agent', id: 'claude', assigned_stage: 'snapshot' }, B);
let sv = await svc.getSnapshot(B);
const comp = (n) => sv.components.find((c) => c.component === n);
check('snapshot recorded: uses the VALIDATED roles (1300 / 2400); GL, AR and prepaid supported; AP not applicable (the source chart has no AP account); PASS; not stale',
  sn1.status === 'PASS' && sv.completion_id === sn1.completion_id && sv.stale === false && comp('gl').status === 'PASS' && comp('ar_detail').supported_cents === 51000 && comp('prepaid_detail').supported_cents === -8500 && comp('ap_detail').status === 'NOT_APPLICABLE');
const glLines = sv.lines.filter((l) => l.kind === 'gl_opening_balance');
check('snapshot lines: GL opening balances balance; each line keeps provenance; AR detail per account', glLines.reduce((t, l) => t + Number(l.amount_cents), 0) === 0 && sv.lines.every((l) => l.provenance.length && /^[0-9a-f]{64}$/.test(l.provenance[0].artifact_sha256)) && sv.lines.filter((l) => l.kind === 'ar_detail').length === 2);
v = await svc.getBatch(B, OWNER);
check('snapshot: a PASS snapshot offers the owner an advance and no waiver', v.derived.permitted_actions.some((x) => x.action === 'advance' && x.to === 'activity_bridge') && !v.derived.permitted_actions.some((x) => x.action === 'waive'));
const sn2 = await svc.runStage(ADMIN, B, { ap_account: '2400' });   // re-run (different AP setting) -> a new snapshot
const oldView = await svc.getSnapshot(B, sn1.completion_id); sv = await svc.getSnapshot(B);
check('snapshot re-run: new completion and sha; the earlier snapshot is still readable and flagged stale', sv.completion_id === sn2.completion_id && sv.snapshot_sha256 !== oldView.snapshot_sha256 && oldView.stale === true && sv.stale === false);
check('replay: a waiver against the stale snapshot is refused by the database', /REFUSED_BY_DATABASE/.test((await code(() => svc.waive(OWNER, B, { completion_id: sn1.completion_id, code: 'snapshot.ap_detail_supports_gl', reason: 'AP aging to follow; reviewed' }))) || ''));
check('the unsupported AP remainder is its own line naming nobody', sv.lines.some((l) => l.kind === 'unsupported_detail' && l.component === 'ap_detail' && l.source_account_key === null));
await svc.waive(OWNER, B, { completion_id: sn2.completion_id, code: 'snapshot.ap_detail_supports_gl', reason: 'AP aging to follow; reviewed for the test' });
await svc.advance(OWNER, B, { completion_id: sn2.completion_id, to: 'activity_bridge' });
v = await svc.getBatch(B, OWNER);
// ---- Stage 4: activity bridge (reads Trusted through the read-only path; changes nothing)
check('activity bridge: the stage has a runner; an agent assigned elsewhere cannot run it', v.derived.runner_available === true && /AGENT_OUTSIDE_ASSIGNED_STAGE/.test((await code(() => svc.runStage({ kind: 'agent', id: 'claude', assigned_stage: 'snapshot' }, B))) || ''));
const br1 = await svc.runStage({ kind: 'agent', id: 'claude', assigned_stage: 'activity_bridge' }, B);
let bv = await svc.getBridge(B);
const cls = (k) => bv.items.filter((i) => i.classification === k).map((i) => i.event_key);
check('bridge recorded: legacy import ALREADY; invoice EX-0001 dated after cutoff ALREADY by number+amount; test payment OUT; Aug invoice SUBSEQUENT; amount-only AMBIGUOUS',
  cls('ALREADY_IN_SOURCE').includes('je:t-legacy') && cls('ALREADY_IN_SOURCE').includes('je:t-inv-src') && cls('OUT_OF_SCOPE').includes('loose:payments:t-pay') && cls('LEGITIMATE_SUBSEQUENT').includes('je:t-inv-new') && cls('AMBIGUOUS').includes('je:t-ach'));
check('bridge: every Trusted record classified exactly once; totals reconcile; status BLOCKED on the ambiguous item', bv.status === 'BLOCKED' && bv.items.reduce((n, i) => n + i.records.length, 0) === trustedRecordCount() && Object.values(bv.totals).reduce((n, t) => n + Number(t.records), 0) === trustedRecordCount());
check('bridge freshness: fresh right after the run', (await svc.bridgeFreshness(B)).fresh === true);
trustedRows.ap_invoices[0] = { ...trustedRows.ap_invoices[0], total_cents: trustedRows.ap_invoices[0].total_cents + 1, updated_at: '2026-10-03T12:00:00Z' };
check('bridge freshness: a later change to Trusted activity makes the bridge stale (fresh = false)', (await svc.bridgeFreshness(B)).fresh === false);
const br2 = await svc.runStage(ADMIN, B);
const oldB = await svc.getBridge(B, br1.completion_id); bv = await svc.getBridge(B);
check('bridge re-run: new completion; earlier bridge readable and flagged stale; a waiver against it is refused', bv.completion_id === br2.completion_id && oldB.stale === true
  && /REFUSED_BY_DATABASE/.test((await code(() => svc.waive(OWNER, B, { completion_id: br1.completion_id, code: 'bridge.ambiguous_items_reviewed', reason: 'reviewed the ambiguous items' }))) || ''));
check('the Trusted reader was only ever given the community id (it reads, never writes)', readerCalls.length >= 3 && readerCalls.every((c) => c === COMM));
check('no accounting table was touched by any of it', (await world.db.query(`SELECT count(*)::int AS n FROM journal_entries`)).rows[0].n === 0);

// Tampered artifact bytes refuse the stage (new batch so we are back in intake/normalize).
const B2 = await svc.createBatch(ADMIN, { community_id: COMM, batch_code: 'CONV-EX-TAMPER', as_of_date: '2026-03-31', source_system: 'vantaca' });
await svc.registerArtifact(ADMIN, B2, { buffer: fs.readFileSync(path.join(FX, 'gl_trial_balance.txt')), filename: 'gl_trial_balance.txt', artifact_type: 'gl_trial_balance' });
const p2 = (await svc.getBatch(B2, OWNER)).artifacts[0].storage_path;
storage.m.set(p2, Buffer.from('tampered bytes'));
const t0 = await svc.runStage(ADMIN, B2);
const tv = await svc.getBatch(B2, OWNER);
check('tampered artifact: intake FAILS on the re-hash check (the stored bytes no longer match the record)', t0.status === 'FAIL' && tv.current.controls.find((c) => c.code === 'intake.artifacts_match_recorded_hashes').status === 'FAIL');

// Only allowlisted guarded functions were ever called; the service holds no table writes.
check('service used only the allowlisted onboarding_* functions', rpcCalls.every((n) => /^onboarding_(batches|batch_view|create_batch|register_artifact|record_completion|waive|approve|advance|record_snapshot|snapshot_view|record_bridge|bridge_view)$/.test(n)));
const forged = await code(() => svc.waive({ kind: 'human', id: 'ed', role: 'admin' }, B, { completion_id: r2b.completion_id, code: 'x', reason: 'pretending to be the owner' }));
check('identity: an actor without the owner role cannot waive even with the owner id', forged === 'OWNER_ONLY');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
