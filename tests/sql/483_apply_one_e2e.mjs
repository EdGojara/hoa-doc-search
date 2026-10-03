// tests/sql/483_apply_one_e2e.mjs — migration 483 (conversion snapshot
// persistence, Issue #15 Milestone 3) applied END TO END through the
// single-migration tool with its REAL checks file, on top of 452/481/482.
// Proves:
//   - a snapshot result can only be recorded WITH its lines (a bare
//     snapshot-stage completion is refused), only while the batch is in
//     snapshot, and every line's batch code / cutoff must equal the batch;
//   - lines are append-only, need provenance, and an unsupported_detail line can
//     never name a homeowner;
//   - re-running the snapshot binds new lines to a new completion; the earlier
//     snapshot is reported stale and a waiver against it is refused (481);
//   - the batch view carries each stage result's summary;
//   - no accounting table is touched (journal_entries protected); legacy batch
//     untouched; functions executable by service_role only; drift blocks it.
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
catch (_) { console.log('SKIP  483 end-to-end apply rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const F = '483_onboarding_snapshot.sql';
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm483-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`));
const PRINT = process.argv.includes('--print-objects');
const OWNER = { id: 'owner-uuid', email: 'owner@example.test' };
const ctx = (client) => ({ client, user: OWNER, deployedCommit: 'deadbeefcafe', migrationsDir: dir, secret: 'e2e' });

const { db, client, rpc } = await onboardingWorld(PGlite, { through: 482 });
await db.exec(`INSERT INTO conversion_batches (id, community_id, batch_code, as_of_date, status) VALUES ('00000000-0000-0000-0000-0000000000b1', '${COMM}', 'CONV-LEGACY', '2026-07-31', 'posted');
  INSERT INTO journal_entries (id) VALUES ('00000000-0000-0000-0000-00000000aaaa');`);
const plan = await A.planMigration({ ...ctx(client), filename: F });
if (PRINT) { const rr = await A.applyMigration({ ...ctx(client), planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) }); console.log(JSON.stringify((rr.detail || {}).objects || rr, null, 2)); process.exit(0); }
check('plan: ready, every preflight passes', plan.status === 'ready' && plan.preflight.every((p) => p.ok), JSON.stringify({ status: plan.status, error: plan.error }).slice(0, 600));
const r = await A.applyMigration({ ...ctx(client), planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) });
check('apply: 483 applied and verified through the tool', r.status === 'applied', JSON.stringify({ status: r.status, error: r.error }));

const err = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };
const H = (c) => c.repeat(64);
const ctl = (code, status) => ({ code, label: code, status });
const complete = (b, stage, controls) => { const st = controls.some((c) => c.status === 'FAIL') ? 'FAIL' : controls.some((c) => c.status === 'BLOCKED') ? 'BLOCKED' : 'PASS'; return rpc('onboarding_record_completion', { p_batch: b, p_stage: stage, p_status: st, p_open: controls.filter((c) => c.status !== 'PASS').map((c) => c.code), p_controls: controls, p_summary: { roles: { ar_account: '1300' } }, p_actor_kind: 'agent', p_actor_id: 'c' }); };
const advance = (b, cid, to) => rpc('onboarding_advance', { p_batch: b, p_completion: cid, p_to: to, p_actor_kind: 'human', p_actor_id: 'ed' });
const line = (n, extra = {}) => ({ line_no: n, kind: 'gl_opening_balance', component: 'gl', account_code: '1000', amount_cents: 100, provenance: [{ artifact_sha256: H('a'), locator: { line: n } }], batch_code: 'CONV-SNAP', cutoff_date: '2026-07-31', ...extra });
const snap = (b, lines, controls = [ctl('snapshot.gl', 'PASS'), ctl('snapshot.ap_detail_supports_gl', 'BLOCKED')], sha = H('e')) => {
  const st = controls.some((c) => c.status === 'FAIL') ? 'FAIL' : controls.some((c) => c.status === 'BLOCKED') ? 'BLOCKED' : 'PASS';
  return rpc('onboarding_record_snapshot', { p_batch: b, p_status: st, p_open: controls.filter((c) => c.status !== 'PASS').map((c) => c.code), p_controls: controls, p_summary: { components: [{ component: 'gl', status: 'PASS' }] }, p_lines: lines, p_snapshot_sha256: sha, p_actor_kind: 'agent', p_actor_id: 'c' });
};

if (r.status === 'applied') {
  const B = await rpc('onboarding_create_batch', { p_community: COMM, p_batch_code: 'CONV-SNAP', p_as_of: '2026-07-31', p_source_system: 'vantaca', p_actor_kind: 'human', p_actor_id: 'ed' });
  check('a snapshot cannot be recorded before the batch is in snapshot', /only be recorded while the batch is in snapshot/.test(await err(() => snap(B, [line(1)])) || ''));
  for (const [s, to] of [['intake', 'normalize'], ['normalize', 'source_controls'], ['source_controls', 'snapshot']]) { const c = await complete(B, s, [ctl('ok', 'PASS')]); await advance(B, c, to); }
  let v = await rpc('onboarding_batch_view', { p_batch: B });
  check('batch view: latest results now carry their summary (snapshot reads the validated roles)', v.latest_by_stage.source_controls.summary.roles.ar_account === '1300');
  check('a bare snapshot-stage completion (without lines) is refused', /must be recorded with its lines/.test(await err(() => complete(B, 'snapshot', [ctl('x', 'PASS')])) || ''));
  check('line identity must equal the batch code and cutoff', /does not match the batch/.test(await err(() => snap(B, [line(1, { batch_code: 'OTHER' })])) || '') && /does not match the batch/.test(await err(() => snap(B, [line(1, { cutoff_date: '2026-06-30' })])) || ''));
  check('every line needs provenance', /violates check|provenance/.test(await err(() => snap(B, [line(1, { provenance: [] })])) || ''));
  check('an unsupported_detail line can never name a homeowner', /unsupported_never_assigned/.test(await err(() => snap(B, [line(1, { kind: 'unsupported_detail', component: 'prepaid_detail', account_code: '2400', amount_cents: -73753, source_account_key: '90000001' })])) || ''));
  check('nothing was left behind by the refused attempts (all-or-nothing)', (await db.query(`SELECT (SELECT count(*) FROM onboarding_snapshot_lines) + (SELECT count(*) FROM onboarding_stage_events WHERE stage = 'snapshot')::int AS n`)).rows[0].n == 0);
  const s1 = await snap(B, [line(1), line(2, { kind: 'unsupported_detail', component: 'prepaid_detail', account_code: '2400', amount_cents: -73753 })], undefined, H('1'));
  let sv = await rpc('onboarding_snapshot_view', { p_batch: B });
  check('recorded: completion + 2 lines bound to it with sha; components from the summary; not stale', sv.completion_id === s1 && sv.lines.length === 2 && sv.snapshot_sha256 === H('1') && sv.stale === false && sv.components[0].component === 'gl' && sv.status === 'BLOCKED');
  check('lines are append-only (no update, no delete)', /append-only/.test(await err(() => db.query(`UPDATE onboarding_snapshot_lines SET amount_cents = 0`)) || '') && /append-only/.test(await err(() => db.query(`DELETE FROM onboarding_snapshot_lines`)) || ''));
  // re-run: new completion, new lines; the old snapshot is stale and cannot be waived against
  const s2 = await snap(B, [line(1, { amount_cents: 200 })], undefined, H('2'));
  sv = await rpc('onboarding_snapshot_view', { p_batch: B });
  const old = await rpc('onboarding_snapshot_view', { p_batch: B, p_completion: s1 });
  check('re-run: the latest view is the new snapshot; the earlier one is still readable and flagged stale', sv.completion_id === s2 && sv.snapshot_sha256 === H('2') && sv.lines.length === 1 && old.stale === true && old.lines.length === 2);
  check('replay: waiving the stale snapshot result is refused; waiving the current one is accepted', /completion is stale/.test(await err(() => rpc('onboarding_waive', { p_batch: B, p_completion: s1, p_code: 'snapshot.ap_detail_supports_gl', p_reason: 'AP aging to follow; reviewed', p_actor_kind: 'human', p_actor_id: 'ed' })) || '')
    && (await err(() => rpc('onboarding_waive', { p_batch: B, p_completion: s2, p_code: 'snapshot.ap_detail_supports_gl', p_reason: 'AP aging to follow; reviewed', p_actor_kind: 'human', p_actor_id: 'ed' }))) === null);
  check('the snapshot stage advances only by a human on the current, fully-waived result', (await err(() => advance(B, s1, 'activity_bridge'))) !== null && (await err(() => advance(B, s2, 'activity_bridge'))) === null);
  check('no accounting table touched: journal_entries unchanged; legacy batch unchanged', (await db.query(`SELECT count(*)::int AS n FROM journal_entries`)).rows[0].n === 1 && (await db.query(`SELECT onboarding_stage FROM conversion_batches WHERE batch_code = 'CONV-LEGACY'`)).rows[0].onboarding_stage === null);
  const priv = (await db.query(`SELECT has_function_privilege('anon', 'onboarding_record_snapshot(uuid,text,jsonb,jsonb,jsonb,jsonb,text,text,text)', 'EXECUTE') AS a, has_function_privilege('service_role', 'onboarding_snapshot_view(uuid,uuid)', 'EXECUTE') AS s, has_function_privilege('service_role', 'onboarding_record_completion(uuid,text,text,jsonb,jsonb,jsonb,text,text)', 'EXECUTE') AS rc`)).rows[0];
  check('grants: snapshot functions service_role only; the replaced record_completion keeps its service_role grant', priv.a === false && priv.s === true && priv.rc === true);
}
{
  const w = await onboardingWorld(PGlite, { through: 482 });
  await w.db.exec(`CREATE TABLE onboarding_snapshot_lines (id uuid PRIMARY KEY)`);
  const p = await A.planMigration({ ...ctx(w.client), filename: F });
  check('drift: a pre-existing onboarding_snapshot_lines blocks the plan', p.status !== 'ready');
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
