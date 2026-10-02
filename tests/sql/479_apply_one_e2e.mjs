// tests/sql/479_apply_one_e2e.mjs — migration 479 (ACC document manifest +
// current review, Issue #14) applied END TO END through the single-migration
// tool with its REAL checks file. Proves:
//   - the checks file matches exactly what 479 does (objects, no row changes);
//   - existing cases are untouched (old columns identical; empty manifest and
//     errors; no current review) and the original analysis is not altered;
//   - manifest / errors must be JSON arrays;
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
catch (_) { console.log('SKIP  479 end-to-end apply rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const F = '479_acc_document_manifest_current_review.sql';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm479-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`));
const PRINT = process.argv.includes('--print-objects');
const D1 = '00000000-0000-0000-0000-0000000000e1';

async function buildWorld({ preColumn = false } = {}) {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE acc_decisions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text, ai_review_text text, ai_recommendation text,
      ai_letter_body text, application_pdf_storage_path text, photo_storage_paths text[] DEFAULT ARRAY[]::text[], supporting_docs_storage_paths text[] DEFAULT ARRAY[]::text[]);
    CREATE TABLE ap_payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE TABLE journal_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE TABLE schema_migrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), filename text NOT NULL UNIQUE, sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, duration_ms integer, error text);
    INSERT INTO acc_decisions (id, status, ai_review_text, ai_recommendation, application_pdf_storage_path, photo_storage_paths)
      VALUES ('${D1}', 'pending_review', '| Survey | ❌ Not submitted |', 'request_more_info', 'acc_decisions/x/application.pdf', ARRAY['acc_decisions/x/photo_2.pdf']);
    INSERT INTO schema_migrations (filename, sha256) VALUES ('478_w9_secure_form_provenance.sql', 'recorded');`);
  if (preColumn) await db.exec(`ALTER TABLE acc_decisions ADD COLUMN document_manifest jsonb;`);
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
const before = await q1(`SELECT row_to_json(d)::text j FROM acc_decisions d WHERE id = '${D1}'`);
const plan = await A.planMigration({ ...ctx(client), filename: F });
if (PRINT) { console.log(JSON.stringify(plan.objects, null, 2)); process.exit(0); }
check('plan: ready, every preflight passes', plan.status === 'ready' && plan.preflight.every((p) => p.ok), JSON.stringify({ status: plan.status, error: plan.error }).slice(0, 600));
const r = await A.applyMigration({ ...ctx(client), planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) });
check('apply: 479 applied and verified through the tool', r.status === 'applied', JSON.stringify({ status: r.status, error: r.error }));

if (r.status === 'applied') {
  const NEW = ['document_manifest', 'document_intake_errors', 'current_review_text', 'current_ai_recommendation', 'current_letter_body', 'current_review_at', 'current_review_basis'];
  const after = await q1(`SELECT (row_to_json(d)::jsonb - ARRAY[${NEW.map((c) => `'${c}'`).join(',')}])::text j FROM acc_decisions d WHERE id = '${D1}'`);
  const canon = (s) => JSON.stringify(Object.entries(JSON.parse(s)).sort());
  check('existing case unchanged (old columns identical, original analysis intact)', canon(after.j) === canon(before.j), `${after.j} vs ${before.j}`);
  const n = await q1(`SELECT document_manifest::text m, document_intake_errors::text e, current_review_text t, current_review_at a FROM acc_decisions WHERE id = '${D1}'`);
  check('existing case: empty manifest and errors, no current review', n.m === '[]' && n.e === '[]' && n.t === null && n.a === null, JSON.stringify(n));
  check('rule: manifest must be an array', /document_manifest_is_array/.test(await tryErr(`UPDATE acc_decisions SET document_manifest = '{"a":1}'::jsonb WHERE id = '${D1}'`) || ''));
  check('rule: intake errors must be an array', /document_intake_errors_is_array/.test(await tryErr(`UPDATE acc_decisions SET document_intake_errors = '"x"'::jsonb WHERE id = '${D1}'`) || ''));
  const ok = await tryErr(`UPDATE acc_decisions SET document_manifest = '[{"filename":"Survey.pdf","kind":"supporting"}]'::jsonb, current_review_text = 'survey received', current_review_at = now() WHERE id = '${D1}'`);
  const still = await q1(`SELECT ai_review_text, ai_recommendation FROM acc_decisions WHERE id = '${D1}'`);
  check('a current review is stored ALONGSIDE the original analysis (original untouched)', ok === null && /Not submitted/.test(still.ai_review_text) && still.ai_recommendation === 'request_more_info', ok || JSON.stringify(still));
}

const drift = await buildWorld({ preColumn: true });
const plan2 = await A.planMigration({ ...ctx(drift.client), filename: F });
check('drift: an existing document_manifest column BLOCKS the plan (preflight), no token', plan2.status !== 'ready' && !plan2.plan_token, JSON.stringify({ status: plan2.status }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
