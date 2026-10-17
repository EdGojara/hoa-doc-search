// tests/sql/535_conversion_primitives_e2e.mjs — migrations 535 + 536 on the REAL SQL (452-501 onboarding
// engine + 504, applied through the single-migration tool with its checks file), a SYNTHETIC
// community only. Proves, against the database itself:
//   * the persisted normalized source: a normalize PASS must carry a sealed fact set; facts are
//     append-only, sealed by count, bound once; the service reads them back and re-hashes them;
//   * conversion adjustments / policies: the DATABASE computes the fingerprint; content is
//     immutable; only a human with channel in_app and the exact fingerprint approves; an agent /
//     operator / other channel / stale fingerprint is refused; approvals are permanent; one live
//     policy per kind + key; a suspense policy can never allocate to owners;
//   * the objects digest the preflight binds equals the JS formula; EXECUTE refuses when the
//     approved set changed after the preflight, or when an old-format preflight ignores approved objects;
//   * EXECUTE: a post-opening equity adjustment that changes an account's sign posts as its own
//     entry; the audit chain (before / lines + fingerprint / after / GL measured) is recorded;
//     legacy-owner records are created and every prior-owner row sits on one; the first owner
//     tenure of a lot that never had one is established (start not invented) with a unique source
//     identity; a labelled suspense balance is a reconciling item;
//   * the PORTAL PATH: v_current_owner_ledger / v_current_owner_balance (what the portal reads)
//     never contain a prior-owner row; v_former_owner_ledger_balances does;
//   * REGRESSION: a source account previously held on a legacy record whose lot is established
//     in the conversion: its cutoff balance goes to the new current owner, never the legacy record;
//   * carried-balance policies need evidence and exact cents; open AP rides only on an opening correction;
//   * idempotency: a retry writes nothing; the same source account can never be established
//     twice (unique identity; the tenure guard refuses a second first-owner tenure).
// Postgres 17 (PGlite 0.3.x). Skips without PGlite. --print-objects (PRINT_FILE=<migration>) prints its object diff.
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { onboardingWorld } from './onboarding_world.mjs';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  535 conversion primitives (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const { createOnboardingService } = require(`${REPO}/lib/onboarding/service.js`);
const { buildConversionPlan } = require(`${REPO}/lib/onboarding/conversion_plan.js`);
const { trustedFingerprint } = require(`${REPO}/lib/onboarding/bridge.js`);
const PF = require(`${REPO}/lib/onboarding/preflight.js`);
const SF = require(`${REPO}/lib/onboarding/source_facts.js`);
const OBJ = require(`${REPO}/lib/onboarding/conversion_objects.js`);
const PRINT = process.argv.includes('--print-objects');
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const code = async (fn) => { try { await fn(); return null; } catch (e) { return `${e.code || ''} ${e.message || ''}`; } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const u = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// ------------------------------------------------------------------- the database
const world = await onboardingWorld(PGlite, { through: 498, gl: true });
const { db, rpc } = world;
const q = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
const COMM = u(1); const MC = u(2); const OPR = u(3);
await db.exec(`
  ALTER TABLE chart_of_accounts ADD COLUMN account_type text, ADD COLUMN is_active boolean DEFAULT true, ADD COLUMN is_summary boolean DEFAULT false;
  ALTER TABLE properties ADD COLUMN trusted_account_number text, ADD COLUMN city text, ADD COLUMN state text, ADD COLUMN zip text;
  ALTER TABLE contacts ADD COLUMN full_name text;
  ALTER TABLE vendors ADD COLUMN dba text, ADD COLUMN is_active boolean DEFAULT true;
  ALTER TABLE ownership_tenures ALTER COLUMN id SET DEFAULT gen_random_uuid();   -- production (456) default
  ALTER TABLE ownership_tenures ADD COLUMN vantaca_account_id text, ADD COLUMN notes text, ADD COLUMN created_at timestamptz DEFAULT now(),
    ADD COLUMN origin text NOT NULL DEFAULT 'backfill_current' CONSTRAINT ownership_tenures_origin_check CHECK (origin IN ('backfill_current', 'backfill_historical', 'backfill_legacy', 'transfer'));
  ALTER TABLE homeowner_transactions ADD COLUMN reduction_source text;
  ALTER TABLE homeowner_transactions ALTER COLUMN vantaca_account_id DROP NOT NULL;
  CREATE TABLE builder_companies (id uuid PRIMARY KEY, management_company_id uuid, company_name text NOT NULL);
  CREATE TABLE property_ownerships (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid REFERENCES properties(id), contact_id uuid REFERENCES contacts(id),
    tenure_id uuid REFERENCES ownership_tenures(id), start_date date, end_date date, is_primary boolean DEFAULT true);
  CREATE TABLE ownership_change_proposals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid, community_id uuid, status text NOT NULL,
    effective_start_date date, proposed_owner_name text, current_contact_id uuid, seller_tenure_id uuid REFERENCES ownership_tenures(id), buyer_tenure_id uuid REFERENCES ownership_tenures(id));
  CREATE TABLE library_documents (id uuid PRIMARY KEY);
  CREATE TABLE ap_payments (id uuid PRIMARY KEY, community_id uuid, vendor_id uuid, payment_date date, amount_cents bigint, payment_method text, check_number text, posting_journal_entry_id uuid, status text, voided_at timestamptz, created_at timestamptz, updated_at timestamptz);
  CREATE TABLE ap_payment_applications (id uuid PRIMARY KEY, payment_id uuid, invoice_id uuid, applied_cents bigint);
  CREATE TABLE ar_charges (id uuid PRIMARY KEY, community_id uuid, property_id uuid, charge_date date, original_amount_cents bigint, status text, source_module text, source_reference text, posting_journal_entry_id uuid, created_at timestamptz, updated_at timestamptz);
  CREATE TABLE ar_payments (id uuid PRIMARY KEY, community_id uuid, property_id uuid, payment_date date, amount_cents bigint, source text, source_reference text, status text, posting_journal_entry_id uuid, created_at timestamptz, updated_at timestamptz);
  CREATE TABLE payments (id uuid PRIMARY KEY, community_id uuid, property_id uuid, amount_cents bigint, status text, livemode boolean, paid_at timestamptz, journal_entry_id uuid, homeowner_txn_id uuid, created_at timestamptz, updated_at timestamptz);
  CREATE TABLE budget_line_items (id uuid PRIMARY KEY, budget_id uuid, account_id uuid, annual_amount_cents bigint, monthly_amounts_cents bigint[]);
  CREATE TABLE community_budgets (id uuid PRIMARY KEY, status text, fiscal_year int);
  CREATE TABLE budget_forecasts (id uuid PRIMARY KEY, community_id uuid);
  CREATE TABLE forecast_lines (id uuid PRIMARY KEY, forecast_id uuid, account_id uuid, method text, settings jsonb);
  CREATE TABLE cd_parties (id uuid, community_id uuid); CREATE TABLE cd_ownerships (id uuid, community_id uuid); CREATE TABLE cd_addresses (id uuid, community_id uuid);
  CREATE TABLE cd_contact_methods (id uuid, community_id uuid); CREATE TABLE cd_occupancies (id uuid, community_id uuid); CREATE TABLE cd_evidence (id uuid, community_id uuid);`);
for (const m of ['235_recognition_engine.sql', '253_recognition_basis_daily.sql', '466_recognition_schedules_controls.sql', '360_assessment_proration.sql']) await db.exec(lf(`${REPO}/migrations/${m}`));
const m457 = lf(`${REPO}/migrations/457_current_tenure_reader_views.sql`);
await db.exec(m457.slice(m457.indexOf('CREATE OR REPLACE VIEW v_current_owner_ledger'), m457.indexOf('GRANT SELECT ON v_current_owner_ledger')));
await db.exec(`INSERT INTO schema_migrations (filename, sha256) VALUES ('360_assessment_proration.sql', 'recorded'), ('459_ownership_transfer_single_path.sql', 'recorded'),
  ('461_homeowner_payment_applications.sql', 'recorded'), ('466_recognition_schedules_controls.sql', 'recorded'), ('456_ownership_tenures.sql', 'recorded');
  INSERT INTO management_companies VALUES ('${MC}');
  INSERT INTO communities (id, name, management_company_id, gl_cutover_date) VALUES ('${COMM}', 'Example Meadows', '${MC}', '2026-01-01');`);
await db.exec(lf(`${REPO}/migrations/495_onboarding_evidence.sql`));
await db.exec(`INSERT INTO schema_migrations (filename, sha256) VALUES ('495_onboarding_evidence.sql', 'recorded')`);

// 500 / 501 exactly as committed (their own rehearsal, 501_conversion_builder_e2e, runs them through the
// tool against their seed community); 535 through the Approve & Apply tool with its real checks file.
for (const F of ['500_transfer_assessment_proration.sql', '501_conversion_builder_coverage.sql']) {
  await db.exec(lf(`${REPO}/migrations/${F}`)); await db.query(`INSERT INTO schema_migrations (filename, sha256) VALUES ($1, 'recorded')`, [F]);
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm535-e2e-')); fs.mkdirSync(path.join(dir, 'checks'));
const FILES = ['535_conversion_primitives.sql', '536_conversion_execute_establishment.sql'];
for (const F of FILES) {
  fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
  const cf = `${REPO}/migrations/checks/${F.replace('.sql', '.json')}`;
  if (fs.existsSync(cf)) fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), lf(cf));
}
const ctxA = { client: world.client, user: { id: 'o', email: 'owner@example.test' }, deployedCommit: 'deadbeefcafe', migrationsDir: dir, secret: 'e2e' };

// ------------------------------------------- the community BEFORE 535 (tenures by the old guards)
const ACC = {};
await db.query(`INSERT INTO account_funds VALUES ($1, $2, 'OPR')`, [OPR, COMM]);
for (const [n, t] of [['1000', 'asset'], ['1300', 'asset'], ['2000', 'liability'], ['2310', 'liability'], ['2400', 'liability'], ['3000', 'equity'], ['3050', 'equity'], ['4000', 'revenue'], ['5000', 'expense']]) {
  ACC[n] = (await one(`INSERT INTO chart_of_accounts (id, community_id, account_number, fund_id, account_type) VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING id`, [COMM, n, OPR, t])).id;
}
await db.query(`INSERT INTO accounting_periods (community_id, fiscal_year, period_number, period_start, period_end, status)
  SELECT $1, 2026, m, make_date(2026, m, 1), (make_date(2026, m, 1) + interval '1 month - 1 day')::date, 'open' FROM generate_series(1, 12) m`, [COMM]);
const P1 = u(101); const P2 = u(102); const T1 = u(201); const TLEG = u(202); const TLEG2 = u(203);
await db.exec(`
  INSERT INTO properties (id, community_id, vantaca_account_id, street_address, city, state, zip) VALUES
    ('${P1}', '${COMM}', '20001', '1 Example Lane', 'Example', 'TX', '77000'), ('${P2}', '${COMM}', '20002', '2 Example Lane', 'Example', 'TX', '77000');
  INSERT INTO ownership_tenures (id, community_id, property_id, kind, start_date, vantaca_account_id, origin) VALUES
    ('${T1}', '${COMM}', '${P1}', 'owner', '2020-01-01', '20001', 'backfill_current'),
    ('${TLEG}', '${COMM}', NULL, 'legacy', NULL, '90010', 'backfill_legacy'),
    ('${TLEG2}', '${COMM}', NULL, 'legacy', NULL, '20002', 'backfill_legacy');`);
// P2 has NEVER had an owner tenure (a lot added before the conversion): the conversion establishes it.
// REGRESSION: P2's source account 20002 was previously held on a LEGACY record (TLEG2, no lot). The
// cutoff balance of 20002 belongs to the current owner the conversion establishes on P2, never to the
// legacy record, which stays for provenance only and carries no balance.
// Production carries 459's single-transfer-path guard on ownership_tenures; install the real one (as
// committed) so 535's object diff here is production's (the guard function CHANGED, not added).
{ const m459 = lf(`${REPO}/migrations/459_ownership_transfer_single_path.sql`);
  await db.exec(m459.slice(m459.indexOf('CREATE OR REPLACE FUNCTION ownership_transfer_in_progress'), m459.indexOf('CREATE OR REPLACE FUNCTION property_ownerships_transfer_guard'))); }

for (const F of FILES) {
  const plan = await A.planMigration({ ...ctxA, filename: F });
  const r = await A.applyMigration({ ...ctxA, planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) });
  if (PRINT && F === process.env.PRINT_FILE) { console.log('OBJECTS' + JSON.stringify((r.detail || {}).objects || r)); process.exit(0); }
  check(`${F}: planned (every preflight passes) and applied + verified through the tool`, plan.status === 'ready' && r.status === 'applied', JSON.stringify({ plan: plan.status, pre: plan.preflight, err: plan.error, r: r.status, e: r.error, d: r.detail }).slice(0, 2500));
  if (r.status !== 'applied') { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }
}

