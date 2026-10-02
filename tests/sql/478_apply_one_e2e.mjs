// tests/sql/478_apply_one_e2e.mjs — migration 478 (W-9 secure-form provenance,
// Issue #14) applied END TO END through the single-migration tool with its REAL
// checks file. Proves:
//   - the checks file matches exactly what 478 does (objects, no row changes);
//   - existing requests read 'ach' and existing documents are untouched;
//   - an unknown request kind or document source is rejected;
//   - a 'secure_form' document must name its request;
//   - one secure-form request can file at most ONE document (retry/duplicate);
//   - the request behind a document cannot be deleted (provenance);
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
catch (_) { console.log('SKIP  478 end-to-end apply rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const F = '478_w9_secure_form_provenance.sql';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm478-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`));
const PRINT = process.argv.includes('--print-objects');
const V1 = '00000000-0000-0000-0000-0000000000a1';
const R1 = '00000000-0000-0000-0000-0000000000c1';
const D0 = '00000000-0000-0000-0000-0000000000d0';

async function buildWorld({ preColumn = false } = {}) {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE vendors (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, w9_on_file boolean DEFAULT false);
    CREATE TABLE vendor_ach_requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), vendor_id uuid REFERENCES vendors(id) ON DELETE SET NULL,
      vendor_name text NOT NULL, token_hash text NOT NULL UNIQUE, status text NOT NULL DEFAULT 'sent');
    CREATE TABLE vendor_documents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), vendor_id uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
      doc_type text NOT NULL, file_name text, file_url text, notes text, uploaded_at timestamptz NOT NULL DEFAULT now(),
      file_hash text, content_hash text, is_current boolean NOT NULL DEFAULT true, superseded_at timestamptz);
    CREATE UNIQUE INDEX uq_vendor_w9_current ON vendor_documents (vendor_id) WHERE is_current = TRUE AND doc_type = 'w9';
    CREATE TABLE journal_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE TABLE ap_payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE TABLE schema_migrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), filename text NOT NULL UNIQUE, sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, duration_ms integer, error text);
    INSERT INTO vendors (id, name, w9_on_file) VALUES ('${V1}', 'Lawn Co', true);
    INSERT INTO vendor_ach_requests (id, vendor_id, vendor_name, token_hash, status) VALUES ('${R1}', '${V1}', 'Lawn Co', 'h1', 'submitted');
    INSERT INTO vendor_documents (id, vendor_id, doc_type, file_name, is_current) VALUES ('${D0}', '${V1}', 'w9', 'old-w9.pdf', true);
    INSERT INTO schema_migrations (filename, sha256) VALUES ('477_vendor_tax_reporting_status.sql', 'recorded');`);
  if (preColumn) await db.exec(`ALTER TABLE vendor_ach_requests ADD COLUMN request_kind text;`);
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
const beforeDocs = await q1(`SELECT json_agg(row_to_json(d) ORDER BY id)::text j FROM vendor_documents d`);
const plan = await A.planMigration({ ...ctx(client), filename: F });
if (PRINT) { console.log(JSON.stringify(plan.objects, null, 2)); process.exit(0); }
check('plan: ready, every preflight passes', plan.status === 'ready' && plan.preflight.every((p) => p.ok), JSON.stringify({ status: plan.status, error: plan.error }).slice(0, 600));
const r = await A.applyMigration({ ...ctx(client), planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) });
check('apply: 478 applied and verified through the tool', r.status === 'applied', JSON.stringify({ status: r.status, error: r.error }));

if (r.status === 'applied') {
  const afterDocs = await q1(`SELECT json_agg((row_to_json(d)::jsonb - ARRAY['source','vendor_ach_request_id']) ORDER BY id)::text j FROM vendor_documents d`);
  const canon = (s) => JSON.stringify(JSON.parse(s).map((o) => Object.keys(o).sort().map((k) => [k, o[k]])));
  check('existing documents unchanged (old columns identical, source/link NULL)', canon(afterDocs.j) === canon(beforeDocs.j)
    && (await q1(`SELECT count(*)::int n FROM vendor_documents WHERE source IS NULL AND vendor_ach_request_id IS NULL`)).n === 1);
  check('existing request reads ach', (await q1(`SELECT request_kind k FROM vendor_ach_requests WHERE id = '${R1}'`)).k === 'ach');
  check('rule: an unknown request kind is rejected', /request_kind_check/.test(await tryErr(`UPDATE vendor_ach_requests SET request_kind = 'banking' WHERE id = '${R1}'`) || ''));
  check('rule: an unknown document source is rejected', /vendor_documents_source_check/.test(await tryErr(`UPDATE vendor_documents SET source = 'email' WHERE id = '${D0}'`) || ''));
  check('rule: a secure_form document must name its request',
    /secure_form_provenance/.test(await tryErr(`INSERT INTO vendor_documents (vendor_id, doc_type, is_current, source) VALUES ('${V1}', 'w9', false, 'secure_form')`) || ''));
  const ok1 = await tryErr(`INSERT INTO vendor_documents (vendor_id, doc_type, is_current, source, vendor_ach_request_id, file_name) VALUES ('${V1}', 'w9', false, 'secure_form', '${R1}', 'new-w9.pdf')`);
  check('a secure_form document with its request is accepted', ok1 === null, ok1 || '');
  check('idempotency: a SECOND document for the same request is rejected (retry / duplicate submit)',
    /uq_vendor_documents_ach_request|duplicate key/.test(await tryErr(`INSERT INTO vendor_documents (vendor_id, doc_type, is_current, source, vendor_ach_request_id) VALUES ('${V1}', 'w9', false, 'secure_form', '${R1}')`) || ''));
  check('provenance: the request behind a document cannot be deleted',
    /foreign key|violates/.test(await tryErr(`DELETE FROM vendor_ach_requests WHERE id = '${R1}'`) || ''));
  check('staff_upload source is accepted without a request', (await tryErr(`UPDATE vendor_documents SET source = 'staff_upload' WHERE id = '${D0}'`)) === null);
}

const drift = await buildWorld({ preColumn: true });
const plan2 = await A.planMigration({ ...ctx(drift.client), filename: F });
check('drift: an existing request_kind column BLOCKS the plan (preflight), no token', plan2.status !== 'ready' && !plan2.plan_token, JSON.stringify({ status: plan2.status }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
