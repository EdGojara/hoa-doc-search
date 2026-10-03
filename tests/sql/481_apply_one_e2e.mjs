// tests/sql/481_apply_one_e2e.mjs — migration 481 (Trusted Onboarding Engine
// schema, Issue #15) applied END TO END through the single-migration tool with
// its REAL checks file, on top of the real 452 conversion staging tables.
// Proves in Postgres that the DATABASE enforces the same substantive gate as
// lib/onboarding/stages.js, not just "a human advance event exists":
//   - a stage advances only on its LATEST completion, which must be PASS or
//     have every open control waived by a human for THAT completion;
//   - incomplete, FAIL, BLOCKED, partially waived and agent-waived cases are
//     refused; fully human-waived FAIL / BLOCKED advance;
//   - replay: after a stage is re-run, earlier waivers / advances / approvals
//     cannot authorize the new result;
//   - execute needs a human approval of the preflight hash bound to the
//     current preflight result; the write lock opens only in execute;
//   - waived control results keep their FAIL/BLOCKED status with who/why/when;
//   - artifacts and events are append-only; legacy batches are untouched;
//   - drift blocks it.
// Postgres 17 (PGlite 0.3.x). Skips without PGlite.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  481 end-to-end apply rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const F = '481_onboarding_engine.sql';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm481-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`));
const PRINT = process.argv.includes('--print-objects');
const COMM = '00000000-0000-0000-0000-0000000000c1';
const LEGACY = '00000000-0000-0000-0000-0000000000b1';
const H = 'a'.repeat(64);