// ------------------------------------------------------- service over the real SQL
const RO = (() => {
  const from = (table) => {
    const st = { cols: '*', where: [], params: [], order: null, lim: null, off: 0 };
    const b = {
      select(c) { st.cols = c; return b; },
      eq(c, v) { st.params.push(v); st.where.push(`${c} = $${st.params.length}`); return b; },
      in(c, arr) { st.params.push(arr.map(String)); st.where.push(`${c}::text = ANY($${st.params.length}::text[])`); return b; },
      gte(c, v) { st.params.push(v); st.where.push(`${c} >= $${st.params.length}`); return b; },
      lte(c, v) { st.params.push(v); st.where.push(`${c} <= $${st.params.length}`); return b; },
      order(c, o = {}) { st.order = `${c} ${o.ascending === false ? 'DESC' : 'ASC'}`; return b; },
      range(a, z) { st.off = a; st.lim = z - a + 1; return b; },
      then(res, rej) {
        const sql = `SELECT to_jsonb(x) AS j FROM (SELECT ${st.cols} FROM ${table}${st.where.length ? ` WHERE ${st.where.join(' AND ')}` : ''}${st.order ? ` ORDER BY ${st.order}` : ''}${st.lim != null ? ` LIMIT ${st.lim} OFFSET ${st.off}` : ''}) x`;
        return db.query(sql, st.params).then((r) => ({ data: r.rows.map((row) => row.j), error: null }), (e) => ({ data: null, error: { message: e.message } })).then(res, rej);
      },
    };
    return b;
  };
  return { __readOnly: true, from };
})();
const { loadTrustedActivity, loadConversionContext } = require(`${REPO}/lib/onboarding/trusted_activity.js`);
const storage = { async putOnce() {}, async get() { return Buffer.alloc(0); } };
const svc = createOnboardingService({ rpc, storage, trustedReader: (cid) => loadTrustedActivity(RO, cid), conversionContext: (cid, o) => loadConversionContext(RO, cid, o) });
const ED = { kind: 'human', id: 'owner-user-id', email: 'owner@example.test', role: 'owner' };
const AGENT = { kind: 'agent', id: 'agent-1', assigned_stage: 'source_controls' };

