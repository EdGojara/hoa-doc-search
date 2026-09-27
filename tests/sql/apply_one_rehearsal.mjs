// tests/sql/apply_one_rehearsal.mjs — rehearsal for lib/migrations/apply_one.js
// (single-migration apply + record in one transaction) against an in-memory
// Postgres (PGlite), using synthetic migrations in a temp folder. Skips (exit 0)
// when @electric-sql/pglite is not installed. Run: node tests/sql/apply_one_rehearsal.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  single-migration apply rehearsal (@electric-sql/pglite not installed; set PGLITE_MODULE or add the dev dependency)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const expectRefusal = async (name, fn, code) => { try { await fn(); fail++; console.log('FAIL ', name, '(no refusal)'); } catch (e) { const ok = e instanceof A.Refusal && (!code || e.code === code); ok ? pass++ : fail++; console.log(ok ? 'PASS ' : 'FAIL ', name, ok ? '' : `${e.code || ''} ${e.message}`); } };

// ---- world ----
const db = new PGlite();
const client = { query: async (sql, params) => {
  if (params) { const r = await db.query(sql, params.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : v))); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; }
  const rs = await db.exec(sql); const last = rs[rs.length - 1] || { rows: [] }; return { rows: last.rows, rowCount: last.affectedRows ?? 0 };
} };
await db.exec(`
CREATE TABLE schema_migrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), filename text NOT NULL UNIQUE, sha256 text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, duration_ms integer, error text);
INSERT INTO schema_migrations (filename, sha256) VALUES ('100_base.sql', 'x');
CREATE TABLE ledger (id int PRIMARY KEY, amount int);
INSERT INTO ledger VALUES (1, 100), (2, 200);
CREATE TABLE widgets (id int PRIMARY KEY, name text);
INSERT INTO widgets VALUES (1, 'a');
`);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-one-'));
fs.mkdirSync(path.join(dir, 'checks'));
const write = (file, sql, checks) => {
  fs.writeFileSync(path.join(dir, file), sql);
  if (checks) fs.writeFileSync(path.join(dir, 'checks', file.replace(/\.sql$/, '.json')), JSON.stringify({ migration: file, summary: 's', requires: ['100_base.sql'], preflight: [], expected_changes: ['x'],
    objects: { added: [], changed: [], removed: [] }, row_changes: {}, protected: [{ table: 'ledger', order_by: 'id' }], verify: [], ...checks }, null, 2));
};
const OWNER = { id: 'owner-1', email: 'owner@example.test' };
const COMMIT = 'abc1234def';
const SECRET = 'test-secret';
const ctx = { client, user: OWNER, deployedCommit: COMMIT, migrationsDir: dir, secret: SECRET };
const plan = (filename, extra = {}) => A.planMigration({ ...ctx, filename, ...extra });
const apply = (token, extra = {}) => A.applyMigration({ ...ctx, planToken: token, log: { error() {} }, ...extra });
const q1 = async (sql, p) => (await db.query(sql, p)).rows[0];
const exists = async (t) => !!(await q1(`SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`, [t]));

// ---- lint ----
check('lint: BEGIN ... COMMIT with BEGIN inside a DO block is accepted',
  (() => { try { return A.lintMigration(`-- x\nBEGIN;\nDO $$ BEGIN PERFORM 1; END $$;\nCREATE TABLE t (id int);\nCOMMIT;\n`).includes('CREATE TABLE t'); } catch (_) { return false; } })());
for (const [name, sql] of [
  ['a COMMIT in the middle', 'BEGIN; CREATE TABLE t(id int); COMMIT; CREATE TABLE u(id int); COMMIT;'],
  ['CREATE INDEX CONCURRENTLY', 'BEGIN; CREATE INDEX CONCURRENTLY i ON widgets(name); COMMIT;'],
  ['no BEGIN', 'CREATE TABLE t(id int); COMMIT;'],
  ['a SAVEPOINT', 'BEGIN; SAVEPOINT s; CREATE TABLE t(id int); COMMIT;'],
]) await expectRefusal(`lint: refuses ${name}`, async () => A.lintMigration(sql), 'lint');
check('lint: a semicolon inside a string literal does not split statements', A.topLevelStatements(`BEGIN; SELECT 'a;b'; COMMIT;`).length === 3);

