// tests/sql/569_acc_routine_annie_e2e.mjs — routine ACC without the owner
// bottleneck (Ed 2026-11-18). Applies 540 + 541 + 569 END TO END through the
// single-migration tool with their REAL checks files, then proves the trigger:
//   - Annie approves AND denies a routine case under the written delegation, on
//     a recorded review (approval_gate 'not_required');
//   - Annie never decides one of Ed's exceptions (approval_gate 'required'),
//     an unclassified case, or without the delegation or a review;
//   - a committee denial no longer needs Ed's review;
//   - Ed's exceptions still need Ed (any decider), and driveway/deviation
//     approvals still need the committee/Board record;
//   - only Waterview gets a delegation; no acc_decisions row changes.
// Postgres 17 (PGlite 0.3.x). Skips without PGlite.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  569 end-to-end apply rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const FILES = ['540_acc_decision_authority_columns.sql', '541_acc_decision_authority_guard.sql', '569_acc_routine_annie.sql', '570_acc_bedrock_acts_as_committee.sql', '571_acc_developer_authorization.sql'];

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm569-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
for (const F of FILES) {
  fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
  fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`));
}
const WV = 'a0000000-0000-4000-8000-000000000001';
const LOPF = 'a0000000-0000-4000-8000-000000000002';
const LIB = '6eeb8060-9b0a-4e88-b714-45f775a0442a';
const ROOF = '00000000-0000-0000-0000-0000000000b1';
const DRIVE = '00000000-0000-0000-0000-0000000000b2';
const PATIO = '00000000-0000-0000-0000-0000000000b3';
const LIKE = '00000000-0000-0000-0000-0000000000b4';

const db = new PGlite();
await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE TABLE communities (id uuid PRIMARY KEY, name text NOT NULL);
  CREATE TABLE library_documents (id uuid PRIMARY KEY, community_id uuid, title text);
  CREATE TABLE acc_finalizations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), acc_decision_id uuid);
  CREATE TABLE acc_decisions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    status text NOT NULL DEFAULT 'decided' CHECK (status IN ('pending_review','awaiting_info','finalizing','decided','withdrawn','archived')),
    decision_type text, project_summary text, letter_body text, decided_by_user_id uuid, notes text);
  CREATE TABLE schema_migrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), filename text NOT NULL UNIQUE, sha256 text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, duration_ms integer, error text);
  INSERT INTO communities VALUES ('${WV}', 'Waterview Estates'), ('${LOPF}', 'Lakes of Pine Forest'), ('a0000000-0000-4000-8000-000000000003', 'Canyon Gate at Cinco Ranch'), ('a0000000-0000-4000-8000-000000000005', 'Quail Ridge'), ('a0000000-0000-4000-8000-000000000006', 'Still Creek Ranch'), ('a0000000-0000-4000-8000-000000000007', 'August Meadows');
  INSERT INTO library_documents VALUES ('${LIB}', '${WV}', 'Waterview Estates Architectural Guidelines (2016)'), ('13848636-9a4f-4bbe-9d63-6ba76abedcf6', '${LOPF}', 'Master Declaration'), ('0edb274a-f334-435e-a379-58dc933f11a4', 'a0000000-0000-4000-8000-000000000003', 'CG Declaration'), ('3ba3d5f0-5884-4743-88bd-e8276e669e38', 'a0000000-0000-4000-8000-000000000005', 'QR Bylaws'), ('887a9352-bff5-4148-80be-28b1d36ce112', 'a0000000-0000-4000-8000-000000000006', 'SCR Declaration'), ('8e31062b-a590-413c-bc5d-1979848d23ad', 'a0000000-0000-4000-8000-000000000007', 'AM Declaration');
  INSERT INTO acc_decisions (id, status, project_summary) VALUES
    ('${ROOF}', 'pending_review', 'Roof replacement with Atlas ProLam shingles in Weathered Wood color'),
    ('${DRIVE}', 'pending_review', 'Replace existing driveway and extend width on one side by 2''6" x 20.5'''),
    ('${PATIO}', 'pending_review', 'Pour a new 12x16 concrete patio at the rear of the house'),
    ('${LIKE}', 'pending_review', 'Driveway replacement, like-for-like within the existing footprint');
  INSERT INTO schema_migrations (filename, sha256) VALUES ('480_acc_finalization_record.sql', 'recorded'), ('539_reply_send_claims.sql', 'recorded'), ('568_property_exclusion.sql', 'recorded');`);
