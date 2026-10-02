// tests/sql/481_apply_one_e2e.mjs — migration 481 (Trusted Onboarding Engine
// schema, Issue #15) applied END TO END through the single-migration tool with
// its REAL checks file, on top of the real 452 conversion staging tables.
// Proves in Postgres:
//   - the checks file matches exactly what 481 does; no rows change; an
//     existing legacy batch (stage NULL) is untouched and still editable;
//   - artifacts and stage events are append-only;
//   - an agent cannot record an advance, waiver or approval; a waiver needs a
//     reason; an approval needs the preflight hash;
//   - a stage moves one step only, only with a human stage_advanced event;
//     execute needs a human-approved preflight hash; the write lock opens only
//     in execute and re-locks after it;
//   - a declared tolerance needs a reason;
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
const checksPath = `${REPO}/migrations/checks/${F.replace('.sql', '.json')}`;
if (fs.existsSync(checksPath)) fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), lf(checksPath));
const PRINT = process.argv.includes('--print-objects');
const COMM = '00000000-0000-0000-0000-0000000000c1';
const LEGACY = '00000000-0000-0000-0000-0000000000b1';
const NEWB = '00000000-0000-0000-0000-0000000000b2';
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
const tryErr = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
const one = async (sql) => (await db.query(sql)).rows[0];
const plan = await A.planMigration({ ...ctx(client), filename: F });
if (PRINT) { const rr = await A.applyMigration({ ...ctx(client), planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) }); console.log(JSON.stringify((rr.detail || {}).objects || rr, null, 2)); process.exit(0); }
check('plan: ready, every preflight passes', plan.status === 'ready' && plan.preflight.every((p) => p.ok), JSON.stringify({ status: plan.status, error: plan.error }).slice(0, 600));
const r = await A.applyMigration({ ...ctx(client), planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) });
check('apply: 481 applied and verified through the tool', r.status === 'applied', JSON.stringify({ status: r.status, error: r.error }));

