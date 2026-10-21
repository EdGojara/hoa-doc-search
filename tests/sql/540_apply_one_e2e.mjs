// tests/sql/540_apply_one_e2e.mjs — migration 540 (ACC decision authority,
// step 1: additive columns) applied END TO END through the single-migration
// tool with its REAL checks file, BEFORE the code that uses it. Proves:
//   - the checks file matches exactly what 540 does (5 columns + 1 CHECK, no
//     row changes);
//   - existing rows are untouched;
//   - the CURRENT code keeps working: a letter render still inserts with the
//     old 'decided' default, and a finalize still records a decision (no
//     interruption; the behavior change is 541, after the code);
//   - drift blocks it (a column already present stops the plan).
// Postgres 17 (PGlite 0.3.x). Skips without PGlite.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  540 end-to-end apply rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const F = '540_acc_decision_authority_columns.sql';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm540-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`));
const D1 = '00000000-0000-0000-0000-0000000000a1';
const D2 = '00000000-0000-0000-0000-0000000000a3';

async function buildWorld({ preColumn = false } = {}) {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE acc_decisions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      status text NOT NULL DEFAULT 'decided' CHECK (status IN ('pending_review','awaiting_info','finalizing','decided','withdrawn','archived')),
      decision_type text, project_summary text, letter_body text);
    CREATE TABLE schema_migrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), filename text NOT NULL UNIQUE, sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, duration_ms integer, error text);
    INSERT INTO acc_decisions (id, status, decision_type, project_summary) VALUES
      ('${D1}', 'decided', 'approved_with_conditions', 'Driveway widening (16.5 ft to 19.5 ft)'),
      ('${D2}', 'pending_review', NULL, 'Replace rear wood fence');
    INSERT INTO schema_migrations (filename, sha256) VALUES ('480_acc_finalization_record.sql', 'recorded'), ('539_reply_send_claims.sql', 'recorded');`);
  if (preColumn) await db.exec(`ALTER TABLE acc_decisions ADD COLUMN decision_record jsonb;`);
  const client = { query: async (sql, params) => {
    if (params) { const r = await db.query(sql, params.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : v))); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; }
    const rs = await db.exec(sql); const last = rs[rs.length - 1] || { rows: [] }; return { rows: last.rows, rowCount: last.affectedRows ?? 0 };
  } };
  return { db, client };
}
const OWNER = { id: 'owner-uuid', email: 'owner@example.test' };
const ctx = (client) => ({ client, user: OWNER, deployedCommit: 'deadbeefcafe', migrationsDir: dir, secret: 'e2e' });

const { db, client } = await buildWorld();
const q1 = async (sql) => (await db.query(sql)).rows[0];
const tryErr = async (sql) => { try { await db.query(sql); return null; } catch (e) { return e.message; } };
const before = await q1(`SELECT row_to_json(d)::text j FROM acc_decisions d WHERE id = '${D1}'`);
const plan = await A.planMigration({ ...ctx(client), filename: F });
check('plan: ready, every preflight passes', plan.status === 'ready' && plan.preflight.every((p) => p.ok), JSON.stringify({ status: plan.status, error: plan.error }).slice(0, 600));
const r = await A.applyMigration({ ...ctx(client), planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) });
check('apply: 540 applied and verified through the tool', r.status === 'applied', JSON.stringify({ status: r.status, error: r.error }));
if (r.status === 'applied') {
  const NEW = ['approval_gate', 'approval_gate_reason', 'owner_review', 'decision_record', 'compliance_evaluation'];
  const after = await q1(`SELECT (row_to_json(d)::jsonb - ARRAY[${NEW.map((c) => `'${c}'`).join(',')}])::text j FROM acc_decisions d WHERE id = '${D1}'`);
  const canon = (s) => JSON.stringify(Object.entries(JSON.parse(s)).sort());
  check('existing decided row unchanged', canon(after.j) === canon(before.j));
  check('current code: a letter render still inserts with the old default', (await tryErr(`INSERT INTO acc_decisions (decision_type, project_summary) VALUES ('approved', 'Paint front door')`)) === null
    && (await q1(`SELECT status FROM acc_decisions WHERE project_summary = 'Paint front door'`)).status === 'decided');
  check('current code: finalizing a decision still works (no interruption)', (await tryErr(`UPDATE acc_decisions SET status = 'decided', decision_type = 'approved' WHERE id = '${D2}'`)) === null);
  check('rule: approval_gate accepts only required / not_required', /approval_gate_check/.test(await tryErr(`UPDATE acc_decisions SET approval_gate = 'maybe' WHERE id = '${D1}'`) || ''));
}
const drift = await buildWorld({ preColumn: true });
const plan2 = await A.planMigration({ ...ctx(drift.client), filename: F });
check('drift: an existing decision_record column BLOCKS the plan (preflight), no token', plan2.status !== 'ready' && !plan2.plan_token, JSON.stringify({ status: plan2.status }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