// =============================================== 1) the persisted normalized source
const CUTOFF = '2026-03-31';
const B0 = await rpc('onboarding_create_batch', { p_community: COMM, p_batch_code: 'CONV-EXM-FACTS', p_as_of: CUTOFF, p_source_system: 'vantaca', p_actor_kind: 'human', p_actor_id: 'owner-user-id' });
const ctl = [{ code: 'ok', label: 'ok', status: 'PASS' }];
const c0 = await rpc('onboarding_record_completion', { p_batch: B0, p_stage: 'intake', p_status: 'PASS', p_open: [], p_controls: ctl, p_summary: {}, p_actor_kind: 'system', p_actor_id: 'op' });
await rpc('onboarding_auto_advance', { p_batch: B0, p_completion: c0, p_actor_id: 'op' });
check('a normalize PASS WITHOUT persisted facts is refused by the database (fails closed with the migration named)',
  /persisted source facts \(migration 535\)/.test((await code(() => rpc('onboarding_record_completion', { p_batch: B0, p_stage: 'normalize', p_status: 'PASS', p_open: [], p_controls: ctl, p_summary: {}, p_actor_kind: 'system', p_actor_id: 'op' }))) || ''));
const parsed = { gl_trial_balance: { artifact_type: 'gl_trial_balance', period: { start: '2026-01-01', end: CUTOFF }, defects: [], printed: {},
  rows: [{ domain: 'gl_account_balance', account_code: '1000', ending_cents: 100, provenance: { artifact_sha256: 'a'.repeat(64), locator: { line: 1 }, raw: '1000 ...' } },
         { domain: 'gl_account_balance', account_code: '3000', ending_cents: -100, provenance: { artifact_sha256: 'a'.repeat(64), locator: { line: 2 }, raw: '3000 ...' } }] } };
const facts = SF.factsFromParsed(parsed, { cutoff: CUTOFF });
const FS = await rpc('onboarding_open_fact_set', { p_batch: B0, p_cutoff: CUTOFF, p_actor_kind: 'system', p_actor_id: 'op' });
await rpc('onboarding_append_source_facts', { p_fact_set: FS, p_facts: facts.facts.slice(0, 2) });
check('sealing with a count the set does not hold is refused', /holds 2 facts/.test((await code(() => rpc('onboarding_seal_fact_set', { p_fact_set: FS, p_count: facts.fact_count, p_sha256: facts.facts_sha256, p_slices: [] }))) || ''));
await rpc('onboarding_append_source_facts', { p_fact_set: FS, p_facts: facts.facts.slice(2) });
await rpc('onboarding_seal_fact_set', { p_fact_set: FS, p_count: facts.fact_count, p_sha256: facts.facts_sha256, p_slices: [] });
check('a sealed fact set accepts no more facts', /sealed|no staging fact set/.test((await code(() => rpc('onboarding_append_source_facts', { p_fact_set: FS, p_facts: [{ ...facts.facts[0], seq: 99 }] }))) || ''));
check('stored facts are permanent (no update, no delete)', /permanent/.test((await code(() => db.query(`UPDATE onboarding_source_facts SET raw = 'x' WHERE fact_set_id = $1`, [FS]))) || '')
  && /permanent/.test((await code(() => db.query(`DELETE FROM onboarding_source_facts WHERE fact_set_id = $1`, [FS]))) || ''));
check('a normalize result naming a WRONG fingerprint for the set is refused', /sealed, unbound set/.test((await code(() => rpc('onboarding_record_completion', { p_batch: B0, p_stage: 'normalize', p_status: 'PASS', p_open: [], p_controls: ctl,
  p_summary: { fact_set: { id: FS, fact_count: facts.fact_count, facts_sha256: 'f'.repeat(64) } }, p_actor_kind: 'system', p_actor_id: 'op' }))) || ''));
const n0 = await rpc('onboarding_record_completion', { p_batch: B0, p_stage: 'normalize', p_status: 'PASS', p_open: [], p_controls: ctl, p_summary: { fact_set: { id: FS, fact_count: facts.fact_count, facts_sha256: facts.facts_sha256 } }, p_actor_kind: 'system', p_actor_id: 'op' });
check('the normalize PASS with its sealed fact set is recorded and binds the set (once)', !!n0 && (await one(`SELECT completion_event_id FROM onboarding_source_fact_sets WHERE id = $1`, [FS])).completion_event_id === n0);
check('a bound fact set cannot be bound to a second result', /sealed, unbound set/.test((await code(() => rpc('onboarding_record_completion', { p_batch: B0, p_stage: 'normalize', p_status: 'PASS', p_open: [], p_controls: ctl,
  p_summary: { fact_set: { id: FS, fact_count: facts.fact_count, facts_sha256: facts.facts_sha256 } }, p_actor_kind: 'system', p_actor_id: 'op' }))) || ''));
{
  const view = await rpc('onboarding_batch_view', { p_batch: B0 });
  const src = await svc.loadSource(view);
  check('later stages read the normalized source back from the stored facts, re-hashed, exactly as stored', PF.canonicalJson(src.parsed) === PF.canonicalJson(SF.parsedFromFacts(facts.facts)) && src.factSet.id === FS);
}

