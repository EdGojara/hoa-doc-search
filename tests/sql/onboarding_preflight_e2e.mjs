// tests/sql/onboarding_preflight_e2e.mjs — Issue #15 M5: conversion preflight on the REAL
// 452-486 SQL. A batch is walked to `preflight` with PASS results; a v2 preflight report
// (pure plan builder + canonical hash) is recorded append-only as the preflight result.
// Proves: approval binds to EXACTLY the recorded report (+ current waivers); a tampered
// report, a different (validly hashed) report and a stale one are refused; a newer
// preflight result makes the earlier one unapprovable (database); the read endpoint's
// service view renders the report; nothing posts and the batch stays write-locked.
// Postgres 17 (PGlite 0.3.x). Skips without PGlite.
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { onboardingWorld, COMM } from './onboarding_world.mjs';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  onboarding preflight e2e (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const { createOnboardingService } = require(`${REPO}/lib/onboarding/service.js`);
const { buildConversionPlan } = require(`${REPO}/lib/onboarding/conversion_plan.js`);
const { trustedFingerprint } = require(`${REPO}/lib/onboarding/bridge.js`);
const PF = require(`${REPO}/lib/onboarding/preflight.js`);
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const code = async (fn) => { try { await fn(); return null; } catch (e) { return `${e.code || ''} ${e.message || ''}`; } };

const world = await onboardingWorld(PGlite, { through: 486 });
const { rpc, db } = world;
const trusted = { journal_entries: [], journal_entry_lines: [], ap_invoices: [], ap_payments: [], ar_charges: [], ar_payments: [], payments: [], homeowner_transactions: [] };
let liveTrusted = trusted;
const trustedReader = async () => ({ trusted: liveTrusted, accountNumber: () => null, accountOfProperty: () => null });
const storage = { async putOnce() {}, async get() { return Buffer.alloc(0); } };
const svc = createOnboardingService({ rpc, storage, trustedReader });
const ED = { kind: 'human', id: 'ed', role: 'owner' };
const FP = trustedFingerprint(trusted);

// walk a batch to preflight with PASS results (system operator path)
const B = await rpc('onboarding_create_batch', { p_community: COMM, p_batch_code: 'CONV-EX-PF', p_as_of: '2026-03-31', p_source_system: 'vantaca', p_actor_kind: 'human', p_actor_id: 'ed' });
const ctl = [{ code: 'ok', label: 'ok', status: 'PASS' }];
for (const s of ['intake', 'normalize', 'source_controls']) { const c = await rpc('onboarding_record_completion', { p_batch: B, p_stage: s, p_status: 'PASS', p_open: [], p_controls: ctl, p_summary: {}, p_actor_kind: 'system', p_actor_id: 'op' }); await rpc('onboarding_auto_advance', { p_batch: B, p_completion: c, p_actor_id: 'op' }); }
const sn = await rpc('onboarding_record_snapshot', { p_batch: B, p_status: 'PASS', p_open: [], p_controls: ctl, p_summary: { roles: { ar_account: '1300' } }, p_lines: [], p_snapshot_sha256: 'a'.repeat(64), p_actor_kind: 'system', p_actor_id: 'op' });
await rpc('onboarding_auto_advance', { p_batch: B, p_completion: sn, p_actor_id: 'op' });
const br = await rpc('onboarding_record_bridge', { p_batch: B, p_status: 'PASS', p_open: [], p_controls: ctl, p_summary: { snapshot_completion_id: sn, bridge_engine: 'test' }, p_items: [], p_bridge_sha256: 'b'.repeat(64), p_trusted_fingerprint: FP, p_actor_kind: 'system', p_actor_id: 'op' });
await rpc('onboarding_auto_advance', { p_batch: B, p_completion: br, p_actor_id: 'op' });

const makeReport = (decisions = []) => {
  const plan = buildConversionPlan({ batch: { id: B, batch_code: 'CONV-EX-PF', community_id: COMM, as_of_date: '2026-03-31' }, snapshot: { completion_id: sn, sha256: 'a'.repeat(64), roles: {}, lines: [] },
    bridge: { completion_id: br, sha256: 'b'.repeat(64), trusted_fingerprint: FP, status: 'PASS', items: [] }, trusted, ctx: { accounts: [], funds: [], properties: [], tenures: [], vendors: [], gl_cutover_date: null, current_trusted_fingerprint: FP } });
  const { controls, ...body } = plan;
  return PF.buildConversionPreflight({ batch: { batch_code: 'CONV-EX-PF', community_id: COMM, source_system: 'vantaca', stage: 'preflight' }, source_cutoff: { cutoff_date: '2026-03-31', cutover_date: plan.cutover },
    inputs: { snapshot: { completion_id: sn, sha256: 'a'.repeat(64), status: 'PASS' }, bridge: { completion_id: br, sha256: 'b'.repeat(64), trusted_fingerprint: FP, status: 'PASS', engine: 'test' }, decisions, bridge_waivers: [], artifacts: [] },
    plan: body, controls });
};
const recordPf = async (report) => rpc('onboarding_record_completion', { p_batch: B, p_stage: 'preflight', p_status: report.status.overall, p_open: [], p_controls: report.controls.map((c) => ({ code: c.code, label: c.label, status: c.status })),
  p_summary: { preflight_format: report.format, preflight_sha256: report.sha256, preflight_report: report }, p_actor_kind: 'system', p_actor_id: 'onboarding-operator' });

const report = makeReport();
check('the empty synthetic plan passes every preflight control (the report is eligible)', report.status.overall === 'PASS', JSON.stringify(report.controls.filter((c) => c.status !== 'PASS')));
const pf1 = await recordPf(report);
let v = await svc.getBatch(B, ED);
check('the preflight result is recorded append-only through the guarded path (stage_completed preflight, the report + its sha in the result)', v.batch.stage === 'preflight' && v.current.completion_id === pf1 && v.current.summary.preflight_sha256 === report.sha256);
const view = await svc.getPreflight(B);
check('service view (GET /batches/:id/preflight): the report re-derives to the recorded hash, renders, and is fresh', view && view.report.sha256 === report.sha256 && view.recorded_sha256 === report.sha256 && /Conversion preflight: CONV-EX-PF/.test(view.markdown) && view.stale === null, JSON.stringify(view && { s: view.stale }));

const tampered = JSON.parse(JSON.stringify(report)); tampered.plan.cutover = '2026-04-02';
check('approval refuses a TAMPERED report (hash no longer verifies)', /PREFLIGHT_REPORT_ALTERED/.test((await code(() => svc.approve(ED, B, { completion_id: pf1, preflight: tampered }))) || ''));
const other = makeReport([{ id: 'dec-x', event_key: 'je:x', choice_key: 'record_after_cutoff', actor_id: 'ed' }]);
check('approval refuses a DIFFERENT report even though its hash is valid (it is not the recorded preflight)', PF.verifyPreflight(other) && /PREFLIGHT_NOT_THE_RECORDED_REPORT/.test((await code(() => svc.approve(ED, B, { completion_id: pf1, preflight: other }))) || ''));
check('only the owner may approve', /OWNER_ONLY/.test((await code(() => svc.approve({ kind: 'human', id: 'staff', role: 'admin' }, B, { completion_id: pf1, preflight: report }))) || ''));

liveTrusted = { ...trusted, journal_entries: [{ id: 'late', posting_date: '2026-04-05', status: 'posted', total_debits_cents: 1, total_credits_cents: 1 }] };
check('approval refuses a STALE preflight: Trusted activity changed after it was built', /PREFLIGHT_STALE/.test((await code(() => svc.approve(ED, B, { completion_id: pf1, preflight: report }))) || ''));
check('the read view says why it is stale', /Trusted financial activity changed/.test((await svc.getPreflight(B)).stale || ''));
liveTrusted = trusted;

const before = (await db.query(`SELECT count(*)::int AS n FROM journal_entries`)).rows[0].n;
const ok = await code(() => svc.approve(ED, B, { completion_id: pf1, preflight: report }));
v = await svc.getBatch(B, ED);
check('the EXACT recorded report (no waivers) is approvable by the owner; the approved hash is the report hash', ok === null && v.batch.approved_preflight_sha256 === report.sha256, ok);
check('approval is not execution: still in preflight, still write-locked, no accounting row written', v.batch.stage === 'preflight' && v.batch.write_locked === true && (await db.query(`SELECT count(*)::int AS n FROM journal_entries`)).rows[0].n === before && before === 0);
check('EXECUTE stays unavailable in this milestone (the advance is refused)', /EXECUTE is not available|execute needs/.test((await code(() => svc.advance(ED, B, { completion_id: pf1, to: 'execute' }))) || ''));

// repeated preflight: a newer result supersedes the old one; the old one can no longer be approved
const pf2 = await recordPf(report);
check('a repeated preflight is a NEW append-only result; the earlier result stays in history', pf2 !== pf1 && (await db.query(`SELECT count(*)::int AS n FROM onboarding_stage_events WHERE batch_id = $1 AND stage = 'preflight' AND event_type = 'stage_completed'`, [B])).rows[0].n === 2);
check('the service refuses to approve against a superseded preflight result', /NOT_THE_CURRENT_PREFLIGHT_RESULT/.test((await code(() => svc.approve(ED, B, { completion_id: pf1, preflight: report }))) || ''));
check('the DATABASE refuses an approval bound to a superseded preflight result', /stale|newer result/.test((await code(() => rpc('onboarding_approve', { p_batch: B, p_completion: pf1, p_preflight_sha256: report.sha256, p_actor_kind: 'human', p_actor_id: 'ed' }))) || ''));
check('an operator (system) can never approve (database human gate)', /human/.test((await code(() => rpc('onboarding_approve', { p_batch: B, p_completion: pf2, p_preflight_sha256: report.sha256, p_actor_kind: 'system', p_actor_id: 'onboarding-operator' }))) || ''));
check('still nothing posted anywhere', (await db.query(`SELECT count(*)::int AS n FROM journal_entries`)).rows[0].n === 0);

// ---- Approval BY HASH (the owner sends only completion id + sha256; the server rebuilds what it recorded).
// A large, real-shape preflight (1,500 homeowner-ledger rows) whose full report would not fit a request body.
async function walk(code6) {
  const id = await rpc('onboarding_create_batch', { p_community: COMM, p_batch_code: code6, p_as_of: '2026-03-31', p_source_system: 'vantaca', p_actor_kind: 'human', p_actor_id: 'ed' });
  for (const s of ['intake', 'normalize', 'source_controls']) { const c = await rpc('onboarding_record_completion', { p_batch: id, p_stage: s, p_status: 'PASS', p_open: [], p_controls: ctl, p_summary: {}, p_actor_kind: 'system', p_actor_id: 'op' }); await rpc('onboarding_auto_advance', { p_batch: id, p_completion: c, p_actor_id: 'op' }); }
  const s1 = await rpc('onboarding_record_snapshot', { p_batch: id, p_status: 'PASS', p_open: [], p_controls: ctl, p_summary: {}, p_lines: [], p_snapshot_sha256: 'a'.repeat(64), p_actor_kind: 'system', p_actor_id: 'op' });
  await rpc('onboarding_auto_advance', { p_batch: id, p_completion: s1, p_actor_id: 'op' });
  const b1 = await rpc('onboarding_record_bridge', { p_batch: id, p_status: 'PASS', p_open: [], p_controls: ctl, p_summary: { snapshot_completion_id: s1, bridge_engine: 'test' }, p_items: [], p_bridge_sha256: 'b'.repeat(64), p_trusted_fingerprint: FP, p_actor_kind: 'system', p_actor_id: 'op' });
  await rpc('onboarding_auto_advance', { p_batch: id, p_completion: b1, p_actor_id: 'op' });
  return { id, s1, b1, code6 };
}
function bigReport(w, { n = 1500, breakTb = false } = {}) {
  const props = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, vantaca_account_id: String(500000 + i), street_address: `${i} Example Lane` }));
  const lines = [{ line_no: 1, kind: 'gl_opening_balance', account_code: '1300', amount_cents: n * 100 }, { line_no: 2, kind: 'gl_opening_balance', account_code: '3000', amount_cents: -(n * 100) + (breakTb ? 1 : 0) },
    ...props.map((p, i) => ({ line_no: 3 + i, kind: 'ar_aging_item', account_code: '1300', source_account_key: p.vantaca_account_id, amount_cents: 100, detail: { charge_type: 'Annual Assessment' } }))];
  const plan = buildConversionPlan({ batch: { id: w.id, batch_code: w.code6, community_id: COMM, as_of_date: '2026-03-31' }, snapshot: { completion_id: w.s1, sha256: 'a'.repeat(64), roles: { ar_account: '1300' }, lines },
    bridge: { completion_id: w.b1, sha256: 'b'.repeat(64), trusted_fingerprint: FP, status: 'PASS', items: [] }, trusted,
    ctx: { accounts: [{ id: 'a1300', account_number: '1300', fund_id: 'f' }, { id: 'a3000', account_number: '3000', fund_id: 'f' }], funds: [{ id: 'f', code: 'OPR' }], properties: props,
      tenures: props.map((p) => ({ id: `t-${p.id}`, property_id: p.id, kind: 'owner', end_date: null })), vendors: [], periods: [{ id: 'per-mar', period_start: '2026-03-01', period_end: '2026-03-31', status: 'open' }],
      management_company_id: 'mc1', gl_cutover_date: null, current_trusted_fingerprint: FP } });
  const { controls, ...body } = plan;
  return PF.buildConversionPreflight({ batch: { batch_code: w.code6, community_id: COMM, source_system: 'vantaca', stage: 'preflight' }, source_cutoff: { cutoff_date: '2026-03-31', cutover_date: plan.cutover },
    inputs: { snapshot: { completion_id: w.s1, sha256: 'a'.repeat(64), status: 'PASS' }, bridge: { completion_id: w.b1, sha256: 'b'.repeat(64), trusted_fingerprint: FP, status: 'PASS', engine: 'test' }, decisions: [], bridge_waivers: [], artifacts: [] }, plan: body, controls });
}
const recordOn = (w, report) => rpc('onboarding_record_completion', { p_batch: w.id, p_stage: 'preflight', p_status: report.status.overall, p_open: report.controls.filter((c) => c.status !== 'PASS').map((c) => c.code), p_controls: report.controls.map((c) => ({ code: c.code, label: c.label, status: c.status })),
  p_summary: { preflight_format: report.format, preflight_sha256: report.sha256, preflight_report: report }, p_actor_kind: 'system', p_actor_id: 'onboarding-operator' });

