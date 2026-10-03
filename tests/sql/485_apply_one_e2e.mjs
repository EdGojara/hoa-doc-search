// tests/sql/485_apply_one_e2e.mjs — migration 485 (onboarding operator) applied
// END TO END through the single-migration tool with its REAL checks file, on top
// of 452-484. Proves the operator ('system') can advance ONLY on a plain PASS
// result into routine stages, never on a waived FAIL / BLOCKED, never into
// execute; waivers and approvals stay human-only; nothing else changed.
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
catch (_) { console.log('SKIP  485 end-to-end apply rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const F = '485_onboarding_operator.sql';
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm485-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`));
const PRINT = process.argv.includes('--print-objects');
const OWNER = { id: 'owner-uuid', email: 'owner@example.test' };
const ctx = (client) => ({ client, user: OWNER, deployedCommit: 'deadbeefcafe', migrationsDir: dir, secret: 'e2e' });
const { db, client, rpc } = await onboardingWorld(PGlite, { through: 484 });
const plan = await A.planMigration({ ...ctx(client), filename: F });
if (PRINT) { const rr = await A.applyMigration({ ...ctx(client), planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) }); console.log(JSON.stringify((rr.detail || {}).objects || rr, null, 2)); process.exit(0); }
check('plan: ready, every preflight passes', plan.status === 'ready' && plan.preflight.every((p) => p.ok), JSON.stringify({ status: plan.status, error: plan.error }).slice(0, 600));
const r = await A.applyMigration({ ...ctx(client), planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) });
check('apply: 485 applied and verified through the tool', r.status === 'applied', JSON.stringify({ status: r.status, error: r.error }));
const err = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };
const ctl = (code, status) => ({ code, label: code, status });
const complete = (b, stage, cs, kind = 'system') => rpc('onboarding_record_completion', { p_batch: b, p_stage: stage, p_status: cs.some((c) => c.status === 'FAIL') ? 'FAIL' : cs.some((c) => c.status === 'BLOCKED') ? 'BLOCKED' : 'PASS', p_open: cs.filter((c) => c.status !== 'PASS').map((c) => c.code), p_controls: cs, p_summary: {}, p_actor_kind: kind, p_actor_id: 'op' });
const auto = (b, c) => rpc('onboarding_auto_advance', { p_batch: b, p_completion: c, p_actor_id: 'onboarding-operator' });
if (r.status === 'applied') {
  const B = await rpc('onboarding_create_batch', { p_community: COMM, p_batch_code: 'CONV-OP', p_as_of: '2026-07-31', p_source_system: 'vantaca', p_actor_kind: 'human', p_actor_id: 'ed' });
  const c1 = await complete(B, 'intake', [ctl('ok', 'PASS')]);
  check('the operator advances on a plain PASS (recorded as system)', (await err(() => auto(B, c1))) === null && (await db.query(`SELECT actor_kind FROM onboarding_stage_events WHERE batch_id = $1 AND event_type = 'stage_advanced'`, [B])).rows[0].actor_kind === 'system');
  const c2 = await complete(B, 'normalize', [ctl('gl.x', 'FAIL')]);
  check('the operator cannot advance a FAIL result', /not a plain PASS/.test(await err(() => auto(B, c2)) || ''));
  await rpc('onboarding_waive', { p_batch: B, p_completion: c2, p_code: 'gl.x', p_reason: 'reviewed and accepted by Ed', p_actor_kind: 'human', p_actor_id: 'ed' });
  check('the operator cannot advance even a human-WAIVED FAIL (only a plain PASS); the human can', /not a plain PASS/.test(await err(() => auto(B, c2)) || '')
    && (await err(() => rpc('onboarding_advance', { p_batch: B, p_completion: c2, p_to: 'source_controls', p_actor_kind: 'human', p_actor_id: 'ed' }))) === null);
  check('a direct system advance event on a waived result is refused by the validate trigger', /operator advance refused|refused/.test(await err(async () => { const c = await complete(B, 'source_controls', [ctl('y', 'BLOCKED')]); await rpc('onboarding_waive', { p_batch: B, p_completion: c, p_code: 'y', p_reason: 'reviewed and accepted by Ed', p_actor_kind: 'human', p_actor_id: 'ed' }); await db.query(`INSERT INTO onboarding_stage_events (batch_id, event_type, stage, to_stage, completion_event_id, actor_kind, actor_id) VALUES ($1, 'stage_advanced', 'source_controls', 'snapshot', $2, 'system', 'op')`, [B, c]); }) || ''));
  const cz = await complete(B, 'source_controls', [ctl('z', 'BLOCKED')]);
  check('waivers remain human only: an operator waiver of an open control is refused by the human gate', /human_gates/.test(await err(() => db.query(`INSERT INTO onboarding_stage_events (batch_id, event_type, stage, completion_event_id, control_code, reason, actor_kind, actor_id) VALUES ($1, 'control_waived', 'source_controls', $2, 'z', 'system should never waive', 'system', 'op')`, [B, cz])) || ''));
  const priv = (await db.query(`SELECT has_function_privilege('anon', 'onboarding_auto_advance(uuid,uuid,text)', 'EXECUTE') AS a, has_function_privilege('service_role', 'onboarding_auto_advance(uuid,uuid,text)', 'EXECUTE') AS s`)).rows[0];
  check('grants: onboarding_auto_advance service_role only', priv.a === false && priv.s === true);
}
{
  const w = await onboardingWorld(PGlite, { through: 484 });
  await w.db.exec(`CREATE FUNCTION onboarding_auto_advance(p_batch uuid, p_completion uuid, p_actor_id text) RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$`);
  const p = await A.planMigration({ ...ctx(w.client), filename: F });
  check('drift: a pre-existing onboarding_auto_advance blocks the plan', p.status !== 'ready');
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