// ======================================== 2) adjustments and policies: fingerprints and approvals
const EVID = { description: 'GL trial balance at the cutoff', artifact_sha256: 'a'.repeat(64), locator: 'account 3000' };
await db.query(`INSERT INTO onboarding_artifacts (batch_id, community_id, artifact_type, filename, sha256, bytes, storage_path, source_system, cutoff_date) VALUES ($1, $2, 'gl_trial_balance', 'tb.txt', $3, 10, 'x', 'vantaca', $4)`, [B0, COMM, 'a'.repeat(64), CUTOFF]).catch(() => null);
const adjBody = (no, extra = {}) => ({ adjustment_no: no, kind: 'equity_normalization', effect: 'post_opening', allow_sign_change: true, lines: [{ account: '3000', amount_cents: 500 }, { account: '3050', amount_cents: -500 }], resolves: [], reason: 'Move the never-closed opening fund balance to the accumulated fund balance', evidence: EVID, ...extra });
const r1 = await rpc('conversion_propose_adjustment', { p_batch: B0, p_adjustment: adjBody(1), p_actor_kind: 'agent', p_actor_id: 'agent-1' });
const row1 = await one(`SELECT * FROM conversion_adjustments WHERE id = $1`, [r1.id]);
const recomputed = (await one(`SELECT conversion_sha256_jsonb(jsonb_build_object('batch_id', batch_id, 'adjustment_no', adjustment_no, 'kind', kind, 'effect', effect, 'allow_sign_change', allow_sign_change, 'lines', lines, 'resolves', resolves, 'open_ap_items', open_ap_items, 'reason', reason, 'evidence', evidence)) AS f FROM conversion_adjustments WHERE id = $1`, [r1.id])).f;
check('the DATABASE computes the fingerprint over the content (the caller cannot supply it)', row1.fingerprint === r1.fingerprint && row1.fingerprint === recomputed && row1.status === 'proposed' && row1.fingerprint !== '0'.repeat(64));
check('an unbalanced adjustment is refused', /must balance/.test((await code(() => rpc('conversion_propose_adjustment', { p_batch: B0, p_adjustment: adjBody(2, { lines: [{ account: '3000', amount_cents: 500 }, { account: '3050', amount_cents: -400 }] }), p_actor_kind: 'agent', p_actor_id: 'agent-1' }))) || ''));
check('a sign change on an OPENING adjustment is refused (the opening always equals the source sign)', /sign_change|23514/.test((await code(() => rpc('conversion_propose_adjustment', { p_batch: B0, p_adjustment: adjBody(2, { effect: 'opening' }), p_actor_kind: 'agent', p_actor_id: 'agent-1' }))) || ''));
check('an adjustment cannot be created already approved', /created proposed/.test((await code(() => db.query(`INSERT INTO conversion_adjustments (batch_id, community_id, adjustment_no, kind, effect, lines, reason, evidence, fingerprint, status, proposed_by_kind, proposed_by, approved_by_user_id, approved_at, approval_channel)
  VALUES ($1, $2, 9, 'opening_correction', 'opening', '[{"account":"1","amount_cents":1},{"account":"2","amount_cents":-1}]', 'a reason long enough', $3, $4, 'approved', 'agent', 'x', 'y', now(), 'in_app')`, [B0, COMM, EVID, 'e'.repeat(64)]))) || ''));
check('content is immutable once proposed', /content is fixed/.test((await code(() => db.query(`UPDATE conversion_adjustments SET reason = 'changed reason here' WHERE id = $1`, [r1.id]))) || ''));
check('status changes only through the decision function', /only through conversion_decide_object/.test((await code(() => db.query(`UPDATE conversion_adjustments SET status = 'approved', approved_by_user_id = 'x', approved_at = now(), approval_channel = 'in_app' WHERE id = $1`, [r1.id]))) || ''));
const decide = (o) => rpc('conversion_decide_object', { p_object_type: 'adjustment', p_object_id: r1.id, p_decision: 'approved', p_fingerprint: r1.fingerprint, p_channel: 'in_app', p_actor_kind: 'human', p_actor_id: 'owner-user-id', p_actor_label: 'owner@example.test', p_note: null, ...o });
check('an operator / agent can never approve (DATABASE)', /only a human/.test((await code(() => decide({ p_actor_kind: 'system', p_actor_id: 'onboarding-operator' }))) || '') && /only a human/.test((await code(() => decide({ p_actor_kind: 'agent', p_actor_id: 'agent-1' }))) || ''));
check('an approval through another channel is refused (DATABASE)', /channel in_app/.test((await code(() => decide({ p_channel: 'email' }))) || ''));
check('an approval of a fingerprint the owner did not see is refused (DATABASE)', /fingerprint you reviewed/.test((await code(() => decide({ p_fingerprint: 'd'.repeat(64) }))) || ''));
check('the service refuses a non-owner and a non-app channel before the database', /OWNER_ONLY/.test((await code(() => svc.decideObject({ kind: 'human', id: 'staff', role: 'admin' }, B0, { object_type: 'adjustment', id: r1.id, decision: 'approved', fingerprint: r1.fingerprint, channel: 'in_app' }))) || '')
  && /IN_APP_ONLY/.test((await code(() => svc.decideObject(ED, B0, { object_type: 'adjustment', id: r1.id, decision: 'approved', fingerprint: r1.fingerprint, channel: 'chat' }))) || ''));
const d1 = await svc.decideObject(ED, B0, { object_type: 'adjustment', id: r1.id, decision: 'approved', fingerprint: r1.fingerprint, channel: 'in_app' });
const ap1 = await one(`SELECT * FROM conversion_adjustments WHERE id = $1`, [r1.id]);
check('the owner approves exactly that fingerprint in the app: who (the session user id + label), when, channel in_app',
  d1.status === 'approved' && ap1.approved_by_user_id === 'owner-user-id' && ap1.approved_by_label === 'owner@example.test' && ap1.approval_channel === 'in_app' && !!ap1.approved_at);
check('a second decision on an approved adjustment is refused', /is approved/.test((await code(() => decide({}))) || ''));
const ev1 = await q(`SELECT event, actor_kind, channel, fingerprint FROM conversion_object_events WHERE object_id = $1 ORDER BY seq`, [r1.id]);
check('the audit trail: proposed (agent) then approved (human, in_app, the fingerprint)', JSON.stringify(ev1.map((e) => [e.event, e.actor_kind, e.channel, e.fingerprint === r1.fingerprint])) === JSON.stringify([['proposed', 'agent', 'agent', true], ['approved', 'human', 'in_app', true]]));
check('the audit trail is append-only', /append-only/.test((await code(() => db.query(`DELETE FROM conversion_object_events WHERE object_id = $1`, [r1.id]))) || ''));
check('the approved-objects digest in SQL equals the JS formula', (await rpc('onboarding_conversion_objects_digest', { p_batch: B0 })) === OBJ.objectsDigest(await svc.listObjects(B0)));
check('a carried-balance policy without source evidence or exact cents is refused (DATABASE)',
  /carried-balance policy names/.test((await code(() => rpc('conversion_propose_policy', { p_batch: B0, p_policy: { policy_kind: 'carried_balance', value: { control: 'preflight.builder_positions_resolved', reconciling_kind: 'builder_position_unresolved', item_key: 'lot-1', amount_cents: 9018, label: 'a builder balance carried' }, reason: 'carried as the source shows it' }, p_actor_kind: 'agent', p_actor_id: 'agent-1' }))) || '')
  && /carried-balance policy names/.test((await code(() => rpc('conversion_propose_policy', { p_batch: B0, p_policy: { policy_kind: 'carried_balance', value: { control: 'preflight.builder_positions_resolved', reconciling_kind: 'builder_position_unresolved', item_key: 'lot-1', amount_cents: 'about 90', label: 'a builder balance carried' }, reason: 'carried as the source shows it', evidence: EVID }, p_actor_kind: 'agent', p_actor_id: 'agent-1' }))) || ''));