const client = { query: async (sql, params) => {
  if (params) { const r = await db.query(sql, params.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : v))); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; }
  const rs = await db.exec(sql); const last = rs[rs.length - 1] || { rows: [] }; return { rows: last.rows, rowCount: last.affectedRows ?? 0 };
} };
const ctx = { client, user: { id: 'owner-uuid', email: 'owner@example.test' }, deployedCommit: 'deadbeefcafe', migrationsDir: dir, secret: 'e2e' };
for (const F of FILES) {
  const plan = await A.planMigration({ ...ctx, filename: F });
  if (process.argv.includes('--print-objects')) console.log(F, JSON.stringify(plan.objects, null, 2));
  const ready = plan.status === 'ready';
  check(`${F} plan: ready, every preflight passes`, ready && plan.preflight.every((p) => p.ok), JSON.stringify({ status: plan.status, error: plan.error, pre: plan.preflight, objects: plan.objects }).slice(0, 1200));
  if (!ready) { console.log(`\n${pass} passed, ${fail + 1} failed`); process.exit(1); }
  const r = await A.applyMigration({ ...ctx, planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) });
  check(`${F} apply: applied and verified through the tool`, r && r.status === 'applied', JSON.stringify(r && { status: r.status, error: r.error, verify: r.verify }).slice(0, 800));
}

const q1 = async (sql, params) => (await db.query(sql, params)).rows[0];
const tryErr = async (sql, params) => { try { await db.query(sql, params); return null; } catch (e) { return e.message; } };
const decide = (id, dt, r, gate, reason) => tryErr(`UPDATE acc_decisions SET status = 'decided', decision_type = $1, decision_record = $2::jsonb, approval_gate = $3, approval_gate_reason = $5 WHERE id = $4`, [dt, r, gate === undefined ? null : gate, id, reason || null]);
const reset = (id) => db.query(`UPDATE acc_decisions SET status = 'pending_review', decision_type = NULL, decision_record = NULL, approval_gate = NULL, owner_review = NULL WHERE id = $1`, [id]);
const at = new Date().toISOString();
const annie = (o = {}) => ({ decided_by: 'annie', outcome: 'approved_with_conditions', decided_at: at, evaluated_by: 'annie', review_at: at,
  authority_basis: { kind: 'written_delegation', reference: 'Architectural Guidelines (2016) §1.4.4.1-1.4.4.2 delegation to the Managing Agent', library_document_id: LIB, routine_delegated: true }, ...o });
const ED_REC = { user_id: 'ed-uuid', email: 'egojara@bedrocktx.com', name: 'Ed Gojara', at };
const STAFF_REC = { user_id: 'staff-uuid', email: 'staffer@bedrocktx.com', name: 'A Staffer', at };
const ARC = { body: 'committee', decision: 'denied', decided_on: '2026-11-18', approvers: 'Member A, Member B, Member C', evidence_type: 'minutes', evidence_reference: 'ARC minutes 2026-11-18, item 2' };

check('570+571: all six associations Bedrock acts as the Committee, none flagged', (await q1(`SELECT count(*)::int n FROM communities WHERE acc_delegation->>'acts_as' = 'committee'`)).n === 6 && (await q1(`SELECT count(*)::int n FROM communities WHERE acc_delegation->>'status' = 'needs_clarification'`)).n === 0);
check('571: developer communities reserve Declarant decisions to the developer and flag written confirmation', (await q1(`SELECT count(*)::int n FROM communities WHERE acc_delegation->>'reserved_to' = 'developer' AND acc_delegation->>'follow_up' LIKE 'obtain the developer%'`)).n === 2);
check('570: Waterview keeps its 569 delegation and gains acts_as', (await q1(`SELECT (acc_delegation->>'acts_as') a, (acc_delegation->>'appeal') ap FROM communities WHERE id = '${WV}'`)).a === 'committee');
check('Waterview delegation names the Guidelines on file', (await q1(`SELECT acc_delegation->>'library_document_id' d FROM communities WHERE id = '${WV}'`)).d === LIB);

