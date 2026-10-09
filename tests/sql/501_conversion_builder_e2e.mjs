// tests/sql/501_conversion_builder_e2e.mjs — GitHub #96: the FULL Still Creek
// conversion rehearsal on the REAL SQL (452-498 onboarding engine, 235/253/466
// recognition engine, 360 + 500 + 501 applied through the single-migration tool
// with their real checks files), in Still Creek's real shape: 321 lots billed
// $495.00 on 1/1/2026, Lennar holding 24 (5302 Sleepy Fox billed $495.00, 5450
// Still Meadow showing $90.18 on 5/13, 22 never billed), 2205 at $79,449.50 on
// the 6/30 source TB. The conversion context comes from the PRODUCTION loader
// (loadConversionContext + loadBuilderContext) over a read-only PostgREST-shaped
// client; the plan from buildConversionPlan; approval, waivers and EXECUTE from
// the onboarding service. Then the monthly accrual (Jul-Dec, the GL lines from
// the production line builder), a Lennar -> homeowner transfer after the accrual,
// the full-year $247.50, a rate change the next year, the status surface, and the
// reconciling items' append-only / rerun guarantees.
// Postgres 17 (PGlite 0.3.x). Skips without PGlite. --report prints the exhibits.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { onboardingWorld } from './onboarding_world.mjs';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  501 conversion builder rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const { createOnboardingService } = require(`${REPO}/lib/onboarding/service.js`);
const { buildConversionPlan } = require(`${REPO}/lib/onboarding/conversion_plan.js`);
const { loadTrustedActivity, loadConversionContext, loadPostProofData } = require(`${REPO}/lib/onboarding/trusted_activity.js`);
const { trustedFingerprint } = require(`${REPO}/lib/onboarding/bridge.js`);
const PF = require(`${REPO}/lib/onboarding/preflight.js`);
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'; process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test';   // module load only
const { periodLines } = require(`${REPO}/lib/accounting/builder_accrual.js`);
const { glLines, recognitionScheduleRow } = require(`${REPO}/lib/accounting/transfer_proration.js`);
const { postingDateFor } = require(`${REPO}/lib/accounting/recognition_engine.js`);
const REPORT = process.argv.includes('--report'); const PRINT = process.argv.includes('--print-objects');
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const code = async (fn) => { try { await fn(); return null; } catch (e) { return `${e.code || ''} ${e.message || ''}`; } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const $ = (c) => `$${(Number(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const SCR = 'a0000000-0000-4000-8000-000000000006';
const LENNAR = '0eda1b79-0526-4e5d-8a4b-5488a0938ed1';
const LENNAR_NAME = 'Lennar Homes of Texas Land and Construction, Ltd.';
const MC = '00000000-0000-0000-0000-0000000000a1';

// ------------------------------------------------------------------- the database
const world = await onboardingWorld(PGlite, { through: 498, gl: true });
const { db, rpc } = world;
const q = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
await db.exec(`
  ALTER TABLE chart_of_accounts ADD COLUMN account_type text, ADD COLUMN is_active boolean DEFAULT true, ADD COLUMN is_summary boolean DEFAULT false;
  ALTER TABLE properties ADD COLUMN trusted_account_number text;
  ALTER TABLE contacts ADD COLUMN full_name text;
  ALTER TABLE vendors ADD COLUMN dba text, ADD COLUMN is_active boolean DEFAULT true;
  ALTER TABLE ownership_tenures ADD COLUMN vantaca_account_id text,
    ADD COLUMN origin text NOT NULL DEFAULT 'backfill_current' CHECK (origin IN ('backfill_current', 'backfill_historical', 'backfill_legacy', 'transfer'));
  ALTER TABLE homeowner_transactions ADD COLUMN is_operator_override boolean DEFAULT false,
    ADD COLUMN reduction_source text CHECK (reduction_source IS NULL OR (reduction_source IN ('cash_payment','prepaid_credit','credit_waiver','correcting_adjustment') AND amount_cents < 0));
  ALTER TABLE homeowner_transactions ALTER COLUMN vantaca_account_id DROP NOT NULL;
  ALTER TABLE communities ADD COLUMN books_of_record text;
  CREATE TABLE builder_companies (id uuid PRIMARY KEY, management_company_id uuid, company_name text NOT NULL);
  CREATE TABLE property_ownerships (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid REFERENCES properties(id), contact_id uuid REFERENCES contacts(id),
    tenure_id uuid REFERENCES ownership_tenures(id), start_date date, end_date date, is_primary boolean DEFAULT true);
  CREATE TABLE ownership_change_proposals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid, community_id uuid, status text NOT NULL,
    effective_start_date date, proposed_owner_name text, current_contact_id uuid, seller_tenure_id uuid REFERENCES ownership_tenures(id), buyer_tenure_id uuid REFERENCES ownership_tenures(id));
  CREATE TABLE library_documents (id uuid PRIMARY KEY);
  CREATE TABLE cd_parties (id uuid, community_id uuid); CREATE TABLE cd_ownerships (id uuid, community_id uuid); CREATE TABLE cd_addresses (id uuid, community_id uuid);
  CREATE TABLE cd_contact_methods (id uuid, community_id uuid); CREATE TABLE cd_occupancies (id uuid, community_id uuid); CREATE TABLE cd_evidence (id uuid, community_id uuid);
  -- financial tables the production Trusted loader reads (empty at Still Creek in this rehearsal)
  CREATE TABLE ap_payments (id uuid PRIMARY KEY, community_id uuid, vendor_id uuid, payment_date date, amount_cents bigint, payment_method text, check_number text, posting_journal_entry_id uuid, status text, voided_at timestamptz, created_at timestamptz, updated_at timestamptz);
  CREATE TABLE ap_payment_applications (id uuid PRIMARY KEY, payment_id uuid, invoice_id uuid, applied_cents bigint);
  CREATE TABLE ar_charges (id uuid PRIMARY KEY, community_id uuid, property_id uuid, charge_date date, original_amount_cents bigint, status text, source_module text, source_reference text, posting_journal_entry_id uuid, created_at timestamptz, updated_at timestamptz);
  CREATE TABLE ar_payments (id uuid PRIMARY KEY, community_id uuid, property_id uuid, payment_date date, amount_cents bigint, source text, source_reference text, status text, posting_journal_entry_id uuid, created_at timestamptz, updated_at timestamptz);
  CREATE TABLE payments (id uuid PRIMARY KEY, community_id uuid, property_id uuid, amount_cents bigint, status text, livemode boolean, paid_at timestamptz, journal_entry_id uuid, homeowner_txn_id uuid, created_at timestamptz, updated_at timestamptz);
  CREATE TABLE budget_line_items (id uuid PRIMARY KEY, budget_id uuid, account_id uuid, annual_amount_cents bigint, monthly_amounts_cents bigint[]);
  CREATE TABLE community_budgets (id uuid PRIMARY KEY, status text, fiscal_year int);
  CREATE TABLE budget_forecasts (id uuid PRIMARY KEY, community_id uuid);
  CREATE TABLE forecast_lines (id uuid PRIMARY KEY, forecast_id uuid, account_id uuid, method text, settings jsonb);`);
for (const m of ['235_recognition_engine.sql', '253_recognition_basis_daily.sql', '466_recognition_schedules_controls.sql', '360_assessment_proration.sql']) await db.exec(lf(`${REPO}/migrations/${m}`));
// The real JE reference function (359) the recognition posting engine calls.
{ const m359 = lf(`${REPO}/migrations/359_je_reference_gap_tolerant.sql`); await db.exec(m359.slice(m359.indexOf('CREATE OR REPLACE FUNCTION next_je_reference'), m359.indexOf('$ LANGUAGE plpgsql;') + '$ LANGUAGE plpgsql;'.length)); }
const m457 = lf(`${REPO}/migrations/457_current_tenure_reader_views.sql`);
await db.exec(m457.slice(m457.indexOf('CREATE OR REPLACE VIEW v_current_owner_ledger'), m457.indexOf('CREATE OR REPLACE VIEW v_current_owner_balance AS')));
await db.exec(`INSERT INTO schema_migrations (filename, sha256) VALUES ('360_assessment_proration.sql', 'recorded'), ('459_ownership_transfer_single_path.sql', 'recorded'),
  ('461_homeowner_payment_applications.sql', 'recorded'), ('466_recognition_schedules_controls.sql', 'recorded');
  INSERT INTO management_companies VALUES ('${MC}');
  INSERT INTO communities (id, name, management_company_id, gl_cutover_date, books_of_record) VALUES ('${SCR}', 'Still Creek Ranch', '${MC}', '2026-07-01', 'trusted');
  INSERT INTO builder_companies VALUES ('${LENNAR}', '${MC}', 'Lennar'), (gen_random_uuid(), '${MC}', 'Perry Homes');`);

// The two migrations through the Approve & Apply tool, with their real checks files.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm501-e2e-')); fs.mkdirSync(path.join(dir, 'checks'));
for (const F of ['500_transfer_assessment_proration.sql', '501_conversion_builder_coverage.sql']) {
  fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
  fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`));
}
const ctxA = { client: world.client, user: { id: 'o', email: 'owner@example.test' }, deployedCommit: 'deadbeefcafe', migrationsDir: dir, secret: 'e2e' };
for (const F of ['500_transfer_assessment_proration.sql', '501_conversion_builder_coverage.sql']) {
  { const req = JSON.parse(lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`)).requires || []; const missing = req.filter((x) => !fs.existsSync(`${REPO}/migrations/${x}`));
    check(`every prerequisite named by the ${F.slice(0, 3)} checks file is a real migration file`, missing.length === 0, JSON.stringify(missing)); }
  const plan = await A.planMigration({ ...ctxA, filename: F });
  const r = await A.applyMigration({ ...ctxA, planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) });
  if (PRINT && F.startsWith('501')) { console.log(JSON.stringify((r.detail || {}).objects || r, null, 2)); process.exit(0); }
  check(`${F}: planned (every preflight passes) and applied + verified through the tool`, plan.status === 'ready' && r.status === 'applied', JSON.stringify({ plan: plan.status, pre: plan.preflight, err: plan.error, r: r.status, e: r.error, d: r.detail }).slice(0, 1500));
  if (r.status !== 'applied') { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }
}

// ------------------------------------------------- a read-only PostgREST-shaped client
// (so the PRODUCTION loaders run unchanged: select / eq / in / gte / lte / order / range)
function readClient() {
  const from = (table) => {
    const st = { cols: '*', where: [], params: [], order: null, lim: null, off: 0, head: false };
    const b = {
      select(c, o = {}) { st.cols = c; st.head = !!o.head; return b; },
      eq(c, v) { st.params.push(v); st.where.push(`${c} = $${st.params.length}`); return b; },
      in(c, arr) { st.params.push(arr.map(String)); st.where.push(`${c}::text = ANY($${st.params.length}::text[])`); return b; },
      gte(c, v) { st.params.push(v); st.where.push(`${c} >= $${st.params.length}`); return b; },
      lte(c, v) { st.params.push(v); st.where.push(`${c} <= $${st.params.length}`); return b; },
      order(c, o = {}) { st.order = `${c} ${o.ascending === false ? 'DESC' : 'ASC'}`; return b; },
      range(a, z) { st.off = a; st.lim = z - a + 1; return b; },
      then(res, rej) {
        if (st.head) return db.query(`SELECT count(*)::int AS n FROM ${table}${st.where.length ? ` WHERE ${st.where.join(' AND ')}` : ''}`, st.params).then((r) => ({ count: r.rows[0].n, error: null }), (e) => ({ count: null, error: { message: e.message } })).then(res, rej);
        const sql = `SELECT to_jsonb(x) AS j FROM (SELECT ${st.cols} FROM ${table}${st.where.length ? ` WHERE ${st.where.join(' AND ')}` : ''}${st.order ? ` ORDER BY ${st.order}` : ''}${st.lim != null ? ` LIMIT ${st.lim} OFFSET ${st.off}` : ''}) x`;
        return db.query(sql, st.params).then((r) => ({ data: r.rows.map((row) => row.j), error: null }), (e) => ({ data: null, error: { message: e.message } })).then(res, rej);
      },
    };
    return b;
  };
  return { __readOnly: true, from };
}
const RO = readClient();

// ------------------------------------------------------------- Still Creek in miniature
const ACC = {}; const OPR = '00000000-0000-4000-8000-00000000f001';
await db.query(`INSERT INTO account_funds VALUES ($1, $2, 'OPR')`, [OPR, SCR]);
for (const [n, t] of [['1000', 'asset'], ['1300', 'asset'], ['2205', 'liability'], ['3000', 'equity'], ['4000', 'revenue'], ['5000', 'expense']]) {
  ACC[n] = (await one(`INSERT INTO chart_of_accounts (id, community_id, account_number, fund_id, account_type) VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING id`, [SCR, n, OPR, t])).id;
}
await db.query(`INSERT INTO accounting_periods (community_id, fiscal_year, period_number, period_start, period_end, status)
  SELECT $1, y, m, make_date(y, m, 1), (make_date(y, m, 1) + interval '1 month - 1 day')::date, 'open' FROM generate_series(2026, 2027) y, generate_series(1, 12) m`, [SCR]);
const LEG = (await one(`INSERT INTO transaction_upload_batches (management_company_id, community_id, period_label, as_of_date, row_count, status, uploaded_by) VALUES ($1, $2, 'Vantaca import', '2026-06-30', 0, 'committed', 'vantaca') RETURNING id`, [MC, SCR])).id;
let rowIx = 0;
async function lot(addr, vacct, owner, { tacct = null, rows = [] } = {}) {
  const p = (await one(`INSERT INTO properties (id, community_id, vantaca_account_id, street_address, trusted_account_number) VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING id`, [SCR, vacct, addr, tacct || `1006${vacct}`])).id;
  const t = (await one(`INSERT INTO ownership_tenures (id, community_id, property_id, kind, start_date, vantaca_account_id, origin) VALUES (gen_random_uuid(), $1, $2, 'owner', '2026-05-21', $3, 'backfill_current') RETURNING id`, [SCR, p, vacct])).id;
  const c = (await one(`INSERT INTO contacts (id, full_name) VALUES (gen_random_uuid(), $1) RETURNING id`, [owner])).id;
  await db.query(`INSERT INTO property_ownerships (property_id, contact_id, tenure_id, start_date) VALUES ($1, $2, $3, '2026-05-21')`, [p, c, t]);
  for (const r of rows) {
    await db.query(`INSERT INTO homeowner_transactions (source_batch_id, source_row_index, community_id, vantaca_account_id, property_id, transaction_date, description, txn_type, amount_cents, charge_category)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'charge', $8, $9)`, [LEG, ++rowIx, SCR, vacct, p, r.date, r.desc, r.cents, r.cat || null]);
  }
  return { property: p, seller: t, community: SCR, addr, vacct };
}
const ANNUAL = { date: '2026-01-01', desc: 'Annual Assessment', cents: 49500, cat: 'assessment' };
for (let i = 0; i < 320; i++) await lot(`${10000 + i} Creek Bend Dr`, String(10300000 + i), `Homeowner ${i}`, { rows: [ANNUAL] });
const S5302 = await lot('5302 Sleepy Fox', '10211416', LENNAR_NAME, { tacct: '1006808133', rows: [ANNUAL, { date: '2026-02-01', desc: 'Late Interest', cents: 825, cat: 'interest' }] });
const S5450 = await lot('5450 Still Meadow', '10216949', LENNAR_NAME, { rows: [{ date: '2026-05-13', desc: 'Assessment', cents: 9018, cat: 'assessment' }] });
const S8211 = await lot('8211 Rustic Pine Trail', '10216914', LENNAR_NAME, { tacct: '1006473433' });
const UNB = [S8211];
for (let i = 1; i < 22; i++) UNB.push(await lot(`${8300 + i} Rustic Pine Trail`, String(10217000 + i), LENNAR_NAME));
const UNSOLD = UNB[1];   // stays with Lennar all year: the full-year $247.50
await db.query(`UPDATE transaction_upload_batches SET row_count = $2 WHERE id = $1`, [LEG, rowIx]);
const period = async (d) => (await one(`SELECT id FROM accounting_periods WHERE community_id = $1 AND period_start <= $2::date AND period_end >= $2::date`, [SCR, d])).id;
async function postJe(ref, date, module, lines, sourceRef = null) {
  const tot = lines.reduce((t, l) => t + Number(l.debit_cents || 0), 0);
  const id = (await one(`INSERT INTO journal_entries (community_id, period_id, posting_date, reference, description, source_module, source_reference, total_debits_cents, total_credits_cents, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, 'posted') RETURNING id`, [SCR, await period(date), date, ref, `rehearsal ${ref}`, module, sourceRef, tot])).id;
  let n = 0;
  for (const l of lines) await db.query(`INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, fund_id, debit_cents, credit_cents, memo, property_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, ++n, l.account_id, OPR, Number(l.debit_cents || 0), Number(l.credit_cents || 0), l.memo || null, l.property_id || null]);
  return { id, reference: ref };
}
async function postJe2(community, ref, date, lines, sourceRef = null) {
  const per = (await one(`SELECT id FROM accounting_periods WHERE community_id = $1 AND period_start <= $2::date AND period_end >= $2::date`, [community, date])).id;
  const tot = lines.reduce((s, l) => s + Number(l.debit_cents || 0), 0);
  const fund = (await one(`SELECT id FROM account_funds WHERE community_id = $1 LIMIT 1`, [community])).id;
  const id = (await one(`INSERT INTO journal_entries (community_id, period_id, posting_date, reference, description, source_module, source_reference, total_debits_cents, total_credits_cents, status)
    VALUES ($1, $2, $3, $4, $5, 'assessment_billing', $6, $7, $7, 'posted') RETURNING id`, [community, per, date, ref, `rehearsal ${ref}`, sourceRef, tot])).id;
  let n = 0;
  for (const l of lines) await db.query(`INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, fund_id, debit_cents, credit_cents, memo, property_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, ++n, l.account_id, fund, Number(l.debit_cents || 0), Number(l.credit_cents || 0), l.memo || null, l.property_id || null]);
  return { id, reference: ref };
}
// The legacy (Vantaca-era) GL import in Trusted: retired at the cutover, replaced by the opening entries.
const L1 = await postJe('VANTACA-2026H1', '2026-06-30', 'vantaca_import', [{ account_id: ACC['1300'], debit_cents: 15889500 }, { account_id: ACC['2205'], credit_cents: 15889500 }]);

// Source position at 6/30/2026 (Still Creek's real 2205 and 4000; the rest synthetic, balanced).
const CUTOFF = '2026-06-30'; const CODE = 'CONV-SCR-20260630';
const TB = { 1000: 12780857, 1300: 108843, 2205: -7944950, 3000: -2000000, 4000: -7944750, 5000: 5000000 };
const AGING = [['10211416', 50325, 'Annual Assessment'], ['10216949', 9018, 'Assessment'], ['10300000', 49500, 'Annual Assessment']];
const snapshotLines = () => Object.entries(TB).map(([a, c], i) => ({ line_no: i + 1, kind: 'gl_opening_balance', account_code: a, amount_cents: c, detail: {} }))
  .concat(AGING.map(([k, c, t], i) => ({ line_no: 10 + i, kind: 'ar_aging_item', account_code: '1300', source_account_key: k, amount_cents: c, detail: { charge_type: t } })))
  .map((l) => ({ ...l, batch_code: CODE, cutoff_date: CUTOFF, component: l.kind === 'gl_opening_balance' ? 'gl' : 'ar', provenance: [{ artifact: 'rehearsal', line: l.line_no }] }));

const trustedReader = (cid) => loadTrustedActivity(RO, cid);
const conversionContext = (cid, opts) => loadConversionContext(RO, cid, opts);
const storage = { async putOnce() {}, async get() { return Buffer.alloc(0); } };
const postProofReader = (cid, opts) => loadPostProofData(RO, cid, opts);
const svc = createOnboardingService({ rpc, storage, trustedReader, conversionContext, postProofReader });
const ED = { kind: 'human', id: 'ed', role: 'owner' };
const ctl = [{ code: 'ok', label: 'ok', status: 'PASS' }];

const B = await rpc('onboarding_create_batch', { p_community: SCR, p_batch_code: CODE, p_as_of: CUTOFF, p_source_system: 'vantaca', p_actor_kind: 'human', p_actor_id: 'ed' });
for (const s of ['intake', 'normalize', 'source_controls']) { const c = await rpc('onboarding_record_completion', { p_batch: B, p_stage: s, p_status: 'PASS', p_open: [], p_controls: ctl, p_summary: {}, p_actor_kind: 'system', p_actor_id: 'op' }); await rpc('onboarding_auto_advance', { p_batch: B, p_completion: c, p_actor_id: 'op' }); }
const lines = snapshotLines();
const SN = await rpc('onboarding_record_snapshot', { p_batch: B, p_status: 'PASS', p_open: [], p_controls: ctl, p_summary: { roles: { ar_account: '1300', prepaid_account: '2400', ap_account: '2000' } }, p_lines: lines, p_snapshot_sha256: 'a'.repeat(64), p_actor_kind: 'system', p_actor_id: 'op' });
await rpc('onboarding_auto_advance', { p_batch: B, p_completion: SN, p_actor_id: 'op' });
const legacyHt = (await q(`SELECT id FROM homeowner_transactions WHERE source_batch_id = $1 ORDER BY id`, [LEG])).map((r) => `homeowner_transactions:${r.id}`);
const items = [{ item_no: 1, event_key: 'legacy', kind: 'legacy_import', classification: 'ALREADY_IN_SOURCE', method: 'provenance_legacy_import', amount_cents: 15889500,
  records: [`journal_entries:${L1.id}`, ...legacyHt], confidence: 'high', evidence: {}, batch_code: CODE, cutoff_date: CUTOFF }];
const FP = trustedFingerprint((await trustedReader(SCR)).trusted);
const BR = await rpc('onboarding_record_bridge', { p_batch: B, p_status: 'PASS', p_open: [], p_controls: ctl, p_summary: { snapshot_completion_id: SN, bridge_engine: 'rehearsal' }, p_items: items, p_bridge_sha256: 'b'.repeat(64), p_trusted_fingerprint: FP, p_actor_kind: 'system', p_actor_id: 'op' });
await rpc('onboarding_auto_advance', { p_batch: B, p_completion: BR, p_actor_id: 'op' });

// The preflight exactly as the service builds it: production loaders -> buildConversionPlan -> v2 report.
const ctx = await conversionContext(SCR, { cutoff: CUTOFF });
const trusted = (await trustedReader(SCR)).trusted;
const plan = buildConversionPlan({ batch: { id: B, batch_code: CODE, community_id: SCR, as_of_date: CUTOFF },
  snapshot: { completion_id: SN, sha256: 'a'.repeat(64), roles: { ar_account: '1300', prepaid_account: '2400', ap_account: '2000' }, lines },
  bridge: { completion_id: BR, sha256: 'b'.repeat(64), trusted_fingerprint: FP, status: 'PASS', items }, source: {}, trusted, ctx: { ...ctx, current_trusted_fingerprint: trustedFingerprint(trusted) } });
const { controls, ...body } = plan;
const report = PF.buildConversionPreflight({ batch: { batch_code: CODE, community_id: SCR, source_system: 'vantaca', stage: 'preflight' }, source_cutoff: { cutoff_date: CUTOFF, cutover_date: plan.cutover },
  inputs: { snapshot: { completion_id: SN, sha256: 'a'.repeat(64), status: 'PASS' }, bridge: { completion_id: BR, sha256: 'b'.repeat(64), trusted_fingerprint: FP, status: 'PASS', engine: 'rehearsal' }, decisions: [], bridge_waivers: [], artifacts: [] },
  plan: body, controls }, []);
const w = report.plan.writes; const bb = w.builder_coverage_batch;
const row = (addr) => bb.rows.find((r) => r.street_address === addr);
const bje = w.repost_journal_entries.find((j) => j.reference === `${CODE}-BUILDER`);

console.log('\n-- the conversion plan (production loader + plan builder)');
check('the loader found the builder rule, the program (50%, deferral 2205) and the annual assessment, 24 Lennar owner names and the year’s legacy rows (323 = 321 annual + 5302 interest + 5450)',
  ctx.builder && ctx.builder.builders.length === 1 && ctx.builder.rate.annual_amount_cents === 49500 && Number(ctx.builder.program.builder_rate_pct) === 50 && ctx.builder.program.deferral_account_number === '2205'
    && ctx.builder.owners.filter((o) => o.full_name === LENNAR_NAME).length === 24 && ctx.builder.legacy_rows.length === 323, JSON.stringify({ owners: ctx.builder && ctx.builder.owners.length, rows: ctx.builder && ctx.builder.legacy_rows.length }));
check('23 builder lots resolved (5302 normalized, 22 baseline), 5450 unresolved; all from Jan 1, never the 5/21 load date',
  bb.rows.length === 23 && bb.rows.filter((r) => r.kind === 'normalization').length === 1 && bb.rows.filter((r) => r.kind === 'baseline').length === 22 && bb.rows.every((r) => r.covered_from === '2026-01-01' && r.covered_through === CUTOFF));
check('5302: $122.73 coverage; ledger -$372.27 (correcting adjustment); the $495.00 kept as evidence only',
  row('5302 Sleepy Fox').base_amount_cents === 12273 && row('5302 Sleepy Fox').ledger_amount_cents === -37227 && row('5302 Sleepy Fox').annual_billed_cents === 49500);
check('the builder entry: cutover-dated 7/1, in the re-posts, balanced, names an open period',
  bje && bje.posting_date === '2026-07-01' && bje.total_debits_cents === bje.total_credits_cents && !!bje.period_id);
check('the 2205 schedule: $79,200.00, 2205 -> 4000, Jul-Dec ($13,200.00/mo); basis 321 lots x $495.00, released 6/12',
  w.deferral_schedules.length === 1 && w.deferral_schedules[0].recognize_amount_cents === 7920000 && w.deferral_schedules[0].term_months === 6 && w.deferral_schedules[0].start_month === '2026-07-01'
    && w.deferral_schedules[0].basis.billed_lots === 321 && w.deferral_schedules[0].basis.residue_cents === 200, JSON.stringify(w.deferral_schedules[0] && w.deferral_schedules[0].basis));
check('reconciling items: the $2.00 2205 residue and 5450 Still Meadow, carried separately (nothing folded into the schedule)',
  JSON.stringify(w.reconciling_items.map((r) => [r.kind, r.amount_cents]).sort()) === JSON.stringify([['builder_position_unresolved', 9018], ['deferral_residue', 200]]));
const open = report.controls.filter((c) => c.status !== 'PASS').map((c) => `${c.code}:${c.status}`).sort();
check('exactly two open controls, both waivable FAILs (no BLOCKED): positions unresolved (5450) and the 2205 residue',
  JSON.stringify(open) === JSON.stringify(['preflight.builder_positions_resolved:FAIL', 'preflight.deferral_schedule_reconciles:FAIL']), JSON.stringify(open));
check('the cutoff trial balance still equals the source (the builder entry is cutover-dated)', report.controls.find((c) => c.code === 'preflight.projected_cutoff_tb_equals_source').status === 'PASS');

// ------------------------------------------------------- record, waive, approve, execute
const recordPf = () => rpc('onboarding_record_completion', { p_batch: B, p_stage: 'preflight', p_status: report.status.overall, p_open: report.controls.filter((c) => c.status !== 'PASS').map((c) => c.code),
  p_controls: report.controls.map((c) => ({ code: c.code, label: c.label, status: c.status })), p_summary: { preflight_format: report.format, preflight_sha256: report.sha256, preflight_report: report }, p_actor_kind: 'system', p_actor_id: 'onboarding-operator' });
const PFC = await recordPf();
const cntAll = async () => one(`SELECT (SELECT count(*)::int FROM journal_entries) AS je, (SELECT count(*)::int FROM homeowner_transactions) AS ht, (SELECT count(*)::int FROM builder_assessment_coverage) AS cov,
  (SELECT count(*)::int FROM recognition_schedules) AS rs, (SELECT count(*)::int FROM conversion_reconciling_items) AS items`);
const base = await cntAll();
check('unwaived FAILs: the owner cannot approve (CONTROLS_NOT_PASSING)', /CONTROLS_NOT_PASSING|not waived/.test((await code(() => svc.approve(ED, B, { completion_id: PFC, preflight: report }))) || ''));
check('a waiver needs the owner and a real reason', /OWNER_ONLY/.test((await code(() => svc.waive({ kind: 'human', id: 'staff', role: 'admin' }, B, { completion_id: PFC, code: 'preflight.deferral_schedule_reconciles', reason: 'carry the residue separately' }))) || '')
  && /WAIVER_REASON_REQUIRED/.test((await code(() => svc.waive(ED, B, { completion_id: PFC, code: 'preflight.deferral_schedule_reconciles', reason: 'ok' }))) || ''));
await svc.waive(ED, B, { completion_id: PFC, code: 'preflight.deferral_schedule_reconciles', reason: '$2.00 2025 residue carried as a separate reconciling item; schedule stays $79,200' });
await svc.waive(ED, B, { completion_id: PFC, code: 'preflight.builder_positions_resolved', reason: '5450 Still Meadow stays blocked as a reconciling item; no coverage fabricated' });
const pfView = await svc.getPreflight(B);
check('with both waivers recorded the owner approves the report (dispositions WAIVED)', (await code(() => svc.approve(ED, B, { completion_id: PFC, preflight: pfView.report }))) === null);
// An injected failure at the very end: everything rolls back, the reconciling items with it.
await db.exec(`CREATE FUNCTION _boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status = 'committed' THEN RAISE EXCEPTION 'injected failure after the builder writes'; END IF; RETURN NEW; END $$;
  CREATE TRIGGER _boom BEFORE INSERT ON onboarding_executions FOR EACH ROW EXECUTE FUNCTION _boom();`);
const failed = await code(() => svc.execute(ED, B, { completion_id: PFC, preflight_sha256: pfView.report.sha256 }));
check('an injected failure after every builder write rolls back EVERYTHING (no entry, ledger row, coverage, schedule or reconciling item)',
  /injected failure/.test(failed || '') && JSON.stringify(await cntAll()) === JSON.stringify(base), JSON.stringify({ failed, now: await cntAll(), base }));
await db.exec(`DROP TRIGGER _boom ON onboarding_executions; DROP FUNCTION _boom();`);
const ex = await svc.execute(ED, B, { completion_id: PFC, preflight_sha256: pfView.report.sha256 });
check('EXECUTE: executed; write counts include 23 coverage, 23 builder ledger rows, 1 schedule, 2 reconciling items',
  ex.status === 'executed' && ex.write_counts.builder_coverage_rows === 23 && ex.write_counts.builder_ledger_rows === 23 && ex.write_counts.deferral_schedules === 1 && ex.write_counts.reconciling_items === 2,
  JSON.stringify(ex.write_counts));

// Post-proof (stage 7) exactly as the service runs it, on the production post-proof loader.
const exV = await svc.getBatch(B, ED);
await svc.advance(ED, B, { completion_id: exV.current.completion_id, to: 'post_proof' });
await svc.operate(B);
const ppv = (await svc.getBatch(B, ED)).latest_by_stage.post_proof;
check('post-proof PASSES, including the builder coverage, the deferral schedule and the reconciling items; the write log equals the plan',
  ppv && ppv.status === 'PASS' && ['post_proof.builder_coverage_as_planned', 'post_proof.deferral_schedule_as_planned', 'post_proof.reconciling_items_recorded', 'post_proof.write_log_equals_plan'].every((c) => !(ppv.open_controls || []).includes(c)),
  JSON.stringify(ppv && { status: ppv.status, open: ppv.open_controls }));

console.log('\n-- after the conversion');
const tb = async (through) => Object.fromEntries((await q(`SELECT a.account_number AS n, sum(l.debit_cents - l.credit_cents)::bigint AS c FROM journal_entry_lines l JOIN journal_entries j ON j.id = l.journal_entry_id
  JOIN chart_of_accounts a ON a.id = l.account_id WHERE j.community_id = $1 AND (j.status = 'posted' OR (j.status = 'voided' AND j.void_reversal_je_id IS NOT NULL)) AND ($2::date IS NULL OR j.posting_date <= $2::date)
  GROUP BY 1 ORDER BY 1`, [SCR, through])).map((r) => [r.n, Number(r.c)]));
const tbCut = await tb(CUTOFF); const tbNow = await tb('2026-07-01');
check('cutoff TB (6/30) equals the source exactly', Object.entries(TB).every(([a, c]) => tbCut[a] === c), JSON.stringify(tbCut));
check('2205 at 7/1 = $79,202.00 = the $79,200.00 schedule + the $2.00 reconciling item', tbNow['2205'] === -7920200, String(tbNow['2205']));
const bjeRow = await one(`SELECT id, reference, posting_date::text AS d FROM journal_entries WHERE reference = $1`, [`${CODE}-BUILDER`]);
const bLines = await q(`SELECT a.account_number AS acct, l.debit_cents::int AS dr, l.credit_cents::int AS cr, p.street_address AS lot FROM journal_entry_lines l JOIN chart_of_accounts a ON a.id = l.account_id
  LEFT JOIN properties p ON p.id = l.property_id WHERE l.journal_entry_id = $1 ORDER BY l.line_number`, [bjeRow.id]);
const s5302 = bLines.filter((l) => /5302/.test(l.lot || '') || (l.acct !== '1300' && bLines.indexOf(l) < 3));
check('5302 entry lines exactly: Dr 4000 $124.77, Dr 2205 $247.50, Cr 1300 $372.27 (5302)',
  JSON.stringify(bLines.slice(0, 3)) === JSON.stringify([{ acct: '4000', dr: 12477, cr: 0, lot: null }, { acct: '2205', dr: 24750, cr: 0, lot: null }, { acct: '1300', dr: 0, cr: 37227, lot: '5302 Sleepy Fox' }]), JSON.stringify(bLines.slice(0, 3)));
const l8211 = bLines.filter((l) => /^8211 /.test(l.lot || '') || false);
check('8211 Rustic Pine Trail (unbilled): Dr 1300 $122.73 on the lot; the matching 4000 credit; no $495 anywhere',
  l8211.length === 1 && l8211[0].dr === 12273 && bLines.some((l) => l.acct === '4000' && l.cr === 12273 && /8211/.test(JSON.stringify(l)) === false) && !bLines.some((l) => l.dr === 49500 || l.cr === 49500), JSON.stringify({ l8211, inc: bLines.filter((l) => l.acct === '4000').slice(0, 3) }));
const cov = async (L, y = 2026) => rpc('builder_coverage', { p_tenure_id: L.seller, p_year_start: `${y}-01-01` });
const c5302 = await cov(S5302); const c8211 = await cov(S8211); const c5450 = await cov(S5450);
check('coverage: 5302 and 8211 valid, posted, Jan 1 - Jun 30, $122.73, posted to the BUILDER entry; 5450 has NONE',
  c5302.valid && c5302.count === 1 && c5302.covered_through === '2026-06-30' && c5302.amount_cents === 12273 && c5302.rows[0].journal_entry_reference === `${CODE}-BUILDER` && c5302.rows[0].status === 'posted'
    && c8211.valid && c8211.covered_through === '2026-06-30' && c5450.count === 0, JSON.stringify({ c5302, c5450 }));
const ht5302 = await one(`SELECT h.amount_cents::int AS a, h.txn_type, h.reduction_source, h.transaction_date::text AS d, h.tenure_id = $2 AS stamped FROM homeowner_transactions h JOIN transaction_upload_batches b ON b.id = h.source_batch_id
  WHERE b.source_filename = $1 AND h.property_id = $3`, [`${CODE}-BUILDER`, S5302.seller, S5302.property]);
check('5302 ledger: -$372.27 correcting adjustment dated 7/1 on Lennar’s tenure (legacy batch reverted; opening balance carried by the AR batch)',
  ht5302 && ht5302.a === -37227 && ht5302.txn_type === 'adjustment' && ht5302.reduction_source === 'correcting_adjustment' && ht5302.d === '2026-07-01' && ht5302.stamped
    && (await one(`SELECT status FROM transaction_upload_batches WHERE id = $1`, [LEG])).status === 'reverted', JSON.stringify(ht5302));
const sched = await one(`SELECT id, recognize_amount_cents::int AS t, status, source_type, approved_by, balance_account_number AS bal FROM recognition_schedules WHERE source_id = $1`, [B]);
const months = await q(`SELECT period_month::text AS m, scheduled_cents::int AS c FROM recognition_schedule_periods WHERE schedule_id = $1 ORDER BY 1`, [sched.id]);
check('the release schedule: active, conversion_balance, approved by the person who approved the preflight (ed), 6 x $13,200.00 Jul-Dec',
  sched.t === 7920000 && sched.status === 'active' && sched.source_type === 'conversion_balance' && sched.approved_by === 'ed' && sched.bal === '2205'
    && JSON.stringify(months.map((m) => m.c)) === JSON.stringify(Array(6).fill(1320000)) && months[0].m === '2026-07-01' && months[5].m === '2026-12-01', JSON.stringify({ sched, months }));

console.log('\n-- reconciling items: append-only, and a rerun cannot make them disappear');
const itemsNow = async () => q(`SELECT kind, item_key, amount_cents::int AS a, status FROM conversion_reconciling_items WHERE community_id = $1 ORDER BY kind`, [SCR]);
const its = await itemsNow();
check('both recorded open on this batch: the $2.00 2205 residue and 5450 ($90.18)', JSON.stringify(its.map((i) => [i.kind, i.a, i.status])) === JSON.stringify([['builder_position_unresolved', 9018, 'open'], ['deferral_residue', 200, 'open']]));
const residueId = (await one(`SELECT id FROM conversion_reconciling_items WHERE kind = 'deferral_residue'`)).id;
const e1 = await code(() => db.query(`DELETE FROM conversion_reconciling_items WHERE id = $1`, [residueId]));
const e2 = await code(() => db.query(`UPDATE conversion_reconciling_items SET amount_cents = 0 WHERE id = $1`, [residueId]));
const e3 = await code(() => db.query(`UPDATE conversion_reconciling_items SET status = 'resolved', resolved_by = 'ed', resolved_at = now(), resolution_note = 'gone' WHERE id = $1`, [residueId]));
const e4 = await code(() => db.query(`UPDATE conversion_reconciling_items SET status = 'resolved' WHERE id = $1`, [residueId]));
check('never deleted, never edited; resolving needs who, when and a 10+ character note', /never deleted/.test(e1 || '') && /fixed once recorded/.test(e2 || '') && /resolution_check/.test(e3 || '') && /resolution_check/.test(e4 || ''), JSON.stringify({ e1, e2, e3, e4 }));
const again = await svc.execute(ED, B, { completion_id: PFC, preflight_sha256: pfView.report.sha256 });
const again2 = await code(() => rpc('onboarding_execute', { p_batch: B, p_completion: PFC, p_preflight_sha256: pfView.report.sha256, p_actor_kind: 'human', p_actor_id: 'ed' }));
check('rerunning the conversion returns the earlier result and writes nothing: both items still there, once', again.status === 'already_executed' && again.rows_written_now === 0
  && JSON.stringify(await itemsNow()) === JSON.stringify(its) && again2 === null && (await one(`SELECT count(*)::int AS n FROM builder_assessment_coverage WHERE conversion_batch_id = $1`, [B])).n === 23);
const dupe = await code(() => db.query(`INSERT INTO conversion_reconciling_items (batch_id, community_id, kind, item_key, amount_cents, created_by) VALUES ($1, $2, 'deferral_residue', '2205', 0, 'x')`, [B, SCR]));
check('a second residue row for the same batch cannot be written (UNIQUE batch, kind, key)', /conversion_reconciling_items_unique/.test(dupe || ''));

console.log('\n-- 5450 stays blocked everywhere');
const p5450 = await rpc('transfer_proration_plan', { p_property_id: S5450.property, p_seller_tenure_id: S5450.seller, p_settlement_date: '2026-09-15', p_buyer_name: 'Pat Homeowner', p_buyer_tenure_id: null });
check('a transfer of 5450 blocks: builder_coverage_missing', p5450.blocked && p5450.blocked_reasons.includes('builder_coverage_missing'), JSON.stringify(p5450.blocked_reasons));

// ------------------------------------------------------------- the monthly accrual
console.log('\n-- the monthly accrual');
// The runner's steps (lib/accounting/builder_accrual.js run()): stage, one entry per period from the
// production line builder on the program's accounts, finish. acctIds maps account numbers to ids.
async function accrue(through, community = SCR, acctIds = { 1300: ACC['1300'], 4000: ACC['4000'] }, je = postJe) {
  // the rehearsal runs each accrual the day after its through date (a period is billed only once it has ended)
  const asOf = new Date(Date.parse(through + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
  const st = await rpc('builder_accrual_stage', { p_community_id: community, p_through: through, p_actor: 'rehearsal', p_as_of: asOf });
  if (!st || st.status === 'nothing_to_accrue') return st;
  const out = [];
  for (const p of st.periods) {
    if (!Number(p.pending)) continue;
    const ref = `BACCR-${p.period_end}-${st.run_id.slice(0, 6)}`;
    const e = await je(ref, p.period_end, 'assessment_billing', periodLines(acctIds, st.ar_account_number, st.income_account_number, p), `${st.batch_id}:${p.period_end}`);
    out.push(await rpc('builder_accrual_finish', { p_run: st.run_id, p_period_end: p.period_end, p_je: e.id }));
  }
  return { ...st, finished: out[out.length - 1] };
}
console.log('   (activation: the explicit post-conversion step)');
const notYet = await code(() => rpc('builder_accrual_stage', { p_community_id: SCR, p_through: '2026-07-31', p_actor: 'rehearsal' }));
check('the accrual cannot run until it is activated (the conversion is posted, but activation is a separate, explicit step)', /not activated/.test(notYet || ''), notYet);
const stNA = await rpc('builder_coverage_status', { p_community_id: SCR, p_as_of: '2026-07-02' });
check('until activated, the status says so (accrual_active false, amber at least)', stNA.accrual_active === false && stNA.status !== 'ok');
const act = await rpc('activate_builder_accrual', { p_community_id: SCR, p_actor: 'ed' });
const act2 = await rpc('activate_builder_accrual', { p_community_id: SCR, p_actor: 'someone else' });
check('activated by ed (who + when recorded); activating again changes nothing; the activation cannot be rewritten',
  act.status === 'activated' && act.activated_by === 'ed' && act2.status === 'already_active' && act2.activated_by === 'ed'
    && /recorded once/.test((await code(() => db.query(`UPDATE builder_assessment_programs SET accrual_activated_by = 'x' WHERE community_id = $1`, [SCR]))) || ''));
const prev = await rpc('builder_accrual_plan', { p_community_id: SCR, p_through: '2026-08-31' });
const p8211 = prev.lots.find((l) => l.street_address === '8211 Rustic Pine Trail');
check('plan through 8/31: 23 lots continue from 7/1 (Jul $21.02, Aug $21.02); 5450 listed BLOCKED (coverage missing), never skipped silently',
  prev.lots.length === 23 && JSON.stringify(p8211.periods.map((p) => [p.covered_from, p.covered_through, p.amount_cents])) === JSON.stringify([['2026-07-01', '2026-07-31', 2102], ['2026-08-01', '2026-08-31', 2102]])
    && prev.blocked.length === 1 && prev.blocked[0].street_address === '5450 Still Meadow' && prev.blocked[0].reason === 'builder_coverage_missing', JSON.stringify({ n: prev.lots.length, blocked: prev.blocked.map((b) => [b.street_address, b.reason]) }));
check('a period that has not ended is never billed (through 11/30 run on 11/15: refused)', /only periods that have ended/.test((await code(() => rpc('builder_accrual_stage', { p_community_id: SCR, p_through: '2026-11-30', p_actor: 'rehearsal', p_as_of: '2026-11-15' }))) || ''));
const midMonth = await rpc('builder_accrual_plan', { p_community_id: SCR, p_through: '2026-08-30' });
check('a through-date mid-period bills only COMPLETED periods (through 8/30: July only)', midMonth.lots.every((l) => l.periods.length === 1 && l.periods[0].covered_through === '2026-07-31'));
const a1 = await accrue('2026-08-31');
check('Jul + Aug accrued: 2 entries (23 x $21.02 = $483.46 each), coverage posted, batch committed, run posted',
  a1.finished.status === 'posted' && a1.periods.length === 2 && a1.periods.every((m) => Number(m.amount_cents) === 23 * 2102)
    && (await one(`SELECT status FROM transaction_upload_batches WHERE id = $1`, [a1.batch_id])).status === 'committed', JSON.stringify(a1.finished && a1.finished.periods));
check('rerun through 8/31: nothing to accrue (no duplicate period, no duplicate penny)', (await rpc('builder_accrual_stage', { p_community_id: SCR, p_through: '2026-08-31', p_actor: 'rehearsal' })).status === 'nothing_to_accrue');
const c8211b = await cov(S8211);
check('8211 coverage: Jan 1 - Aug 31 in three contiguous periods ($122.73 + $21.02 + $21.02), all posted', c8211b.valid && c8211b.count === 3 && c8211b.covered_through === '2026-08-31' && c8211b.amount_cents === 16477 && c8211b.pending === 0);

console.log('\n-- a transfer after the accrual consumes the coverage');
const settle = '2026-09-15';
await db.query(`UPDATE ownership_tenures SET end_date = ($1::date - 1) WHERE id = $2`, [settle, S8211.seller]);
await db.query(`UPDATE property_ownerships SET end_date = ($1::date - 1) WHERE tenure_id = $2`, [settle, S8211.seller]);
const bt = (await one(`INSERT INTO ownership_tenures (id, community_id, property_id, start_date, vantaca_account_id, origin) VALUES (gen_random_uuid(), $1, $2, $3, $4, 'transfer') RETURNING id`, [SCR, S8211.property, settle, S8211.vacct])).id;
const bc = (await one(`INSERT INTO contacts (id, full_name) VALUES (gen_random_uuid(), 'Pat Homeowner') RETURNING id`)).id;
await db.query(`INSERT INTO property_ownerships (property_id, contact_id, tenure_id, start_date) VALUES ($1, $2, $3, $4)`, [S8211.property, bc, bt, settle]);
const prop = (await one(`INSERT INTO ownership_change_proposals (property_id, community_id, status, effective_start_date, proposed_owner_name, seller_tenure_id, buyer_tenure_id) VALUES ($1, $2, 'approved', $3, 'Pat Homeowner', $4, $5) RETURNING id`,
  [S8211.property, SCR, settle, S8211.seller, bt])).id;
const tw = await rpc('post_transfer_assessment_proration', { p_proposal_id: prop, p_posted_by: 'rehearsal', p_dry_run: false });
check('transfer 9/15: reads coverage through 8/31; bills ONLY 9/1-9/14 (14 days = $9.49); Lennar’s year = $174.26; homeowner from 9/15 at 100%',
  !tw.blocked && tw.builder_coverage.covered_through === '2026-08-31' && tw.builder_unbilled_period.start === '2026-09-01' && tw.builder_unbilled_period.end === '2026-09-14' && tw.builder_unbilled_period.days === 14
    && tw.builder_adjustment_cents === 949 && tw.builder_due_cents === 16477 + 949 && tw.homeowner_due_cents === Math.round(49500 * 108 / 365),
  JSON.stringify({ b: tw.blocked_reasons, cov: tw.builder_coverage && tw.builder_coverage.covered_through, unb: tw.builder_unbilled_period, adj: tw.builder_adjustment_cents, due: tw.builder_due_cents, ho: tw.homeowner_due_cents }));
// The JS step: GL from the production line builder, batch committed, coverage marked posted.
const tbatch = (await one(`SELECT batch_id FROM assessment_prorations WHERE proposal_id = $1 AND batch_id IS NOT NULL LIMIT 1`, [prop])).batch_id;
const tje = await postJe(`TP-${prop.slice(0, 8)}`, settle, 'assessment_billing', glLines({ 1300: ACC['1300'], 4000: ACC['4000'], 2205: ACC['2205'] }, tw), tbatch);
await db.query(`UPDATE transaction_upload_batches SET status = 'committed', committed_at = now() WHERE id = $1`, [tbatch]);
await db.query(`UPDATE builder_assessment_coverage SET status = 'posted', journal_entry_id = $2, journal_entry_reference = $3 WHERE proposal_id = $1 AND status = 'pending'`, [prop, tje.id, tje.reference]);
const c8211c = await cov(S8211);
check('8211 after the transfer: Jan 1 - Sep 14 covered once (4 contiguous periods, $174.26), no overlap, no double post',
  c8211c.valid && c8211c.count === 4 && c8211c.covered_through === '2026-09-14' && c8211c.amount_cents === 17426 && c8211c.rows[3].source_type === 'transfer_true_up', JSON.stringify(c8211c.rows.map((r) => [r.from, r.through, r.amount_cents, r.source_type])));
console.log('\n-- the new owner\u2019s 9/15 charge: released by the days it covers, on the real recognition engine');
const hRow = await one(`SELECT id FROM assessment_prorations WHERE proposal_id = $1 AND role = 'homeowner_charge'`, [prop]);
const schedRow = recognitionScheduleRow(tw, { communityId: SCR, proposalId: prop, homeownerRowId: hRow.id, journalEntryId: tje.id, incomeAccountId: ACC['4000'] });
const keys = Object.keys(schedRow);
const hSched = (await one(`INSERT INTO recognition_schedules (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, keys.map((k) => schedRow[k]))).id;
const engineMonths = await q(`SELECT period_month::text AS m, scheduled_cents::int AS c FROM recognition_schedule_periods WHERE schedule_id = $1 ORDER BY 1`, [hSched]);
check('9/15 closing: the new owner owes 108 days (9/15-12/31) = $146.47; Dr 1300 / Cr 2205 $146.47 on 9/15',
  tw.homeowner_due_cents === 14647 && tw.homeowner_days === 108 && tje && (await one(`SELECT count(*)::int AS n FROM journal_entry_lines WHERE journal_entry_id = $1 AND ((account_id = $2 AND debit_cents = 14647) OR (account_id = $3 AND credit_cents = 14647))`, [tje.id, ACC['1300'], ACC['2205']])).n === 2);
check('release months by covered days: Sep 16 days $21.70, Oct 31 days $42.04, Nov 30 days $40.69, Dec 31 days $42.04 = $146.47 (not 4 equal quarters); the real engine generates exactly the plan\u2019s months',
  JSON.stringify(tw.homeowner_recognition.months.map((m) => [m.month, m.days, m.cents])) === JSON.stringify([['2026-09-01', 16, 2170], ['2026-10-01', 31, 4204], ['2026-11-01', 30, 4069], ['2026-12-01', 31, 4204]])
    && JSON.stringify(engineMonths.map((r) => [r.m, r.c])) === JSON.stringify(tw.homeowner_recognition.months.map((m) => [m.month, m.cents])),
  JSON.stringify({ plan: tw.homeowner_recognition.months, engine: engineMonths }));
const relPosted = [];
for (const m of engineMonths) {
  // the recognition runner's own date rule (lib/accounting/recognition_engine.js postingDateFor)
  const pid = (await one(`SELECT post_recognition_period($1, $2::date, 'rehearsal', $3::date) AS id`, [hSched, m.m, postingDateFor(schedRow, m.m)])).id;
  const pj = await one(`SELECT j.posting_date::text AS d, j.reference, (SELECT debit_cents::int FROM journal_entry_lines WHERE journal_entry_id = j.id AND account_id = $2) AS dr2205,
    (SELECT credit_cents::int FROM journal_entry_lines WHERE journal_entry_id = j.id AND account_id = $3) AS cr4000 FROM recognition_postings p JOIN journal_entries j ON j.id = p.journal_entry_id WHERE p.id = $1`, [pid, ACC['2205'], ACC['4000']]);
  relPosted.push(pj);
}
check('the releases post on the real engine: 9/15 $21.70 (the settlement month: never before the charge exists), then the 1st of each month (the community\u2019s release day) 10/1 $42.04, 11/1 $40.69, 12/1 $42.04, each Dr 2205 / Cr 4000; the schedule completes at $146.47',
  JSON.stringify(relPosted.map((r) => [r.d, r.dr2205, r.cr4000])) === JSON.stringify([['2026-09-15', 2170, 2170], ['2026-10-01', 4204, 4204], ['2026-11-01', 4069, 4069], ['2026-12-01', 4204, 4204]])
    && (await one(`SELECT status FROM recognition_schedules WHERE id = $1`, [hSched])).status === 'fully_recognized', JSON.stringify(relPosted));
const tw2 = await rpc('post_transfer_assessment_proration', { p_proposal_id: prop, p_posted_by: 'rehearsal', p_dry_run: false });
check('re-running the transfer posts nothing new', tw2.already_prorated === true && (await one(`SELECT count(*)::int AS n FROM builder_assessment_coverage WHERE tenure_id = $1`, [S8211.seller])).n === 4);

console.log('\n-- the rest of the year, and the Jan 5 rule');
await accrue('2026-11-30');
const st0105 = await rpc('builder_coverage_status', { p_community_id: SCR, p_as_of: '2027-01-05' });
const unsoldSt = st0105.lots.find((l) => l.property_id === UNSOLD.property);
check('Jan 5 with December not yet accrued: every Lennar lot covered only through 11/30 is RED; 5450 RED (coverage missing); status RED; open items listed',
  st0105.status === 'red' && unsoldSt.severity === 'red' && unsoldSt.covered_through === '2026-11-30' && st0105.lots.find((l) => l.street_address === '5450 Still Meadow').reason === 'coverage_missing'
    && st0105.open_reconciling_items.length === 2 && !st0105.lots.some((l) => l.street_address === '8211 Rustic Pine Trail'), JSON.stringify({ s: st0105.status, u: unsoldSt, c: st0105.counts, l5450: st0105.lots.find((l) => l.street_address === '5450 Still Meadow'), items: st0105.open_reconciling_items.length }));
const st1203 = await rpc('builder_coverage_status', { p_community_id: SCR, p_as_of: '2026-12-03' });
check('Dec 3 (before the 5th): expected through 10/31, so lots through 11/30 are on time (only 5450 RED)', st1203.counts.red === 1 && st1203.counts.amber === 0 && st1203.expected_through === '2026-10-31', JSON.stringify(st1203.counts));
const aDec = await accrue('2026-12-31');
const decUnsold = (await cov(UNSOLD)).rows;
check('the unsold lot’s year: Jan-Jun $122.73 + Jul $21.02 + Aug $21.02 + Sep $20.34 + Oct $21.02 + Nov $20.34 + Dec $21.03 (base $21.02 + 1 cent true-up, marked) = $247.50',
  JSON.stringify(decUnsold.map((r) => r.amount_cents)) === JSON.stringify([12273, 2102, 2102, 2034, 2102, 2034, 2103]) && decUnsold[6].rounding_true_up_cents === 1
    && decUnsold.reduce((t, r) => t + r.amount_cents, 0) === 24750, JSON.stringify(decUnsold.map((r) => [r.through, r.amount_cents, r.rounding_true_up_cents])));
const y5302 = await cov(S5302);
check('5302’s year (normalized at conversion, accrued after) is exactly $247.50 too', y5302.amount_cents === 24750 && y5302.covered_through === '2026-12-31');
check('rerun through 12/31 after the true-up: nothing to accrue, no duplicate penny',
  (await rpc('builder_accrual_stage', { p_community_id: SCR, p_through: '2026-12-31', p_actor: 'rehearsal', p_as_of: '2027-01-03' })).status === 'nothing_to_accrue'
    && (await one(`SELECT count(*)::int AS n FROM builder_assessment_coverage WHERE rounding_true_up_cents <> 0 AND tenure_id = $1`, [UNSOLD.seller])).n === 1);
const st0106 = await rpc('builder_coverage_status', { p_community_id: SCR, p_as_of: '2027-01-06' });
check('Jan 6 after December: only 5450 is RED', st0106.counts.red === 1 && st0106.lots.find((l) => l.severity === 'red').street_address === '5450 Still Meadow', JSON.stringify(st0106.counts));
const gl4000 = Number((await one(`SELECT sum(l.credit_cents - l.debit_cents)::bigint AS c FROM journal_entry_lines l JOIN journal_entries j ON j.id = l.journal_entry_id WHERE j.reference LIKE 'BACCR-%' AND l.account_id = $1`, [ACC['4000']])).c);
const covAcc = Number((await one(`SELECT sum(amount_cents)::bigint AS c FROM builder_assessment_coverage WHERE source_type = 'scheduled_accrual' AND status = 'posted'`)).c);
check('accrual GL income = the accrued coverage exactly (one entry per month, no pending left)', gl4000 === covAcc && (await one(`SELECT count(*)::int AS n FROM builder_assessment_coverage WHERE status = 'pending'`)).n === 0, `${gl4000} vs ${covAcc}`);

console.log('\n-- next year: a rate change mid-year');
await accrue('2027-06-30');
await db.query(`UPDATE community_assessment_rates SET annual_amount_cents = 52000 WHERE community_id = $1 AND owner_class = 'homeowner'`, [SCR]);
await accrue('2027-12-31');
const y27 = (await cov(UNSOLD, 2027)).rows;
const base27 = (annual, days) => Math.round(annual * 50 * days / (100 * 365));
check('2027: Jan-Jun at $495.00, Jul-Dec at $520.00; the year mixes rates so December carries NO true-up (not deterministically recomputable)',
  y27.length === 12 && y27[0].amount_cents === base27(49500, 31) && y27[6].amount_cents === base27(52000, 31) && y27[11].rounding_true_up_cents === 0
    && y27.reduce((t, r) => t + r.amount_cents, 0) === y27.reduce((t, r) => t + (r.amount_cents - r.rounding_true_up_cents), 0), JSON.stringify(y27.map((r) => r.amount_cents)));

console.log('\n-- PORTABILITY: a second community configuration on the same engine (no Still Creek fact anywhere)');
{
  // Example Oaks: $600.00 annual, builder 25%, homeowner 100%, AR 1310 / income 4010, NO deferral,
  // assessment year Jul 1 - Jun 30, QUARTERLY builder billing. Builder: a different company.
  const OAK = 'a0000000-0000-4000-8000-0000000000cc'; const OF2 = '00000000-0000-4000-8000-00000000f0cc'; const ACME = '00000000-0000-4000-8000-0000000ac0e5';
  await db.query(`INSERT INTO communities (id, name, management_company_id, gl_cutover_date) VALUES ($1, 'Example Oaks', $2, '2025-10-01')`, [OAK, MC]);
  await db.query(`INSERT INTO builder_companies VALUES ($1, $2, 'Acme Homes')`, [ACME, MC]);
  await db.query(`INSERT INTO account_funds VALUES ($1, $2, 'OPR')`, [OF2, OAK]);
  const A2 = {};
  for (const [n, ty] of [['1310', 'asset'], ['4010', 'revenue']]) A2[n] = (await one(`INSERT INTO chart_of_accounts (id, community_id, account_number, fund_id, account_type) VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING id`, [OAK, n, OF2, ty])).id;
  await db.query(`INSERT INTO accounting_periods (community_id, fiscal_year, period_number, period_start, period_end, status)
    SELECT $1, y, m, make_date(y, m, 1), (make_date(y, m, 1) + interval '1 month - 1 day')::date, 'open' FROM generate_series(2025, 2027) y, generate_series(1, 12) m`, [OAK]);
  await db.query(`INSERT INTO community_assessment_rates (community_id, owner_class, annual_amount_cents, fiscal_year_end_mmdd) VALUES ($1, 'homeowner', 60000, '06-30')`, [OAK]);
  await db.query(`INSERT INTO builder_assessment_programs (community_id, builder_rate_pct, homeowner_rate_pct, ar_account_number, income_account_number, accrual_cadence_months, evidence, created_by)
    VALUES ($1, 25, 100, '1310', '4010', 3, 'rehearsal configuration', 'rehearsal')`, [OAK]);
  await db.query(`INSERT INTO transfer_proration_builders (community_id, builder_company_id, created_by) VALUES ($1, $2, 'rehearsal')`, [OAK, ACME]);
  const oakLot = async (addr, owner, opts = {}) => {
    const p = (await one(`INSERT INTO properties (id, community_id, vantaca_account_id, street_address, trusted_account_number) VALUES (gen_random_uuid(), $1, $2, $3, $2) RETURNING id`, [OAK, `O-${addr}`, addr])).id;
    const tn = (await one(`INSERT INTO ownership_tenures (id, community_id, property_id, kind, start_date, origin) VALUES (gen_random_uuid(), $1, $2, 'owner', $3, $4) RETURNING id`, [OAK, p, opts.start || '2025-08-01', opts.origin || 'backfill_current'])).id;
    const c = (await one(`INSERT INTO contacts (id, full_name) VALUES (gen_random_uuid(), $1) RETURNING id`, [owner])).id;
    await db.query(`INSERT INTO property_ownerships (property_id, contact_id, tenure_id, start_date) VALUES ($1, $2, $3, $4)`, [p, c, tn, opts.start || '2025-08-01']);
    return { property: p, seller: tn, addr };
  };
  const OA = await oakLot('10 Oak Ct', 'Acme Homes of Texas LLC');
  const OB = await oakLot('20 Oak Ct', 'Acme Homes of Texas LLC', { origin: 'transfer', start: '2025-11-10' });
  const OH = await oakLot('30 Oak Ct', 'Pat Owner');
  const activateEarly = await code(() => rpc('activate_builder_accrual', { p_community_id: OAK, p_actor: 'ed' }));
  check('second community: activation is refused before ITS conversion is posted', /only after/.test(activateEarly || ''), activateEarly);
  // Its conversion (as-of 9/30/2026), posted, with 10 Oak Ct's conversion coverage 7/1-9/30 (92/365 days at 25% of $600 = $37.81).
  const OCB = (await one(`INSERT INTO conversion_batches (community_id, batch_code, as_of_date, source_system, status) VALUES ($1, 'CONV-OAK-20250930', '2025-09-30', 'vantaca', 'posted') RETURNING id`, [OAK])).id;
  const convBatch = (await one(`INSERT INTO transaction_upload_batches (management_company_id, community_id, period_label, as_of_date, status, uploaded_by) VALUES ($1, $2, 'conv', '2025-10-01', 'committed', 'conversion') RETURNING id`, [MC, OAK])).id;
  const convJe = await postJe2(OAK, 'CONV-OAK-BUILDER', '2025-10-01', [{ account_id: A2['1310'], debit_cents: 3781, property_id: OA.property }, { account_id: A2['4010'], credit_cents: 3781 }]);
  const cvId = (await one(`INSERT INTO builder_assessment_coverage (community_id, property_id, tenure_id, builder_company_id, fiscal_year, covered_from, covered_through, days, days_in_year, annual_assessment_cents, builder_rate_pct,
      base_amount_cents, amount_cents, source_type, conversion_batch_id, batch_id, status, created_by)
    VALUES ($1, $2, $3, $4, 2026, '2025-07-01', '2025-09-30', 92, 365, 60000, 25, 3781, 3781, 'conversion', $5, $6, 'pending', 'rehearsal') RETURNING id, year_start::text AS ys, year_end::text AS ye`, [OAK, OA.property, OA.seller, ACME, OCB, convBatch]));
  await db.query(`UPDATE builder_assessment_coverage SET status = 'posted', journal_entry_id = $2, journal_entry_reference = 'CONV-OAK-BUILDER' WHERE id = $1`, [cvId.id, convJe.id]);
  check('second community: the coverage row takes ITS assessment year from configuration (Jul 1 2025 - Jun 30 2026)', cvId.ys === '2025-07-01' && cvId.ye === '2026-06-30');
  const actOak = await rpc('activate_builder_accrual', { p_community_id: OAK, p_actor: 'ed' });
  check('second community: activated after its conversion posted', actOak.status === 'activated');
  const je2 = (ref, date, module, lines, sref) => postJe2(OAK, ref, date, lines, sref);
  const planQ = await rpc('builder_accrual_plan', { p_community_id: OAK, p_through: '2025-12-31' });
  const pA = planQ.lots.find((l) => l.street_address === '10 Oak Ct'); const pB = planQ.lots.find((l) => l.street_address === '20 Oak Ct');
  check('second community, quarterly through 12/31: 10 Oak Ct bills Oct 1 - Dec 31 (92 days = $37.81); 20 Oak Ct (builder from 11/10/2025 by transfer) bills Nov 10 - Dec 31 (52 days = $21.37); 30 Oak Ct (not a builder) nothing; accounts 1310 / 4010',
    JSON.stringify(pA.periods.map((p) => [p.covered_from, p.covered_through, p.amount_cents])) === JSON.stringify([['2025-10-01', '2025-12-31', 3781]])
      && JSON.stringify(pB.periods.map((p) => [p.covered_from, p.covered_through, p.amount_cents])) === JSON.stringify([['2025-11-10', '2025-12-31', 2137]])
      && !planQ.lots.some((l) => l.street_address === '30 Oak Ct') && planQ.ar_account_number === '1310' && planQ.income_account_number === '4010' && planQ.cadence_months === 3,
    JSON.stringify(planQ.lots.map((l) => [l.street_address, l.periods])));
  await accrue('2025-12-31', OAK, A2, je2);
  // A transfer on the second community mid-quarter: 10 Oak Ct to a homeowner on 2/15/2027.
  const settle2 = '2026-02-15';
  await db.query(`UPDATE ownership_tenures SET end_date = ($1::date - 1) WHERE id = $2`, [settle2, OA.seller]);
  const bt2 = (await one(`INSERT INTO ownership_tenures (id, community_id, property_id, start_date, origin) VALUES (gen_random_uuid(), $1, $2, $3, 'transfer') RETURNING id`, [OAK, OA.property, settle2])).id;
  const bc2 = (await one(`INSERT INTO contacts (id, full_name) VALUES (gen_random_uuid(), 'Lee Buyer') RETURNING id`)).id;
  await db.query(`INSERT INTO property_ownerships (property_id, contact_id, tenure_id, start_date) VALUES ($1, $2, $3, $4)`, [OA.property, bc2, bt2, settle2]);
  const prop2 = (await one(`INSERT INTO ownership_change_proposals (property_id, community_id, status, effective_start_date, proposed_owner_name, seller_tenure_id, buyer_tenure_id) VALUES ($1, $2, 'approved', $3, 'Lee Buyer', $4, $5) RETURNING id`, [OA.property, OAK, settle2, OA.seller, bt2])).id;
  const tw3 = await rpc('post_transfer_assessment_proration', { p_proposal_id: prop2, p_posted_by: 'rehearsal', p_dry_run: false });
  check('second community transfer 2/15/2026: coverage through 12/31 -> bills ONLY 1/1-2/14 (45 days at 25% of $600 = $18.49); homeowner 136 days at 100% = $223.56 straight to 4010 (no deferral: no release schedule)',
    !tw3.blocked && tw3.builder_unbilled_period.start === '2026-01-01' && tw3.builder_unbilled_period.end === '2026-02-14' && tw3.builder_adjustment_cents === 1849
      && tw3.homeowner_due_cents === 22356 && tw3.homeowner_days === 136 && tw3.ar_account === '1310' && tw3.income_account === '4010' && tw3.deferral_account === null && tw3.homeowner_recognition === null
      && tw3.year_start === '2025-07-01' && tw3.year_end === '2026-06-30',
    JSON.stringify({ b: tw3.blocked_reasons, unb: tw3.builder_unbilled_period, adj: tw3.builder_adjustment_cents, ho: tw3.homeowner_due_cents, ar: tw3.ar_account, inc: tw3.income_account }));
  const tb3 = (await one(`SELECT batch_id FROM assessment_prorations WHERE proposal_id = $1 AND batch_id IS NOT NULL LIMIT 1`, [prop2])).batch_id;
  const gl3 = glLines({ 1310: A2['1310'], 4010: A2['4010'] }, tw3);
  const tje3 = await postJe2(OAK, `TP-${prop2.slice(0, 8)}`, settle2, gl3, tb3);
  await db.query(`UPDATE transaction_upload_batches SET status = 'committed', committed_at = now() WHERE id = $1`, [tb3]);
  await db.query(`UPDATE builder_assessment_coverage SET status = 'posted', journal_entry_id = $2, journal_entry_reference = $3 WHERE proposal_id = $1 AND status = 'pending'`, [prop2, tje3.id, tje3.reference]);
  check('second community transfer GL lines use only ITS accounts (1310 / 4010)', gl3.every((l) => [A2['1310'], A2['4010']].includes(l.account_id)));
  await accrue('2026-06-30', OAK, A2, je2);
  const covB = await rpc('builder_coverage', { p_tenure_id: OB.seller, p_year_start: '2025-07-01' });
  const covA = await rpc('builder_coverage', { p_tenure_id: OA.seller, p_year_start: '2025-07-01' });
  check('second community year: 20 Oak Ct continues quarterly (Nov 10-Dec 31 $21.37, Jan-Mar $36.99, Apr-Jun $37.40), no true-up (its year did not start on Jul 1); 10 Oak Ct stops at its transfer (Jul-Sep $37.81, Oct-Dec $37.81, Jan 1-Feb 14 $18.49 = $94.11)',
    JSON.stringify(covB.rows.map((r) => [r.from, r.through, r.amount_cents, r.rounding_true_up_cents])) === JSON.stringify([['2025-11-10', '2025-12-31', 2137, 0], ['2026-01-01', '2026-03-31', 3699, 0], ['2026-04-01', '2026-06-30', 3740, 0]])
      && covA.valid && covA.amount_cents === 3781 + 3781 + 1849 && covA.covered_through === '2026-02-14',
    JSON.stringify({ B: covB.rows.map((r) => [r.from, r.through, r.amount_cents]), A: covA.rows.map((r) => [r.from, r.through, r.amount_cents]) }));
  // A full-year builder lot on the second community: covered from Jul 1, quarterly, year-end true-up -> exactly 25% of $600 = $150.00.
  const OC2 = await oakLot('40 Oak Ct', 'Acme Homes of Texas LLC', { origin: 'transfer', start: '2026-07-01' });   // the builder bought it from the developer on 7/1/2026 (a recorded transfer)
  const y2 = '2026-07-01';   // the NEXT assessment year (Jul 1 2026 - Jun 30 2027), billed only by the accrual
  await accrue('2027-06-30', OAK, A2, je2);
  const covC = await rpc('builder_coverage', { p_tenure_id: OC2.seller, p_year_start: y2 });
  check('second community, a full assessment year (Jul 1 2026 - Jun 30 2027) billed quarterly sums to EXACTLY $150.00 (25% of $600) (any rounding difference lands, marked, on the Jun 30 period)',
    covC.valid && covC.count === 4 && covC.amount_cents === 15000 && covC.rows[3].through === '2027-06-30'
      && covC.rows.slice(0, 3).every((r) => r.rounding_true_up_cents === 0),
    JSON.stringify(covC.rows.map((r) => [r.from, r.through, r.amount_cents, r.rounding_true_up_cents])));
  const stOak = await rpc('builder_coverage_status', { p_community_id: OAK, p_as_of: '2027-07-06' });
  check('second community status, 6 days after ITS year end: expected through Jun 30 2027; the lots that are not covered through it would be RED; these are covered (only 10 Oak Ct sold) ',
    stOak.expected_through === '2027-06-30' && stOak.cadence_months === 3 && stOak.lots.every((l) => l.severity === 'ok'), JSON.stringify(stOak.lots.map((l) => [l.street_address, l.covered_through, l.severity, l.reason])));
  const noLeak = await one(`SELECT count(*)::int AS n FROM journal_entry_lines l JOIN journal_entries j ON j.id = l.journal_entry_id WHERE j.community_id = $1 AND l.account_id NOT IN ($2, $3)`, [OAK, A2['1310'], A2['4010']]);
  check('nothing from the first community leaks into the second: every one of its entries posts only to 1310 / 4010', noLeak.n === 0);
  void OH;
}

console.log('\n-- a community with no builder rule converts exactly as before (501’s EXECUTE)');
{
  const OTH = 'a0000000-0000-4000-8000-0000000000bb'; const OF = '00000000-0000-4000-8000-00000000f0bb'; const OC = 'CONV-OTH-20260630';
  await db.query(`INSERT INTO communities (id, name, management_company_id, gl_cutover_date) VALUES ($1, 'Example Glen', $2, '2026-07-01')`, [OTH, MC]);
  await db.query(`INSERT INTO account_funds VALUES ($1, $2, 'OPR')`, [OF, OTH]);
  for (const [n, t] of [['1000', 'asset'], ['1300', 'asset'], ['3000', 'equity']]) await db.query(`INSERT INTO chart_of_accounts (id, community_id, account_number, fund_id, account_type) VALUES (gen_random_uuid(), $1, $2, $3, $4)`, [OTH, n, OF, t]);
  await db.query(`INSERT INTO accounting_periods (community_id, fiscal_year, period_number, period_start, period_end, status) SELECT $1, 2026, m, make_date(2026, m, 1), (make_date(2026, m, 1) + interval '1 month - 1 day')::date, 'open' FROM generate_series(1, 12) m`, [OTH]);
  const OB = await rpc('onboarding_create_batch', { p_community: OTH, p_batch_code: OC, p_as_of: CUTOFF, p_source_system: 'vantaca', p_actor_kind: 'human', p_actor_id: 'ed' });
  for (const s of ['intake', 'normalize', 'source_controls']) { const c = await rpc('onboarding_record_completion', { p_batch: OB, p_stage: s, p_status: 'PASS', p_open: [], p_controls: ctl, p_summary: {}, p_actor_kind: 'system', p_actor_id: 'op' }); await rpc('onboarding_auto_advance', { p_batch: OB, p_completion: c, p_actor_id: 'op' }); }
  const ol = [{ line_no: 1, kind: 'gl_opening_balance', account_code: '1000', amount_cents: 100000, detail: {} }, { line_no: 2, kind: 'gl_opening_balance', account_code: '3000', amount_cents: -100000, detail: {} }]
    .map((l) => ({ ...l, batch_code: OC, cutoff_date: CUTOFF, component: 'gl', provenance: [{ artifact: 'rehearsal', line: l.line_no }] }));
  const osn = await rpc('onboarding_record_snapshot', { p_batch: OB, p_status: 'PASS', p_open: [], p_controls: ctl, p_summary: { roles: { ar_account: '1300', prepaid_account: '2400', ap_account: '2000' } }, p_lines: ol, p_snapshot_sha256: 'a'.repeat(64), p_actor_kind: 'system', p_actor_id: 'op' });
  await rpc('onboarding_auto_advance', { p_batch: OB, p_completion: osn, p_actor_id: 'op' });
  const ofp = trustedFingerprint((await trustedReader(OTH)).trusted);
  const obr = await rpc('onboarding_record_bridge', { p_batch: OB, p_status: 'PASS', p_open: [], p_controls: ctl, p_summary: { snapshot_completion_id: osn, bridge_engine: 'rehearsal' }, p_items: [], p_bridge_sha256: 'b'.repeat(64), p_trusted_fingerprint: ofp, p_actor_kind: 'system', p_actor_id: 'op' });
  await rpc('onboarding_auto_advance', { p_batch: OB, p_completion: obr, p_actor_id: 'op' });
  const octx = await conversionContext(OTH, { cutoff: CUTOFF }); const otr = (await trustedReader(OTH)).trusted;
  const op = buildConversionPlan({ batch: { id: OB, batch_code: OC, community_id: OTH, as_of_date: CUTOFF }, snapshot: { completion_id: osn, sha256: 'a'.repeat(64), roles: { ar_account: '1300', prepaid_account: '2400', ap_account: '2000' }, lines: ol },
    bridge: { completion_id: obr, sha256: 'b'.repeat(64), trusted_fingerprint: ofp, status: 'PASS', items: [] }, source: {}, trusted: otr, ctx: { ...octx, current_trusted_fingerprint: trustedFingerprint(otr) } });
  const { controls: oc, ...ob } = op;
  const orep = PF.buildConversionPreflight({ batch: { batch_code: OC, community_id: OTH, source_system: 'vantaca', stage: 'preflight' }, source_cutoff: { cutoff_date: CUTOFF, cutover_date: op.cutover },
    inputs: { snapshot: { completion_id: osn, sha256: 'a'.repeat(64), status: 'PASS' }, bridge: { completion_id: obr, sha256: 'b'.repeat(64), trusted_fingerprint: ofp, status: 'PASS', engine: 'rehearsal' }, decisions: [], bridge_waivers: [], artifacts: [] }, plan: ob, controls: oc }, []);
  check('no builder rule: the loader returns no builder context; the plan has no builder writes, keys or controls', octx.builder === null && !orep.plan.writes.builder_coverage_batch && !('builder_coverage_rows' in orep.plan.summary)
    && !orep.controls.some((c) => /builder|deferral/.test(c.code)) && orep.status.overall === 'PASS', JSON.stringify(orep.controls.filter((c) => c.status !== 'PASS')));
  const opf = await rpc('onboarding_record_completion', { p_batch: OB, p_stage: 'preflight', p_status: orep.status.overall, p_open: [], p_controls: orep.controls.map((c) => ({ code: c.code, label: c.label, status: c.status })),
    p_summary: { preflight_format: orep.format, preflight_sha256: orep.sha256, preflight_report: orep }, p_actor_kind: 'system', p_actor_id: 'onboarding-operator' });
  await svc.approve(ED, OB, { completion_id: opf, preflight: orep });
  const oex = await svc.execute(ED, OB, { completion_id: opf, preflight_sha256: orep.sha256 });
  check('...and 501’s EXECUTE runs it with exactly the 498 write counts (no builder keys, no builder rows)', oex.status === 'executed'
    && JSON.stringify(Object.keys(oex.write_counts).sort()) === JSON.stringify(['ap_opening_invoices', 'ar_opening_rows', 'neutralize_journal_entries', 'opening_journal_entries', 'repost_journal_entries', 'revert_ar_batches', 'supersede_journal_entries'])
    && (await one(`SELECT count(*)::int AS n FROM builder_assessment_coverage WHERE community_id = $1`, [OTH])).n === 0 && (await one(`SELECT count(*)::int AS n FROM conversion_reconciling_items WHERE community_id = $1`, [OTH])).n === 0,
    JSON.stringify(oex.write_counts));
}

// ------------------------------------------------------------------------ exhibits
if (REPORT) {
  const L = (rows) => rows.map((l) => `    ${l.dr ? 'Dr' : 'Cr'} ${l.acct}  ${$(l.dr || l.cr).padStart(10)}${l.lot ? `  (${l.lot})` : ''}`).join('\n');
  console.log(`\n================ EXHIBITS (rehearsal ${CODE}) ================`);
  console.log(`\n1) 5302 Sleepy Fox, inside ${CODE}-BUILDER (posted ${bjeRow.d}):\n${L(bLines.slice(0, 3))}`);
  console.log(`   ledger: -${$(-ht5302.a)} correcting adjustment, Lennar tenure; coverage 2026-01-01..2026-06-30 = ${$(c5302.amount_cents)} (legacy $495.00 kept as evidence)`);
  console.log(`\n2) 8211 Rustic Pine Trail (one of 22 unbilled), inside the same entry:\n${L(l8211)}\n    Cr 4000  ${$(12273).padStart(10)}  (its line in the income credit)`);
  console.log(`   ledger: +$122.73 charge dated 7/1; coverage 2026-01-01..2026-06-30 = $122.73`);
  console.log(`   entry totals: ${$(bje.total_debits_cents)} Dr = Cr; 22 x $122.73 = $2,700.06 baseline`);
  console.log(`\n3) 2205: source 6/30 ${$(-TB[2205])} -> after the builder entry ${$(-tbNow['2205'])} = schedule $79,200.00 + reconciling $2.00`);
  console.log(`   schedule ${sched.id.slice(0, 8)} (active, conversion_balance, approved_by ${sched.approved_by}): ${months.map((m) => `${m.m.slice(0, 7)} ${$(m.c)}`).join(', ')}`);
  console.log(`\n4) accrual (Dr 1300 per lot / Cr 4000), per month for the unsold lot: ${decUnsold.map((r) => `${r.through.slice(0, 7)} ${$(r.amount_cents)}${r.rounding_true_up_cents ? ' (incl. +1c true-up)' : ''}`).join(', ')} = ${$(decUnsold.reduce((t, r) => t + r.amount_cents, 0))}`);
  console.log(`\n5) transfer 8211 on 9/15 after Jul + Aug: coverage through ${tw.builder_coverage.covered_through}; bills ${tw.builder_unbilled_period.start}..${tw.builder_unbilled_period.end} = ${$(tw.builder_adjustment_cents)}; homeowner ${$(tw.homeowner_due_cents)}`);
  console.log(`   8211 coverage: ${c8211c.rows.map((r) => `${r.from}..${r.through} ${$(r.amount_cents)} [${r.source_type}]`).join(' | ')}`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