check('open AP items ride only on an OPENING correction (DATABASE)', /open_ap_shape|23514/.test((await code(() => rpc('conversion_propose_adjustment', { p_batch: B0, p_adjustment: adjBody(7, { effect: 'post_opening', open_ap_items: [{ vendor: 'Acme Pools', invoice_number: 'X-1', invoice_date: '2026-03-01', amount_cents: 500 }] }), p_actor_kind: 'agent', p_actor_id: 'agent-1' }))) || ''));
check('a suspense policy that would allocate to owners is refused (DATABASE)', /never allocated/.test((await code(() => rpc('conversion_propose_policy', { p_batch: B0, p_policy: { policy_kind: 'suspense_treatment', value: { account: '2310', label: 'Unapplied cash carried', allocate_to_owners: true }, reason: 'no owner-level source exists' }, p_actor_kind: 'agent', p_actor_id: 'agent-1' }))) || ''));
const pp = { policy_kind: 'timing_treatment', value: { treatment: 'record_on_cutover_date', applies_to: 'absent_from_source_created_after_cutover', max_days_before_cutoff: 31 }, reason: 'late-entered bills move to the cutover date' };
await rpc('conversion_propose_policy', { p_batch: B0, p_policy: pp, p_actor_kind: 'agent', p_actor_id: 'agent-1' });
check('only one live policy per kind and key', /uq_conversion_policies_live|duplicate key/.test((await code(() => rpc('conversion_propose_policy', { p_batch: B0, p_policy: pp, p_actor_kind: 'agent', p_actor_id: 'agent-1' }))) || ''));
const r1b = await rpc('conversion_propose_adjustment', { p_batch: B0, p_adjustment: { ...adjBody(1), supersedes_id: r1.id, reason: 'Move the opening fund balance (restated reason)' }, p_actor_kind: 'agent', p_actor_id: 'agent-1' });
check('an approved adjustment can be superseded by a new proposal (the approval itself is never rewritten)', (await one(`SELECT status, approved_by_user_id FROM conversion_adjustments WHERE id = $1`, [r1.id])).status === 'superseded'
  && (await one(`SELECT status, approved_by_user_id FROM conversion_adjustments WHERE id = $1`, [r1.id])).approved_by_user_id === 'owner-user-id' && (await one(`SELECT status FROM conversion_adjustments WHERE id = $1`, [r1b.id])).status === 'proposed');

// ==================================================== 3) EXECUTE with the 535 writes
const period = async (d) => (await one(`SELECT id FROM accounting_periods WHERE community_id = $1 AND period_start <= $2::date AND period_end >= $2::date`, [COMM, d])).id;
const L1 = u(801); const LB = u(802);
await db.query(`INSERT INTO journal_entries (id, community_id, period_id, posting_date, reference, description, source_module, total_debits_cents, total_credits_cents, status) VALUES ($1, $2, $3, '2026-02-28', 'JE-L1', 'legacy import', 'vantaca_import', 700, 700, 'posted')`, [L1, COMM, await period('2026-02-28')]);
await db.query(`INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, fund_id, debit_cents, credit_cents) VALUES ($1, 1, $2, $3, 700, 0), ($1, 2, $4, $3, 0, 700)`, [L1, ACC['1300'], OPR, ACC['4000']]);
await db.query(`INSERT INTO transaction_upload_batches (id, management_company_id, community_id, period_label, as_of_date, row_count, status) VALUES ($1, $2, $3, 'legacy import', '2026-02-28', 1, 'committed')`, [LB, MC, COMM]);
await db.query(`INSERT INTO homeowner_transactions (source_batch_id, source_row_index, community_id, vantaca_account_id, property_id, transaction_date, description, txn_type, amount_cents) VALUES ($1, 1, $2, '20001', $3, '2026-02-01', 'legacy charge', 'charge', 700)`, [LB, COMM, P1]);

async function toPreflight(batchCode) {
  const B = await rpc('onboarding_create_batch', { p_community: COMM, p_batch_code: batchCode, p_as_of: CUTOFF, p_source_system: 'vantaca', p_actor_kind: 'human', p_actor_id: 'owner-user-id' });
  const c = await rpc('onboarding_record_completion', { p_batch: B, p_stage: 'intake', p_status: 'PASS', p_open: [], p_controls: ctl, p_summary: {}, p_actor_kind: 'system', p_actor_id: 'op' });
  await rpc('onboarding_auto_advance', { p_batch: B, p_completion: c, p_actor_id: 'op' });
  const fs1 = await rpc('onboarding_open_fact_set', { p_batch: B, p_cutoff: CUTOFF, p_actor_kind: 'system', p_actor_id: 'op' });
  await rpc('onboarding_append_source_facts', { p_fact_set: fs1, p_facts: facts.facts });
  await rpc('onboarding_seal_fact_set', { p_fact_set: fs1, p_count: facts.fact_count, p_sha256: facts.facts_sha256, p_slices: [] });
  const nz = await rpc('onboarding_record_completion', { p_batch: B, p_stage: 'normalize', p_status: 'PASS', p_open: [], p_controls: ctl, p_summary: { fact_set: { id: fs1, fact_count: facts.fact_count, facts_sha256: facts.facts_sha256 } }, p_actor_kind: 'system', p_actor_id: 'op' });
  await rpc('onboarding_auto_advance', { p_batch: B, p_completion: nz, p_actor_id: 'op' });
  const sc = await rpc('onboarding_record_completion', { p_batch: B, p_stage: 'source_controls', p_status: 'PASS', p_open: [], p_controls: ctl, p_summary: {}, p_actor_kind: 'system', p_actor_id: 'op' });
  await rpc('onboarding_auto_advance', { p_batch: B, p_completion: sc, p_actor_id: 'op' });
  return B;
}
// The owner's decisions for a batch, as approved records: an opening correction, a post-opening
// equity normalization that changes 3050's sign, legacy owners in the control accounts, suspense.
const TB = { 1000: 10000, 1300: 2700, 2000: -500, 2310: -400, 2400: -300, 3000: -6000, 3050: 1000, 4000: -9000, 5000: 2500 };
await db.query(`INSERT INTO vendors (id, name, management_company_id) VALUES ($1, 'Acme Pools', $2)`, [u(950), MC]);
const source = {
  aging_rows: [{ source_account_key: '90009', previous_owner: true, balance_cents: 500, provenance: { artifact_sha256: 'a'.repeat(64), locator: { line: 9 }, raw: '90009 - *** 9 Placeholder Way - Prior Owner' } }],
  prepaid_rows: [{ source_account_key: '90010', previous_owner: true, amount_cents: 100, provenance: { artifact_sha256: 'a'.repeat(64), locator: { line: 3 }, raw: '***90010  10 Placeholder Way  Earlier Owner  1.00' } }],
  ledger_accounts: [{ source_account_key: '20002', provenance: { artifact_sha256: 'a'.repeat(64), locator: { line: 40 }, raw: '20002 - Example Builder LLC - 2 Example Lane' } }],
};
const trustedNow = async () => (await loadTrustedActivity(RO, COMM)).trusted;
const legacyItems = async (code0) => [{ item_no: 1, event_key: 'legacy', kind: 'legacy_import', classification: 'ALREADY_IN_SOURCE', method: 'provenance_legacy_import', amount_cents: 700,
  records: [`journal_entries:${L1}`, ...((await q(`SELECT id FROM homeowner_transactions WHERE source_batch_id = $1`, [LB])).map((r) => `homeowner_transactions:${r.id}`))] }]
  .map((it) => ({ confidence: 'high', evidence: { resolution: 'already_in_source' }, ...it, batch_code: code0, cutoff_date: CUTOFF }));
