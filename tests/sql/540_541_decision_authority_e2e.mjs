// tests/sql/540_541_decision_authority_e2e.mjs — ACC decision authority,
// migrations 540 (additive columns) and 541 (status default + trigger), applied
// END TO END through the single-migration tool with their REAL checks files, in
// the deployment order (Ed 2026-10-20: sequence it safely, the 539 lesson):
//   1. 540 applies BEFORE the code: the CURRENT code keeps working unchanged
//      (Generate Letter still decides via the default; finalize still decides).
//   2. 541 applies AFTER the code: status default becomes pending_review and the
//      trigger refuses an approval/denial without an authorized decision record,
//      honors a routine delegated decision, and never touches decided rows.
//   3. 541 cannot be applied before 540 (preflight blocks the plan).
// Postgres 17 (PGlite 0.3.x). Skips without PGlite.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  540/541 end-to-end apply rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const F1 = '540_acc_decision_authority_columns.sql';
const F2 = '541_acc_decision_authority_guard.sql';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm540-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
for (const F of [F1, F2]) {
  fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
  fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`));
}
const PRINT = process.argv.includes('--print-objects');
const HIST = '00000000-0000-0000-0000-0000000000a1';   // historical staff approval (Moss Bark-like)
const BRIAN = '00000000-0000-0000-0000-0000000000a2';  // open paving expansion
const FENCE = '00000000-0000-0000-0000-0000000000a3';  // open routine application
const LIB = '00000000-0000-0000-0000-0000000000d1';    // the delegation instrument

async function buildWorld() {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE acc_decisions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      status text NOT NULL DEFAULT 'decided' CHECK (status IN ('pending_review','awaiting_info','finalizing','decided','withdrawn','archived')),
      decision_type text, project_summary text, letter_body text, decided_by_user_id uuid, notes text);
    CREATE TABLE schema_migrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), filename text NOT NULL UNIQUE, sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, duration_ms integer, error text);
    INSERT INTO acc_decisions (id, status, decision_type, project_summary, letter_body) VALUES
      ('${HIST}', 'decided', 'approved_with_conditions', 'Driveway widening (16.5 ft to 19.5 ft) and front approach walkway modification', 'We are pleased to confirm that your application is approved.'),
      ('${BRIAN}', 'pending_review', NULL, 'Replace existing driveway and extend width on one side by 2''6" x 20.5''', NULL),
      ('${FENCE}', 'pending_review', NULL, 'Replace rear wood fence, 6 ft cedar, same location', NULL);
    INSERT INTO schema_migrations (filename, sha256) VALUES ('480_acc_finalization_record.sql', 'recorded'), ('539_reply_send_claims.sql', 'recorded');`);
  const client = { query: async (sql, params) => {
    if (params) { const r = await db.query(sql, params.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : v))); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; }
    const rs = await db.exec(sql); const last = rs[rs.length - 1] || { rows: [] }; return { rows: last.rows, rowCount: last.affectedRows ?? 0 };
  } };
  return { db, client };
}

const OWNER = { id: 'owner-uuid', email: 'owner@example.test' };
const ctx = (client) => ({ client, user: OWNER, deployedCommit: 'deadbeefcafe', migrationsDir: dir, secret: 'e2e' });
const apply = async (client, F) => {
  const plan = await A.planMigration({ ...ctx(client), filename: F });
  if (PRINT) { console.log(F, JSON.stringify(plan.objects, null, 2)); }
  if (plan.status !== 'ready') return { plan, r: null };
  const r = await A.applyMigration({ ...ctx(client), planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) });
  return { plan, r };
};

// ---- 3. order guard first, on its own world ----------------------------------
{
  const w = await buildWorld();
  const p = await A.planMigration({ ...ctx(w.client), filename: F2 });
  check('order: 541 cannot be planned before 540 (preflight blocks, no token)', p.status !== 'ready' && !p.plan_token, JSON.stringify({ status: p.status }).slice(0, 300));
}

const { db, client } = await buildWorld();
const q1 = async (sql, params) => (await db.query(sql, params)).rows[0];
const tryErr = async (sql, params) => { try { await db.query(sql, params); return null; } catch (e) { return e.message; } };
const histBefore = await q1(`SELECT row_to_json(d)::text j FROM acc_decisions d WHERE id = '${HIST}'`);