const WL = await walk('CONV-EX-BIG');
const big = bigReport(WL);
check('the large real-shape preflight passes its controls and is far bigger than a request body allows (>100 KB; the 413 that broke the click)', big.status.overall === 'PASS' && JSON.stringify(big).length > 100000, `${big.status.overall} ${JSON.stringify(big).length} ${JSON.stringify(big.controls.filter((c) => c.status !== 'PASS'))}`);
const pfBig = await recordOn(WL, big);
check('approve-by-hash refuses a WRONG hash (one digit off)', /PREFLIGHT_HASH_MISMATCH/.test((await code(() => svc.approveByHash(ED, WL.id, { completion_id: pfBig, preflight_sha256: big.sha256.replace(/.$/, (c) => (c === '0' ? '1' : '0')) }))) || ''));
check('approve-by-hash refuses a malformed request (no hash)', /COMPLETION_AND_HASH_REQUIRED/.test((await code(() => svc.approveByHash(ED, WL.id, { completion_id: pfBig }))) || ''));
check('approve-by-hash refuses a non-owner', /OWNER_ONLY/.test((await code(() => svc.approveByHash({ kind: 'human', id: 'staff', role: 'admin' }, WL.id, { completion_id: pfBig, preflight_sha256: big.sha256 }))) || ''));
liveTrusted = { ...trusted, journal_entries: [{ id: 'late2', posting_date: '2026-04-06', status: 'posted', total_debits_cents: 1, total_credits_cents: 1 }] };
check('approve-by-hash refuses a STALE preflight (Trusted activity changed)', /PREFLIGHT_STALE/.test((await code(() => svc.approveByHash(ED, WL.id, { completion_id: pfBig, preflight_sha256: big.sha256 }))) || ''));
liveTrusted = trusted;
const okBig = await code(() => svc.approveByHash(ED, WL.id, { completion_id: pfBig, preflight_sha256: big.sha256 }));
const vb = await svc.getBatch(WL.id, ED);
check('approve-by-hash APPROVES the large preflight with only id + hash; the approved hash is that report; still preflight, write-locked, nothing posted', okBig === null && vb.batch.approved_preflight_sha256 === big.sha256 && vb.batch.stage === 'preflight' && vb.batch.write_locked === true && (await db.query(`SELECT count(*)::int AS n FROM journal_entries`)).rows[0].n === 0, okBig);