async function buildWorld() {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE OR REPLACE FUNCTION trusted_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
    CREATE TABLE communities (id uuid PRIMARY KEY);
    CREATE TABLE properties (id uuid PRIMARY KEY);
    CREATE TABLE chart_of_accounts (id uuid PRIMARY KEY);
    CREATE TABLE account_funds (id uuid PRIMARY KEY);
    CREATE TABLE bank_accounts (id uuid PRIMARY KEY);
    CREATE TABLE vendors (id uuid PRIMARY KEY);
    CREATE TABLE journal_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE TABLE schema_migrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), filename text NOT NULL UNIQUE, sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, duration_ms integer, error text);
    INSERT INTO communities VALUES ('${COMM}');`);
  await db.exec(lf(`${REPO}/migrations/452_conversion_staging.sql`));
  await db.exec(`
    INSERT INTO schema_migrations (filename, sha256) VALUES ('452_conversion_staging.sql', 'recorded'), ('480_acc_finalization_record.sql', 'recorded');
    INSERT INTO conversion_batches (id, community_id, batch_code, as_of_date, status) VALUES ('${LEGACY}', '${COMM}', 'CONV-LEGACY-20260731', '2026-07-31', 'posted');`);
  const client = { query: async (sql, params) => {
    if (params) { const r = await db.query(sql, params.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : v))); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; }
    const rs = await db.exec(sql); const last = rs[rs.length - 1] || { rows: [] }; return { rows: last.rows, rowCount: last.affectedRows ?? 0 };
  } };
  return { db, client };
}

const OWNER = { id: 'owner-uuid', email: 'owner@example.test' };
const ctx = (client) => ({ client, user: OWNER, deployedCommit: 'deadbeefcafe', migrationsDir: dir, secret: 'e2e' });
const { db, client } = await buildWorld();
const err = async (sql, params) => { try { await db.query(sql, params); return null; } catch (e) { return e.message; } };
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const plan = await A.planMigration({ ...ctx(client), filename: F });
if (PRINT) { const rr = await A.applyMigration({ ...ctx(client), planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) }); console.log(JSON.stringify((rr.detail || {}).objects || rr, null, 2)); process.exit(0); }
check('plan: ready, every preflight passes', plan.status === 'ready' && plan.preflight.every((p) => p.ok), JSON.stringify({ status: plan.status, error: plan.error }).slice(0, 600));
const r = await A.applyMigration({ ...ctx(client), planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) });
check('apply: 481 applied and verified through the tool', r.status === 'applied', JSON.stringify({ status: r.status, error: r.error }));

// --- helpers (one batch per scenario) ---
let n = 0;
async function newBatch() { n++; const id = `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`; await db.query(`INSERT INTO conversion_batches (id, community_id, batch_code, as_of_date, onboarding_stage) VALUES ($1, $2, $3, '2026-07-31', 'intake')`, [id, COMM, `CONV-T${n}`]); return id; }
const stageOf = async (b) => (await one(`SELECT onboarding_stage FROM conversion_batches WHERE id = $1`, [b])).onboarding_stage;
async function complete(b, stage, status, open = [], actor = 'agent') {
  return (await one(`INSERT INTO onboarding_stage_events (batch_id, event_type, stage, actor_kind, actor_id, result) VALUES ($1, 'stage_completed', $2, $3, 'x', $4::jsonb) RETURNING id`, [b, stage, actor, JSON.stringify({ status, open_controls: open })])).id;
}
const waive = (b, stage, cid, code, actor = 'human', reason = 'reviewed with Ed; source gap documented') =>
  err(`INSERT INTO onboarding_stage_events (batch_id, event_type, stage, completion_event_id, control_code, reason, actor_kind, actor_id) VALUES ($1, 'control_waived', $2, $3, $4, $5, $6, 'ed')`, [b, stage, cid, code, reason, actor]);
const advEvent = (b, stage, to, cid, actor = 'human') =>
  err(`INSERT INTO onboarding_stage_events (batch_id, event_type, stage, to_stage, completion_event_id, actor_kind, actor_id) VALUES ($1, 'stage_advanced', $2, $3, $4, $5, 'ed')`, [b, stage, to, cid, actor]);
const move = (b, to) => err(`UPDATE conversion_batches SET onboarding_stage = $2 WHERE id = $1`, [b, to]);
async function passTo(b, target) { // walk with PASS completions up to target
  const order = ['intake', 'normalize', 'source_controls', 'snapshot', 'activity_bridge', 'preflight'];
  for (let k = 0; k < order.indexOf(target); k++) { const c = await complete(b, order[k], 'PASS'); await advEvent(b, order[k], order[k + 1], c); await move(b, order[k + 1]); }
}

if (r.status === 'applied') {
  // ---------------- legacy / artifacts / append-only
  const leg = await one(`SELECT onboarding_stage, write_locked, status FROM conversion_batches WHERE id = '${LEGACY}'`);
  check('legacy batch untouched: stage NULL, locked, still posted and editable', leg.onboarding_stage === null && leg.write_locked === true && leg.status === 'posted' && (await err(`UPDATE conversion_batches SET notes = 'x' WHERE id = '${LEGACY}'`)) === null);
  check('a legacy batch can only be enrolled at intake', /enters the onboarding engine at intake/.test(await err(`UPDATE conversion_batches SET onboarding_stage = 'execute' WHERE id = '${LEGACY}'`) || ''));
  const b0 = await newBatch();
  await db.query(`INSERT INTO onboarding_artifacts (batch_id, community_id, source_system, artifact_type, filename, cutoff_date, sha256, bytes) VALUES ($1, $2, 'vantaca', 'gl_trial_balance', 'gl.txt', '2026-07-31', $3, 10)`, [b0, COMM, H]);
  check('artifacts are append-only; same bytes twice and a bad hash are refused',
    /append-only/.test(await err(`UPDATE onboarding_artifacts SET filename = 'other' WHERE batch_id = $1`, [b0]) || '') && /append-only/.test(await err(`DELETE FROM onboarding_artifacts WHERE batch_id = $1`, [b0]) || '')
    && /duplicate key/.test(await err(`INSERT INTO onboarding_artifacts (batch_id, community_id, source_system, artifact_type, filename, cutoff_date, sha256, bytes) VALUES ($1, $2, 'vantaca', 'gl', 'copy.txt', '2026-07-31', $3, 10)`, [b0, COMM, H]) || '')
    && /check/.test(await err(`INSERT INTO onboarding_artifacts (batch_id, community_id, source_system, artifact_type, filename, cutoff_date, sha256, bytes) VALUES ($1, $2, 'vantaca', 'x', 'x', '2026-07-31', 'nothex', 1)`, [b0, COMM]) || ''));

  // ---------------- completion shape + current-stage binding
  check('a completion must be well-formed: PASS has no open controls; FAIL/BLOCKED list at least one; status known',
    /completion_result/.test(await err(`INSERT INTO onboarding_stage_events (batch_id, event_type, stage, actor_kind, actor_id, result) VALUES ($1, 'stage_completed', 'intake', 'agent', 'x', '{"status":"PASS","open_controls":["a"]}')`, [b0]) || '')
    && /completion_result/.test(await err(`INSERT INTO onboarding_stage_events (batch_id, event_type, stage, actor_kind, actor_id, result) VALUES ($1, 'stage_completed', 'intake', 'agent', 'x', '{"status":"FAIL","open_controls":[]}')`, [b0]) || '')
    && /completion_result/.test(await err(`INSERT INTO onboarding_stage_events (batch_id, event_type, stage, actor_kind, actor_id, result) VALUES ($1, 'stage_completed', 'intake', 'agent', 'x', '{"status":"WAIVED","open_controls":[]}')`, [b0]) || ''));
  check('events are only accepted for the batch CURRENT stage', /batch is in intake/.test(await err(`INSERT INTO onboarding_stage_events (batch_id, event_type, stage, actor_kind, actor_id, result) VALUES ($1, 'stage_completed', 'normalize', 'agent', 'x', '{"status":"PASS","open_controls":[]}')`, [b0]) || ''));
  await complete(b0, 'intake', 'PASS');
  check('stage events are append-only (no update, no delete)', /append-only/.test(await err(`DELETE FROM onboarding_stage_events WHERE batch_id = $1`, [b0]) || '') && /append-only/.test(await err(`UPDATE onboarding_stage_events SET actor_id = 'someone' WHERE batch_id = $1`, [b0]) || ''));

  // ---------------- INCOMPLETE
  const bI = await newBatch();
  check('incomplete: an advance event must reference a completion (a generic advance can never substitute)', /bound_to_completion|must reference a completion/.test(await err(`INSERT INTO onboarding_stage_events (batch_id, event_type, stage, to_stage, actor_kind, actor_id) VALUES ($1, 'stage_advanced', 'intake', 'normalize', 'human', 'ed')`, [bI]) || ''));
  check('incomplete: the batch cannot move without an advance event', /needs a human stage_advanced event/.test(await move(bI, 'normalize') || ''));

  // ---------------- PASS
  const bP = await newBatch(); const cP = await complete(bP, 'intake', 'PASS');
  check('PASS: an agent cannot record the advance', /human_gates/.test(await advEvent(bP, 'intake', 'normalize', cP, 'agent') || ''));
  check('PASS: no skipping', /may only advance to normalize/.test(await advEvent(bP, 'intake', 'source_controls', cP) || ''));
  check('PASS: human advance on the latest PASS completion moves the batch', (await advEvent(bP, 'intake', 'normalize', cP)) === null && (await move(bP, 'normalize')) === null && (await stageOf(bP)) === 'normalize');
  check('a completion of ANOTHER stage cannot authorize an advance', /reference a completion of this batch and stage/.test(await advEvent(bP, 'normalize', 'source_controls', cP) || ''));

  // ---------------- FAIL: unwaived, agent-waived, partially waived, fully human-waived
  const bF = await newBatch(); await passTo(bF, 'source_controls');
  const cF = await complete(bF, 'source_controls', 'FAIL', ['subledger.credit_balances_equal_gl_prepaid', 'gl.x']);
  check('FAIL unwaived: advance refused', ((m) => /FAIL; not waived:/.test(m) && /subledger.credit_balances_equal_gl_prepaid/.test(m) && /gl.x/.test(m))(await advEvent(bF, 'source_controls', 'snapshot', cF) || ''));
  check('FAIL: an AGENT waiver is refused', /human_gates/.test(await waive(bF, 'source_controls', cF, 'gl.x', 'agent') || ''));
  check('FAIL: a waiver without a real reason is refused', /waiver_reason/.test(await waive(bF, 'source_controls', cF, 'gl.x', 'human', 'ok') || ''));
  check('FAIL: a waiver of a control that is NOT open on that result is refused', /not an open control/.test(await waive(bF, 'source_controls', cF, 'gl.other') || ''));
  check('FAIL partially waived: one of two waived -> advance still refused', (await waive(bF, 'source_controls', cF, 'gl.x')) === null && /not waived: subledger.credit_balances_equal_gl_prepaid/.test(await advEvent(bF, 'source_controls', 'snapshot', cF) || ''));
  check('FAIL: the same control cannot be waived twice for one result', /already waived/.test(await waive(bF, 'source_controls', cF, 'gl.x') || ''));
  check('FAIL fully human-waived: advance accepted and the batch moves', (await waive(bF, 'source_controls', cF, 'subledger.credit_balances_equal_gl_prepaid')) === null && (await advEvent(bF, 'source_controls', 'snapshot', cF)) === null && (await move(bF, 'snapshot')) === null);
  check('the waived result is still FAIL in the audit (a waiver never rewrites the completion)', (await one(`SELECT result->>'status' AS s FROM onboarding_stage_events WHERE id = $1`, [cF])).s === 'FAIL');

  // ---------------- BLOCKED
  const bB = await newBatch(); const cB = await complete(bB, 'intake', 'BLOCKED', ['needs.ap_aging']);
  check('BLOCKED unwaived: advance refused', /BLOCKED; not waived: needs.ap_aging/.test(await advEvent(bB, 'intake', 'normalize', cB) || ''));
  check('BLOCKED human-waived: advance accepted', (await waive(bB, 'intake', cB, 'needs.ap_aging')) === null && (await advEvent(bB, 'intake', 'normalize', cB)) === null && (await move(bB, 'normalize')) === null);

  // ---------------- REPLAY: re-run the stage after waiver + advance were recorded
  const bR = await newBatch();
  const c1 = await complete(bR, 'intake', 'FAIL', ['gl.x']);
  await waive(bR, 'intake', c1, 'gl.x'); await advEvent(bR, 'intake', 'normalize', c1);
  const c2 = await complete(bR, 'intake', 'FAIL', ['gl.y']);                        // stage re-run: a different result
  check('replay: the old advance event cannot move the batch once a newer result exists', /newer result was recorded/.test(await move(bR, 'normalize') || ''));
  check('replay: the old completion cannot be waived or advanced on any more', /completion is stale/.test(await waive(bR, 'intake', c1, 'gl.x') || '') && /completion is stale/.test(await advEvent(bR, 'intake', 'normalize', c1) || ''));
  check('replay: the old waiver of gl.x does not cover the new result', /not waived: gl.y/.test(await advEvent(bR, 'intake', 'normalize', c2) || ''));
  check('replay: once the NEW result is waived and advanced, the batch moves', (await waive(bR, 'intake', c2, 'gl.y')) === null && (await advEvent(bR, 'intake', 'normalize', c2)) === null && (await move(bR, 'normalize')) === null);
  const bR2 = await newBatch(); const d1 = await complete(bR2, 'intake', 'PASS'); await advEvent(bR2, 'intake', 'normalize', d1);
  await complete(bR2, 'intake', 'FAIL', ['gl.z']);
  check('replay: a PASS-then-FAIL re-run cannot ride the earlier PASS advance', /newer result was recorded/.test(await move(bR2, 'normalize') || ''));

  // ---------------- EXECUTE + approvals + write lock
  const bE = await newBatch(); await passTo(bE, 'preflight');
  check('write lock cannot open outside execute', /write_lock_only_in_execute/.test(await err(`UPDATE conversion_batches SET write_locked = false WHERE id = $1`, [bE]) || ''));
  const p1 = await complete(bE, 'preflight', 'FAIL', ['subledger.credit_balances_equal_gl_prepaid']);
  check('approval refused while the preflight result has an unwaived control', /approval refused: .*not waived/.test(await err(`INSERT INTO onboarding_stage_events (batch_id, event_type, stage, completion_event_id, preflight_sha256, actor_kind, actor_id) VALUES ($1, 'preflight_approved', 'preflight', $2, $3, 'human', 'ed')`, [bE, p1, 'b'.repeat(64)]) || ''));
  await waive(bE, 'preflight', p1, 'subledger.credit_balances_equal_gl_prepaid');
  check('an agent cannot approve', /human_gates/.test(await err(`INSERT INTO onboarding_stage_events (batch_id, event_type, stage, completion_event_id, preflight_sha256, actor_kind, actor_id) VALUES ($1, 'preflight_approved', 'preflight', $2, $3, 'agent', 'claude')`, [bE, p1, 'b'.repeat(64)]) || ''));
  await db.query(`INSERT INTO onboarding_stage_events (batch_id, event_type, stage, completion_event_id, preflight_sha256, actor_kind, actor_id) VALUES ($1, 'preflight_approved', 'preflight', $2, $3, 'human', 'ed')`, [bE, p1, 'b'.repeat(64)]);
  // preflight re-run AFTER approval: the approval is stale
  const p2 = await complete(bE, 'preflight', 'PASS');
  check('replay: an approval of an earlier preflight result cannot record the hash', /human approval of the current preflight result/.test(await err(`UPDATE conversion_batches SET approved_preflight_sha256 = $2 WHERE id = $1`, [bE, 'b'.repeat(64)]) || ''));
  await db.query(`INSERT INTO onboarding_stage_events (batch_id, event_type, stage, completion_event_id, preflight_sha256, actor_kind, actor_id) VALUES ($1, 'preflight_approved', 'preflight', $2, $3, 'human', 'ed')`, [bE, p2, 'c'.repeat(64)]);
  await advEvent(bE, 'preflight', 'execute', p2);
  check('execute refused until the approved hash is recorded', /execute needs an approved preflight/.test(await move(bE, 'execute') || ''));
  check('with a human approval of the current result the hash is recorded and execute is allowed, lock may open',
    (await err(`UPDATE conversion_batches SET approved_preflight_sha256 = $2 WHERE id = $1`, [bE, 'c'.repeat(64)])) === null
    && (await err(`UPDATE conversion_batches SET onboarding_stage = 'execute', write_locked = false WHERE id = $1`, [bE])) === null);
  check('the approved hash is write-once', /write-once/.test(await err(`UPDATE conversion_batches SET approved_preflight_sha256 = $2 WHERE id = $1`, [bE, 'd'.repeat(64)]) || ''));
  const x1 = await complete(bE, 'execute', 'PASS'); await advEvent(bE, 'execute', 'post_proof', x1); await move(bE, 'post_proof');
  check('leaving execute re-locks writes automatically', (await one(`SELECT write_locked FROM conversion_batches WHERE id = $1`, [bE])).write_locked === true);

  // ---------------- control results: disposition never changes status; tolerance needs reason
  const run = '00000000-0000-0000-0000-0000000000d1';
  await db.query(`INSERT INTO conversion_runs (id, batch_id, run_kind, source_file_ids, counts, staged_rows, all_pass, report) VALUES ($1, $2, 'source_controls', '{}', '{}', '{}', false, '{}')`, [run, bF]);
  const wEv = (await one(`SELECT id FROM onboarding_stage_events WHERE batch_id = $1 AND event_type = 'control_waived' AND control_code = 'subledger.credit_balances_equal_gl_prepaid'`, [bF])).id;
  check('a WAIVED disposition on a PASS control is refused', /waiver_disposition/.test(await err(`INSERT INTO conversion_control_results (run_id, rule_code, status, disposition, waived_by, waiver_reason, waived_at, waiver_event_id) VALUES ($1, 'a', 'PASS', 'WAIVED', 'ed', 'reviewed with Ed; documented', now(), $2)`, [run, wEv]) || ''));
  check('a WAIVED disposition without who / why / when / waiver event is refused', /waiver_disposition/.test(await err(`INSERT INTO conversion_control_results (run_id, rule_code, status, disposition) VALUES ($1, 'b', 'FAIL', 'WAIVED')`, [run]) || ''));
  const kept = (await err(`INSERT INTO conversion_control_results (run_id, rule_code, status, left_cents, right_cents, disposition, waived_by, waiver_reason, waived_at, waiver_event_id) VALUES ($1, 'subledger.credit_balances_equal_gl_prepaid', 'FAIL', 18460, 92213, 'WAIVED', 'ed', 'former-owner credits report pending; reviewed', now(), $2)`, [run, wEv])) === null;
  const row = await one(`SELECT status, left_cents, right_cents, disposition, waived_by FROM conversion_control_results WHERE run_id = $1 AND rule_code = 'subledger.credit_balances_equal_gl_prepaid'`, [run]);
  check('a waived FAIL is stored as status FAIL + disposition WAIVED, original amounts retained', kept && row.status === 'FAIL' && Number(row.left_cents) === 18460 && Number(row.right_cents) === 92213 && row.disposition === 'WAIVED' && row.waived_by === 'ed');
  check('a declared tolerance needs a reason (no plugs)', /tolerance_declared/.test(await err(`INSERT INTO conversion_control_results (run_id, rule_code, status, tolerance_cents) VALUES ($1, 'x', 'PASS', 5)`, [run]) || ''));
}

// drift: a pre-existing onboarding_artifacts table blocks the plan
{
  const w = await buildWorld();
  await w.db.exec(`CREATE TABLE onboarding_artifacts (id uuid PRIMARY KEY)`);
  const p = await A.planMigration({ ...ctx(w.client), filename: F });
  check('drift: a pre-existing onboarding_artifacts table blocks the plan', p.status !== 'ready');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