// ---- 1. 540 before the code --------------------------------------------------
const s1 = await apply(client, F1);
check('540 plan: ready, every preflight passes', s1.plan.status === 'ready' && s1.plan.preflight.every((p) => p.ok), JSON.stringify({ status: s1.plan.status, error: s1.plan.error }).slice(0, 600));
check('540 apply: applied and verified through the tool', s1.r && s1.r.status === 'applied', JSON.stringify(s1.r && { status: s1.r.status, error: s1.r.error }));
const NEW = ['approval_gate', 'approval_gate_reason', 'owner_review', 'decision_record', 'compliance_evaluation'];
const canon = (s) => JSON.stringify(Object.entries(JSON.parse(s)).sort());
const strip = async (id) => (await q1(`SELECT (row_to_json(d)::jsonb - ARRAY[${NEW.map((c) => `'${c}'`).join(',')}])::text j FROM acc_decisions d WHERE id = '${id}'`)).j;
check('after 540: historical decided row unchanged', canon(await strip(HIST)) === canon(histBefore.j));
// The CURRENT (pre-#239) code paths, unchanged:
const oldLetter = await tryErr(`INSERT INTO acc_decisions (decision_type, project_summary, letter_body) VALUES ('approved', 'Paint front door', 'approved')`);
const oldRow = await q1(`SELECT status FROM acc_decisions WHERE project_summary = 'Paint front door'`);
check('after 540, old code: Generate Letter insert still works and still takes the old default', oldLetter === null && oldRow && oldRow.status === 'decided', oldLetter || JSON.stringify(oldRow));
const oldFinalize = await tryErr(`UPDATE acc_decisions SET status = 'decided', decision_type = 'approved_with_conditions' WHERE id = '${FENCE}'`);
check('after 540, old code: finalizing a decision still works (no interruption)', oldFinalize === null, oldFinalize);
await db.exec(`UPDATE acc_decisions SET status = 'pending_review', decision_type = NULL WHERE id = '${FENCE}'; DELETE FROM acc_decisions WHERE project_summary = 'Paint front door';`);

// ---- 2. 541 after the code ---------------------------------------------------
const s2 = await apply(client, F2);
check('541 plan: ready, every preflight passes', s2.plan.status === 'ready' && s2.plan.preflight.every((p) => p.ok), JSON.stringify({ status: s2.plan.status, error: s2.plan.error, pre: s2.plan.preflight }).slice(0, 800));
check('541 apply: applied and verified through the tool', s2.r && s2.r.status === 'applied', JSON.stringify(s2.r && { status: s2.r.status, error: s2.r.error }));

