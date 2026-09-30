// tests/sql/475_apply_one_e2e.mjs — migration 475 (historical certified-letter
// recovery, Issue #11) applied END TO END through the single-migration tool
// (lib/migrations/apply_one.js) with its REAL checks file, on a stub world with
// existing interactions, violations, mail pieces and archive rows. Proves:
//   - the checks file matches exactly what 475 does (objects, no row changes,
//     protected tables untouched, verify);
//   - the recovery rules hold (key unique, hash format, reconstruction detail
//     required only for reconstructions, acceptance time on the receipt date);
//   - the seal: a recovered notice's interaction cannot be deleted or have its
//     mailing record changed, while other interactions (drafts) behave as before;
//   - append-only for the service role; browser roles have no access;
//   - drift blocks it (the table already present stops the plan).
// Postgres 17 (PGlite 0.3.x). Skips without PGlite.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  475 end-to-end apply rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const F = '475_historical_letter_recovery.sql';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };

const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm475-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`));
const PRINT = process.argv.includes('--print-objects');

const C = 'a0000000-0000-4000-8000-000000000001';
const P1 = 'c0000000-0000-4000-8000-000000000001';
const V1 = 'b0000000-0000-4000-8000-000000000001', V2 = 'b0000000-0000-4000-8000-000000000002';
const I_REJ = 'f0000000-0000-4000-8000-000000000001', I_SENT = 'f0000000-0000-4000-8000-000000000002', I_DRAFT = 'f0000000-0000-4000-8000-000000000003';

async function buildWorld({ preTable = false } = {}) {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE communities (id uuid PRIMARY KEY, name text);
    CREATE TABLE properties (id uuid PRIMARY KEY, community_id uuid, street_address text);
    CREATE TABLE violations (id uuid PRIMARY KEY, community_id uuid, property_id uuid, current_stage text);
    CREATE TABLE interactions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), community_id uuid NOT NULL REFERENCES communities(id),
      property_id uuid REFERENCES properties(id), violation_id uuid REFERENCES violations(id) ON DELETE SET NULL,
      type text NOT NULL, direction text, subject text, content text, delivery_method text, certified_tracking_number text,
      status text NOT NULL DEFAULT 'sent', sent_at timestamptz, printed_at timestamptz, notes text, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE letter_mail_pieces (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), interaction_id uuid NOT NULL UNIQUE REFERENCES interactions(id), community_id uuid);
    CREATE TABLE sent_letter_archive (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), interaction_id uuid, archive_path text NOT NULL UNIQUE, sha256 text NOT NULL);
    CREATE TABLE homeowner_transactions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), community_id uuid, amount_cents bigint);
    CREATE TABLE journal_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), community_id uuid, source_module text);
    CREATE TABLE schema_migrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), filename text NOT NULL UNIQUE, sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, duration_ms integer, error text);
    INSERT INTO communities VALUES ('${C}', 'Sample HOA');
    INSERT INTO properties VALUES ('${P1}', '${C}', '4101 Sample Meadow Dr');
    INSERT INTO violations VALUES ('${V1}', '${C}', '${P1}', 'voided'), ('${V2}', '${C}', '${P1}', 'certified_209');
    INSERT INTO interactions (id, community_id, property_id, violation_id, type, direction, content, delivery_method, status, created_at) VALUES
      ('${I_REJ}', '${C}', '${P1}', '${V1}', 'letter_209', 'outbound', '${V1}/certified_209-2026-07-30.pdf', 'certified_mail', 'rejected', '2026-07-30T20:51:12Z'),
      ('${I_SENT}', '${C}', '${P1}', '${V1}', 'letter_209', 'outbound', '${V1}/recovered.pdf', 'certified_mail', 'sent', now()),
      ('${I_DRAFT}', '${C}', '${P1}', '${V2}', 'letter_209', 'outbound', '${V2}/draft.pdf', 'certified_mail', 'draft', '2026-07-31T15:18:31Z');
    INSERT INTO letter_mail_pieces (interaction_id, community_id) VALUES ('${I_SENT}', '${C}');
    INSERT INTO sent_letter_archive (interaction_id, archive_path, sha256) VALUES ('${I_SENT}', 'x/y.pdf', '${'b'.repeat(64)}');
    INSERT INTO homeowner_transactions (community_id, amount_cents) VALUES ('${C}', 2500);
    INSERT INTO journal_entries (community_id, source_module) VALUES ('${C}', 'ar');
    INSERT INTO schema_migrations (filename, sha256) VALUES ('474_legal_invoice_extractions.sql', 'recorded');`);
  if (preTable) await db.exec(`CREATE TABLE letter_recovery_records (id uuid PRIMARY KEY);`);
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
const plan = await A.planMigration({ ...ctx(client), filename: F });
if (PRINT) { console.log(JSON.stringify(plan.objects, null, 2)); process.exit(0); }
check('plan: ready, every preflight passes', plan.status === 'ready' && plan.preflight.every((p) => p.ok), JSON.stringify({ status: plan.status, error: plan.error, pf: plan.preflight && plan.preflight.filter((p) => !p.ok) }).slice(0, 900));
const r = await A.applyMigration({ ...ctx(client), planToken: plan.plan_token, log: { error() {} },
  apiCheck: async ({ table }) => ({ ok: true, count: Number((await q1(`SELECT count(*)::int n FROM ${table}`)).n) }) });
