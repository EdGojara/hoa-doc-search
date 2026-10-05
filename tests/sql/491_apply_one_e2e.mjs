// tests/sql/491_apply_one_e2e.mjs — migration 491 (onboarding Batches read model,
// Issue #15) applied END TO END through the single-migration tool with its REAL
// checks file, on top of the real 452 + 481-486. Proves the apply is a function
// replacement only (objects exactly as declared, no row changes), the list keeps
// reading a non-complete batch exactly as before (its current stage's result,
// plus result_stage), active batches sort above completed ones, grants stay
// service_role only, and a second apply is refused by the preflight.
// The completed-batch case (stage complete -> latest post-proof result) needs a
// real execution, so it is proved in tests/sql/onboarding_execute_e2e.mjs.
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
catch (_) { console.log('SKIP  491 end-to-end apply rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const F = '491_onboarding_batches_complete_result.sql';
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm491-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`));
const PRINT = process.argv.includes('--print-objects');
const OWNER = { id: 'owner-uuid', email: 'owner@example.test' };
const ctx = (client) => ({ client, user: OWNER, deployedCommit: 'deadbeefcafe', migrationsDir: dir, secret: 'e2e' });
const ctl = (code, status) => ({ code, label: code, status, left_cents: 100, right_cents: status === 'PASS' ? 100 : 90, difference_cents: status === 'PASS' ? 0 : 10 });

const { db, client, rpc } = await onboardingWorld(PGlite, { through: 486 });
// Two batches before the apply: an older one moved to normalize with a FAIL result, a newer one at intake with no result.
const OLD = await rpc('onboarding_create_batch', { p_community: COMM, p_batch_code: 'CONV-OLD-20260731', p_as_of: '2026-07-31', p_source_system: 'vantaca', p_actor_kind: 'human', p_actor_id: 'ed' });
const c0 = await rpc('onboarding_record_completion', { p_batch: OLD, p_stage: 'intake', p_status: 'PASS', p_open: [], p_controls: [ctl('intake.ok', 'PASS')], p_summary: {}, p_actor_kind: 'system', p_actor_id: 'op' });
await rpc('onboarding_advance', { p_batch: OLD, p_completion: c0, p_to: 'normalize', p_actor_kind: 'human', p_actor_id: 'ed' });
await rpc('onboarding_record_completion', { p_batch: OLD, p_stage: 'normalize', p_status: 'FAIL', p_open: ['gl.tie'], p_controls: [ctl('gl.tie', 'FAIL')], p_summary: {}, p_actor_kind: 'system', p_actor_id: 'op' });
await rpc('onboarding_create_batch', { p_community: COMM, p_batch_code: 'CONV-NEW-20260831', p_as_of: '2026-08-31', p_source_system: 'vantaca', p_actor_kind: 'human', p_actor_id: 'ed' });
const before = await rpc('onboarding_batches', { p_community: null });

const plan = await A.planMigration({ ...ctx(client), filename: F });
if (PRINT) { const rr = await A.applyMigration({ ...ctx(client), planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) }); console.log(JSON.stringify((rr.detail || {}).objects || rr, null, 2)); process.exit(0); }
check('plan: ready, every preflight passes', plan.status === 'ready' && plan.preflight.every((p) => p.ok), JSON.stringify({ status: plan.status, error: plan.error, pre: plan.preflight }).slice(0, 600));
const r = await A.applyMigration({ ...ctx(client), planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) });
check('apply: 491 applied and verified through the tool (function replaced, no row changes)', r.status === 'applied', JSON.stringify({ status: r.status, error: r.error }).slice(0, 600));

if (r.status === 'applied') {
  const after = await rpc('onboarding_batches', { p_community: null });
  const strip = (rows) => JSON.stringify(rows.map(({ result_stage, ...rest }) => rest).sort((a, b) => a.batch_code.localeCompare(b.batch_code)));
  check('list: for non-complete batches every 482 field reads exactly as before (only result_stage is added)', strip(after) === strip(before), strip(after));
  const old = after.find((b) => b.batch_code === 'CONV-OLD-20260731'); const neu = after.find((b) => b.batch_code === 'CONV-NEW-20260831');
  check('list: a batch reads its CURRENT stage result (normalize FAIL), result_stage = its stage', old.stage === 'normalize' && old.current_status === 'FAIL' && old.result_stage === 'normalize');
  check('list: a batch with no result for its stage still reads null (the page says "not run")', neu.stage === 'intake' && neu.current_status === null && neu.result_stage === 'intake');
  check('list: with no completed batch, newest first as before', after[0].batch_code === 'CONV-NEW-20260831' && after[1].batch_code === 'CONV-OLD-20260731');
  check('list: community filter still applies', (await rpc('onboarding_batches', { p_community: '00000000-0000-0000-0000-0000000000ff' })).length === 0);
  const priv = (await db.query(`SELECT has_function_privilege('anon', 'onboarding_batches(uuid)', 'EXECUTE') AS anon, has_function_privilege('service_role', 'onboarding_batches(uuid)', 'EXECUTE') AS svc`)).rows[0];
  check('grants: still executable by service_role only (not anon)', priv.anon === false && priv.svc === true);
  const again = await A.planMigration({ ...ctx(client), filename: F });
  check('re-apply: the plan refuses once 491 is in place', again.status !== 'ready');
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
