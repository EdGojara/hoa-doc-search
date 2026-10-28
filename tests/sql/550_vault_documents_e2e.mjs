// tests/sql/550_vault_documents_e2e.mjs — Owner Vault documents.
//
// Builds the pre-550 vault (Supabase roles with Supabase's default privileges;
// a NON-superuser app_owner that owns the public objects and runs the
// migration; vault_entities as 365 made it) and proves:
//   APPLY   550 goes through lib/migrations/apply_one.js with its real checks
//           file (preflight, catalog diff, protected rows, verify); no vault
//           entity row changes.
//   ACCESS  anon and signed-in users cannot read or write a document, even with
//           Supabase's default privileges; the server can file, read and archive
//           but never delete one.
//   RULES   the same bytes file once per company; a bad category, blank title,
//           bad hash or bad tax year is refused; a company that has documents
//           cannot be deleted out from under them.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  550 vault documents e2e (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const F = '550_vault_documents.sql';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm550-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`));

const BEDROCK = '50000000-0000-4000-8000-000000000001';
const OTHER = '50000000-0000-4000-8000-000000000002';
const H1 = 'a'.repeat(64), H2 = 'b'.repeat(64);

const WORLD = `
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
  CREATE ROLE app_owner NOSUPERUSER NOBYPASSRLS;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  GRANT USAGE, CREATE ON SCHEMA public TO app_owner;
  -- Supabase's default privileges: every new table is granted to the API roles.
  ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  SET ROLE app_owner;
  CREATE OR REPLACE FUNCTION trusted_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
  CREATE TABLE vault_entities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
    entity_type text NOT NULL DEFAULT 's_corp' CHECK (entity_type IN ('s_corp','c_corp','llc','partnership','sole_prop','individual')),
    ein text, fiscal_year_end text NOT NULL DEFAULT '12-31', is_active boolean NOT NULL DEFAULT true, notes text,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
  REVOKE ALL ON vault_entities FROM anon, authenticated;
  CREATE TABLE schema_migrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), filename text NOT NULL UNIQUE, sha256 text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, duration_ms integer, error text);
  INSERT INTO schema_migrations (filename, sha256) VALUES ('365_owner_vault.sql', 'r');
  INSERT INTO vault_entities (id, name, entity_type) VALUES ('${BEDROCK}', 'Bedrock Association Management, LLC', 'llc'), ('${OTHER}', 'Other Co', 'llc');
`;

const db = new PGlite();
await db.exec(WORLD);
const client = { query: async (sql, params) => {
  if (params) { const r = await db.query(sql, params.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : v))); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; }
  const rs = await db.exec(sql); const last = rs[rs.length - 1] || { rows: [] }; return { rows: last.rows, rowCount: last.affectedRows ?? 0 };
} };
async function as(who, sql) {
  const role = { service: 'service_role', anon: 'anon', auth: 'authenticated', app: 'app_owner' }[who] || null;
  await db.exec('RESET ROLE;' + (role ? ` SET ROLE ${role};` : ''));
  try { return { rows: (await db.query(sql)).rows, err: null }; }
  catch (e) { return { rows: [], err: e.message }; }
  finally { await db.exec('RESET ROLE; SET ROLE app_owner;'); }
}
const one = async (who, sql) => (await as(who, sql)).rows[0];
const denied = (r) => /permission denied/.test(r.err || '');

// ---- apply through the tool ---------------------------------------------------
const entBefore = (await one('owner', `SELECT md5(string_agg(x::text, '|' ORDER BY x::text)) h FROM vault_entities x`)).h;
const ctx = { client, user: { id: 'owner-uuid', email: 'owner@example.test' }, deployedCommit: 'deadbeefcafe', migrationsDir: dir, secret: 'e2e' };
const plan = await A.planMigration({ ...ctx, filename: F });
check('plan: ready, every preflight passes', plan.status === 'ready' && plan.preflight.every((p) => p.ok), JSON.stringify({ status: plan.status, error: plan.error, reason: plan.reason, preflight: plan.preflight }).slice(0, 1500));
const r = await A.applyMigration({ ...ctx, planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) });
check('apply: 550 applied and verified through the tool', r.status === 'applied', JSON.stringify({ status: r.status, error: r.error, detail: r.detail }).slice(0, 5000));
if (r.status !== 'applied') { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }
check('no vault entity row changed', (await one('owner', `SELECT md5(string_agg(x::text, '|' ORDER BY x::text)) h FROM vault_entities x`)).h === entBefore);

