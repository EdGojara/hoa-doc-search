// tests/sql/489_apply_one_e2e.mjs — migration 489 (Amanda Operating Manager
// Phase 1, Issue #27) applied END TO END through the single-migration tool with
// its REAL checks file, on top of the REAL migration 399 (objectives). Proves:
//   - the checks file matches exactly what 489 does; existing objectives and
//     their history are untouched;
//   - the exact rows lib/manager/state.js and lib/manager/wake.js write are
//     accepted by the production constraints, and bad shapes are rejected
//     (BLOCK without a reason, unknown class/domain/owner, a second OPEN
//     objective for the same subject, a duplicate wake);
//   - every wake outcome / objective_events kind the code emits is allowed;
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
catch (_) { console.log('SKIP  489 end-to-end apply rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const F = '489_amanda_manager_phase1.sql';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm489-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`));
const PRINT = process.argv.includes('--print-objects');
const C1 = '11111111-1111-4111-8111-111111111111';

async function buildWorld({ preColumn = false } = {}) {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE communities (id uuid PRIMARY KEY);
    INSERT INTO communities VALUES ('${C1}');
    CREATE TABLE schema_migrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), filename text NOT NULL UNIQUE, sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, duration_ms integer, error text);
    INSERT INTO schema_migrations (filename, sha256) VALUES ('488_onboarding_execute.sql', 'recorded');`);
  await db.exec(lf(`${REPO}/migrations/399_objectives.sql`));
  await db.exec(`INSERT INTO objectives (id, community_id, title, objective_type, owner_persona, status, resident_email, next_action, next_action_due)
      VALUES ('22222222-2222-4222-8222-222222222222', '${C1}', 'Fence complaint follow-up', 'homeowner_issue', 'amanda', 'open', 'owner@example.test', 'Call back', now() + interval '1 day');
    INSERT INTO objective_events (objective_id, actor, kind, summary) VALUES ('22222222-2222-4222-8222-222222222222', 'amanda', 'opened', 'Fence complaint');`);
  if (preColumn) await db.exec(`ALTER TABLE objectives ADD COLUMN subject_key text;`);
  const client = { query: async (sql, params) => {
    if (params) { const r = await db.query(sql, params.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : v))); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; }
    const rs = await db.exec(sql); const last = rs[rs.length - 1] || { rows: [] }; return { rows: last.rows, rowCount: last.affectedRows ?? 0 };
  } };
  return { db, client };
}

const OWNER = { id: 'owner-uuid', email: 'owner@example.test' };
const ctx = (client) => ({ client, user: OWNER, deployedCommit: 'deadbeefcafe', migrationsDir: dir, secret: 'e2e' });
const { db, client } = await buildWorld();
const tryErr = async (sql, params) => { try { await db.query(sql, params); return null; } catch (e) { return e.message; } };
const snap = async () => JSON.stringify((await db.query(`SELECT row_to_json(o)::text j FROM objectives o ORDER BY id`)).rows) + JSON.stringify((await db.query(`SELECT row_to_json(e)::text j FROM objective_events e ORDER BY id`)).rows);
const before = await snap();
const plan = await A.planMigration({ ...ctx(client), filename: F });
if (PRINT) { console.log(JSON.stringify(plan.objects, null, 2)); process.exit(0); }
check('plan: ready, every preflight passes', plan.status === 'ready' && plan.preflight.every((p) => p.ok), JSON.stringify({ status: plan.status, error: plan.error, pre: plan.preflight }).slice(0, 800));
const r = await A.applyMigration({ ...ctx(client), planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) });
check('apply: 489 applied and verified through the tool', r.status === 'applied', JSON.stringify({ status: r.status, error: r.error }));

if (r.status === 'applied') {
  const strip = (s) => s.replace(/,\\?"(owner_kind|owner_key|accountable_persona|domain|priority|autonomy_class|blocked_reason|depends_on|wake_reason|subject_key|subject_refs|needs_reasoning|state_hash)\\?":(null|false)/g, '');
  check('existing objective and its history unchanged (new columns NULL / false)', strip(await snap()) === strip(before));

  // The exact objective row lib/manager/state.js inserts (REVIEW / BLOCK).
  const objRow = (o = {}) => ({ title: 'Check coding: bill A-1 ($125.00)', objective_type: 'ap', owner_kind: 'workflow', owner_key: 'ap.intake', accountable_persona: 'amanda', owner_persona: 'amanda',
    domain: 'ap', priority: 'normal', autonomy_class: 'REVIEW', blocked_reason: null, depends_on: null, subject_key: 'ap_invoice:inv-1', subject_refs: { table: 'ap_invoices', id: 'inv-1' },
    needs_reasoning: false, next_action: 'A person checks the coding / payee before approval.', next_action_due: null, community_id: C1, state_hash: 'a'.repeat(64),
    status: 'open', goal: 'new payee', wake_reason: 'loaded', last_activity_at: new Date().toISOString(), ...o });
  const ins = (table, row) => { const cols = Object.keys(row); return tryErr(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, cols.map((k) => (row[k] && typeof row[k] === 'object' ? JSON.stringify(row[k]) : row[k]))); };
  check('state.js REVIEW row accepted', (await ins('objectives', objRow())) === null);
  check('state.js BLOCK row with dependency accepted', (await ins('objectives', objRow({ subject_key: 'ap_exception:e-1', autonomy_class: 'BLOCK', blocked_reason: 'Payables needs to supply the community this bill belongs to before this bill can load.', depends_on: [{ table: 'ap_intake_exceptions', id: 'e-1', condition: 'not_pending' }] }))) === null);
  check('board-packet row (domain board, type board, due instant) accepted', (await ins('objectives', objRow({ subject_key: 'board_packet:bp-1', objective_type: 'board', domain: 'board', owner_key: 'board.packet', priority: 'high', next_action_due: '2026-10-07T05:00:00.000Z' }))) === null);
  check('rule: a BLOCK without a reason is rejected', /objectives_block_has_reason/.test(await ins('objectives', objRow({ subject_key: 'ap_exception:e-2', autonomy_class: 'BLOCK', blocked_reason: null })) || ''));
  check('rule: a second OPEN objective for the same subject is rejected', /uq_objectives_open_subject|duplicate key/.test(await ins('objectives', objRow()) || ''));
  await db.query(`UPDATE objectives SET status = 'resolved', closed_at = now() WHERE subject_key = 'ap_invoice:inv-1'`);
  check('after resolve, the same subject may open again (only OPEN is unique)', (await ins('objectives', objRow())) === null);
  check('rule: unknown autonomy class rejected', /objectives_autonomy_class_check/.test(await ins('objectives', objRow({ subject_key: 'x:1', autonomy_class: 'MAYBE' })) || ''));
  check('rule: unknown domain rejected', /objectives_domain_check/.test(await ins('objectives', objRow({ subject_key: 'x:2', domain: 'marketing' })) || ''));
  check('rule: unknown owner kind rejected', /objectives_owner_kind_check/.test(await ins('objectives', objRow({ subject_key: 'x:3', owner_kind: 'robot' })) || ''));
  check('old objective types still allowed (homeowner_issue without any new field)', (await tryErr(`INSERT INTO objectives (title, objective_type) VALUES ('legacy', 'homeowner_issue')`)) === null);
  const oid = (await db.query(`SELECT id FROM objectives WHERE subject_key = 'ap_exception:e-1'`)).rows[0].id;
  for (const kind of ['opened', 'status_change', 'reattached', 'note', 'closed']) check(`objective_events kind '${kind}' (emitted by state.js) accepted`, (await tryErr(`INSERT INTO objective_events (objective_id, actor, kind, summary) VALUES ($1, 'amanda', $2, 'x')`, [oid, kind])) === null);

  // The exact wake row lib/manager/wake.js upserts, and the dedup it relies on.
  const wake = { community_id: C1, kind: 'ap_invoice', source_table: 'ap_invoices', source_id: 'inv-1', wake_reason: 'loaded', dedup_key: 'ap_invoice:inv-1:abc', status: 'pending' };
  check('wake.js row accepted', (await ins('manager_wakes', wake)) === null);
  const cols = Object.keys(wake);
  await db.query(`INSERT INTO manager_wakes (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) ON CONFLICT (dedup_key) DO NOTHING`, cols.map((k) => wake[k]));
  check('duplicate wake is a no-op under ON CONFLICT (dedup_key) DO NOTHING', (await db.query(`SELECT count(*)::int n FROM manager_wakes`)).rows[0].n === 1);
  for (const outcome of ['no_action', 'execute_candidate', 'review', 'block', 'resolved', 'unchanged', 'source_missing']) {
    check(`wake outcome '${outcome}' (emitted by sweep.js) accepted`, (await tryErr(`UPDATE manager_wakes SET status = 'consumed', outcome = $1, consumed_at = now() WHERE dedup_key = 'ap_invoice:inv-1:abc'`, [outcome])) === null);
  }
  check('rule: unknown wake kind rejected', /manager_wakes_kind_check/.test(await ins('manager_wakes', { ...wake, kind: 'email', dedup_key: 'k2' }) || ''));
}

const drift = await buildWorld({ preColumn: true });
const plan2 = await A.planMigration({ ...ctx(drift.client), filename: F });
check('drift: an existing subject_key column BLOCKS the plan (preflight), no token', plan2.status !== 'ready' && !plan2.plan_token, JSON.stringify({ status: plan2.status }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