// Walk a batch through its objects, snapshot and bridge (each recorded through the real functions).
async function prepare(code0) {
  const Bx = await toPreflight(code0);
  const propose = (body) => rpc('conversion_propose_adjustment', { p_batch: Bx, p_adjustment: body, p_actor_kind: 'agent', p_actor_id: 'agent-1' });
  const proposeP = (body) => rpc('conversion_propose_policy', { p_batch: Bx, p_policy: body, p_actor_kind: 'agent', p_actor_id: 'agent-1' });
  const approve = async (type, r) => svc.decideObject(ED, Bx, { object_type: type, id: r.id, decision: 'approved', fingerprint: r.fingerprint, channel: 'in_app' });
  const A1 = await propose({ adjustment_no: 1, kind: 'opening_correction', effect: 'opening', lines: [{ account: '3050', amount_cents: 100 }, { account: '2000', amount_cents: -100 }], resolves: [{ control: 'ap_aging.total_equals_gl_ap', account: '2000' }], reason: 'A paid bill never entered left a debit in AP', evidence: EVID });
  const A2 = await propose({ adjustment_no: 2, kind: 'equity_normalization', effect: 'post_opening', allow_sign_change: true, lines: [{ account: '3000', amount_cents: 6000 }, { account: '3050', amount_cents: -6000 }], reason: 'The opening fund balance was never closed to the accumulated fund balance', evidence: EVID });
  const PL = await proposeP({ policy_kind: 'legacy_owner_routing', value: { presentation: 'control_accounts' }, reason: 'prior owners stay in the control accounts on legacy records' });
  const PS = await proposeP({ policy_kind: 'suspense_treatment', value: { account: '2310', label: 'Unapplied cash carried from the prior system', allocate_to_owners: false }, reason: 'no owner-level source exists for it' });
  for (const [t, r] of [['adjustment', A1], ['adjustment', A2], ['policy', PL], ['policy', PS]]) await approve(t, r);
  const objs = await svc.listObjects(Bx);
  // Source position at the cutoff (synthetic), with the approved opening correction applied as the snapshot does.
  const corr = OBJ.openingCorrections(objs)[0];
  const gl = Object.entries(TB).map(([a, c], i) => {
    const m = corr.lines.filter((l) => l.account === a).reduce((t, l) => t + l.amount_cents, 0);
    return { line_no: i + 1, kind: 'gl_opening_balance', account_code: a, amount_cents: c + m, detail: m ? { source_ending_cents: c, corrections: corr.lines.filter((l) => l.account === a).map((l) => ({ amount_cents: l.amount_cents, object_id: corr.object_id, fingerprint: corr.fingerprint })) } : {} };
  });
  const lines = gl.concat([
    { line_no: 20, kind: 'ar_aging_item', account_code: '1300', source_account_key: '20001', amount_cents: 1500, detail: { charge_type: 'Annual Assessment' } },
    { line_no: 21, kind: 'ar_aging_item', account_code: '1300', source_account_key: '20002', amount_cents: 700, detail: { charge_type: 'Annual Assessment' } },
    { line_no: 22, kind: 'ar_aging_item', account_code: '1300', source_account_key: '90009', amount_cents: 500, detail: { charge_type: 'Late Fee' } },
    { line_no: 23, kind: 'prepaid_detail', account_code: '2400', source_account_key: '20001', amount_cents: -200, detail: {} },
    { line_no: 24, kind: 'prepaid_detail', account_code: '2400', source_account_key: '90010', amount_cents: -100, detail: { former_owner: true } },
    { line_no: 25, kind: 'ap_detail', account_code: '2000', amount_cents: -600, detail: { source_vendor_key: 'ACME POOLS', invoice_number: 'INV-1', invoice_date: '2026-03-10' } },
  ]).map((l) => ({ ...l, batch_code: code0, cutoff_date: CUTOFF, component: 'x', provenance: [{ artifact: 'synthetic', line: l.line_no }] }));
  const snap = await rpc('onboarding_record_snapshot', { p_batch: Bx, p_status: 'PASS', p_open: [], p_controls: ctl, p_summary: { roles: { ar_account: '1300', prepaid_account: '2400', ap_account: '2000' }, conversion_objects_digest: OBJ.objectsDigest(objs, { scope: 'snapshot' }) }, p_lines: lines, p_snapshot_sha256: 'a'.repeat(64), p_actor_kind: 'system', p_actor_id: 'op' });
  await rpc('onboarding_auto_advance', { p_batch: Bx, p_completion: snap, p_actor_id: 'op' });
  const fp = trustedFingerprint(await trustedNow());
  const items = await legacyItems(code0);
  const br = await rpc('onboarding_record_bridge', { p_batch: Bx, p_status: 'PASS', p_open: [], p_controls: ctl, p_summary: { snapshot_completion_id: snap, bridge_engine: 'test', conversion_objects_digest: OBJ.objectsDigest(objs, { scope: 'activity_bridge' }) }, p_items: items, p_bridge_sha256: 'b'.repeat(64), p_trusted_fingerprint: fp, p_actor_kind: 'system', p_actor_id: 'op' });
  await rpc('onboarding_auto_advance', { p_batch: Bx, p_completion: br, p_actor_id: 'op' });
  return { B: Bx, code: code0, snap, br, fp, items, lines, objs, A1, A2, proposeP, approve };
}
async function buildReport(W, { dropDigest = false } = {}) {
  const ctx = await loadConversionContext(RO, COMM, { cutoff: CUTOFF, identities: true }); const trusted = await trustedNow();
  const plan = buildConversionPlan({ batch: { id: W.B, batch_code: W.code, community_id: COMM, as_of_date: CUTOFF, source_system: 'vantaca' }, objects: await svc.listObjects(W.B),
    snapshot: { completion_id: W.snap, sha256: 'a'.repeat(64), roles: { ar_account: '1300', prepaid_account: '2400', ap_account: '2000' }, lines: W.lines },
    bridge: { completion_id: W.br, sha256: 'b'.repeat(64), trusted_fingerprint: W.fp, status: 'PASS', items: W.items }, source, trusted, ctx: { ...ctx, current_trusted_fingerprint: trustedFingerprint(trusted) } });
  if (dropDigest) delete plan.preconditions.conversion_objects_digest;
  const { controls, ...body } = plan;
  return PF.buildConversionPreflight({ batch: { batch_code: W.code, community_id: COMM, source_system: 'vantaca', stage: 'preflight' }, source_cutoff: { cutoff_date: CUTOFF, cutover_date: plan.cutover },
    inputs: { snapshot: { completion_id: W.snap, sha256: 'a'.repeat(64), status: 'PASS' }, bridge: { completion_id: W.br, sha256: 'b'.repeat(64), trusted_fingerprint: W.fp, status: 'PASS', engine: 'test' }, decisions: [], bridge_waivers: [], artifacts: [] },
    plan: body, controls }, []);
}
const recordPf = async (Bx, report) => rpc('onboarding_record_completion', { p_batch: Bx, p_stage: 'preflight', p_status: report.status.overall, p_open: report.controls.filter((c) => c.status !== 'PASS').map((c) => c.code),
  p_controls: report.controls.map((c) => ({ code: c.code, label: c.label, status: c.status })), p_summary: { preflight_format: report.format, preflight_sha256: report.sha256, preflight_report: report }, p_actor_kind: 'system', p_actor_id: 'onboarding-operator' });