if (s2.r && s2.r.status === 'applied') {
  check('after 541: historical decided row unchanged', canon(await strip(HIST)) === canon(histBefore.j));
  check('after 541: a harmless edit to a historical decided row is still allowed', (await tryErr(`UPDATE acc_decisions SET notes = 'audited 2026-10-20' WHERE id = '${HIST}'`)) === null);
  check('after 541: a historical row may still be archived', (await tryErr(`UPDATE acc_decisions SET status = 'archived' WHERE id = '${HIST}'`)) === null);
  // Moving an archived approval BACK to decided is a new entry into decided, so
  // it needs an authorized record like any other approval.
  check('after 541: un-archiving an unrecorded approval back to decided is refused',
    /decision_not_authorized/.test(await tryErr(`UPDATE acc_decisions SET status = 'decided' WHERE id = '${HIST}'`) || ''));

  await db.exec(`INSERT INTO acc_decisions (project_summary) VALUES ('default probe')`);
  check('a new row is never decided by default (pending_review)', (await q1(`SELECT status FROM acc_decisions WHERE project_summary = 'default probe'`)).status === 'pending_review');

  const rec = (o) => JSON.stringify(Object.assign({ decided_by: 'ed', decided_by_email: 'egojara@bedrocktx.com', outcome: 'approved', decided_at: new Date().toISOString(),
    authority_basis: { kind: 'governing_document', reference: 'Declaration Article II §2.1, p. 4 of 47' } }, o));
  const decide = (id, dt, r) => tryErr(`UPDATE acc_decisions SET status = 'decided', decision_type = $1, decision_record = $2::jsonb WHERE id = $3`, [dt, r, id]);
  const reset = (id) => db.query(`UPDATE acc_decisions SET status = 'pending_review', decision_type = NULL, decision_record = NULL WHERE id = $1`, [id]).catch(() => {});

  check('refused: inserting a decided approval with no record (the old Generate Letter bug)',
    /decision_not_authorized/.test(await tryErr(`INSERT INTO acc_decisions (status, decision_type, project_summary) VALUES ('decided', 'approved', 'Paint front door')`) || ''));
  check('refused: approving with no decision record', /decision_not_authorized/.test(await decide(FENCE, 'approved', null) || ''));
  check('refused: a decider other than ed/annie/amanda', /decision_not_authorized/.test(await decide(FENCE, 'approved', rec({ decided_by: 'martha' })) || ''));
  check('refused: a denial issued on an approval record', /decision_outcome_mismatch/.test(await decide(FENCE, 'denied', rec({ outcome: 'approved' })) || ''));
  check('refused: bedrock_only as authority', /decision_authority_missing/.test(await decide(FENCE, 'approved', rec({ authority_basis: { kind: 'written_delegation', reference: 'arc_approval_workflow = bedrock_only', library_document_id: LIB } })) || ''));
  check('refused: a written delegation that names no instrument', /decision_authority_missing/.test(await decide(FENCE, 'approved', rec({ authority_basis: { kind: 'written_delegation', reference: 'Guidelines 1.4.4.1 delegation to the Managing Agent' } })) || ''));
  check('refused: a delegated approval not attested as routine / clearly compliant', /delegation_scope/.test(await decide(FENCE, 'approved', rec({ authority_basis: { kind: 'written_delegation', reference: 'Guidelines 1.4.4.1 delegation to the Managing Agent', library_document_id: LIB } })) || ''));
  const routine = await decide(FENCE, 'approved', rec({ authority_basis: { kind: 'written_delegation', reference: 'Guidelines 1.4.4.1 delegation to the Managing Agent', library_document_id: LIB, clearly_compliant: true } }));
  check('ALLOWED: a routine, clearly compliant approval under the written delegation, no committee vote', routine === null, routine);
  await reset(FENCE);
  const delegatedDenial = await decide(FENCE, 'denied', rec({ outcome: 'denied', authority_basis: { kind: 'written_delegation', reference: 'Guidelines 1.4.4.2: all others shall be disapproved', library_document_id: LIB } }));
  check('ALLOWED: a disapproval under the written delegation', delegatedDenial === null, delegatedDenial);
  await reset(FENCE);
  const govdoc = await decide(FENCE, 'approved', rec({}));
  check('ALLOWED: Ed approving a routine application under a cited governing provision', govdoc === null, govdoc);
  await reset(FENCE);

  check('refused: a paving-expansion approval with no committee/Board record, even routine-attested',
    /committee_authorization_required/.test(await decide(BRIAN, 'approved_with_conditions', rec({ outcome: 'approved_with_conditions', authority_basis: { kind: 'written_delegation', reference: 'Guidelines 1.4.4.1 delegation', library_document_id: LIB, clearly_compliant: true } })) || ''));
  const cb = { body: 'board', decision: 'approved_with_conditions', decided_on: '2026-10-19', approvers: 'Director A, Director B, Director C', evidence_type: 'email', evidence_reference: 'Board email thread 2026-10-19' };
  check('refused: a granted deviation without the written deviation authorization',
    /committee_authorization_required/.test(await decide(BRIAN, 'approved_with_conditions', rec({ outcome: 'approved_with_conditions', committee_or_board: { ...cb, deviation_granted: true } })) || ''));
  const brianOk = await decide(BRIAN, 'approved_with_conditions', rec({ outcome: 'approved_with_conditions', committee_or_board: { ...cb, deviation_granted: true, deviation_statement: 'Board grants a width deviation under §2.1 size/location authority.' } }));
  check('ALLOWED: the paving expansion with the Board approval and written deviation', brianOk === null, brianOk);
  await reset(BRIAN);
  check('refused: Annie deciding without a compliance evaluation', /evaluation_required/.test(await decide(FENCE, 'approved', rec({ decided_by: 'annie' })) || ''));
  check('ALLOWED: requests for more information and incomplete notices need no record',
    (await decide(FENCE, 'request_more_info', null)) === null && (await reset(FENCE), (await decide(FENCE, 'incomplete', null)) === null));
  await reset(FENCE);
  await db.query(`UPDATE acc_decisions SET status = 'finalizing', decision_type = 'approved', decision_record = $1::jsonb WHERE id = $2`, [rec({}), FENCE]);
  check('finalizing -> decided passes (the record was checked on the way into finalizing)', (await tryErr(`UPDATE acc_decisions SET status = 'decided' WHERE id = '${FENCE}'`)) === null);
  const rows = await q1(`SELECT count(*)::int n FROM acc_decisions`);
  check('no row was created or deleted by either migration', rows.n === 4, JSON.stringify(rows));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
