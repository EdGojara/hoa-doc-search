// tests/sql/482_apply_one_e2e.mjs — migration 482 (onboarding guarded service
// path, Issue #15 Milestone 2) applied END TO END through the single-migration
// tool with its REAL checks file, on top of the real 452 + 481. Proves the SQL
// functions the app uses are the guarded path and cannot be talked past:
//   - human-only create / waive / approve / advance (agent refused in SQL);
//   - artifacts only while in intake;
//   - a stage result's status and open controls must equal its controls;
//   - a waiver sets the WAIVED disposition on that control result and the
//     status stays FAIL; control results are otherwise immutable, undeletable;
//   - advance re-proved by 481 (unwaived refused, waived allowed); EXECUTE
//     unreachable; approval needs the current preflight result fully waived;
//   - read views show controls, dispositions, waivers and the gate;
//   - functions are executable by service_role only; legacy runs untouched.
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
catch (_) { console.log('SKIP  482 end-to-end apply rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const F = '482_onboarding_service.sql';
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm482-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`));
const PRINT = process.argv.includes('--print-objects');
const OWNER = { id: 'owner-uuid', email: 'owner@example.test' };
const ctx = (client) => ({ client, user: OWNER, deployedCommit: 'deadbeefcafe', migrationsDir: dir, secret: 'e2e' });

const { db, client, rpc } = await onboardingWorld(PGlite, { through: 481 });
// a legacy (452-style) dry run with a result, to prove 482 leaves it alone
const LEGACY = '00000000-0000-0000-0000-0000000000b1';
await db.exec(`INSERT INTO conversion_batches (id, community_id, batch_code, as_of_date, status) VALUES ('${LEGACY}', '${COMM}', 'CONV-LEGACY', '2026-07-31', 'posted');
  INSERT INTO conversion_runs (id, batch_id, run_kind, source_file_ids, counts, staged_rows, all_pass, report) VALUES ('00000000-0000-0000-0000-0000000000a9', '${LEGACY}', 'dry_run', '{}', '{}', '{}', true, '{}');
  INSERT INTO conversion_control_results (run_id, rule_code, status) VALUES ('00000000-0000-0000-0000-0000000000a9', 'legacy.rule', 'PASS');`);
const plan = await A.planMigration({ ...ctx(client), filename: F });
if (PRINT) { const rr = await A.applyMigration({ ...ctx(client), planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) }); console.log(JSON.stringify((rr.detail || {}).objects || rr, null, 2)); process.exit(0); }
check('plan: ready, every preflight passes', plan.status === 'ready' && plan.preflight.every((p) => p.ok), JSON.stringify({ status: plan.status, error: plan.error }).slice(0, 600));
const r = await A.applyMigration({ ...ctx(client), planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) });
check('apply: 482 applied and verified through the tool', r.status === 'applied', JSON.stringify({ status: r.status, error: r.error }));

const err = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };
const H = (c) => c.repeat(64);
const ctl = (code, status, extra = {}) => ({ code, label: code, status, left_cents: 100, right_cents: status === 'PASS' ? 100 : 90, difference_cents: status === 'PASS' ? 0 : 10, ...extra });
const complete = (b, stage, controls, actor = ['agent', 'claude']) => {
  const st = controls.some((c) => c.status === 'FAIL') ? 'FAIL' : controls.some((c) => c.status === 'BLOCKED') ? 'BLOCKED' : 'PASS';
  return rpc('onboarding_record_completion', { p_batch: b, p_stage: stage, p_status: st, p_open: controls.filter((c) => c.status !== 'PASS').map((c) => c.code), p_controls: controls, p_summary: {}, p_actor_kind: actor[0], p_actor_id: actor[1] });
};
const advance = (b, cid, to, kind = 'human') => rpc('onboarding_advance', { p_batch: b, p_completion: cid, p_to: to, p_actor_kind: kind, p_actor_id: kind === 'human' ? 'ed' : 'claude' });
const waive = (b, cid, code, kind = 'human', reason = 'former-owner credit report pending; reviewed') => rpc('onboarding_waive', { p_batch: b, p_completion: cid, p_code: code, p_reason: reason, p_actor_kind: kind, p_actor_id: kind === 'human' ? 'ed' : 'claude' });

if (r.status === 'applied') {
  check('create: an agent cannot create a batch', /only a human/.test(await err(() => rpc('onboarding_create_batch', { p_community: COMM, p_batch_code: 'X', p_as_of: '2026-07-31', p_source_system: 'vantaca', p_actor_kind: 'agent', p_actor_id: 'claude' })) || ''));
  const B = await rpc('onboarding_create_batch', { p_community: COMM, p_batch_code: 'CONV-EX-20260731', p_as_of: '2026-07-31', p_source_system: 'Vantaca', p_actor_kind: 'human', p_actor_id: 'ed' });
  const bt = (await db.query(`SELECT onboarding_stage, status, write_locked, source_system FROM conversion_batches WHERE id = $1`, [B])).rows[0];
  check('create: human batch starts at intake, draft, locked; source normalized', bt.onboarding_stage === 'intake' && bt.status === 'draft' && bt.write_locked === true && bt.source_system === 'vantaca');
  const art = await rpc('onboarding_register_artifact', { p_batch: B, p_artifact: { artifact_type: 'gl_trial_balance', filename: 'gl.txt', sha256: H('a'), bytes: 10, storage_path: `onboarding/${B}/${H('a')}` }, p_actor_kind: 'agent', p_actor_id: 'claude' });
  check('artifact: registered in intake (agents may register), community/cutoff taken from the batch', !!art && (await db.query(`SELECT cutoff_date::text AS d, community_id FROM onboarding_artifacts WHERE id = $1`, [art])).rows[0].d === '2026-07-31');

  check('completion: must carry control results', /must carry its control results/.test(await err(() => rpc('onboarding_record_completion', { p_batch: B, p_stage: 'intake', p_status: 'PASS', p_open: [], p_controls: [], p_summary: {}, p_actor_kind: 'agent', p_actor_id: 'c' })) || ''));
  check('completion: cannot claim PASS over a FAIL control', /do not match the control results/.test(await err(() => rpc('onboarding_record_completion', { p_batch: B, p_stage: 'intake', p_status: 'PASS', p_open: [], p_controls: [ctl('a', 'FAIL')], p_summary: {}, p_actor_kind: 'agent', p_actor_id: 'c' })) || ''));
  check('completion: cannot hide an open control', /do not match the control results/.test(await err(() => rpc('onboarding_record_completion', { p_batch: B, p_stage: 'intake', p_status: 'FAIL', p_open: ['a'], p_controls: [ctl('a', 'FAIL'), ctl('b', 'BLOCKED')], p_summary: {}, p_actor_kind: 'agent', p_actor_id: 'c' })) || ''));
  check('completion: only for the current stage', /result for stage normalize but the batch is in intake/.test(await err(() => complete(B, 'normalize', [ctl('a', 'PASS')])) || ''));
  const c0 = await complete(B, 'intake', [ctl('intake.ok', 'PASS')]);
  const ev0 = (await db.query(`SELECT result FROM onboarding_stage_events WHERE id = $1`, [c0])).rows[0].result;
  const runRows = (await db.query(`SELECT count(*)::int AS n FROM conversion_control_results WHERE run_id = $1`, [ev0.run_id])).rows[0].n;
  check('completion: one transaction writes the event, its run and every control result', ev0.status === 'PASS' && runRows === 1);
  check('advance: an agent cannot advance (SQL refuses before any write)', /only a human/.test(await err(() => advance(B, c0, 'normalize', 'agent')) || ''));
  await advance(B, c0, 'normalize');
  check('artifact: refused once the batch has left intake', /only be registered while the batch is in intake/.test(await err(() => rpc('onboarding_register_artifact', { p_batch: B, p_artifact: { artifact_type: 'x', filename: 'late.txt', sha256: H('b'), bytes: 1 }, p_actor_kind: 'human', p_actor_id: 'ed' })) || ''));

  const c1 = await complete(B, 'normalize', [ctl('gl.tie', 'PASS'), ctl('subledger.credit_balances_equal_gl_prepaid', 'FAIL'), ctl('needs.ap', 'BLOCKED')]);
  check('advance: refused while controls are unwaived (481 re-proves through the function)', /not waived/.test(await err(() => advance(B, c1, 'source_controls')) || ''));
  check('waive: an agent cannot waive', /only a human/.test(await err(() => waive(B, c1, 'needs.ap', 'agent')) || ''));
  check('waive: a PASS / non-open control cannot be waived', /not an open control/.test(await err(() => waive(B, c1, 'gl.tie')) || ''));
  await waive(B, c1, 'subledger.credit_balances_equal_gl_prepaid');
  const run1 = (await db.query(`SELECT result->>'run_id' AS r FROM onboarding_stage_events WHERE id = $1`, [c1])).rows[0].r;
  const wr = (await db.query(`SELECT status, left_cents, right_cents, disposition, waived_by, waiver_reason FROM conversion_control_results WHERE run_id = $1 AND rule_code = 'subledger.credit_balances_equal_gl_prepaid'`, [run1])).rows[0];
  check('waive: the result row gets disposition WAIVED (who/why) and its status stays FAIL with its amounts', wr.status === 'FAIL' && Number(wr.left_cents) === 100 && Number(wr.right_cents) === 90 && wr.disposition === 'WAIVED' && wr.waived_by === 'ed' && /former-owner/.test(wr.waiver_reason));
  check('waive: twice for the same result is refused', /already waived/.test(await err(() => waive(B, c1, 'subledger.credit_balances_equal_gl_prepaid')) || ''));
  check('results: a status / amount change is refused', /immutable/.test(await err(() => db.query(`UPDATE conversion_control_results SET status = 'PASS' WHERE run_id = $1 AND rule_code = 'subledger.credit_balances_equal_gl_prepaid'`, [run1])) || '') && /immutable/.test(await err(() => db.query(`UPDATE conversion_control_results SET right_cents = 100 WHERE run_id = $1`, [run1])) || ''));
  check('results: a disposition without the matching human waiver event is refused; write-once', /matching human waiver event/.test(await err(() => db.query(`UPDATE conversion_control_results SET disposition = 'WAIVED', waived_by = 'ed', waiver_reason = 'forged without an event', waived_at = now(), waiver_event_id = (SELECT id FROM onboarding_stage_events WHERE event_type = 'control_waived' LIMIT 1) WHERE run_id = $1 AND rule_code = 'needs.ap'`, [run1])) || '')
    && /write-once/.test(await err(() => db.query(`UPDATE conversion_control_results SET waiver_reason = 'changed afterwards' WHERE run_id = $1 AND rule_code = 'subledger.credit_balances_equal_gl_prepaid'`, [run1])) || ''));
  check('results: cannot be deleted', /cannot be deleted/.test(await err(() => db.query(`DELETE FROM conversion_control_results WHERE run_id = $1`, [run1])) || ''));
  check('results: legacy (452 dry_run) rows are untouched by the guard', (await err(() => db.query(`UPDATE conversion_control_results SET note = 'legacy edit' WHERE rule_code = 'legacy.rule'`))) === null);
  let v = await rpc('onboarding_batch_view', { p_batch: B });
  check('view: current controls (FAIL first) with disposition, waivers, and the gate still naming the unwaived control', v.current.controls[0].status === 'FAIL' && v.current.controls[0].disposition.disposition === 'WAIVED' && v.current.waivers.length === 1 && /needs\.ap/.test(v.current.gate || ''));
  check('advance: partially waived still refused', /not waived: needs.ap/.test(await err(() => advance(B, c1, 'source_controls')) || ''));
  await waive(B, c1, 'needs.ap');
  check('advance: fully human-waived advances through the function', (await err(() => advance(B, c1, 'source_controls'))) === null);
  v = await rpc('onboarding_batch_view', { p_batch: B });
  check('view: batch now in source_controls; normalize latest result still FAIL in history', v.batch.stage === 'source_controls' && v.latest_by_stage.normalize.status === 'FAIL' && v.current === null);
  // walk to preflight with PASS results
  let cid = await complete(B, 'source_controls', [ctl('x', 'PASS')]); await advance(B, cid, 'snapshot');
  cid = await complete(B, 'snapshot', [ctl('x', 'PASS')]); await advance(B, cid, 'activity_bridge');
  cid = await complete(B, 'activity_bridge', [ctl('x', 'PASS')]); await advance(B, cid, 'preflight');
  const p1 = await complete(B, 'preflight', [ctl('pf.ok', 'PASS'), ctl('pf.gap', 'FAIL')]);
  check('approve: an agent cannot approve', /only a human/.test(await err(() => rpc('onboarding_approve', { p_batch: B, p_completion: p1, p_preflight_sha256: H('c'), p_actor_kind: 'agent', p_actor_id: 'claude' })) || ''));
  check('approve: refused while the preflight result has an unwaived control', /approval refused/.test(await err(() => rpc('onboarding_approve', { p_batch: B, p_completion: p1, p_preflight_sha256: H('c'), p_actor_kind: 'human', p_actor_id: 'ed' })) || ''));
  await waive(B, p1, 'pf.gap');
  check('approve: with the current preflight result fully waived, the approval and hash are recorded', (await err(() => rpc('onboarding_approve', { p_batch: B, p_completion: p1, p_preflight_sha256: H('c'), p_actor_kind: 'human', p_actor_id: 'ed' }))) === null
    && (await db.query(`SELECT approved_preflight_sha256 AS h, approved_by FROM conversion_batches WHERE id = $1`, [B])).rows[0].h === H('c'));
  check('advance: EXECUTE is not reachable in this milestone', /EXECUTE is not available yet/.test(await err(() => advance(B, p1, 'execute')) || ''));
  const list = await rpc('onboarding_batches', { p_community: null });
  check('list: engine batches only (legacy batch excluded), with current status', list.length === 1 && list[0].batch_code === 'CONV-EX-20260731' && list[0].stage === 'preflight' && list[0].current_status === 'FAIL');
  const priv = (await db.query(`SELECT has_function_privilege('anon', 'onboarding_advance(uuid,uuid,text,text,text)', 'EXECUTE') AS anon, has_function_privilege('service_role', 'onboarding_advance(uuid,uuid,text,text,text)', 'EXECUTE') AS svc`)).rows[0];
  check('grants: functions executable by service_role only (not anon)', priv.anon === false && priv.svc === true);
}

{
  const w = await onboardingWorld(PGlite, { through: 481 });
  await w.db.exec(`CREATE FUNCTION onboarding_batches(p_community uuid DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$ SELECT '[]'::jsonb $$`);
  const p = await A.planMigration({ ...ctx(w.client), filename: F });
  check('drift: a pre-existing onboarding function blocks the plan', p.status !== 'ready');
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