// --- refusals, each on its own batch (an approved preflight hash is write-once per batch)
{
  const WX = await prepare('CONV-EXM-X-20260331');
  const rx = await buildReport(WX); const pfx = await recordPf(WX.B, rx);
  await svc.approve(ED, WX.B, { completion_id: pfx, preflight: rx });
  const extra = await WX.proposeP({ policy_kind: 'cutoff_authority', value: { source_system: 'vantaca', authoritative_through: CUTOFF }, reason: 'the source is the book of record through the cutoff' });
  await WX.approve('policy', extra);
  check('approved conversion objects changed after the preflight -> EXECUTE refused by the database', /changed since the preflight/.test((await code(() => rpc('onboarding_execute', { p_batch: WX.B, p_completion: pfx, p_preflight_sha256: rx.sha256, p_actor_kind: 'human', p_actor_id: 'owner-user-id' }))) || ''));
  check('... and by the service (stale preflight)', /PREFLIGHT_STALE|stale/.test((await code(() => svc.execute(ED, WX.B, { completion_id: pfx, preflight_sha256: rx.sha256 }))) || ''));
  const WY = await prepare('CONV-EXM-Y-20260331');
  const ry = await buildReport(WY, { dropDigest: true }); const pfy = await recordPf(WY.B, ry);
  // The service would already refuse it (stale: it binds no objects digest); approve it at the database to prove the database refuses too.
  check('the service refuses to approve a preflight that does not bind the approved objects', /PREFLIGHT_STALE/.test((await code(() => svc.approve(ED, WY.B, { completion_id: pfy, preflight: ry }))) || ''));
  await rpc('onboarding_approve', { p_batch: WY.B, p_completion: pfy, p_preflight_sha256: ry.sha256, p_actor_kind: 'human', p_actor_id: 'owner-user-id' });
  check('an old-format preflight that ignores approved conversion objects is refused by the database', /predates them/.test((await code(() => rpc('onboarding_execute', { p_batch: WY.B, p_completion: pfy, p_preflight_sha256: ry.sha256, p_actor_kind: 'human', p_actor_id: 'owner-user-id' }))) || ''));
}

// --- the proving batch
const W = await prepare('CONV-EXM-20260331');
const B = W.B; const A2 = W.A2; const brC = W.br;
check('bridge exceptions: recorded for the current bridge result only, then permanent', (await rpc('onboarding_record_exceptions', { p_batch: B, p_completion: brC, p_items: [{ event_key: 'legacy', classification: 'ALREADY_IN_SOURCE', resolution: 'already_in_source', method: 'provenance_legacy_import', confidence: 'high', amount_cents: 700, evidence: { note: 'x' } }], p_actor_kind: 'system', p_actor_id: 'op' })) === 1
  && /permanent|fixed once/.test((await code(() => db.query(`UPDATE conversion_exceptions SET detail = 'x' WHERE completion_event_id = $1`, [brC]))) || ''));
const report2 = await buildReport(W);
const w = report2.plan.writes;
check('the plan: every preflight control PASSES', report2.status.overall === 'PASS', JSON.stringify(report2.controls.filter((c) => c.status !== 'PASS')).slice(0, 1500));
check('the plan: one post-opening adjustment entry (3050 changes sign, declared), 2 audit-chain links, 1 legacy record (90009; 90010 reuses its existing one), 1 establishment (lot 2), 1 suspense item',
  w.adjustment_journal_entries.length === 1 && w.adjustment_applications.length === 2 && w.legacy_tenures.length === 1 && w.legacy_tenures[0].vantaca_account_id === '90009'
  && w.establishments.length === 1 && w.establishments[0].property_id === P2 && w.establishments[0].start_date === null
  && w.establishments[0].tenure_xref === null && w.establishments[0].xref_held_by_legacy_tenure === TLEG2 && (w.reconciling_items || []).some((x) => x.kind === 'suspense_balance' && x.item_key === '2310'),
  JSON.stringify(report2.plan.summary));