// ---- checks validation ----
write('101_bad_checks.sql', 'BEGIN; CREATE TABLE t1 (id int); COMMIT;', { verify: [{ name: 'sneaky', sql: 'SELECT 1; DELETE FROM ledger', expect: 1 }] });
await expectRefusal('checks: a verify query with a second (write) statement is refused', () => plan('101_bad_checks.sql'), 'checks');
write('102_bad_checks.sql', 'BEGIN; CREATE TABLE t1 (id int); COMMIT;', { preflight: [{ name: 'w', sql: 'SELECT set_config(\'a.b\', \'1\', false)', expect: 1 }] });
await expectRefusal('checks: a preflight using set_config is refused', () => plan('102_bad_checks.sql'), 'checks');
write('103_no_checks.sql', 'BEGIN; CREATE TABLE t1 (id int); COMMIT;');
await expectRefusal('plan: a migration without a checks file is refused', () => plan('103_no_checks.sql'), 'no_checks');
await expectRefusal('plan: a file that is not deployed is refused', () => plan('199_missing.sql'), 'not_deployed');
await expectRefusal('plan: an unknown deployed commit is refused', () => plan('103_no_checks.sql', { deployedCommit: 'unknown' }), 'no_commit');

// ---- happy path ----
write('110_add_gadgets.sql', `BEGIN;\nCREATE TABLE gadgets (id int PRIMARY KEY, widget_id int REFERENCES widgets(id));\nINSERT INTO gadgets VALUES (1, 1), (2, 1);\nALTER TABLE widgets ADD COLUMN color text;\nCOMMIT;\n`, {
  preflight: [{ name: 'no gadgets table yet', sql: `SELECT count(*)::int FROM information_schema.tables WHERE table_name = 'gadgets'`, expect: 0 }],
  objects: { added: ['table:gadgets', 'column:gadgets.id', 'column:gadgets.widget_id', 'column:widgets.color', 'index:gadgets_pkey', 'constraint:gadgets.gadgets_pkey', 'constraint:gadgets.gadgets_widget_id_fkey'], changed: [], removed: [] },
  row_changes: { gadgets: 2 }, protected: [{ table: 'ledger', order_by: 'id' }, { table: 'widgets', order_by: 'id' }],
  verify: [{ name: 'two gadgets', sql: 'SELECT count(*)::int FROM gadgets', expect: 2 }], api_checks: [{ table: 'gadgets', expect_count: 2 }],
});
const before = await q1(`SELECT (SELECT count(*) FROM pg_class)::int c`);
const p110 = await plan('110_add_gadgets.sql');
check('plan: ready, with filename, hash, checks hash, deployed commit, expected changes, protected tables, preflight', p110.status === 'ready' && p110.sha256.length === 64 && p110.checks_sha256.length === 64
  && p110.deployed_commit === COMMIT && p110.protected.join() === 'ledger,widgets' && p110.preflight[0].ok && p110.plan_token, JSON.stringify(p110).slice(0, 300));
check('plan: shows the one-time tracker bootstrap it would do', p110.tracker_bootstrap.some((s) => /commit_sha/.test(s)) && p110.tracker_bootstrap.some((s) => /migration_attempts/.test(s)));
check('plan: is read-only (no table created, no attempt log, no bootstrap)', !(await exists('gadgets')) && !(await exists('migration_attempts'))
  && (await q1(`SELECT (SELECT count(*) FROM pg_class)::int c`)).c === before.c);
check('plan: the SHA-256 is the hash of the exact file', p110.sha256 === A._internal.sha256(fs.readFileSync(path.join(dir, '110_add_gadgets.sql'), 'utf8')));

await expectRefusal('apply: a tampered plan token is refused', () => apply(p110.plan_token.slice(0, -2) + 'xx'), 'bad_plan');
await expectRefusal('apply: an expired plan is refused', () => apply(p110.plan_token, { now: Date.now() + 31 * 60 * 1000 }), 'plan_expired');
await expectRefusal('apply: a different user cannot use the owner\'s plan', () => apply(p110.plan_token, { user: { id: 'someone-else', email: 'x@y' } }), 'wrong_user');
await expectRefusal('apply: refused if the deployed commit changed since review', () => apply(p110.plan_token, { deployedCommit: 'fffffff' }), 'commit_changed');
check('apply refusals wrote nothing', !(await exists('gadgets')) && !(await exists('migration_attempts')));