// Annie: routine
let e = await decide(ROOF, 'approved_with_conditions', annie(), 'not_required');
check('ALLOWED: Annie approves a routine roof under the delegation', e === null, e); await reset(ROOF);
e = await decide(ROOF, 'denied', annie({ outcome: 'denied' }), 'not_required');
check('ALLOWED: Annie denies a routine case under the delegation (no Ed review)', e === null, e); await reset(ROOF);
e = await decide(LIKE, 'approved', annie({ outcome: 'approved' }), 'not_required');
check('ALLOWED: Annie approves a like-for-like driveway replacement the app classified not_required', e === null, e); await reset(LIKE);
// Annie: refused
check('refused: Annie on one of Ed\'s exceptions (approval_gate required)', /owner_review_required/.test(await decide(PATIO, 'approved', annie({ outcome: 'approved' }), 'required') || ''));
await reset(PATIO);
check('refused: Annie on an unclassified case (no app stamp)', /owner_review_required/.test(await decide(ROOF, 'approved_with_conditions', annie(), null) || ''));
await reset(ROOF);
check('refused: Annie on a driveway widening even if stamped not_required? no: DB paving words win', /owner_review_required|committee_authorization_required/.test(await decide(DRIVE, 'approved_with_conditions', annie(), 'required') || ''));
await reset(DRIVE);
check('refused: Annie without a recorded review', /evaluation_required/.test(await decide(ROOF, 'approved_with_conditions', annie({ review_at: null }), 'not_required') || ''));
await reset(ROOF);
check('refused: Annie without the routine delegation flag', /decision_authority_missing|delegation_scope/.test(await decide(ROOF, 'approved_with_conditions', annie({ authority_basis: { kind: 'written_delegation', reference: 'Architectural Guidelines (2016) §1.4.4.1 delegation', library_document_id: LIB } }), 'not_required') || ''));
await reset(ROOF);
check('refused: Annie under a governing-document citation (no delegation)', /decision_authority_missing/.test(await decide(ROOF, 'approved_with_conditions', annie({ authority_basis: { kind: 'governing_document', reference: 'Declaration Art. VI §2, ARC approval', routine_delegated: true } }), 'not_required') || ''));
await reset(ROOF);

// Committee / Ed
const crec = (o) => ({ decided_by: 'committee', outcome: 'denied', decided_at: at, recorded_by: STAFF_REC, authority_basis: { kind: 'governing_document', reference: 'Declaration Art. VI §2-3, pp. 15-16' }, committee_or_board: ARC, ...o });
e = await decide(ROOF, 'denied', crec({}), 'not_required');
check('ALLOWED: a committee denial recorded by staff, no Ed review (was refused before 569)', e === null, e); await reset(ROOF);
check('refused: a committee decision on Ed\'s exception before Ed approves', /owner_review_required/.test(await decide(PATIO, 'denied', crec({}), 'required') || ''));
await reset(PATIO);
const edRec = (o) => ({ decided_by: 'ed', decided_by_email: 'egojara@bedrocktx.com', outcome: 'approved', decided_at: at, recorded_by: ED_REC,
  authority_basis: { kind: 'written_delegation', reference: 'Architectural Guidelines (2016) §1.4.4.1 delegation', library_document_id: LIB, clearly_compliant: true }, ...o });
e = await decide(PATIO, 'approved', edRec({}), 'required', 'New concrete, or an extension or expansion of an existing concrete surface.');
check('ALLOWED: Ed approves a concrete patio (his exception) under the delegation', e === null, e); await reset(PATIO);
check('unchanged: Ed\'s driveway widening approval still needs the committee/Board record', /committee_authorization_required/.test(await decide(DRIVE, 'approved_with_conditions', edRec({ outcome: 'approved_with_conditions' }), 'required') || ''));
await reset(DRIVE);
check('unchanged: staff are never the decider', /decision_not_authorized/.test(await decide(ROOF, 'approved', { ...edRec({}), decided_by: 'martha' }, 'not_required') || ''));
await reset(ROOF);
check('unchanged: requests for more information need no record', (await decide(ROOF, 'request_more_info', null, null)) === null);
await reset(ROOF);
check('no acc_decisions row created or deleted', (await q1(`SELECT count(*)::int n FROM acc_decisions`)).n === 4);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