const pf2 = await recordPf(B, report2);
const apprErr = await code(() => svc.approve(ED, B, { completion_id: pf2, preflight: report2 }));
const res = apprErr ? null : await svc.execute(ED, B, { completion_id: pf2, preflight_sha256: report2.sha256 }).catch((e) => ({ error: e.message }));
check('EXECUTE succeeds with the 535 writes and counts', res && res.status === 'executed' && res.write_counts.adjustment_journal_entries === 1 && res.write_counts.adjustment_applications === 2 && res.write_counts.legacy_tenures === 1 && res.write_counts.establishments === 1, JSON.stringify(res || apprErr).slice(0, 1500));
const proposeP = W.proposeP;
if (res && res.status === 'executed') {
  const tb = Object.fromEntries((await q(`SELECT c.account_number AS a, sum(l.debit_cents - l.credit_cents)::bigint AS v FROM journal_entry_lines l JOIN journal_entries j ON j.id = l.journal_entry_id JOIN chart_of_accounts c ON c.id = l.account_id
    WHERE j.community_id = $1 AND j.posting_date <= $2 AND (j.status = 'posted' OR (j.status = 'voided' AND j.void_reversal_je_id IS NOT NULL)) GROUP BY 1`, [COMM, CUTOFF])).filter((r) => Number(r.v) !== 0).map((r) => [r.a, Number(r.v)]));
  check('cutoff TB = source + approved adjustments: 2000 carries the opening correction, 3000 is zero, 3050 changed sign as declared', tb['2000'] === -600 && !tb['3000'] && tb['3050'] === 1000 + 100 - 6000 && tb['1300'] === 2700, JSON.stringify(tb));
  const adjJe = await one(`SELECT reference, source_module, posting_date::text AS d FROM journal_entries WHERE reference = 'CONV-EXM-20260331-ADJ-002'`);
  check('the post-opening adjustment is its own entry, dated the cutoff', adjJe && adjJe.source_module === 'opening_entry' && adjJe.d === CUTOFF);
  const apps = await q(`SELECT a.*, c.adjustment_no FROM conversion_adjustment_applications a JOIN conversion_adjustments c ON c.id = a.adjustment_id WHERE a.batch_id = $1 ORDER BY c.adjustment_no`, [B]);
  check('the audit chain is permanent and complete: before -> approved lines + fingerprint -> after, and the GL measured at the cutoff equals the last after',
    apps.length === 2 && apps[0].before_balances['2000'] === -500 && apps[0].after_balances['2000'] === -600 && apps[1].before_balances['3050'] === 1100 && apps[1].after_balances['3050'] === -4900
    && apps[1].gl_after_execute['3050'] === -4900 && apps[1].fingerprint === A2.fingerprint && !!apps[1].journal_entry_id
    && /append-only/.test((await code(() => db.query(`DELETE FROM conversion_adjustment_applications WHERE batch_id = $1`, [B]))) || ''), JSON.stringify(apps.map((a) => [a.before_balances, a.after_balances, a.gl_after_execute])));
  const leg = await one(`SELECT kind, property_id, origin, start_date FROM ownership_tenures WHERE vantaca_account_id = '90009'`);
  check('a legacy-owner record was created for the prior owner (kind legacy, no lot, origin conversion)', leg && leg.kind === 'legacy' && leg.property_id === null && leg.origin === 'conversion' && leg.start_date === null);
  const prior = await q(`SELECT h.vantaca_account_id, h.amount_cents::int AS c, t.kind FROM homeowner_transactions h JOIN ownership_tenures t ON t.id = h.tenure_id WHERE h.community_id = $1 AND (h.raw_row_jsonb->'onboarding'->>'prior_owner')::boolean`, [COMM]);
  check('every prior-owner row (receivable AND credit) sits on a legacy record', prior.length === 2 && prior.every((r) => r.kind === 'legacy'), JSON.stringify(prior));
  const portal = await q(`SELECT vantaca_account_id, amount_cents::int AS c FROM v_current_owner_ledger WHERE community_id = $1 ORDER BY vantaca_account_id`, [COMM]);
  const bal = await q(`SELECT property_id, balance_cents::int AS b FROM v_current_owner_balance WHERE community_id = $1 ORDER BY property_id`, [COMM]);
  check('PORTAL PATH: the current-owner ledger and balances (what the portal reads) contain NO prior-owner row; lot 1 = 1,500 - 200, lot 2 = 700',
    !portal.some((r) => ['90009', '90010'].includes(r.vantaca_account_id)) && JSON.stringify(bal) === JSON.stringify([{ property_id: P1, b: 1300 }, { property_id: P2, b: 700 }]), JSON.stringify({ portal, bal }));
  const former = await q(`SELECT vantaca_account_id, balance_cents::int AS b FROM v_former_owner_ledger_balances WHERE community_id = $1 AND vantaca_account_id IN ('90009','90010') ORDER BY 1`, [COMM]);
  check('... and both prior-owner balances are separately identifiable in the former-owner view', JSON.stringify(former) === JSON.stringify([{ vantaca_account_id: '90009', b: 500 }, { vantaca_account_id: '90010', b: -100 }]), JSON.stringify(former));
  const est = await one(`SELECT t.kind, t.origin, t.start_date, t.vantaca_account_id, s.external_id, s.source_system FROM ownership_tenures t JOIN conversion_source_identities s ON s.tenure_id = t.id WHERE t.property_id = $1`, [P2]);
  check('the first owner tenure of lot 2 was established: origin conversion, start not invented, keyed by source system + account', est && est.kind === 'owner' && est.origin === 'conversion' && est.start_date === null && est.external_id === '20002' && est.source_system === 'vantaca');
  const estId = (await one(`SELECT tenure_id FROM conversion_source_identities WHERE community_id = $1 AND external_id = '20002'`, [COMM])).tenure_id;
  const on20002 = await q(`SELECT tenure_id, amount_cents::int AS c FROM homeowner_transactions WHERE community_id = $1 AND vantaca_account_id = '20002' AND source_batch_id IS DISTINCT FROM $2`, [COMM, LB]);
  const onLegacy = await one(`SELECT count(*)::int AS n, coalesce(sum(amount_cents), 0)::int AS c FROM homeowner_transactions WHERE tenure_id = $1`, [TLEG2]);
  const legacyRec = await one(`SELECT kind, property_id, vantaca_account_id, origin FROM ownership_tenures WHERE id = $1`, [TLEG2]);
  const formerOf20002 = await q(`SELECT balance_cents::int AS b FROM v_former_owner_ledger_balances WHERE community_id = $1 AND vantaca_account_id = '20002'`, [COMM]);
  check('REGRESSION: a source account previously held on a legacy record whose lot is established: its cutoff balance goes to the NEW current owner (not the legacy record)',
    on20002.length === 1 && on20002[0].tenure_id === estId && on20002[0].c === 700 && onLegacy.n === 0 && onLegacy.c === 0
    && legacyRec.kind === 'legacy' && legacyRec.property_id === null && legacyRec.vantaca_account_id === '20002' && legacyRec.origin === 'backfill_legacy'
    && formerOf20002.every((r) => r.b === 0), JSON.stringify({ estId, on20002, onLegacy, legacyRec, formerOf20002 }));
  check('a labelled suspense balance is a reconciling item (never allocated)', (await one(`SELECT kind, amount_cents::int AS c, detail->>'label' AS l FROM conversion_reconciling_items WHERE batch_id = $1 AND kind = 'suspense_balance'`, [B])).c === -400);
  // ---------------------------------------------------------------- idempotency
  const again = await svc.execute(ED, B, { completion_id: pf2, preflight_sha256: report2.sha256 });
  check('a retry returns the committed execution and writes nothing', again.status === 'already_executed' && again.rows_written_now === 0);
  check('the same source account can never be established twice (unique identity)', /uq_conversion_source_identity|duplicate key/.test((await code(() => db.query(`INSERT INTO conversion_source_identities (community_id, source_system, external_id_kind, external_id, property_id, batch_id) VALUES ($1, 'vantaca', 'account', '20002', $2, $3)`, [COMM, P2, B]))) || ''));
  check('the ownership guard refuses a second first-owner tenure for the lot even under the conversion flag', /first owner tenure|only a legacy-owner record/.test((await code(() => db.exec(`BEGIN; SELECT set_config('trusted.onboarding_establish', 'on', true);
    INSERT INTO ownership_tenures (community_id, property_id, kind, origin) VALUES ('${COMM}', '${P2}', 'owner', 'conversion'); COMMIT;`))) || ''));
  await db.exec('ROLLBACK').catch(() => null);
  check('outside EXECUTE a tenure still cannot be created (the transfer path only)', /approved ownership transfer/.test((await code(() => db.query(`INSERT INTO ownership_tenures (community_id, property_id, kind, origin) VALUES ($1, NULL, 'legacy', 'conversion')`, [COMM]))) || ''));
  check('after EXECUTE no adjustment or policy can be proposed or decided on the batch', /fixed once the batch enters execute/.test((await code(() => proposeP({ policy_kind: 'preserve_source_coding', value: { account: '5000', note: 'keep the source coding as is' }, reason: 'owner decision to keep it' }))) || ''));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