// ---- the server files, reads and archives ---------------------------------------
const ins = (who, { ent = BEDROCK, cat = 'correspondence', title = 'Business Use Letter', sha = H1, year = 'NULL', path = null } = {}) => as(who,
  `INSERT INTO vault_documents (entity_id, category, title, filename, original_filename, document_date, tax_year, storage_path, content_type, size_bytes, sha256, created_by)
   VALUES ('${ent}', '${cat}', '${title}', 'Bedrock_Association_Management_Business_Use_Letter_2026-10-28.pdf', 'letter.pdf', '2026-10-28', ${year},
           '${path || `owner-vault/${ent}/documents/${Math.random()}.pdf`}', 'application/pdf', 1234, '${sha}', 'owner@example.test') RETURNING id`);
const first = await ins('service');
check('the server files a document', !first.err && first.rows.length === 1, first.err);
const docId = first.rows[0] && first.rows[0].id;
check('the server reads it', (await as('service', `SELECT * FROM vault_documents`)).rows.length === 1);
const arch = await as('service', `UPDATE vault_documents SET archived_at = now() WHERE id = '${docId}' RETURNING archived_at, updated_at > created_at OR updated_at = created_at AS ok`);
check('the server archives it (and updated_at is kept)', !arch.err && arch.rows.length === 1 && arch.rows[0].archived_at, arch.err);
check('the server can never delete a document', denied(await as('service', `DELETE FROM vault_documents WHERE id = '${docId}'`)));

// ---- nobody else reaches it -------------------------------------------------------
check('anon cannot read documents', denied(await as('anon', `SELECT * FROM vault_documents`)));
check('a signed-in user cannot read documents', denied(await as('auth', `SELECT * FROM vault_documents`)));
check('a signed-in user cannot file a document', denied(await ins('auth', { sha: H2 })));
check('a signed-in user cannot archive or rename one', denied(await as('auth', `UPDATE vault_documents SET title = 'x'`)));
check('anon cannot delete one', denied(await as('anon', `DELETE FROM vault_documents`)));
check('row level security is on with no policies',
  (await one('owner', `SELECT (relrowsecurity AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'vault_documents'))::int ok FROM pg_class WHERE relname = 'vault_documents'`)).ok === 1);

// ---- the rules -----------------------------------------------------------------------
check('the same bytes file once per company', /duplicate key|unique/.test((await ins('service')).err || ''));
check('the same bytes may be filed for a different company', !(await ins('service', { ent: OTHER })).err);
check('an unknown category is refused', /check constraint/.test((await ins('service', { cat: 'random', sha: H2 })).err || ''));
check('a blank title is refused', /check constraint/.test((await ins('service', { title: '  ', sha: H2 })).err || ''));
check('a malformed hash is refused', /check constraint/.test((await ins('service', { sha: 'XYZ' })).err || ''));
check('a nonsense tax year is refused', /check constraint/.test((await ins('service', { sha: H2, year: 1850 })).err || ''));
check('a second document with the same storage path is refused', /duplicate key|unique/.test((await ins('service', { sha: H2, path: (await one('owner', `SELECT storage_path p FROM vault_documents WHERE id = '${docId}'`)).p })).err || ''));
check('a company with documents cannot be deleted out from under them',
  /foreign key|violates/.test((await as('owner', `DELETE FROM vault_entities WHERE id = '${BEDROCK}'`)).err || ''));

const replan = await A.planMigration({ ...ctx, filename: F });
check('re-planning after apply is refused as already applied', replan.status !== 'ready' && !replan.plan_token, JSON.stringify({ status: replan.status }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
