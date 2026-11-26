// tests/sql/577_owner_authorization_e2e.mjs — migration 577 (Owner Authorization Service, step 1)
// applied END TO END through the single-migration tool with its REAL checks file. Proves:
//   - the checks file matches exactly what 577 does (objects; no row data changes);
//   - existing owner authorizations read coordinator Amanda, tier 1; existing grants read time_limited;
//   - coordinator / executor / tier are fixed once requested; a tier-3 request cannot be authorized;
//   - time-limited grants stay at most 24 hours; standing authority needs a written policy and at most a year;
//   - a grant's kind and policy cannot change afterwards (only revocation);
//   - authorization_events is append-only and requires executor / authorizer / the answered event;
//   - drift blocks it (an existing authorization_events table stops the plan).
// Postgres 17 (PGlite 0.3.x). Skips without PGlite.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  577 end-to-end apply rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const F = '577_owner_authorization_service.sql';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm577-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`));
const C1 = '00000000-0000-0000-0000-0000000000c1';
const A1 = '00000000-0000-0000-0000-0000000000a1';
const G1 = '00000000-0000-0000-0000-0000000000b1';

async function buildWorld({ preTable = false } = {}) {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE communities (id uuid PRIMARY KEY, name text);
    CREATE TABLE journal_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE TABLE accounting_runs (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    -- owner_authorizations as 554 + 555 left it (the parts 577 touches)
    CREATE TABLE owner_authorizations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), scope text NOT NULL, subject text NOT NULL, summary text NOT NULL, items jsonb NOT NULL, items_sha256 text NOT NULL,
      owner_email text NOT NULL, requested_by text NOT NULL, requested_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
      status text NOT NULL DEFAULT 'requested', authorized_by_user_id text, authorized_by_email text, authorized_at timestamptz, evidence jsonb,
      executed_at timestamptz, execution jsonb, request_message_id text, request_conversation_id text, request_sent_at timestamptz);
    CREATE TABLE schema_migrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), filename text NOT NULL UNIQUE, sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, duration_ms integer, error text);
    INSERT INTO communities (id, name) VALUES ('${C1}', 'Test HOA');
    INSERT INTO owner_authorizations (id, scope, subject, summary, items, items_sha256, owner_email, requested_by, expires_at)
      VALUES ('${A1}', 'accounting_runs', 'Owner authorization TEST', 'a test request of one run', '[{"run_id":"r1"}]', 'x', 'owner@example.test', 'ai-team:kat', now() + interval '3 days');
    INSERT INTO schema_migrations (filename, sha256) VALUES ('556_owner_authorization_definer.sql', 'recorded'), ('566_owner_authorized_accounting_runs.sql', 'recorded'), ('567_owner_execution_grants.sql', 'recorded');`);
  // owner_execution_grants exactly as migration 567 creates it (table, window CHECK, guard).
  await db.exec(lf(`${REPO}/migrations/567_owner_execution_grants.sql`));
  await db.exec(`INSERT INTO owner_execution_grants (id, owner_user_id, owner_email, community_id, processes, max_run_cents, expires_at)
    VALUES ('${G1}', 'u1', 'owner@example.test', '${C1}', ARRAY['journal_entry'], 5000000, now() + interval '12 hours');`);
  if (preTable) await db.exec(`CREATE TABLE authorization_events (id uuid PRIMARY KEY);`);
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
const tryErr = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
const plan = await A.planMigration({ ...ctx(client), filename: F });
if (process.argv.includes('--print-objects')) { console.log(JSON.stringify(plan.objects, null, 2)); process.exit(0); }
check('plan: ready, every preflight passes', plan.status === 'ready' && plan.preflight.every((p) => p.ok), JSON.stringify({ status: plan.status, error: plan.error, preflight: plan.preflight }).slice(0, 900));
const r = await A.applyMigration({ ...ctx(client), planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) });
check('apply: 577 applied and verified through the tool', r.status === 'applied', JSON.stringify({ status: r.status, error: r.error }).slice(0, 900));

if (r.status === 'applied') {
  const a = await q1(`SELECT coordinator, executor, sensitivity_tier FROM owner_authorizations WHERE id = '${A1}'`);
  check('existing request: coordinator Amanda, tier 1, no executor', a.coordinator === 'ai-team:amanda' && a.sensitivity_tier === 1 && a.executor === null, JSON.stringify(a));
  check('existing grant reads time_limited', (await q1(`SELECT kind FROM owner_execution_grants WHERE id = '${G1}'`)).kind === 'time_limited');
  check('a request\'s coordinator is fixed', /fixed/.test(await tryErr(`UPDATE owner_authorizations SET coordinator = 'ai-team:kat' WHERE id = '${A1}'`) || ''));
  const A3 = '00000000-0000-0000-0000-0000000000a3';
  await db.exec(`INSERT INTO owner_authorizations (id, scope, subject, summary, items, items_sha256, owner_email, requested_by, expires_at, sensitivity_tier)
    VALUES ('${A3}', 'accounting_runs', 'Owner authorization T3', 'a tier three request test', '[{"run_id":"r3"}]', 'x', 'owner@example.test', 'ai-team:kat', now() + interval '1 day', 3)`);
  check('a tier-3 request cannot be authorized by reply', /tier-3/.test(await tryErr(`UPDATE owner_authorizations SET status = 'authorized', authorized_by_user_id = 'u1', authorized_by_email = 'owner@example.test', authorized_at = now() WHERE id = '${A3}'`) || ''));
  check('tier is limited to 1-3', /sensitivity_tier_check/.test(await tryErr(`INSERT INTO owner_authorizations (scope, subject, summary, items, items_sha256, owner_email, requested_by, expires_at, sensitivity_tier) VALUES ('accounting_runs', 'T4', 'a tier four test row', '[]', 'x', 'o@x', 'k', now() + interval '1 day', 4)`) || ''));
  const ins = (kind, hours, policy) => tryErr(`INSERT INTO owner_execution_grants (owner_user_id, owner_email, community_id, processes, max_run_cents, expires_at, kind, policy)
    VALUES ('u1', 'owner@example.test', '${C1}', ARRAY['journal_entry'], 100000, now() + interval '${hours} hours', '${kind}', ${policy ? `'${JSON.stringify(policy)}'` : 'NULL'})`);
  check('time-limited grant over 24 hours is rejected', /owner_execution_grants_window/.test(await ins('time_limited', 25) || ''));
  check('standing authority without a written policy is rejected', /owner_execution_grants_window/.test(await ins('standing', 24 * 200) || ''));
  check('standing authority over a year is rejected', /owner_execution_grants_window/.test(await ins('standing', 24 * 400, { description: 'Routine Kat runs under the close policy' }) || ''));
  check('standing authority with a policy, within a year, is accepted', (await ins('standing', 24 * 300, { description: 'Routine Kat runs under the close policy' })) === null);
  check('an unknown grant kind is rejected', /owner_execution_grants_kind_check/.test(await ins('forever', 1) || ''));
  check('a grant\'s kind cannot change afterwards', /cannot be changed/.test(await tryErr(`UPDATE owner_execution_grants SET kind = 'standing', policy = '{"description":"retroactive standing"}' WHERE id = '${G1}'`) || ''));
  check('a grant can still be revoked once', (await tryErr(`UPDATE owner_execution_grants SET revoked_at = now(), revoked_by = 'owner@example.test' WHERE id = '${G1}'`)) === null);
  const ev = (cols, vals) => tryErr(`INSERT INTO authorization_events (authority_kind, action_type, event${cols}) VALUES ('request', 'accounting_run'${vals})`);
  check('an event is recorded', (await ev(`, authorization_id, target_id, channel`, `, 'requested', '${A1}', 'r1', 'email'`)) === null);
  check('execution without the executing teammate is rejected', /executor_named/.test(await ev('', ", 'executed'") || ''));
  check('authorization without the authorizing person is rejected', /authorizer_named/.test(await ev('', ", 'authorized'") || ''));
  check('a report must name the event it answers', /report_links/.test(await ev('', ", 'reported'") || ''));
  check('an unknown channel is rejected', /channel_check/.test(await ev(', channel', ", 'requested', 'sms'") || ''));
  check('events are append-only (no update)', /permanent/.test(await tryErr(`UPDATE authorization_events SET note = 'changed'`) || ''));
  check('events are append-only (no delete)', /permanent/.test(await tryErr(`DELETE FROM authorization_events`) || ''));
}

const drift = await buildWorld({ preTable: true });
const plan2 = await A.planMigration({ ...ctx(drift.client), filename: F });
check('drift: an existing authorization_events table BLOCKS the plan (preflight), no token', plan2.status !== 'ready' && !plan2.plan_token, JSON.stringify({ status: plan2.status }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