let attemptSeen = null;
const r110 = await apply(p110.plan_token, { onAttempt: (id) => { attemptSeen = id; }, apiCheck: async ({ table }) => ({ ok: true, count: Number((await q1(`SELECT count(*)::int n FROM ${table}`)).n) }) });
check('apply: applied', r110.status === 'applied', JSON.stringify(r110).slice(0, 400));
const rec = await q1(`SELECT * FROM schema_migrations WHERE filename='110_add_gadgets.sql'`);
check('record: filename, sha256, applied_at, applied_by, commit_sha, status, checks hash, applied_via, verification all written',
  rec && rec.sha256 === p110.sha256 && rec.applied_at && rec.applied_by === OWNER.email && rec.commit_sha === COMMIT && rec.status === 'applied'
  && rec.checks_sha256 === p110.checks_sha256 && rec.applied_via === 'owner_single_apply' && rec.error === null && rec.verification && rec.verification.verify[0].ok);
const att = await q1(`SELECT * FROM migration_attempts WHERE id=$1`, [attemptSeen]);
check('attempt log: one row, applied, with the plan nonce and requester', att && att.status === 'applied' && att.plan_nonce && att.requested_by === OWNER.email && att.finished_at);
check('apply: the objects and data exist', (await q1(`SELECT count(*)::int n FROM gadgets`)).n === 2);
check('apply: post-commit API check result is kept', r110.detail.api_checks[0].ok === true);
const again = await apply(p110.plan_token);
check('apply: replaying the same approval after success is "already applied", nothing re-run', again.status === 'already_applied' && (await q1(`SELECT count(*)::int n FROM gadgets`)).n === 2);
check('plan: an applied file reports already_applied and offers no token', (await plan('110_add_gadgets.sql')).status === 'already_applied' && !(await plan('110_add_gadgets.sql')).plan_token);

// ---- file changed after it was applied -> blocked ----
fs.appendFileSync(path.join(dir, '110_add_gadgets.sql'), '-- edited\n');
const pChanged = await plan('110_add_gadgets.sql');
check('plan: a recorded file whose hash changed is BLOCKED for review', pChanged.status === 'blocked' && /DIFFERENT hash/.test(pChanged.reason) && !pChanged.plan_token);

// ---- atomic failure: SQL error mid-migration ----
write('120_fails_midway.sql', `BEGIN;\nCREATE TABLE half (id int);\nINSERT INTO half VALUES (1);\nSELECT 1/0;\nCOMMIT;\n`, { objects: { added: ['table:half', 'column:half.id'], changed: [], removed: [] }, row_changes: { half: 1 } });
const p120 = await plan('120_fails_midway.sql');
const r120 = await apply(p120.plan_token);
check('failure: SQL error -> status failed', r120.status === 'failed' && /division by zero/.test(r120.error), JSON.stringify(r120));
check('failure: nothing from the migration exists and NOTHING is recorded', !(await exists('half')) && !(await q1(`SELECT 1 FROM schema_migrations WHERE filename='120_fails_midway.sql'`)));
check('failure: the attempt log says failed (never applied)', (await q1(`SELECT status FROM migration_attempts WHERE id=$1`, [r120.attempt_id])).status === 'failed');
await expectRefusal('failure: the same approval cannot be reused for a retry', () => apply(p120.plan_token), 'plan_used');

// ---- verification failures roll everything back ----
const verifyFail = async (file, sql, checks, name, re) => {
  write(file, sql, checks);
  const pl = await plan(file);
  const r = await apply(pl.plan_token);
  const recorded = !!(await q1(`SELECT 1 FROM schema_migrations WHERE filename=$1`, [file]));
  check(name, r.status === 'verify_failed' && re.test(r.error) && !recorded, JSON.stringify({ status: r.status, error: r.error }));
  return r;
};
const v1 = await verifyFail('130_wrong_verify.sql', `BEGIN;\nCREATE TABLE things (id int);\nCOMMIT;\n`,
  { objects: { added: ['table:things', 'column:things.id'], changed: [], removed: [] }, verify: [{ name: 'has 5 things', sql: 'SELECT count(*)::int FROM things', expect: 5 }] },
  'verify: a failed check rolls back the migration and records nothing', /has 5 things/);
check('verify: the migration\'s own objects were rolled back too', !(await exists('things')));
check('verify: attempt log says verify_failed', (await q1(`SELECT status FROM migration_attempts WHERE id=$1`, [v1.attempt_id])).status === 'verify_failed');
await verifyFail('131_surprise_object.sql', `BEGIN;\nCREATE TABLE declared (id int);\nCREATE TABLE surprise (id int);\nCOMMIT;\n`,
  { objects: { added: ['table:declared', 'column:declared.id'], changed: [], removed: [] } }, 'verify: an undeclared new object rolls back', /unexpected added objects: .*table:surprise/);
