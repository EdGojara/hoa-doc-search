// tests/sql/477_apply_one_e2e.mjs — migration 477 (vendor tax reporting status,
// Issue #14) applied END TO END through the single-migration tool with its REAL
// checks file. Proves:
//   - the checks file matches exactly what 477 does (objects, no row changes);
//   - existing vendors are untouched and read 'unknown';
//   - an exemption without its provenance is rejected; with it, accepted;
//   - every change to the tax fields is audited (before/after), and an
//     unrelated vendor edit is not;
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
catch (_) { console.log('SKIP  477 end-to-end apply rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const F = '477_vendor_tax_reporting_status.sql';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm477-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`));
const PRINT = process.argv.includes('--print-objects');
const V1 = '00000000-0000-0000-0000-0000000000a1';

async function buildWorld({ preColumn = false } = {}) {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE vendors (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, kind text DEFAULT 'vendor',
      w9_on_file boolean DEFAULT false, tax_classification text, is_legal_counsel boolean DEFAULT false, is_mud boolean DEFAULT false, reimbursee_contact_id uuid,
      email text, notes text);
    CREATE TABLE vendor_documents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), vendor_id uuid REFERENCES vendors(id), doc_type text);
    CREATE TABLE journal_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE TABLE ap_payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE TABLE ap_invoices (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE TABLE schema_migrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), filename text NOT NULL UNIQUE, sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, duration_ms integer, error text);
    INSERT INTO vendors (id, name, w9_on_file, tax_classification) VALUES ('${V1}', 'Lawn Co', true, 'c_corporation');
    INSERT INTO vendors (name) VALUES ('DJ (individual)');
    INSERT INTO schema_migrations (filename, sha256) VALUES ('476_agent_runs_model_telemetry.sql', 'recorded');`);
  if (preColumn) await db.exec(`ALTER TABLE vendors ADD COLUMN tax_reporting_status text;`);
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
const before = await q1(`SELECT json_agg(row_to_json(v) ORDER BY name)::text j FROM vendors v`);
const plan = await A.planMigration({ ...ctx(client), filename: F });
if (PRINT) { console.log(JSON.stringify(plan.objects, null, 2)); process.exit(0); }
check('plan: ready, every preflight passes', plan.status === 'ready' && plan.preflight.every((p) => p.ok), JSON.stringify({ status: plan.status, error: plan.error }).slice(0, 600));
const r = await A.applyMigration({ ...ctx(client), planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) });
check('apply: 477 applied and verified through the tool', r.status === 'applied', JSON.stringify({ status: r.status, error: r.error }));

if (r.status === 'applied') {
  const NEW = ['tax_reporting_status', 'tax_exemption_basis', 'tax_exemption_source', 'tax_exemption_document_id', 'tax_exemption_verified_by', 'tax_exemption_verified_at', 'tax_exemption_note', 'is_medical_provider'];
  const after = await q1(`SELECT json_agg((row_to_json(v)::jsonb - ARRAY[${NEW.map((c) => `'${c}'`).join(',')}]) ORDER BY name)::text j FROM vendors v`);
  const canon = (s) => JSON.stringify(JSON.parse(s).map((o) => Object.keys(o).sort().map((k) => [k, o[k]])));
  check('existing vendors unchanged (old columns identical)', canon(after.j) === canon(before.j), `${after.j} vs ${before.j}`);
  const st = await q1(`SELECT count(*)::int n FROM vendors WHERE tax_reporting_status = 'unknown' AND NOT is_medical_provider`);
  check('every existing vendor reads unknown / not medical', st.n === 2);

  check('rule: exempt_verified WITHOUT provenance is rejected',
    /vendors_tax_exempt_provenance/.test(await tryErr(`UPDATE vendors SET tax_reporting_status = 'exempt_verified', tax_exemption_basis = 'corporation' WHERE id = '${V1}'`) || ''));
  check('rule: an unknown basis is rejected', /vendors_tax_exemption_basis_check/.test(await tryErr(`UPDATE vendors SET tax_exemption_basis = 'big company' WHERE id = '${V1}'`) || ''));
  check('rule: an unknown status is rejected', /vendors_tax_reporting_status_check/.test(await tryErr(`UPDATE vendors SET tax_reporting_status = 'probably_fine' WHERE id = '${V1}'`) || ''));
  await db.query(`INSERT INTO vendor_documents (id, vendor_id, doc_type) VALUES ('00000000-0000-0000-0000-0000000000d1', '${V1}', 'w9')`);
  const okErr = await tryErr(`UPDATE vendors SET tax_reporting_status = 'exempt_verified', tax_exemption_basis = 'corporation', tax_exemption_source = 'w9_document',
      tax_exemption_document_id = '00000000-0000-0000-0000-0000000000d1', tax_exemption_verified_by = 'reviewer@example.test', tax_exemption_verified_at = now() WHERE id = '${V1}'`);
  check('rule: exempt_verified WITH basis + source + document + who/when is accepted', okErr === null, okErr || '');
  const ev = await q1(`SELECT count(*)::int n, max(changed_by) by, bool_and((before->>'tax_reporting_status') = 'unknown' AND (after->>'tax_reporting_status') = 'exempt_verified') ok FROM vendor_tax_status_events WHERE vendor_id = '${V1}'`);
  check('audit: the exemption change is recorded once, before/after, with who', ev.n === 1 && ev.ok && ev.by === 'reviewer@example.test', JSON.stringify(ev));
  await db.query(`UPDATE vendors SET email = 'ap@lawnco.example' WHERE id = '${V1}'`);
  const ev2 = await q1(`SELECT count(*)::int n FROM vendor_tax_status_events WHERE vendor_id = '${V1}'`);
  check('audit: an unrelated edit (email) is NOT recorded', ev2.n === 1);
  await db.query(`UPDATE vendors SET kind = 'reimbursement' WHERE name = 'DJ (individual)'`);
  const ev3 = await q1(`SELECT count(*)::int n, bool_and((before->>'kind') = 'vendor' AND (after->>'kind') = 'reimbursement') ok FROM vendor_tax_status_events e JOIN vendors v ON v.id = e.vendor_id WHERE v.name = 'DJ (individual)'`);
  check('audit: relabeling a payee as a reimbursement is recorded (no silent bypass)', ev3.n === 1 && ev3.ok, JSON.stringify(ev3));
  check('rule: the proof document cannot be deleted while it backs an exemption',
    /foreign key|violates/.test(await tryErr(`DELETE FROM vendor_documents WHERE id = '00000000-0000-0000-0000-0000000000d1'`) || ''));
}

const drift = await buildWorld({ preColumn: true });
const plan2 = await A.planMigration({ ...ctx(drift.client), filename: F });
check('drift: an existing tax_reporting_status column BLOCKS the plan (preflight), no token', plan2.status !== 'ready' && !plan2.plan_token, JSON.stringify({ status: plan2.status }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