if (r.status === 'applied') {
  const leg = await one(`SELECT onboarding_stage, write_locked, status FROM conversion_batches WHERE id = '${LEGACY}'`);
  check('legacy batch untouched: stage NULL, locked, still posted and editable', leg.onboarding_stage === null && leg.write_locked === true && leg.status === 'posted' && (await tryErr(`UPDATE conversion_batches SET notes = 'x' WHERE id = '${LEGACY}'`)) === null);
  check('a legacy batch can only be enrolled at intake', /enters the onboarding engine at intake/.test(await tryErr(`UPDATE conversion_batches SET onboarding_stage = 'execute' WHERE id = '${LEGACY}'`) || ''));

  await db.exec(`INSERT INTO conversion_batches (id, community_id, batch_code, as_of_date, onboarding_stage) VALUES ('${NEWB}', '${COMM}', 'CONV-EX-20260731', '2026-07-31', 'intake')`);
  await db.exec(`INSERT INTO onboarding_artifacts (batch_id, community_id, source_system, artifact_type, filename, cutoff_date, sha256, bytes) VALUES ('${NEWB}', '${COMM}', 'vantaca', 'gl_trial_balance', 'gl.txt', '2026-07-31', '${H}', 10)`);
  check('artifacts are append-only (no update, no delete)', /append-only/.test(await tryErr(`UPDATE onboarding_artifacts SET filename = 'other' WHERE batch_id = '${NEWB}'`) || '') && /append-only/.test(await tryErr(`DELETE FROM onboarding_artifacts WHERE batch_id = '${NEWB}'`) || ''));
  check('the same bytes cannot be registered twice in a batch; a bad hash is refused',
    /duplicate key/.test(await tryErr(`INSERT INTO onboarding_artifacts (batch_id, community_id, source_system, artifact_type, filename, cutoff_date, sha256, bytes) VALUES ('${NEWB}', '${COMM}', 'vantaca', 'gl_trial_balance', 'copy.txt', '2026-07-31', '${H}', 10)`) || '')
    && /check/.test(await tryErr(`INSERT INTO onboarding_artifacts (batch_id, community_id, source_system, artifact_type, filename, cutoff_date, sha256, bytes) VALUES ('${NEWB}', '${COMM}', 'vantaca', 'x', 'x', '2026-07-31', 'nothex', 1)`) || ''));

  const ev = (type, stage, extra = '') => `INSERT INTO onboarding_stage_events (batch_id, event_type, stage, actor_kind, actor_id${extra ? ', ' + extra.split('|')[0] : ''}) VALUES ('${NEWB}', '${type}', '${stage}', ${extra ? extra.split('|')[1] : "'human', 'ed'"})`;
  check('an agent may record a stage completion but NOT an advance, waiver or approval',
    (await tryErr(`INSERT INTO onboarding_stage_events (batch_id, event_type, stage, actor_kind, actor_id) VALUES ('${NEWB}', 'stage_completed', 'intake', 'agent', 'claude')`)) === null
    && /human_gates/.test(await tryErr(`INSERT INTO onboarding_stage_events (batch_id, event_type, stage, to_stage, actor_kind, actor_id) VALUES ('${NEWB}', 'stage_advanced', 'intake', 'normalize', 'agent', 'claude')`) || '')
    && /human_gates/.test(await tryErr(`INSERT INTO onboarding_stage_events (batch_id, event_type, stage, control_code, reason, actor_kind, actor_id) VALUES ('${NEWB}', 'control_waived', 'intake', 'x', 'a long enough reason', 'agent', 'claude')`) || ''));
  check('a waiver needs a reason; an approval needs the preflight hash and stage preflight',
    /waiver_reason/.test(await tryErr(`INSERT INTO onboarding_stage_events (batch_id, event_type, stage, control_code, reason, actor_kind, actor_id) VALUES ('${NEWB}', 'control_waived', 'intake', 'x', 'ok', 'human', 'ed')`) || '')
    && /approval_hash/.test(await tryErr(`INSERT INTO onboarding_stage_events (batch_id, event_type, stage, actor_kind, actor_id) VALUES ('${NEWB}', 'preflight_approved', 'preflight', 'human', 'ed')`) || ''));
  check('stage events are append-only', /append-only/.test(await tryErr(`DELETE FROM onboarding_stage_events WHERE batch_id = '${NEWB}'`) || ''));

  check('no advance without a human stage_advanced event', /needs a human stage_advanced event/.test(await tryErr(`UPDATE conversion_batches SET onboarding_stage = 'normalize' WHERE id = '${NEWB}'`) || ''));
  check('no skipping a stage', /may only advance to normalize/.test(await tryErr(`UPDATE conversion_batches SET onboarding_stage = 'source_controls' WHERE id = '${NEWB}'`) || ''));
  check('the write lock cannot open outside execute', /write_lock_only_in_execute/.test(await tryErr(`UPDATE conversion_batches SET write_locked = false WHERE id = '${NEWB}'`) || ''));
  const order = ['intake', 'normalize', 'source_controls', 'snapshot', 'activity_bridge', 'preflight'];
  let walked = true;
  for (let k = 0; k < order.length - 1; k++) {
    await db.exec(`INSERT INTO onboarding_stage_events (batch_id, event_type, stage, to_stage, actor_kind, actor_id) VALUES ('${NEWB}', 'stage_advanced', '${order[k]}', '${order[k + 1]}', 'human', 'ed')`);
    if (await tryErr(`UPDATE conversion_batches SET onboarding_stage = '${order[k + 1]}' WHERE id = '${NEWB}'`)) walked = false;
  }
  check('with human advance events the batch walks intake -> preflight one step at a time', walked && (await one(`SELECT onboarding_stage FROM conversion_batches WHERE id = '${NEWB}'`)).onboarding_stage === 'preflight');
  await db.exec(`INSERT INTO onboarding_stage_events (batch_id, event_type, stage, to_stage, actor_kind, actor_id) VALUES ('${NEWB}', 'stage_advanced', 'preflight', 'execute', 'human', 'ed')`);
  check('execute is refused without an approved preflight hash', /execute needs an approved preflight/.test(await tryErr(`UPDATE conversion_batches SET onboarding_stage = 'execute' WHERE id = '${NEWB}'`) || ''));
  check('the preflight hash cannot be set without a matching human approval event', /human approval in stage preflight/.test(await tryErr(`UPDATE conversion_batches SET approved_preflight_sha256 = '${'b'.repeat(64)}' WHERE id = '${NEWB}'`) || ''));
  await db.exec(`INSERT INTO onboarding_stage_events (batch_id, event_type, stage, preflight_sha256, actor_kind, actor_id) VALUES ('${NEWB}', 'preflight_approved', 'preflight', '${'b'.repeat(64)}', 'human', 'ed')`);
  check('with the human approval the hash is recorded, then execute is allowed and the lock may open',
    (await tryErr(`UPDATE conversion_batches SET approved_preflight_sha256 = '${'b'.repeat(64)}' WHERE id = '${NEWB}'`)) === null
    && (await tryErr(`UPDATE conversion_batches SET onboarding_stage = 'execute', write_locked = false WHERE id = '${NEWB}'`)) === null);
  check('the approved hash is write-once', /write-once/.test(await tryErr(`UPDATE conversion_batches SET approved_preflight_sha256 = '${'c'.repeat(64)}' WHERE id = '${NEWB}'`) || ''));
  await db.exec(`INSERT INTO onboarding_stage_events (batch_id, event_type, stage, to_stage, actor_kind, actor_id) VALUES ('${NEWB}', 'stage_advanced', 'execute', 'post_proof', 'human', 'ed')`);
  await db.exec(`UPDATE conversion_batches SET onboarding_stage = 'post_proof' WHERE id = '${NEWB}'`);
  check('leaving execute re-locks writes automatically', (await one(`SELECT write_locked FROM conversion_batches WHERE id = '${NEWB}'`)).write_locked === true);
  check('a declared tolerance needs a reason (no plugs)',
    /tolerance_declared/.test(await tryErr(`INSERT INTO conversion_runs (id, batch_id, run_kind, source_file_ids, counts, staged_rows, all_pass, report) VALUES ('00000000-0000-0000-0000-0000000000d1', '${NEWB}', 'source_controls', '{}', '{}', '{}', true, '{}');
      INSERT INTO conversion_control_results (run_id, rule_code, status, tolerance_cents) VALUES ('00000000-0000-0000-0000-0000000000d1', 'x', 'PASS', 5)`) || ''));
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