await verifyFail('132_undeclared_write.sql', `BEGIN;\nUPDATE widgets SET name = 'b' WHERE id = 1;\nCOMMIT;\n`,
  { protected: [{ table: 'ledger', order_by: 'id' }] }, 'verify: rows written in an undeclared table roll back', /undeclared tables: widgets/);
await verifyFail('133_protected_change.sql', `BEGIN;\nUPDATE ledger SET amount = amount + 1 WHERE id = 2;\nCOMMIT;\n`,
  { row_changes: { ledger: 0 } }, 'verify: a change to a protected table rolls back', /protected table ledger changed/);
check('verify failures left ledger untouched', (await q1(`SELECT sum(amount)::int s FROM ledger`)).s === 300 && (await q1(`SELECT name FROM widgets WHERE id=1`)).name === 'a');
await verifyFail('134_wrong_delta.sql', `BEGIN;\nINSERT INTO widgets (id, name) VALUES (2, 'z'), (3, 'y');\nCOMMIT;\n`,
  { row_changes: { widgets: 1 } }, 'verify: a row count different from the declared delta rolls back', /widgets: expected net 1 rows, got 2/);
await verifyFail('135_missing_object.sql', `BEGIN;\nCREATE TABLE only_one (id int);\nCOMMIT;\n`,
  { objects: { added: ['table:only_one', 'column:only_one.id', 'table:promised'], changed: [], removed: [] } }, 'verify: a promised object that was not created rolls back', /not seen: table:promised/);

// ---- dependencies / preflight / prior failed record ----
write('140_needs_missing.sql', `BEGIN;\nCREATE TABLE t140 (id int);\nCOMMIT;\n`, { requires: ['100_base.sql', '139_not_applied.sql'] });
const p140 = await plan('140_needs_missing.sql');
check('plan: missing dependency is BLOCKED', p140.status === 'blocked' && /139_not_applied/.test(p140.reason) && !p140.plan_token);
write('141_preflight_fails.sql', `BEGIN;\nCREATE TABLE t141 (id int);\nCOMMIT;\n`, { preflight: [{ name: 'ledger must be empty', sql: 'SELECT count(*)::int FROM ledger', expect: 0 }] });
const p141 = await plan('141_preflight_fails.sql');
check('plan: a failed preflight is BLOCKED with the reason', p141.status === 'blocked' && /ledger must be empty/.test(p141.reason) && p141.preflight[0].got === 2);
write('150_prior_error.sql', `BEGIN;\nCREATE TABLE t150 (id int);\nCOMMIT;\n`, { objects: { added: ['table:t150', 'column:t150.id'], changed: [], removed: [] } });
await db.query(`INSERT INTO schema_migrations (filename, sha256, error) VALUES ('150_prior_error.sql', 'old', 'failed long ago')`);
const p150 = await plan('150_prior_error.sql');
check('plan: an old failed-attempt row (bulk-runner era) counts as NOT applied', p150.status === 'ready' && /failed long ago/.test(p150.prior_failed_record));
const r150 = await apply(p150.plan_token);
check('apply: success replaces the old error row with a clean applied record', r150.status === 'applied' && (await q1(`SELECT error, status FROM schema_migrations WHERE filename='150_prior_error.sql'`)).status === 'applied');

// ---- file edited between review and approval ----
write('160_edit_after_plan.sql', `BEGIN;\nCREATE TABLE t160 (id int);\nCOMMIT;\n`, { objects: { added: ['table:t160', 'column:t160.id'], changed: [], removed: [] } });
const p160 = await plan('160_edit_after_plan.sql');
fs.writeFileSync(path.join(dir, '160_edit_after_plan.sql'), `BEGIN;\nCREATE TABLE t160 (id int);\nDROP TABLE ledger;\nCOMMIT;\n`);
await expectRefusal('apply: a file changed after review is refused (hash bound)', () => apply(p160.plan_token), 'hash_changed');
check('apply: ledger survived', await exists('ledger'));

// ---- attempt log is append-only; stale running attempts reconcile ----
let blocked = false; try { await db.query(`UPDATE migration_attempts SET status='applied' WHERE id=$1`, [r120.attempt_id]); } catch (_) { blocked = true; }
check('attempt log: a failed attempt cannot be flipped to applied', blocked);
blocked = false; try { await db.query(`DELETE FROM migration_attempts`); } catch (_) { blocked = true; }
check('attempt log: attempts cannot be deleted', blocked);
await db.query(`INSERT INTO migration_attempts (filename, sha256, plan_nonce, requested_by, status, started_at) VALUES ('170_x.sql', 'h', 'n170', 'o', 'running', now() - interval '1 hour')`);
const stale = await A.getAttempt(client, (await q1(`SELECT id FROM migration_attempts WHERE plan_nonce='n170'`)).id);
check('attempt: a stale running attempt with no tracker row reads as abandoned (nothing applied)', /abandoned/.test(stale.reconciled));

