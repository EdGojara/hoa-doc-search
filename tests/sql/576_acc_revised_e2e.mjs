// tests/sql/576_acc_revised_e2e.mjs: migration 576 (ACC supplemental evidence,
// reconsideration, revised decisions) applied END TO END through the single-migration
// tool with its REAL checks file, on top of the REAL 480. Proves the database itself
// refuses a revised decision that is not the owner-approved outcome and letter of a
// reconsideration of the same case, keeps evidence append-only, and leaves a finalized
// case and its original decision exactly as they were.
// Postgres (PGlite). Skips without PGlite.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  576 end-to-end apply rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const F = '576_acc_revised_decisions.sql';
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const PRINT = process.argv.includes('--print-objects');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm576-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
const CK = `${REPO}/migrations/checks/${F.replace('.sql', '.json')}`;
fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), lf(CK));

const ORIG = 'b7ab635e-4ed9-4c62-ba83-0ec794e14a06', D1 = '7988422a-b406-4b83-b8e7-1c5f63ee9390', D2 = '72bdea21-a787-4312-8053-1cb0bb8bcea4';
const LEG = '00000000-0000-0000-0000-0000000000b1', OPEN = '00000000-0000-0000-0000-0000000000b2', OTHER = '00000000-0000-0000-0000-0000000000b3';
async function world({ withdrawn = true } = {}) {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE FUNCTION trusted_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
    CREATE TABLE acc_decisions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), management_company_id uuid, community_id uuid, status text NOT NULL DEFAULT 'decided',
      decision_type text, letter_body text, letter_pdf_storage_path text, packet_pdf_storage_path text, decided_by_user_id uuid, decided_at timestamptz,
      submitter_email text, homeowner_name text, homeowner_address text, project_summary text, reference_number text, application_pdf_storage_path text,
      photo_storage_paths text[] DEFAULT ARRAY[]::text[], supporting_docs_storage_paths text[] DEFAULT ARRAY[]::text[], document_manifest jsonb NOT NULL DEFAULT '[]'::jsonb,
      ai_review_text text, ai_recommendation text, ai_letter_body text, current_review_text text, current_ai_recommendation text, current_letter_body text, current_review_at timestamptz,
      acknowledged_at timestamptz, acknowledged_to text, acknowledgment_error text, updated_at timestamptz DEFAULT now());
    ALTER TABLE acc_decisions ADD CONSTRAINT acc_decisions_status_check CHECK (status IN ('pending_review', 'awaiting_info', 'decided', 'withdrawn', 'archived'));
    CREATE TABLE schema_migrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), filename text NOT NULL UNIQUE, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, duration_ms integer, error text);
    CREATE TABLE journal_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE TABLE violations (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;`);
  await db.exec(lf(`${REPO}/migrations/480_acc_finalization_record.sql`));
  await db.exec(`
    INSERT INTO schema_migrations (filename, sha256) VALUES ('480_acc_finalization_record.sql', 'r'), ('575_stamp_three_interest_rows.sql', 'r');
    INSERT INTO acc_decisions (id, status, reference_number, homeowner_address) VALUES ('${ORIG}', 'pending_review', 'R-1', '1 Main'), ('${D1}', '${withdrawn ? 'withdrawn' : 'pending_review'}', 'R-58', '1 Main'), ('${D2}', '${withdrawn ? 'withdrawn' : 'pending_review'}', 'R-59', '1 Main'),
      ('${LEG}', 'decided', 'L-1', '2 Main'), ('${OPEN}', 'pending_review', 'O-1', '3 Main'), ('${OTHER}', 'decided', 'X-1', '4 Main');
    INSERT INTO acc_finalizations (id, acc_decision_id, decision_type, letter_text, letter_sha256, letter_archive_path, delivery) VALUES ('1dac35fa-62f0-4e42-ba4f-dacbf3d55efc', '${ORIG}', 'denied', 'denied', 'h1', 'a/1', 'none');
    UPDATE acc_decisions SET status = 'decided', decision_type = 'denied', letter_body = 'denied', decided_at = now(), finalization_id = '1dac35fa-62f0-4e42-ba4f-dacbf3d55efc' WHERE id = '${ORIG}';`);
  const client = { query: async (sql, params) => {
    if (params) { const r = await db.query(sql, params.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : v))); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; }
    const rs = await db.exec(sql); const last = rs[rs.length - 1] || { rows: [] }; return { rows: last.rows, rowCount: last.affectedRows ?? 0 };
  } };
  return { db, client };
}
const ctx = (client) => ({ client, user: { id: 'owner-uuid', email: 'owner@example.test' }, deployedCommit: 'deadbeefcafe', migrationsDir: dir, secret: 'e2e' });
const { db, client } = await world();
const q1 = async (sql) => (await db.query(sql)).rows[0];
const err = async (sql) => { try { await db.query(sql); return null; } catch (e) { return e.message; } };
const plan = await A.planMigration({ ...ctx(client), filename: F });
if (PRINT) { console.log(JSON.stringify({ status: plan.status, error: plan.error, objects: plan.objects }, null, 2)); process.exit(0); }
check('plan: ready, every preflight passes', plan.status === 'ready' && plan.preflight.every((p) => p.ok), JSON.stringify({ status: plan.status, error: plan.error, preflight: plan.preflight, objects: plan.object_mismatch }).slice(0, 1500));
const before = JSON.stringify(await q1(`SELECT * FROM acc_decisions WHERE id = '${ORIG}'`)); const beforeFin = JSON.stringify(await q1(`SELECT id, acc_decision_id, version, decision_type, letter_text, letter_sha256, finalized_at FROM acc_finalizations`));
const r = plan.plan_token ? await A.applyMigration({ ...ctx(client), planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) }) : { status: 'no plan' };
check('apply: 576 applied and verified through the tool', r.status === 'applied', JSON.stringify({ status: r.status, error: r.error }));

if (r.status === 'applied') {
  const after = await q1(`SELECT * FROM acc_decisions WHERE id = '${ORIG}'`); delete after.duplicate_of_id;
  check('the original case and its sealed decision are byte-for-byte unchanged', JSON.stringify(after) === before && JSON.stringify(await q1(`SELECT id, acc_decision_id, version, decision_type, letter_text, letter_sha256, finalized_at FROM acc_finalizations`)) === beforeFin);
  check('both withdrawn duplicates name the original; they are kept', (await q1(`SELECT count(*)::int n FROM acc_decisions WHERE duplicate_of_id = '${ORIG}' AND status = 'withdrawn'`)).n === 2);
  check('a case cannot be its own duplicate', /duplicate_not_self/.test(await err(`UPDATE acc_decisions SET duplicate_of_id = id WHERE id = '${OPEN}'`) || ''));

  // evidence
  const s = await q1(`INSERT INTO acc_case_supplements (acc_decision_id, kind, source_ref, added_by) VALUES ('${ORIG}', 'email', 'msg:<a>', 'Email intake') RETURNING id`);
  check('evidence: the same message cannot be filed twice on a case', /duplicate key|unique/i.test(await err(`INSERT INTO acc_case_supplements (acc_decision_id, kind, source_ref, added_by) VALUES ('${ORIG}', 'email', 'msg:<a>', 'x')`) || ''));
  check('evidence is append-only', /append-only/.test(await err(`UPDATE acc_case_supplements SET note = 'x' WHERE id = '${s.id}'`) || '') && /append-only/.test(await err(`DELETE FROM acc_case_supplements WHERE id = '${s.id}'`) || ''));

  // reconsideration
  const FIN = '1dac35fa-62f0-4e42-ba4f-dacbf3d55efc';
  const mk = async (dec, fin) => (await q1(`INSERT INTO acc_reconsiderations (acc_decision_id, prior_finalization_id, prior_snapshot, opened_reason, opened_by) VALUES ('${dec}', ${fin ? `'${fin}'` : 'NULL'}, '{}', 'swatch', 'Staff') RETURNING id`)).id;
  const rec = await mk(ORIG, FIN);
  check('one active reconsideration per case', /duplicate key|unique/i.test(await err(`INSERT INTO acc_reconsiderations (acc_decision_id, prior_snapshot, opened_reason, opened_by) VALUES ('${ORIG}', '{}', 'x', 'y')`) || ''));
  const ins = (o = {}) => { const v = { dec: ORIG, version: 2, sup: FIN, reason: 'swatch', rec, type: 'approved', sha: 'h2', ...o }; return `INSERT INTO acc_finalizations (acc_decision_id, version, supersedes_id, correction_reason, reconsideration_id, decision_type, letter_text, letter_sha256, letter_archive_path, delivery) VALUES ('${v.dec}', ${v.version}, ${v.sup ? `'${v.sup}'` : 'NULL'}, ${v.reason ? `'${v.reason}'` : 'NULL'}, ${v.rec ? `'${v.rec}'` : 'NULL'}, '${v.type}', 'approved', '${v.sha}', 'a/2', 'none')`; };
  const needs = async (sql) => /approved by the owner/.test(await err(sql) || '');
  check('REFUSED: a revised decision with no reconsideration', await needs(ins({ rec: null })));
  check('REFUSED: a reconsideration not yet approved by the owner', await needs(ins()));
  check('REFUSED: "issuing" without the owner approval', /issuing_approved/.test(await err(`UPDATE acc_reconsiderations SET status = 'issuing' WHERE id = '${rec}'`) || ''));
  const appr = (id, over = '') => `UPDATE acc_reconsiderations SET status = 'issuing', outcome = 'approved', decision_record = '{"decided_by":"ed"}', owner_approval = '{"user_id":"u1","email":"owner@example.test","letter_sha256":"h2"${over}}' WHERE id = '${id}'`;
  check('REFUSED: an approval with no signed-in owner', /approved by the owner/.test(await (async () => { await db.exec(`UPDATE acc_reconsiderations SET status = 'issuing', outcome = 'approved', decision_record = '{}', owner_approval = '{"letter_sha256":"h2"}' WHERE id = '${rec}'`); const e = await err(ins()); await db.exec(`UPDATE acc_reconsiderations SET status = 'ready', owner_approval = NULL WHERE id = '${rec}'`); return e || ''; })()));
  await db.exec(appr(rec));
  check('REFUSED: a different letter than the owner approved', /outcome and letter the owner approved/.test(await err(ins({ sha: 'zzz' })) || ''));
  check('REFUSED: a different outcome than the owner approved', /outcome and letter the owner approved/.test(await err(ins({ type: 'denied' })) || ''));
  check('REFUSED: on another case', /approved by the owner|supersede|only a decided/.test(await err(ins({ dec: OTHER, sup: null })) || ''));
  check('REFUSED: skipping a version, or superseding nothing', /supersede/.test(await err(ins({ version: 3 })) || '') && /supersede/.test(await err(ins({ sup: null })) || ''));
  check('REFUSED: no reason', /version_chain/.test(await err(ins({ reason: null })) || ''));
  check('ACCEPTED: the owner-approved outcome and letter become version 2', (await err(ins())) === null, await err(ins()) || '');
  const v2 = await q1(`SELECT id FROM acc_finalizations WHERE version = 2`);
  check('a reconsideration issues once', /supersede|duplicate key/.test(await err(ins()) || ''));
  check('issued must be complete', /issued_complete/.test(await err(`UPDATE acc_reconsiderations SET status = 'issued' WHERE id = '${rec}'`) || ''));
  await db.exec(`UPDATE acc_reconsiderations SET status = 'issued', issued_at = now(), finalization_id = '${v2.id}' WHERE id = '${rec}'`);
  check('an issued reconsideration is history', /cannot change/.test(await err(`UPDATE acc_reconsiderations SET reason = 'x' WHERE id = '${rec}'`) || '') && /cannot be deleted/.test(await err(`DELETE FROM acc_reconsiderations WHERE id = '${rec}'`) || ''));
  check('versions stay append-only; the original is still version 1 denied', /append-only/.test(await err(`UPDATE acc_finalizations SET decision_type = 'x'`) || '') && (await q1(`SELECT decision_type t FROM acc_finalizations WHERE version = 1`)).t === 'denied');
  check('the case row still says denied, decided, with its original date', await (async () => { const x = await q1(`SELECT * FROM acc_decisions WHERE id = '${ORIG}'`); delete x.duplicate_of_id; return JSON.stringify(x) === before; })());
  const rec2 = await mk(ORIG, v2.id);
  await db.exec(appr(rec2));
  check('a second reconsideration issues version 3, superseding version 2', (await err(ins({ version: 3, sup: v2.id, rec: rec2 }))) === null);

  // decided before sealed records
  const lrec = await mk(LEG, null); await db.exec(appr(lrec));
  check('legacy case: revised decision is version 2 with nothing superseded', (await err(ins({ dec: LEG, sup: null, rec: lrec }))) === null, await err(ins({ dec: LEG, sup: null, rec: lrec })) || '');
  const orec = await mk(OPEN, null); await db.exec(appr(orec));
  check('REFUSED: an open application cannot have a revised decision', /only a decided/.test(await err(ins({ dec: OPEN, sup: null, rec: orec })) || ''));
  check('version 1 of a new case still works as before', (await err(`INSERT INTO acc_finalizations (acc_decision_id, decision_type, letter_text, letter_sha256, letter_archive_path, delivery) VALUES ('${OPEN}', 'approved', 'x', 'y', 'z', 'none')`)) === null);
  const g = async (t, p) => (await q1(`SELECT has_table_privilege('service_role', '${t}', '${p}') ok`)).ok;
  check('server grants: evidence insert/read only; reconsiderations no delete; no browser access', await g('acc_case_supplements', 'INSERT') && !(await g('acc_case_supplements', 'UPDATE')) && !(await g('acc_case_supplements', 'DELETE')) && await g('acc_reconsiderations', 'UPDATE') && !(await g('acc_reconsiderations', 'DELETE'))
    && !(await q1(`SELECT has_table_privilege('anon', 'acc_reconsiderations', 'SELECT') OR has_table_privilege('authenticated', 'acc_case_supplements', 'SELECT') ok`)).ok);
}
const drift = await world({ withdrawn: false });
const plan2 = await A.planMigration({ ...ctx(drift.client), filename: F });
check('drift: if the two duplicates are not withdrawn, the plan is blocked', plan2.status !== 'ready' && !plan2.plan_token, JSON.stringify({ status: plan2.status }));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
