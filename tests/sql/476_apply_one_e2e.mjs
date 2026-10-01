// tests/sql/476_apply_one_e2e.mjs — migration 476 (AI model telemetry on the
// agent_runs trade tape, Issue #12) applied END TO END through the
// single-migration tool with its REAL checks file. Proves:
//   - the checks file matches exactly what 476 does (objects, no row changes);
//   - existing trade-tape rows are untouched;
//   - the exact row lib/ai/router.js writes is accepted, and malformed
//     model-call rows (no workflow / no outcome / fallback without a reason,
//     unknown run_kind) are rejected;
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
catch (_) { console.log('SKIP  476 end-to-end apply rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const F = '476_agent_runs_model_telemetry.sql';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm476-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`));
const PRINT = process.argv.includes('--print-objects');
const MC = '00000000-0000-0000-0000-000000000001';

async function buildWorld({ preColumn = false } = {}) {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE management_companies (id uuid PRIMARY KEY);
    CREATE TABLE communities (id uuid PRIMARY KEY);
    CREATE TABLE agent_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), management_company_id uuid NOT NULL REFERENCES management_companies(id),
      community_id uuid REFERENCES communities(id), module text NOT NULL, endpoint text, user_id uuid, request_input jsonb,
      retrieved_context jsonb, prompt text, model text, prompt_version text, playbook_version text, response jsonb,
      input_tokens integer, output_tokens integer, cost_usd numeric(10,6), duration_ms integer, downstream_action jsonb,
      error text, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE journal_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE TABLE homeowner_transactions (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE TABLE schema_migrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), filename text NOT NULL UNIQUE, sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, duration_ms integer, error text);
    INSERT INTO management_companies VALUES ('${MC}');
    INSERT INTO agent_runs (management_company_id, module, endpoint, model, prompt, input_tokens, output_tokens, duration_ms)
      VALUES ('${MC}', 'billing', 'POST /x', 'claude-sonnet-4-6', 'prompt text', 100, 50, 900);
    INSERT INTO schema_migrations (filename, sha256) VALUES ('475_historical_letter_recovery.sql', 'recorded');`);
  if (preColumn) await db.exec(`ALTER TABLE agent_runs ADD COLUMN workflow text;`);
  const client = { query: async (sql, params) => {
    if (params) { const r = await db.query(sql, params.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : v))); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; }
    const rs = await db.exec(sql); const last = rs[rs.length - 1] || { rows: [] }; return { rows: last.rows, rowCount: last.affectedRows ?? 0 };
  } };
  return { db, client };
}

const OWNER = { id: 'owner-uuid', email: 'owner@example.test' };
const ctx = (client) => ({ client, user: OWNER, deployedCommit: 'deadbeefcafe', migrationsDir: dir, secret: 'e2e' });
const { db, client } = await buildWorld();
const q1 = async (sql, params) => (await db.query(sql, params)).rows[0];
const tryErr = async (sql, params) => { try { await db.query(sql, params); return null; } catch (e) { return e.message; } };
const before = await q1(`SELECT row_to_json(a)::text j FROM agent_runs a`);
const plan = await A.planMigration({ ...ctx(client), filename: F });
if (PRINT) { console.log(JSON.stringify(plan.objects, null, 2)); process.exit(0); }
check('plan: ready, every preflight passes', plan.status === 'ready' && plan.preflight.every((p) => p.ok), JSON.stringify({ status: plan.status, error: plan.error }).slice(0, 600));
const r = await A.applyMigration({ ...ctx(client), planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) });
check('apply: 476 applied and verified through the tool', r.status === 'applied', JSON.stringify({ status: r.status, error: r.error }));

if (r.status === 'applied') {
  const after = await q1(`SELECT (row_to_json(a)::jsonb - ARRAY['run_kind','workflow','provider','requested_model','fallback_used','fallback_reason','route_source','ok','cache_read_tokens','cache_write_tokens'])::text j, run_kind, fallback_used FROM agent_runs a`);
  const canon = (s) => { const o = JSON.parse(s); return JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]])); };
  check('existing trade-tape row is unchanged (new columns NULL / false)', canon(after.j) === canon(before.j) && after.run_kind === null && after.fallback_used === false);

  // The exact shape lib/ai/router.js recordCall() inserts.
  const routerRow = (o = {}) => ({ management_company_id: MC, module: 'drv', endpoint: 'drv.citation', run_kind: 'model_call', workflow: 'drv.citation', provider: 'anthropic',
    requested_model: 'claude-sonnet-5', model: 'claude-sonnet-5', fallback_used: false, fallback_reason: null, route_source: 'config', ok: true,
    input_tokens: 1200, output_tokens: 300, cache_read_tokens: null, cache_write_tokens: null, cost_usd: 0.0054, duration_ms: 2100, error: null, prompt_version: '2026-10-01.v1', ...o });
  const ins = (o) => { const row = routerRow(o); const cols = Object.keys(row); return tryErr(`INSERT INTO agent_runs (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, cols.map((k) => row[k])); };
  check('router row: a successful model call is accepted', (await ins()) === null);
  check('router row: a failed call (executed model null, error text) is accepted', (await ins({ ok: false, model: null, error: '404 not_found_error: model: claude-sonnet-5' })) === null);
  check('router row: a logged fallback with its reason is accepted', (await ins({ requested_model: 'claude-sonnet-5', model: 'claude-sonnet-4-6', fallback_used: true, fallback_reason: 'primary claude-sonnet-5 unavailable' })) === null);
  check('rule: a fallback without a reason is rejected', /agent_runs_fallback_reason/.test(await ins({ fallback_used: true, fallback_reason: null }) || ''));
  check('rule: a model_call without a workflow is rejected', /agent_runs_model_call_shape/.test(await ins({ workflow: null }) || ''));
  check('rule: a model_call without an outcome is rejected', /agent_runs_model_call_shape/.test(await ins({ ok: null }) || ''));
  check('rule: an unknown run_kind is rejected', /agent_runs_run_kind_check/.test(await ins({ run_kind: 'other' }) || ''));
  check('legacy trade-tape inserts (no new columns) still work', (await tryErr(`INSERT INTO agent_runs (management_company_id, module, model) VALUES ('${MC}', 'help', 'claude-sonnet-5')`)) === null);
}

const drift = await buildWorld({ preColumn: true });
const plan2 = await A.planMigration({ ...ctx(drift.client), filename: F });
check('drift: an existing workflow column BLOCKS the plan (preflight), no token', plan2.status !== 'ready' && !plan2.plan_token, JSON.stringify({ status: plan2.status }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