// ---- plan signing: dedicated MIGRATION_PLAN_SECRET only ----
const savedEnv = { s: process.env.MIGRATION_PLAN_SECRET, d: process.env.DATABASE_URL };
delete process.env.MIGRATION_PLAN_SECRET;
process.env.DATABASE_URL = 'postgres://user:pw@db.example:5432/postgres';
await expectRefusal('secret: plan refused when MIGRATION_PLAN_SECRET is missing (DATABASE_URL is never used as a key)', () => A.planMigration({ ...ctx, secret: undefined, filename: '160_edit_after_plan.sql' }), 'no_secret');
await expectRefusal('secret: apply refused when MIGRATION_PLAN_SECRET is missing', () => A.applyMigration({ ...ctx, secret: undefined, planToken: p110.plan_token }), 'no_secret');
process.env.MIGRATION_PLAN_SECRET = 'too-short';
await expectRefusal('secret: a short MIGRATION_PLAN_SECRET is refused', () => A.planMigration({ ...ctx, secret: undefined, filename: '160_edit_after_plan.sql' }), 'weak_secret');
process.env.MIGRATION_PLAN_SECRET = 'x'.repeat(40);
write('180_env_secret.sql', `BEGIN;\nCREATE TABLE t180 (id int);\nCOMMIT;\n`, { objects: { added: ['table:t180', 'column:t180.id'], changed: [], removed: [] } });
const p180 = await A.planMigration({ ...ctx, secret: undefined, filename: '180_env_secret.sql' });
check('secret: with MIGRATION_PLAN_SECRET set, plan is ready', p180.status === 'ready' && p180.plan_token);
await expectRefusal('secret: a token signed with a different secret is refused', () => A.applyMigration({ ...ctx, secret: 'another-secret', planToken: p180.plan_token }), 'bad_plan');
if (savedEnv.s === undefined) delete process.env.MIGRATION_PLAN_SECRET; else process.env.MIGRATION_PLAN_SECRET = savedEnv.s;
if (savedEnv.d === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = savedEnv.d;

// ---- documented atomicity: bootstrap commits separately; migration + record are atomic ----
const db2 = new PGlite();
const client2 = { query: async (sql, params) => {
  if (params) { const r = await db2.query(sql, params.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : v))); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; }
  const rs = await db2.exec(sql); const last = rs[rs.length - 1] || { rows: [] }; return { rows: last.rows, rowCount: last.affectedRows ?? 0 };
} };
await db2.exec(`CREATE TABLE schema_migrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), filename text NOT NULL UNIQUE, sha256 text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, duration_ms integer, error text);
  INSERT INTO schema_migrations (filename, sha256) VALUES ('100_base.sql', 'x');
  CREATE TABLE ledger (id int PRIMARY KEY, amount int);`);
const ctx2 = { ...ctx, client: client2 };
const pf = await A.planMigration({ ...ctx2, filename: '120_fails_midway.sql' });
const rf = await A.applyMigration({ ...ctx2, planToken: pf.plan_token, log: { error() {} } });
const q2 = async (sql) => (await db2.query(sql)).rows[0];
check('atomicity: first-ever apply fails -> migration changes rolled back, nothing recorded', rf.status === 'failed'
  && !(await q2(`SELECT 1 x FROM information_schema.tables WHERE table_name = 'half'`)) && !(await q2(`SELECT 1 x FROM schema_migrations WHERE filename = '120_fails_midway.sql'`)));
check('atomicity: the tracker bootstrap (bookkeeping) committed separately and stays in place', !!(await q2(`SELECT 1 x FROM information_schema.tables WHERE table_name = 'migration_attempts'`))
  && !!(await q2(`SELECT 1 x FROM information_schema.columns WHERE table_name = 'schema_migrations' AND column_name = 'commit_sha'`))
  && (await q2(`SELECT status FROM migration_attempts WHERE id = '${rf.attempt_id}'`)).status === 'failed');

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(dir, { recursive: true, force: true });
process.exitCode = fail ? 1 : 0;
