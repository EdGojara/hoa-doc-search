// tests/sql/484_apply_one_e2e.mjs — migration 484 (activity bridge persistence,
// Issue #15 Milestone 4) applied END TO END through the single-migration tool
// with its REAL checks file, on top of 452-483. Proves:
//   - a bridge result is recorded only WITH its items (bare completion refused),
//     only in stage activity_bridge, only on the CURRENT snapshot result, and
//     item identity must equal the batch;
//   - the DATABASE refuses a Trusted record classified twice in one run, and an
//     ALREADY_IN_SOURCE item on an amount-only method;
//   - items / records are append-only; refused attempts leave nothing;
//   - re-run -> earlier bridge stale; a waiver against it refused;
//   - view totals (events / records / dollars) by classification;
//   - no accounting table touched; service_role only; drift blocks it.
// Postgres 17 (PGlite 0.3.x). Skips without PGlite.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { onboardingWorld, COMM } from './onboarding_world.mjs';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  484 end-to-end apply rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const F = '484_onboarding_activity_bridge.sql';
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm484-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`));
const PRINT = process.argv.includes('--print-objects');
const OWNER = { id: 'owner-uuid', email: 'owner@example.test' };
const ctx = (client) => ({ client, user: OWNER, deployedCommit: 'deadbeefcafe', migrationsDir: dir, secret: 'e2e' });

const { db, client, rpc } = await onboardingWorld(PGlite, { through: 483 });
await db.exec(`INSERT INTO journal_entries (id) VALUES ('00000000-0000-0000-0000-00000000aaaa');`);
const plan = await A.planMigration({ ...ctx(client), filename: F });
if (PRINT) { const rr = await A.applyMigration({ ...ctx(client), planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) }); console.log(JSON.stringify((rr.detail || {}).objects || rr, null, 2)); process.exit(0); }
check('plan: ready, every preflight passes', plan.status === 'ready' && plan.preflight.every((p) => p.ok), JSON.stringify({ status: plan.status, error: plan.error }).slice(0, 600));
const r = await A.applyMigration({ ...ctx(client), planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) });
check('apply: 484 applied and verified through the tool', r.status === 'applied', JSON.stringify({ status: r.status, error: r.error }));

const err = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };
const H = (c) => c.repeat(64);
const ctl = (code, status) => ({ code, label: code, status });
const stOf = (cs) => (cs.some((c) => c.status === 'FAIL') ? 'FAIL' : cs.some((c) => c.status === 'BLOCKED') ? 'BLOCKED' : 'PASS');
const complete = (b, stage, cs) => rpc('onboarding_record_completion', { p_batch: b, p_stage: stage, p_status: stOf(cs), p_open: cs.filter((c) => c.status !== 'PASS').map((c) => c.code), p_controls: cs, p_summary: { roles: { ar_account: '1300' } }, p_actor_kind: 'agent', p_actor_id: 'c' });
const advance = (b, cid, to) => rpc('onboarding_advance', { p_batch: b, p_completion: cid, p_to: to, p_actor_kind: 'human', p_actor_id: 'ed' });
const snapLine = { line_no: 1, kind: 'gl_opening_balance', component: 'gl', account_code: '1000', amount_cents: 100, provenance: [{ artifact_sha256: H('a'), locator: { line: 1 } }], batch_code: 'CONV-BR', cutoff_date: '2026-07-31' };
const item = (n, extra = {}) => ({ item_no: n, event_key: `je:${n}`, kind: 'ap_invoice', classification: 'LEGITIMATE_SUBSEQUENT', method: 'after_cutoff_no_source_evidence', confidence: 'high', event_date: '2026-08-25', amount_cents: 55000, evidence: { cutoff: '2026-07-31' }, structural_issues: [], records: [`journal_entries:${n}`, `ap_invoices:${n}`], batch_code: 'CONV-BR', cutoff_date: '2026-07-31', ...extra });
const bridge = (b, items, snapId, cs = [ctl('bridge.ok', 'PASS'), ctl('bridge.ambiguous_items_reviewed', 'BLOCKED')], sha = H('b')) =>
  rpc('onboarding_record_bridge', { p_batch: b, p_status: stOf(cs), p_open: cs.filter((c) => c.status !== 'PASS').map((c) => c.code), p_controls: cs, p_summary: { snapshot_completion_id: snapId, totals: {} }, p_items: items, p_bridge_sha256: sha, p_trusted_fingerprint: H('f'), p_actor_kind: 'agent', p_actor_id: 'c' });

if (r.status === 'applied') {
  const B = await rpc('onboarding_create_batch', { p_community: COMM, p_batch_code: 'CONV-BR', p_as_of: '2026-07-31', p_source_system: 'vantaca', p_actor_kind: 'human', p_actor_id: 'ed' });
  for (const [s, to] of [['intake', 'normalize'], ['normalize', 'source_controls'], ['source_controls', 'snapshot']]) { const c = await complete(B, s, [ctl('ok', 'PASS')]); await advance(B, c, to); }
  const snap = await rpc('onboarding_record_snapshot', { p_batch: B, p_status: 'PASS', p_open: [], p_controls: [ctl('snapshot.ok', 'PASS')], p_summary: { roles: { ar_account: '1300' } }, p_lines: [snapLine], p_snapshot_sha256: H('5'), p_actor_kind: 'agent', p_actor_id: 'c' });
  check('a bridge cannot be recorded before the batch is in activity_bridge', /only be recorded while the batch is in activity_bridge/.test(await err(() => bridge(B, [item(1)], snap)) || ''));
  await advance(B, snap, 'activity_bridge');
  check('a bare activity-bridge completion (without items) is refused', /must be recorded with its items/.test(await err(() => complete(B, 'activity_bridge', [ctl('x', 'PASS')])) || ''));
  check('the bridge must name the CURRENT snapshot result', /built on the current snapshot result/.test(await err(() => bridge(B, [item(1)], '00000000-0000-0000-0000-000000000000')) || ''));
  check('item identity must equal the batch', /identity does not match the batch/.test(await err(() => bridge(B, [item(1, { batch_code: 'OTHER' })], snap)) || ''));
  check('the DATABASE refuses a record classified twice in one run', /duplicate key/.test(await err(() => bridge(B, [item(1), item(2, { records: ['journal_entries:2', 'ap_invoices:1'] })], snap)) || ''));
  check('the DATABASE refuses ALREADY_IN_SOURCE on an amount-only method', /never_duplicate_on_amount/.test(await err(() => bridge(B, [item(1, { classification: 'ALREADY_IN_SOURCE', method: 'amount_match_without_identifier' })], snap)) || ''));
  check('refused attempts left nothing behind (all-or-nothing)', (await db.query(`SELECT (SELECT count(*) FROM onboarding_bridge_items) + (SELECT count(*) FROM onboarding_bridge_records) + (SELECT count(*) FROM onboarding_stage_events WHERE stage = 'activity_bridge')::int AS n`)).rows[0].n == 0);
  const b1 = await bridge(B, [item(1), item(2, { classification: 'AMBIGUOUS', method: 'amount_match_without_identifier', confidence: 'low', amount_cents: 42244, records: ['journal_entries:2'] }),
    item(3, { classification: 'ALREADY_IN_SOURCE', method: 'invoice_number_and_amount_in_source', amount_cents: 15000, records: ['journal_entries:3', 'ap_invoices:3'] })], snap, undefined, H('1'));
  let v = await rpc('onboarding_bridge_view', { p_batch: B });
  check('recorded: items + records bound to the completion; totals by classification (events / records / dollars); not stale',
    v.completion_id === b1 && v.items.length === 3 && v.stale === false && v.totals.LEGITIMATE_SUBSEQUENT.events === 1 && Number(v.totals.LEGITIMATE_SUBSEQUENT.records) === 2 && Number(v.totals.AMBIGUOUS.amount_cents) === 42244 && v.snapshot_completion_id === snap && v.trusted_fingerprint === H('f'));
  check('items and records are append-only', /append-only/.test(await err(() => db.query(`UPDATE onboarding_bridge_items SET classification = 'OUT_OF_SCOPE'`)) || '') && /append-only/.test(await err(() => db.query(`DELETE FROM onboarding_bridge_records`)) || ''));
  const b2 = await bridge(B, [item(1)], snap, undefined, H('2'));
  const old = await rpc('onboarding_bridge_view', { p_batch: B, p_completion: b1 }); v = await rpc('onboarding_bridge_view', { p_batch: B });
  check('re-run: the latest view is the new bridge; the earlier one is still readable and flagged stale', v.completion_id === b2 && old.stale === true && old.items.length === 3 && v.items.length === 1);
  check('replay: waiving the stale bridge result is refused; the current one can be waived', /completion is stale/.test(await err(() => rpc('onboarding_waive', { p_batch: B, p_completion: b1, p_code: 'bridge.ambiguous_items_reviewed', p_reason: 'reviewed the ambiguous items', p_actor_kind: 'human', p_actor_id: 'ed' })) || '')
    && (await err(() => rpc('onboarding_waive', { p_batch: B, p_completion: b2, p_code: 'bridge.ambiguous_items_reviewed', p_reason: 'reviewed the ambiguous items', p_actor_kind: 'human', p_actor_id: 'ed' }))) === null);
  check('EXECUTE stays unreachable after the bridge', /EXECUTE is not available yet/.test(await err(() => advance(B, b2, 'execute')) || '') || /may only advance to preflight/.test(await err(() => advance(B, b2, 'execute')) || ''));
  check('no accounting table touched', (await db.query(`SELECT count(*)::int AS n FROM journal_entries`)).rows[0].n === 1);
  const priv = (await db.query(`SELECT has_function_privilege('anon', 'onboarding_record_bridge(uuid,text,jsonb,jsonb,jsonb,jsonb,text,text,text,text)', 'EXECUTE') AS a, has_function_privilege('service_role', 'onboarding_bridge_view(uuid,uuid)', 'EXECUTE') AS s, has_function_privilege('service_role', 'onboarding_record_snapshot(uuid,text,jsonb,jsonb,jsonb,jsonb,text,text,text)', 'EXECUTE') AS rs`)).rows[0];
  check('grants: bridge functions service_role only; snapshot path still works after the record_completion replacement', priv.a === false && priv.s === true && priv.rs === true);
}
{
  const w = await onboardingWorld(PGlite, { through: 483 });
  await w.db.exec(`CREATE TABLE onboarding_bridge_items (id uuid PRIMARY KEY)`);
  const p = await A.planMigration({ ...ctx(w.client), filename: F });
  check('drift: a pre-existing onboarding_bridge_items blocks the plan', p.status !== 'ready');
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