const WS = await walk('CONV-EX-SUPERSEDED');
const r1 = bigReport(WS, { n: 3 }); const c1 = await recordOn(WS, r1); await recordOn(WS, r1);
check('approve-by-hash refuses a SUPERSEDED preflight result (a newer one was recorded)', /NOT_THE_CURRENT_PREFLIGHT_RESULT/.test((await code(() => svc.approveByHash(ED, WS.id, { completion_id: c1, preflight_sha256: r1.sha256 }))) || ''));

const WF = await walk('CONV-EX-FAILING');
const bad = bigReport(WF, { n: 3, breakTb: true });
check('setup: a preflight whose controls do not all pass (opening entry would not balance)', bad.status.overall !== 'PASS');
const cf = await recordOn(WF, bad);
check('approve-by-hash refuses NON-PASSING controls (no waiver), exactly as before', /CONTROLS_NOT_PASSING/.test((await code(() => svc.approveByHash(ED, WF.id, { completion_id: cf, preflight_sha256: bad.sha256 }))) || ''));
check('a tampered recorded report cannot be approved by hash (the hash never matches an altered body)', /PREFLIGHT_HASH_MISMATCH|PREFLIGHT_REPORT_ALTERED/.test((await code(() => svc.approveByHash(ED, WF.id, { completion_id: cf, preflight_sha256: big.sha256 }))) || ''));
check('still nothing posted anywhere (after every approval path)', (await db.query(`SELECT count(*)::int AS n FROM journal_entries`)).rows[0].n === 0);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