check('apply: 475 applied and verified through the tool', r.status === 'applied', JSON.stringify({ status: r.status, error: r.error }).slice(0, 900));

if (r.status === 'applied') {
  check('apply: protected tables untouched (interactions, violations, mail pieces, archive, ledger)', (r.detail.protected || []).every((p) => p.unchanged), JSON.stringify(r.detail.protected));

  const SHA = 'a'.repeat(64);
  const ins = (o = {}) => {
    const row = { recovery_key: `${P1}:2026-07-30:${V1}`, community_id: C, property_id: P1, violation_id: V1, interaction_id: I_SENT, prior_interaction_id: I_REJ,
      mailed_on: '2026-07-30', mailed_at: null, delivery_method: 'certified_mail', provenance: 'reconstructed', source_path: 'recon.pdf', sha256: SHA, bytes: 1000,
      archive_path: `${C}/${V1}/recovered-2026-07-30.pdf`, reconstruction: '{"renderer_commit":"0fc480f5"}', receipt_evidence: '{"receipt_date":"2026-07-30"}',
      reason: 'Certified notice mailed 2026-07-30; Trusted record lost to draft cleanup', recovered_by: 'recovery_script', ...o };
    const cols = Object.keys(row);
    return tryErr(`INSERT INTO letter_recovery_records (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, cols.map((k) => row[k]));
  };
  check('rule: a bad hash is rejected', /letter_recovery_sha256_format/.test(await ins({ sha256: 'nothex' }) || ''));
  check('rule: a reconstruction must say how', /letter_recovery_reconstruction_detail/.test(await ins({ reconstruction: null }) || ''));
  check('rule: an original must not claim a reconstruction', /letter_recovery_reconstruction_detail/.test(await ins({ provenance: 'recovered_original' }) || ''));
  check('rule: an acceptance time on another day is rejected', /letter_recovery_mailed_at_on_date/.test(await ins({ mailed_at: '2026-07-31T15:00:00Z' }) || ''));
  check('rule: first-class mail is rejected', /delivery_method_check/.test(await ins({ delivery_method: 'first_class_mail' }) || ''));
  check('rule: a blank reason is rejected', /letter_recovery_reason_present/.test(await ins({ reason: '  ' }) || ''));
  check('rule: a valid recovery row (acceptance time 17:40 Central on the receipt date) is accepted', (await ins({ mailed_at: '2026-07-30T22:40:00Z' })) === null);
  check('idempotency: the same recovery key cannot be recorded twice', /recovery_key/.test(await ins({ interaction_id: I_DRAFT }) || ''));

  check('seal: the recovered notice cannot be deleted', /letter_recovery_sealed/.test(await tryErr(`DELETE FROM interactions WHERE id = '${I_SENT}'`) || ''));
  check('seal: its status cannot change (e.g. to rejected by a cleanup)', /letter_recovery_sealed/.test(await tryErr(`UPDATE interactions SET status = 'rejected' WHERE id = '${I_SENT}'`) || ''));
  check('seal: its PDF pointer cannot change', /letter_recovery_sealed/.test(await tryErr(`UPDATE interactions SET content = NULL WHERE id = '${I_SENT}'`) || ''));
  check('seal: its created_at cannot be rewritten', /letter_recovery_sealed/.test(await tryErr(`UPDATE interactions SET created_at = '2026-07-30' WHERE id = '${I_SENT}'`) || ''));
  check('seal: a violation named by a recovery row cannot be deleted', /foreign key|letter_recovery_sealed/.test(await tryErr(`DELETE FROM violations WHERE id = '${V1}'`) || ''));
  check('seal: a harmless field (notes) can still be written', (await tryErr(`UPDATE interactions SET notes = 'tracking confirmed' WHERE id = '${I_SENT}'`)) === null);
  check('seal: the July rejected row it points at cannot be deleted either (RESTRICT)', /foreign key/.test(await tryErr(`DELETE FROM interactions WHERE id = '${I_REJ}'`) || ''));
  check('scope: an unrelated draft still behaves as before (can be updated and deleted)',
    (await tryErr(`UPDATE interactions SET status = 'rejected' WHERE id = '${I_DRAFT}'`)) === null && (await tryErr(`DELETE FROM interactions WHERE id = '${I_DRAFT}'`)) === null);
  check('grants: recovery rows are append-only for the service role (no UPDATE / DELETE)',
    (await q1(`SELECT has_table_privilege('service_role', 'letter_recovery_records', 'INSERT') AND NOT has_table_privilege('service_role', 'letter_recovery_records', 'UPDATE') AND NOT has_table_privilege('service_role', 'letter_recovery_records', 'DELETE') ok`)).ok === true);
  check('grants: browser roles cannot read recovery rows',
    (await q1(`SELECT NOT has_table_privilege('anon', 'letter_recovery_records', 'SELECT') AND NOT has_table_privilege('authenticated', 'letter_recovery_records', 'SELECT') ok`)).ok === true);
}

const drift = await buildWorld({ preTable: true });
const plan2 = await A.planMigration({ ...ctx(drift.client), filename: F });
check('drift: an existing recovery table BLOCKS the plan (preflight), no token', plan2.status !== 'ready' && !plan2.plan_token, JSON.stringify({ status: plan2.status }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
