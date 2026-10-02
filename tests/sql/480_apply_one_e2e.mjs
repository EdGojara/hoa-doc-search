// tests/sql/480_apply_one_e2e.mjs — migration 480 (ACC finalization record,
// Issue #14) applied END TO END through the single-migration tool with its REAL
// checks file. Proves:
//   - the checks file matches exactly what 480 does (objects, no row changes);
//   - existing cases are untouched and a legacy decided case stays editable;
//   - a FINALIZED case (finalization_id set) refuses changes to its decision,
//     letter, recipient, documents, reviews and status, refuses deletion, and
//     still allows decided -> archived, a write-once fill from empty, and the
//     acknowledgment stamp;
//   - acc_finalizations is append-only; a correction is a new version that
//     references the original; email must match delivery;
//   - drift blocks it.
// Postgres 17 (PGlite 0.3.x). Skips without PGlite.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  480 end-to-end apply rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const F = '480_acc_finalization_record.sql';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm480-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`));
const PRINT = process.argv.includes('--print-objects');
const OPEN = '00000000-0000-0000-0000-0000000000a1';
const LEGACY = '00000000-0000-0000-0000-0000000000a2';

async function buildWorld({ preColumn = false } = {}) {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE acc_decisions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), management_company_id uuid, community_id uuid, status text NOT NULL DEFAULT 'decided',
      decision_type text, letter_body text, letter_pdf_storage_path text, packet_pdf_storage_path text, decided_by_user_id uuid, decided_at timestamptz,
      submitter_email text, homeowner_name text, homeowner_address text, project_summary text, reference_number text, application_pdf_storage_path text,
      photo_storage_paths text[] DEFAULT ARRAY[]::text[], supporting_docs_storage_paths text[] DEFAULT ARRAY[]::text[], document_manifest jsonb NOT NULL DEFAULT '[]'::jsonb,
      ai_review_text text, ai_recommendation text, ai_letter_body text, current_review_text text, current_ai_recommendation text, current_letter_body text, current_review_at timestamptz,
      acknowledged_at timestamptz, acknowledged_to text, acknowledgment_error text, updated_at timestamptz DEFAULT now());
    ALTER TABLE acc_decisions ADD CONSTRAINT acc_decisions_status_check CHECK (status IN ('pending_review', 'awaiting_info', 'decided', 'withdrawn', 'archived'));
    CREATE TABLE ap_payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE TABLE journal_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE TABLE schema_migrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), filename text NOT NULL UNIQUE, sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, duration_ms integer, error text);
    INSERT INTO acc_decisions (id, status, ai_review_text, homeowner_address, submitter_email) VALUES ('${OPEN}', 'pending_review', 'original analysis', '1 Main St', 'owner@example.test');
    INSERT INTO acc_decisions (id, status, decision_type, letter_body) VALUES ('${LEGACY}', 'decided', 'approved_no_conditions', 'legacy letter');
    INSERT INTO schema_migrations (filename, sha256) VALUES ('479_acc_document_manifest_current_review.sql', 'recorded');`);
  if (preColumn) await db.exec(`ALTER TABLE acc_decisions ADD COLUMN finalization_id uuid;`);
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
check('plan: ready, every preflight passes', plan.status === 'ready' && plan.preflight.every((p) => p.ok), JSON.stringify({ status: plan.status, error: plan.error }).slice(0, 600));
const r = await A.applyMigration({ ...ctx(client), planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) });
check('apply: 480 applied and verified through the tool', r.status === 'applied', JSON.stringify({ status: r.status, error: r.error }));

if (r.status === 'applied') {
  check('status finalizing is allowed; unknown status still rejected',
    (await tryErr(`UPDATE acc_decisions SET status = 'finalizing' WHERE id = '${OPEN}'`)) === null && /status_check/.test(await tryErr(`UPDATE acc_decisions SET status = 'sending' WHERE id = '${OPEN}'`) || ''));
  check('legacy decided case (no finalization_id) stays editable (no regression)', (await tryErr(`UPDATE acc_decisions SET letter_body = 'legacy edit' WHERE id = '${LEGACY}'`)) === null);

  // finalize the open case: record + link in the same update that marks it decided
  const fin = await q1(`INSERT INTO acc_finalizations (acc_decision_id, decision_type, letter_text, letter_sha256, letter_archive_path, delivery, email)
    VALUES ('${OPEN}', 'approved_with_conditions', 'Dear Pat, approved.', 'abc', 'arc/x-letter.pdf', 'email', '{"to":"owner@example.test","subject":"ACC Application Decision"}') RETURNING id`);
  const linkErr = await tryErr(`UPDATE acc_decisions SET status = 'decided', decision_type = 'approved_with_conditions', letter_body = 'Dear Pat, approved.', decided_at = now(), finalization_id = '${fin.id}' WHERE id = '${OPEN}'`);
  check('finalizing -> decided with the finalization link is allowed', linkErr === null, linkErr || '');

  const blocked = async (sql) => /finalized/.test(await tryErr(sql) || '');
  check('finalized: decision cannot change', await blocked(`UPDATE acc_decisions SET decision_type = 'denied' WHERE id = '${OPEN}'`));
  check('finalized: letter cannot change', await blocked(`UPDATE acc_decisions SET letter_body = 'rewritten' WHERE id = '${OPEN}'`));
  check('finalized: recipient cannot change', await blocked(`UPDATE acc_decisions SET submitter_email = 'other@example.test' WHERE id = '${OPEN}'`));
  check('finalized: original analysis cannot change', await blocked(`UPDATE acc_decisions SET ai_review_text = 'rewritten' WHERE id = '${OPEN}'`));
  check('finalized: cannot reopen (decided -> pending_review)', await blocked(`UPDATE acc_decisions SET status = 'pending_review' WHERE id = '${OPEN}'`));
  check('finalized: cannot be deleted', await blocked(`DELETE FROM acc_decisions WHERE id = '${OPEN}'`));
  check('finalized: a write-once field may be FILLED from empty (e.g. packet path) but then never changed',
    (await tryErr(`UPDATE acc_decisions SET packet_pdf_storage_path = 'p/packet.pdf' WHERE id = '${OPEN}'`)) === null && await blocked(`UPDATE acc_decisions SET packet_pdf_storage_path = 'p/other.pdf' WHERE id = '${OPEN}'`));
  check('finalized: acknowledgment stamp is still allowed', (await tryErr(`UPDATE acc_decisions SET acknowledged_at = now(), acknowledged_to = 'owner@example.test' WHERE id = '${OPEN}'`)) === null);
  check('finalized: decided -> archived (retire a duplicate) is allowed, content unchanged', (await tryErr(`UPDATE acc_decisions SET status = 'archived' WHERE id = '${OPEN}'`)) === null);

  check('acc_finalizations is append-only: UPDATE refused', /append-only/.test(await tryErr(`UPDATE acc_finalizations SET letter_text = 'x' WHERE id = '${fin.id}'`) || ''));
  check('acc_finalizations is append-only: DELETE refused', /append-only/.test(await tryErr(`DELETE FROM acc_finalizations WHERE id = '${fin.id}'`) || ''));
  check('a second version 1 for the same case is refused', /duplicate key|unique/i.test(await tryErr(`INSERT INTO acc_finalizations (acc_decision_id, decision_type, letter_text, letter_sha256, letter_archive_path, delivery) VALUES ('${OPEN}', 'denied', 'x', 'y', 'z', 'none')`) || ''));
  check('a correction must reference the original and give a reason', /version_chain/.test(await tryErr(`INSERT INTO acc_finalizations (acc_decision_id, version, decision_type, letter_text, letter_sha256, letter_archive_path, delivery) VALUES ('${OPEN}', 2, 'denied', 'x', 'y', 'z', 'none')`) || ''));
  const corr = await tryErr(`INSERT INTO acc_finalizations (acc_decision_id, version, supersedes_id, correction_reason, decision_type, letter_text, letter_sha256, letter_archive_path, delivery) VALUES ('${OPEN}', 2, '${fin.id}', 'typo in condition 3', 'approved_with_conditions', 'corrected', 'def', 'arc/x-v2.pdf', 'none')`);
  check('a correction is a NEW version referencing the original; the original stays', corr === null && (await q1(`SELECT count(*)::int n FROM acc_finalizations WHERE acc_decision_id = '${OPEN}'`)).n === 2, corr || '');
  check('email must match delivery', /email_matches_delivery/.test(await tryErr(`INSERT INTO acc_finalizations (acc_decision_id, version, supersedes_id, correction_reason, decision_type, letter_text, letter_sha256, letter_archive_path, delivery) VALUES ('${OPEN}', 3, '${fin.id}', 'r', 'denied', 'x', 'y', 'z', 'email')`) || ''));
}

const drift = await buildWorld({ preColumn: true });
const plan2 = await A.planMigration({ ...ctx(drift.client), filename: F });
check('drift: an existing finalization_id column BLOCKS the plan (preflight), no token', plan2.status !== 'ready' && !plan2.plan_token, JSON.stringify({ status: plan2.status }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
