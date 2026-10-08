// tests/sql/500_transfer_proration_e2e.mjs — migration 500 (issue #94: Still
// Creek builder-to-homeowner assessment proration) applied END TO END through
// the single-migration tool with its REAL checks file, on the REAL 360 tables
// and the REAL v_current_owner_ledger (sliced from 457). Then every acceptance
// case in the issue, on the transfer engine's convention (seller owns through
// settlement - 1, buyer from settlement):
//   mid-year, Jan 1, Dec 31, leap year, a changed annual rate, non-Lennar and
//   non-configured transfers untouched, re-run protection, builder already
//   billed (full rate / builder rate -> correct net), ambiguous activity blocks,
//   before-cutover blocks, a builder buyer, mixed owners, ledger visibility.
// Postgres 17 (PGlite 0.3.x). Skips without PGlite.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  500 transfer proration rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const F = '500_transfer_assessment_proration.sql';
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm500-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`));
const PRINT = process.argv.includes('--print-objects');

const SCR = 'a0000000-0000-4000-8000-000000000006';   // Still Creek Ranch (the seed targets it)
const OTHER = 'a0000000-0000-4000-8000-0000000000aa';
const LENNAR = '0eda1b79-0526-4e5d-8a4b-5488a0938ed1';
const MC = '00000000-0000-0000-0000-000000000001';

const db = new PGlite();
await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE OR REPLACE FUNCTION trusted_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
  CREATE TABLE schema_migrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), filename text NOT NULL UNIQUE, sha256 text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, duration_ms integer, error text);
  CREATE TABLE communities (id uuid PRIMARY KEY, name text, management_company_id uuid, books_of_record text, gl_cutover_date date);
  CREATE TABLE properties (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), community_id uuid NOT NULL REFERENCES communities(id), street_address text,
    vantaca_account_id text, trusted_account_number text);
  CREATE TABLE contacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), full_name text);
  CREATE TABLE builder_companies (id uuid PRIMARY KEY, management_company_id uuid, company_name text NOT NULL);
  CREATE TABLE ownership_tenures (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), community_id uuid NOT NULL, property_id uuid REFERENCES properties(id),
    kind text NOT NULL DEFAULT 'owner', start_date date, end_date date, vantaca_account_id text,
    origin text NOT NULL CHECK (origin IN ('backfill_current', 'backfill_historical', 'backfill_legacy', 'transfer')));
  CREATE TABLE property_ownerships (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid REFERENCES properties(id), contact_id uuid REFERENCES contacts(id),
    tenure_id uuid REFERENCES ownership_tenures(id), start_date date, end_date date, is_primary boolean DEFAULT true);
  CREATE TABLE ownership_change_proposals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid, community_id uuid, status text NOT NULL,
    effective_start_date date, proposed_owner_name text, current_contact_id uuid, seller_tenure_id uuid REFERENCES ownership_tenures(id),
    buyer_tenure_id uuid REFERENCES ownership_tenures(id));
  CREATE TABLE journal_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  CREATE TABLE recognition_schedules (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  CREATE TABLE conversion_batches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), community_id uuid NOT NULL REFERENCES communities(id), batch_code text NOT NULL,
    as_of_date date NOT NULL, status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','staged','validated','approved','posted','voided')), created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE transaction_upload_batches (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), management_company_id uuid NOT NULL, community_id uuid NOT NULL REFERENCES communities(id),
    period_label text NOT NULL, as_of_date date NOT NULL, source_filename text, source_format text NOT NULL DEFAULT 'csv' CHECK (source_format IN ('csv','pdf','manual')),
    row_count int NOT NULL DEFAULT 0, account_count int NOT NULL DEFAULT 0, total_charges_cents bigint, total_payments_cents bigint,
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','committed','reverted')), uploaded_by text, uploaded_at timestamptz NOT NULL DEFAULT now(),
    committed_at timestamptz, notes text, min_transaction_date date, max_transaction_date date);
  CREATE TABLE homeowner_transactions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_batch_id uuid NOT NULL REFERENCES transaction_upload_batches(id), source_row_index int NOT NULL,
    community_id uuid NOT NULL REFERENCES communities(id), vantaca_account_id text, property_id uuid REFERENCES properties(id), contact_id uuid REFERENCES contacts(id),
    transaction_date date NOT NULL, description text NOT NULL,
    txn_type text NOT NULL DEFAULT 'charge' CHECK (txn_type IN ('charge','payment','credit','adjustment','balance_brought_forward')),
    amount_cents bigint NOT NULL, running_balance_cents bigint, raw_row_jsonb jsonb, notes text, created_at timestamptz NOT NULL DEFAULT now(),
    charge_category text CHECK (charge_category IS NULL OR charge_category IN ('assessment','late_fee','interest','fine','attorney_fee','admin_fee','payment','credit','refund',
      'adjustment','prior_balance','other','certified_letter','attorney_fee_other','nsf_fee')),
    trusted_account_number text, tenure_id uuid REFERENCES ownership_tenures(id), is_operator_override boolean DEFAULT false,
    reduction_source text CHECK (reduction_source IS NULL OR (reduction_source IN ('cash_payment','prepaid_credit','credit_waiver','correcting_adjustment') AND amount_cents < 0)),
    UNIQUE (source_batch_id, source_row_index));
  INSERT INTO communities VALUES ('${SCR}', 'Still Creek Ranch', '${MC}', 'trusted', '2026-07-01'),
                                 ('${OTHER}', 'Example Creek', '${MC}', 'trusted', '2026-01-01');
  INSERT INTO builder_companies VALUES ('${LENNAR}', '${MC}', 'Lennar'), (gen_random_uuid(), '${MC}', 'Perry Homes');`);
// The real ledger view, sliced verbatim from 457 (the plan reads it before approval).
const m457 = lf(`${REPO}/migrations/457_current_tenure_reader_views.sql`);
const viewSql = m457.slice(m457.indexOf('CREATE OR REPLACE VIEW v_current_owner_ledger'), m457.indexOf('CREATE OR REPLACE VIEW v_current_owner_balance AS'));
await db.exec(viewSql);
await db.exec(lf(`${REPO}/migrations/360_assessment_proration.sql`));
await db.exec(`INSERT INTO schema_migrations (filename, sha256) VALUES ('360_assessment_proration.sql', 'recorded'), ('452_conversion_staging.sql', 'recorded'), ('459_ownership_transfer_single_path.sql', 'recorded'), ('461_payment_applications.sql', 'recorded'), ('466_recognition_schedules_controls.sql', 'recorded')`);

const client = { query: async (sql, params) => {
  if (params) { const r = await db.query(sql, params.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : v))); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; }
  const rs = await db.exec(sql); const last = rs[rs.length - 1] || { rows: [] }; return { rows: last.rows, rowCount: last.affectedRows ?? 0 };
} };
const ctx = { client, user: { id: 'o', email: 'owner@example.test' }, deployedCommit: 'deadbeefcafe', migrationsDir: dir, secret: 'e2e' };
const q = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
const err = async (sql, params) => { try { await db.query(sql, params); return null; } catch (e) { return e.message; } };
const rpc = async (name, args) => {
  const keys = Object.keys(args);
  const r = await db.query(`SELECT ${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) AS r`, keys.map((k) => args[k]));
  return r.rows[0].r;
};

const plan = await A.planMigration({ ...ctx, filename: F });
if (PRINT) { const rr = await A.applyMigration({ ...ctx, planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) }); console.log(JSON.stringify((rr.detail || {}).objects || rr, null, 2)); console.log(JSON.stringify((rr.detail || {}).row_changes)); process.exit(0); }
check('plan: ready, every preflight passes', plan.status === 'ready' && plan.preflight.every((p) => p.ok), JSON.stringify({ status: plan.status, error: plan.error, pre: plan.preflight }).slice(0, 600));
const r = await A.applyMigration({ ...ctx, planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) });
check('apply: 500 applied and verified through the tool (objects + seeded rows as declared)', r.status === 'applied', JSON.stringify({ status: r.status, error: r.error, detail: r.detail }).slice(0, 1200));
if (r.status !== 'applied') { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }

const rates = await q(`SELECT owner_class, annual_amount_cents, pct_of_homeowner_rate::text AS pct, income_account_number AS income, deferral_account_number AS deferral FROM community_assessment_rates WHERE community_id = $1 ORDER BY owner_class`, [SCR]);
check('seed: Still Creek homeowner $495.00 deferred through 2205 into 4000, builder 50% of the homeowner rate (configuration from its own GL, not code)',
  JSON.stringify(rates) === JSON.stringify([{ owner_class: 'builder', annual_amount_cents: null, pct: '50.00', income: '4000', deferral: null }, { owner_class: 'homeowner', annual_amount_cents: 49500, pct: null, income: '4000', deferral: '2205' }]), JSON.stringify(rates));

// ---------------------------------------------------------------- the world
let lotN = 0;
async function lot({ community = SCR, sellers = ['Lennar Homes LLC'], origin = 'backfill_current', start = '2026-05-21', prior = [] } = {}) {
  lotN++;
  const p = await one(`INSERT INTO properties (community_id, street_address, vantaca_account_id, trusted_account_number) VALUES ($1, $2, $3, $4) RETURNING id`,
    [community, `${100 + lotN} Test Lane`, `V${1000 + lotN}`, `T${1000 + lotN}`]);
  const t = await one(`INSERT INTO ownership_tenures (community_id, property_id, start_date, vantaca_account_id, origin) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [community, p.id, start, `V${1000 + lotN}`, origin]);
  for (const n of sellers) {
    const c = await one(`INSERT INTO contacts (full_name) VALUES ($1) RETURNING id`, [n]);
    await db.query(`INSERT INTO property_ownerships (property_id, contact_id, tenure_id, start_date) VALUES ($1, $2, $3, $4)`, [p.id, c.id, t.id, start]);
  }
  if (prior.length) {
    const b = await one(`INSERT INTO transaction_upload_batches (management_company_id, community_id, period_label, as_of_date, status) VALUES ($1, $2, 'import', '2026-05-21', 'committed') RETURNING id`, [MC, community]);
    let i = 0;
    for (const x of prior) {
      await db.query(`INSERT INTO homeowner_transactions (source_batch_id, source_row_index, community_id, vantaca_account_id, property_id, transaction_date, description, txn_type, amount_cents, charge_category, tenure_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [b.id, i++, community, `V${1000 + lotN}`, p.id, x.date, x.desc || 'Annual Assessment', x.type || 'charge', x.cents, x.category || null, x.stamped === false ? null : t.id]);
    }
  }
  return { property: p.id, seller: t.id, community };
}
// What approve_ownership_proposal does to tenures (mig 459/460): seller ends settlement - 1, buyer starts on settlement.
async function approve(L, settle, buyer = 'Pat Homeowner') {
  await db.query(`UPDATE ownership_tenures SET end_date = ($1::date - 1) WHERE id = $2`, [settle, L.seller]);
  await db.query(`UPDATE property_ownerships SET end_date = ($1::date - 1) WHERE tenure_id = $2`, [settle, L.seller]);
  const bt = await one(`INSERT INTO ownership_tenures (community_id, property_id, start_date, vantaca_account_id, origin) VALUES ($1, $2, $3, (SELECT vantaca_account_id FROM properties WHERE id = $2), 'transfer') RETURNING id`, [L.community, L.property, settle]);
  const c = await one(`INSERT INTO contacts (full_name) VALUES ($1) RETURNING id`, [buyer]);
  await db.query(`INSERT INTO property_ownerships (property_id, contact_id, tenure_id, start_date) VALUES ($1, $2, $3, $4)`, [L.property, c.id, bt.id, settle]);
  const pr = await one(`INSERT INTO ownership_change_proposals (property_id, community_id, status, effective_start_date, proposed_owner_name, seller_tenure_id, buyer_tenure_id)
    VALUES ($1, $2, 'approved', $3, $4, $5, $6) RETURNING id`, [L.property, L.community, settle, buyer, L.seller, bt.id]);
  return { ...L, proposal: pr.id, buyer: bt.id };
}
const preview = (L, settle, buyer = 'Pat Homeowner') => rpc('transfer_proration_plan', { p_property_id: L.property, p_seller_tenure_id: L.seller, p_settlement_date: settle, p_buyer_name: buyer, p_buyer_tenure_id: null });
const post = (T, dry = false) => rpc('post_transfer_assessment_proration', { p_proposal_id: T.proposal, p_posted_by: 'tester', p_dry_run: dry });
const pick = (p, ks) => Object.fromEntries(ks.map((k) => [k, p[k]]));

// ================================================================ BEFORE CONVERSION
// Still Creek has no POSTED conversion: its 2026 annual billing lives only in the
// Vantaca-era ledger. The workflow calculates, shows and STAGES; nothing financial.
const htCount = async () => (await one(`SELECT count(*)::int AS n FROM homeowner_transactions WHERE raw_row_jsonb->>'source' = 'transfer_proration'`)).n;
const tpBatches = async () => (await one(`SELECT count(*)::int AS n FROM transaction_upload_batches WHERE uploaded_by = 'transfer_proration'`)).n;
await db.query(`INSERT INTO conversion_batches (community_id, batch_code, as_of_date, status) VALUES ($1, 'CONV-SCR-DRAFT', '2026-06-30', 'validated')`, [SCR]);
const B0 = await lot();
const b0 = await preview(B0, '2026-07-01');
check('before conversion: the calculation is the same ($122.73 / $249.53) but posting is NOT ready (accounting_not_converted); a validated-but-unposted conversion does not count',
  b0.applies && !b0.blocked && b0.posting_ready === false && b0.not_ready_reason === 'accounting_not_converted' && b0.builder_due_cents === 12273 && b0.homeowner_due_cents === 24953,
  JSON.stringify(pick(b0, ['applies', 'blocked', 'posting_ready', 'not_ready_reason', 'builder_due_cents', 'homeowner_due_cents'])));
const TB0 = await approve(B0, '2026-07-01');
const s0 = await post(TB0);
const st0 = await q(`SELECT role, status, prorated_amount_cents, net_responsibility_cents, homeowner_txn_id, batch_id, staged_plan IS NOT NULL AS has_plan FROM assessment_prorations WHERE proposal_id = $1 ORDER BY role`, [TB0.proposal]);
check('before conversion, an unbilled Lennar lot: STAGED (both amounts recorded against the transfer), no owner-ledger row, no batch, no GL',
  s0.staged === true && JSON.stringify(st0) === JSON.stringify([
    { role: 'builder_adjustment', status: 'staged', prorated_amount_cents: 12273, net_responsibility_cents: 12273, homeowner_txn_id: null, batch_id: null, has_plan: true },
    { role: 'homeowner_charge', status: 'staged', prorated_amount_cents: 24953, net_responsibility_cents: 24953, homeowner_txn_id: null, batch_id: null, has_plan: true }])
    && await htCount() === 0 && await tpBatches() === 0, JSON.stringify({ s0: pick(s0, ['staged', 'posting_ready']), st0 }));
const s0b = await post(TB0);
check('re-running while still not converted: stays staged, writes nothing new', s0b.staged === true && s0b.posted === false
  && (await one(`SELECT count(*)::int AS n FROM assessment_prorations WHERE proposal_id = $1`, [TB0.proposal])).n === 2 && await htCount() === 0);
// 5302 Sleepy Fox before conversion: the $372.27 credit must NOT exist; the calculation says Lennar nets to $122.73.
const sleepyPre = [
  { date: '2026-01-01', cents: 57128, desc: 'Prior Balance', type: 'balance_brought_forward' },
  { date: '2026-01-01', cents: 49500, desc: 'Annual Assessment' },
  { date: '2026-01-01', cents: 413, desc: 'Late Interest' }, { date: '2026-02-01', cents: 825, desc: 'Late Interest' }, { date: '2026-02-01', cents: 1000, desc: 'Late Fees' }];
const TS0 = await approve(await lot({ prior: sleepyPre }), '2026-07-01');
const bal0 = Number((await one(`SELECT sum(amount_cents)::bigint AS s FROM homeowner_transactions WHERE tenure_id = $1`, [TS0.seller])).s);
const ss0 = await post(TS0);
const sb0 = await one(`SELECT status, prorated_amount_cents, net_responsibility_cents, prior_billed_cents, homeowner_txn_id FROM assessment_prorations WHERE proposal_id = $1 AND role = 'builder_adjustment'`, [TS0.proposal]);
check('before conversion, 5302 Sleepy Fox: calculated (Lennar nets to $122.73; the would-be adjustment -$372.27 is recorded as STAGED), but NO credit row exists and Lennar\u2019s ledger is unchanged',
  ss0.staged === true && sb0.status === 'staged' && Number(sb0.prorated_amount_cents) === -37227 && Number(sb0.net_responsibility_cents) === 12273 && Number(sb0.prior_billed_cents) === 49500
    && sb0.homeowner_txn_id === null && await htCount() === 0
    && Number((await one(`SELECT sum(amount_cents)::bigint AS s FROM homeowner_transactions WHERE tenure_id = $1`, [TS0.seller])).s) === bal0,
  JSON.stringify({ sb0, bal0 }));
const TA0 = await approve(await lot({ prior: [{ date: '2026-05-13', cents: 9018 }] }), '2026-07-01');
const sa0 = await post(TA0);
check('before conversion, 5450 Still Meadow ($90.18): BLOCKED as ambiguous; recorded for the queue (staged calculation), nothing financial',
  sa0.blocked === true && sa0.blocked_reasons.includes('ambiguous_builder_assessment') && sa0.staged === true
    && (await one(`SELECT count(*)::int AS n FROM assessment_prorations WHERE proposal_id = $1 AND status = 'staged' AND homeowner_txn_id IS NULL`, [TA0.proposal])).n === 2
    && await htCount() === 0);

// --report: print what the database holds for the three real lot shapes.
const REPORT = process.argv.includes('--report');
if (REPORT) { process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'; process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test'; }   // module load only; no database call
const glOf = (p) => require(`${REPO}/lib/accounting/transfer_proration.js`).glLines({ 1300: '1300 AR', 4000: '4000 Assessment Income', 2205: '2205 Unearned Income' }, p)
  .map((l) => `${l.debit_cents ? 'Dr' : 'Cr'} ${l.account_id} $${((l.debit_cents || l.credit_cents) / 100).toFixed(2)}`);
async function report(stage) {
  if (!REPORT) return;
  console.log(`\n==================== ${stage}`);
  for (const [label, T] of [['Unbilled Lennar lot (22 lots)', TB0], ['5302 Sleepy Fox', TS0], ['5450 Still Meadow', TA0]]) {
    const ap = await q(`SELECT role, status, prorated_amount_cents AS amount, net_responsibility_cents AS net, prior_billed_cents AS prior, homeowner_txn_id IS NOT NULL AS ledger_row FROM assessment_prorations WHERE proposal_id = $1 ORDER BY role`, [T.proposal]);
    const ht = await q(`SELECT CASE WHEN h.tenure_id = $2 THEN 'Lennar (seller)' ELSE 'new owner (buyer)' END AS account, h.transaction_date::text AS date, h.txn_type, h.amount_cents, h.description, b.status AS batch
                         FROM homeowner_transactions h JOIN transaction_upload_batches b ON b.id = h.source_batch_id
                        WHERE h.raw_row_jsonb->>'proposal_id' = $1 ORDER BY h.source_row_index`, [T.proposal, T.seller]);
    const cov = await q(`SELECT source_type, covered_from::text AS "from", covered_through::text AS through, days, amount_cents, rounding_true_up_cents AS true_up, annual_billed_cents, status FROM builder_assessment_coverage WHERE tenure_id = $1 ORDER BY covered_from`, [T.seller]);
    console.log(`\n-- ${label}`);
    console.log('   builder coverage:', cov.length ? '' : 'none');
    for (const c of cov) console.log(`     ${c.from} .. ${c.through}  ${c.days}d  $${(c.amount_cents / 100).toFixed(2)}  ${c.source_type}${c.annual_billed_cents ? ' (normalizes $' + (c.annual_billed_cents / 100).toFixed(2) + ' billed)' : ''}  [${c.status}]`);
    console.log('   proration record:', ap.length ? JSON.stringify(ap) : 'none');
    console.log('   owner-ledger rows:', ht.length ? '' : 'none');
    for (const h of ht) console.log(`     ${h.account}  ${h.date}  ${h.txn_type}  $${(h.amount_cents / 100).toFixed(2)}  "${h.description}"  [batch ${h.batch}]`);
    if (ht.length) {
      const plan = JSON.parse((await one(`SELECT raw_row_jsonb->>'plan' AS p FROM homeowner_transactions WHERE raw_row_jsonb->>'proposal_id' = $1 LIMIT 1`, [T.proposal])).p);
      console.log('   GL entry (assessment_billing, dated ' + plan.settlement_date + '):', glOf({ ...plan, property_id: T.property }).join(' | '));
      if (plan.homeowner_recognition) console.log(`   recognition schedule (created after the GL posts): 2205 -> 4000, ${plan.homeowner_recognition.start_month} for ${plan.homeowner_recognition.term_months} months, $${(plan.homeowner_recognition.monthly_cents / 100).toFixed(2)}/month (last month takes the rounding)`);
    } else {
      const p = await post(T, true);
      console.log('   GL entry: none' + (p.blocked ? '  [BLOCKED: ' + p.blocked_reasons.join(', ') + ']' : ''));
      if (p.normalization_required) console.log(`   waiting for: the conversion to normalize the $${(p.normalization_required.annual_cents / 100).toFixed(2)} annual assessment (${p.normalization_required.annual_date}) to the ${Number(p.normalization_required.builder_rate_pct)}% builder rate`);
    }
  }
}
await report('BEFORE STILL CREEK CONVERSION (no posted conversion_batches row)');

// ================================================================ CONVERSION POSTED (as-of 6/30/2026)
const CONV = (await one(`INSERT INTO conversion_batches (community_id, batch_code, as_of_date, status) VALUES ($1, 'CONV-SCR-20260630', '2026-06-30', 'posted') RETURNING id`, [SCR])).id;
// Stand-ins for the accounting a coverage period ties to (the conversion / accrual journal entry and batch).
const JE_STUB = (await one(`INSERT INTO journal_entries DEFAULT VALUES RETURNING id`)).id;
const BATCH_STUB = (await one(`INSERT INTO transaction_upload_batches (management_company_id, community_id, period_label, as_of_date, status, uploaded_by) VALUES ($1, $2, 'coverage stand-in', '2026-07-01', 'committed', 'test') RETURNING id`, [MC, SCR])).id;
// Write one coverage period the way #96's conversion / accrual does: pending, then posted with its entry.
async function cover(T, { from, through, source = 'scheduled_accrual', annual = 49500, pct = 50, trueUp = 0, annualBilled = null, post = true, year = Number(String(from).slice(0, 4)) }) {
  const c = await one(`INSERT INTO builder_assessment_coverage (community_id, property_id, tenure_id, builder_company_id, fiscal_year, covered_from, covered_through, days, days_in_year,
      annual_assessment_cents, builder_rate_pct, base_amount_cents, rounding_true_up_cents, amount_cents, annual_billed_cents, source_type, conversion_batch_id, accrual_run_id, created_by)
    SELECT $1, $2, $3, $4, $5, $6::date, $7::date, $7::date - $6::date + 1, make_date($5, 12, 31) - make_date($5, 1, 1) + 1,
      $8::bigint, $9::numeric, round($8::numeric * $9::numeric * ($7::date - $6::date + 1) / (100 * (make_date($5, 12, 31) - make_date($5, 1, 1) + 1))),
      $10::bigint, round($8::numeric * $9::numeric * ($7::date - $6::date + 1) / (100 * (make_date($5, 12, 31) - make_date($5, 1, 1) + 1))) + $10::bigint,
      $11::bigint, $12, CASE WHEN $12 = 'conversion' THEN $13::uuid END, CASE WHEN $12 = 'scheduled_accrual' THEN gen_random_uuid() END, 'test'
    RETURNING id, amount_cents`, [T.community || SCR, T.property, T.seller, LENNAR, year, from, through, annual, pct, trueUp, annualBilled, source, CONV]);
  if (post) await db.query(`UPDATE builder_assessment_coverage SET status = 'posted', journal_entry_id = $2, batch_id = $3 WHERE id = $1`, [c.id, JE_STUB, BATCH_STUB]);
  return c;
}
const convCover = (T, extra = {}) => cover(T, { from: '2026-01-01', through: '2026-06-30', source: 'conversion', ...extra });

// --- converted, but no coverage recorded for a lot: never guess
check('after conversion with NO coverage for the lot: BLOCKED (builder_coverage_missing), nothing written',
  (await post(TB0, true)).blocked_reasons.includes('builder_coverage_missing') && (await post(TS0, true)).blocked_reasons.includes('builder_coverage_missing') && await htCount() === 0);

// --- what #96's conversion writes: 5302 normalized, the unbilled lot baselined; 5450 gets nothing
await convCover(TB0);
await convCover(TS0, { annualBilled: 49500 });
const s1dry = await post(TB0, true);
check('after conversion: the staged proration recomputes from the coverage record (covered through 6/30, $122.73), so a 7/1 sale bills Lennar NOTHING more; dry run writes nothing',
  s1dry.dry_run === true && s1dry.posting_ready === true && s1dry.staged === true && !s1dry.blocked && s1dry.builder_prior_billed_cents === 12273
    && s1dry.builder_adjustment_cents === 0 && s1dry.homeowner_due_cents === 24953 && s1dry.builder_coverage.covered_through === '2026-06-30' && await htCount() === 0,
  JSON.stringify(pick(s1dry, ['blocked_reasons', 'builder_prior_billed_cents', 'builder_adjustment_cents', 'builder_unbilled_period'])));
const s1 = await post(TB0);
const st1 = await q(`SELECT role, status, prorated_amount_cents, homeowner_txn_id IS NOT NULL AS has_txn, staged_plan IS NOT NULL AS kept_plan FROM assessment_prorations WHERE proposal_id = $1 ORDER BY role`, [TB0.proposal]);
check('posting it: the staged pair becomes the posted pair (no second set); only the new owner’s $249.53 is a ledger row; no transfer coverage (no uncovered days)',
  s1.written === true && s1.from_staged === true && JSON.stringify(st1) === JSON.stringify([
    { role: 'builder_adjustment', status: 'posted', prorated_amount_cents: 0, has_txn: false, kept_plan: true },
    { role: 'homeowner_charge', status: 'draft', prorated_amount_cents: 24953, has_txn: true, kept_plan: true }])
    && (await one(`SELECT count(*)::int AS n FROM builder_assessment_coverage WHERE proposal_id = $1`, [TB0.proposal])).n === 0,
  JSON.stringify({ st1 }));
check('the new owner’s share is billed to the deferral account and released monthly (2205 -> 4000, Jul-Dec, $41.59/month)',
  s1.deferral_account === '2205' && s1.income_account === '4000' && JSON.stringify(s1.homeowner_recognition) === JSON.stringify({ method: 'straight_line_monthly', start_month: '2026-07-01', term_months: 6, monthly_cents: 4159 }));
const lennarBefore = await q(`SELECT description, amount_cents FROM homeowner_transactions WHERE tenure_id = $1 ORDER BY transaction_date, source_row_index`, [TS0.seller]);
const sn = await post(TS0);
const lennarAfter = await q(`SELECT description, amount_cents FROM homeowner_transactions WHERE tenure_id = $1 ORDER BY transaction_date, source_row_index`, [TS0.seller]);
check('5302 after the conversion: #95 reads coverage (normalized $495.00 -> $122.73 through 6/30), needs no legacy $495 row, posts NO second Lennar adjustment, and leaves Lennar’s ledger as it was',
  sn.written === true && sn.builder_normalized && sn.builder_normalized.normalized_cents === 12273 && Number(sn.builder_normalized.annual_billed_cents) === 49500
    && sn.builder_adjustment_cents === 0 && JSON.stringify(lennarAfter) === JSON.stringify(lennarBefore),
  JSON.stringify(pick(sn, ['blocked_reasons', 'builder_normalized', 'builder_adjustment_cents'])));
check('5450 Still Meadow: the conversion wrote no coverage (the $90.18 is unexplained), so it stays BLOCKED (builder_coverage_missing); nothing is fabricated',
  (await post(TA0)).blocked_reasons.includes('builder_coverage_missing')
    && (await one(`SELECT count(*)::int AS n FROM builder_assessment_coverage WHERE tenure_id = $1`, [TA0.seller])).n === 0);
await report('AFTER STILL CREEK CONVERSION (CONV-SCR-20260630: coverage through 6/30 for the unbilled lot and 5302; none for 5450)');
if (REPORT) process.exit(0);

// --- transfer after accrual periods: only the uncovered days are billed
const LA = await lot();
await convCover(LA); await cover(LA, { from: '2026-07-01', through: '2026-07-31' }); await cover(LA, { from: '2026-08-01', through: '2026-08-31' });
const TA2 = await approve(LA, '2026-09-15');
const pA2 = await post(TA2, true);
check('transfer 9/15 after the July and August accruals: coverage runs through 8/31, so Lennar is billed only 9/1-9/14 (14 days) = $9.49',
  !pA2.blocked && pA2.builder_coverage.covered_through === '2026-08-31' && pA2.builder_unbilled_period.days === 14 && pA2.builder_adjustment_cents === 949
    && pA2.builder_prior_billed_cents === 12273 + 2102 + 2102,
  JSON.stringify(pick(pA2, ['blocked_reasons', 'builder_unbilled_period', 'builder_adjustment_cents', 'builder_prior_billed_cents'])));
await post(TA2);
const tc = await one(`SELECT source_type, covered_from::text AS f, covered_through::text AS t, amount_cents, status, homeowner_txn_id IS NOT NULL AS has_txn FROM builder_assessment_coverage WHERE proposal_id = $1`, [TA2.proposal]);
check('...and the transfer’s days become a transfer_true_up coverage period (9/1-9/14, $9.49) tied to its ledger row, pending until the GL posts',
  JSON.stringify(tc) === JSON.stringify({ source_type: 'transfer_true_up', f: '2026-09-01', t: '2026-09-14', amount_cents: 949, status: 'pending', has_txn: true }), JSON.stringify(tc));
check('...after it the builder tenure is fully covered through settlement - 1: no gap, no overlap',
  (await rpc('builder_coverage', { p_tenure_id: TA2.seller, p_fiscal_year: 2026 })).covered_through === '2026-09-14');
// --- no accruals since the conversion
const TNo = await approve(await lot(), '2026-09-15');
await convCover({ ...TNo });
const pNo = await post(TNo, true);
check('transfer 9/15 with no accruals since the conversion: Lennar billed 7/1-9/14 (76 days) = $51.53 (each period rounded on its own days, not $51.54)',
  !pNo.blocked && pNo.builder_unbilled_period.days === 76 && pNo.builder_adjustment_cents === 5153, JSON.stringify(pick(pNo, ['blocked_reasons', 'builder_unbilled_period', 'builder_adjustment_cents'])));

// --- an unsold lot through year end: exactly $247.50
const LY = await lot();
await convCover(LY);
for (const [f, t] of [['07-01', '07-31'], ['08-01', '08-31'], ['09-01', '09-30'], ['10-01', '10-31'], ['11-01', '11-30']]) await cover(LY, { from: `2026-${f}`, through: `2026-${t}` });
check('December without its year-end true-up is refused (the year would total $247.49)',
  /rounding true-up of 1 cents/.test(await err(`INSERT INTO builder_assessment_coverage (community_id, property_id, tenure_id, builder_company_id, fiscal_year, covered_from, covered_through, days, days_in_year, annual_assessment_cents, builder_rate_pct, base_amount_cents, rounding_true_up_cents, amount_cents, source_type, accrual_run_id, created_by)
    VALUES ($1, $2, $3, $4, 2026, '2026-12-01', '2026-12-31', 31, 365, 49500, 50, 2102, 0, 2102, 'scheduled_accrual', gen_random_uuid(), 'test')`, [SCR, LY.property, LY.seller, LENNAR]) || ''));
await cover(LY, { from: '2026-12-01', through: '2026-12-31', trueUp: 1 });
const yrs = await q(`SELECT covered_from::text AS f, amount_cents, rounding_true_up_cents AS tu FROM builder_assessment_coverage WHERE tenure_id = $1 ORDER BY covered_from`, [LY.seller]);
check('an unsold Lennar lot through 12/31: $122.73 + Jul $21.02 + Aug $21.02 + Sep $20.34 + Oct $21.02 + Nov $20.34 + Dec $21.03 (true-up +$0.01) = exactly $247.50',
  yrs.map((x) => x.amount_cents).join(',') === '12273,2102,2102,2034,2102,2034,2103' && yrs.reduce((s, x) => s + Number(x.amount_cents), 0) === 24750 && Number(yrs[6].tu) === 1,
  JSON.stringify(yrs));
check('a true-up on a period that does not end Dec 31 is refused', /builder_assessment_coverage_amount_check/.test(await err(`INSERT INTO builder_assessment_coverage (community_id, property_id, tenure_id, builder_company_id, fiscal_year, covered_from, covered_through, days, days_in_year, annual_assessment_cents, builder_rate_pct, base_amount_cents, rounding_true_up_cents, amount_cents, source_type, accrual_run_id, created_by)
    VALUES ($1, $2, $3, $4, 2027, '2027-01-01', '2027-01-31', 31, 365, 49500, 50, 2102, 1, 2103, 'scheduled_accrual', gen_random_uuid(), 'test')`, [SCR, LY.property, LY.seller, LENNAR]) || ''));

// --- the coverage guard: no gap, no overlap, right amount, last-only void, pending blocks
const LG = await lot();
await convCover(LG);
check('a GAP is refused (August written before July)', /would leave a gap/.test(await err(`INSERT INTO builder_assessment_coverage (community_id, property_id, tenure_id, builder_company_id, fiscal_year, covered_from, covered_through, days, days_in_year, annual_assessment_cents, builder_rate_pct, base_amount_cents, amount_cents, source_type, accrual_run_id, created_by)
    VALUES ($1, $2, $3, $4, 2026, '2026-08-01', '2026-08-31', 31, 365, 49500, 50, 2102, 2102, 'scheduled_accrual', gen_random_uuid(), 'test')`, [SCR, LG.property, LG.seller, LENNAR]) || ''));
await cover(LG, { from: '2026-07-01', through: '2026-07-31' });
check('an OVERLAP is refused (July written again)', /would leave a overlap|uq_builder_assessment_coverage_period/.test(await err(`INSERT INTO builder_assessment_coverage (community_id, property_id, tenure_id, builder_company_id, fiscal_year, covered_from, covered_through, days, days_in_year, annual_assessment_cents, builder_rate_pct, base_amount_cents, amount_cents, source_type, accrual_run_id, created_by)
    VALUES ($1, $2, $3, $4, 2026, '2026-07-15', '2026-08-15', 32, 365, 49500, 50, 2170, 2170, 'scheduled_accrual', gen_random_uuid(), 'test')`, [SCR, LG.property, LG.seller, LENNAR]) || ''));
check('a wrong amount is refused (not the builder rate over its days)', /builder_assessment_coverage_amount_check/.test(await err(`INSERT INTO builder_assessment_coverage (community_id, property_id, tenure_id, builder_company_id, fiscal_year, covered_from, covered_through, days, days_in_year, annual_assessment_cents, builder_rate_pct, base_amount_cents, amount_cents, source_type, accrual_run_id, created_by)
    VALUES ($1, $2, $3, $4, 2026, '2026-08-01', '2026-08-31', 31, 365, 49500, 50, 2000, 2000, 'scheduled_accrual', gen_random_uuid(), 'test')`, [SCR, LG.property, LG.seller, LENNAR]) || ''));
const firstId = (await one(`SELECT id FROM builder_assessment_coverage WHERE tenure_id = $1 ORDER BY covered_from LIMIT 1`, [LG.seller])).id;
check('voiding a MIDDLE period is refused (it would open a gap)', /only the LAST covered period/.test(await err(`UPDATE builder_assessment_coverage SET status = 'voided', voided_by = 'ed', voided_at = now(), void_reason = 'test' WHERE id = $1`, [firstId]) || ''));
check('a covered period is never deleted, and its days and amount are fixed', /never deleted/.test(await err(`DELETE FROM builder_assessment_coverage WHERE id = $1`, [firstId]) || '')
  && /fixed once written/.test(await err(`UPDATE builder_assessment_coverage SET amount_cents = amount_cents + 1, base_amount_cents = base_amount_cents + 1 WHERE id = $1`, [firstId]) || ''));
const julId = (await one(`SELECT id FROM builder_assessment_coverage WHERE tenure_id = $1 AND covered_from = '2026-07-01'`, [LG.seller])).id;
await db.query(`UPDATE builder_assessment_coverage SET status = 'voided', voided_by = 'ed', voided_at = now(), void_reason = 'rerun' WHERE id = $1`, [julId]);
await cover(LG, { from: '2026-07-01', through: '2026-07-31' });
check('rerun / idempotency: the last period can be voided (with a reason) and written again; the same period can never be live twice',
  (await one(`SELECT count(*)::int AS n FROM builder_assessment_coverage WHERE tenure_id = $1 AND covered_from = '2026-07-01' AND status <> 'voided'`, [LG.seller])).n === 1
    && /uq_builder_assessment_coverage_period|would leave a overlap/.test(await err(`INSERT INTO builder_assessment_coverage (community_id, property_id, tenure_id, builder_company_id, fiscal_year, covered_from, covered_through, days, days_in_year, annual_assessment_cents, builder_rate_pct, base_amount_cents, amount_cents, source_type, accrual_run_id, created_by)
      VALUES ($1, $2, $3, $4, 2026, '2026-07-01', '2026-07-31', 31, 365, 49500, 50, 2102, 2102, 'scheduled_accrual', gen_random_uuid(), 'test')`, [SCR, LG.property, LG.seller, LENNAR]) || ''));
await cover(LG, { from: '2026-08-01', through: '2026-08-31', post: false });
const TG = await approve(LG, '2026-09-15');
check('a coverage period still pending (its GL not posted) BLOCKS the transfer (builder_coverage_pending)', (await post(TG, true)).blocked_reasons.includes('builder_coverage_pending'));
const LP = await lot();
await convCover(LP);
for (const [f, t] of [['07-01', '07-31'], ['08-01', '08-31'], ['09-01', '09-30']]) await cover(LP, { from: `2026-${f}`, through: `2026-${t}` });
const TP2 = await approve(LP, '2026-09-15');
check('accrued past the settlement (September accrued before a 9/15 closing was recorded): BLOCKED (builder_billed_past_settlement), never credited by guess',
  (await post(TP2, true)).blocked_reasons.includes('builder_billed_past_settlement'));
check('coverage past the end of the builder’s ownership is refused at write time', /runs past the end of the builder/.test(await err(`INSERT INTO builder_assessment_coverage (community_id, property_id, tenure_id, builder_company_id, fiscal_year, covered_from, covered_through, days, days_in_year, annual_assessment_cents, builder_rate_pct, base_amount_cents, amount_cents, source_type, accrual_run_id, created_by)
    VALUES ($1, $2, $3, $4, 2026, '2026-10-01', '2026-10-31', 31, 365, 49500, 50, 2102, 2102, 'scheduled_accrual', gen_random_uuid(), 'test')`, [SCR, LP.property, LP.seller, LENNAR]) || ''));

// --- leap year, and a rate that changes mid-year
const LL = await lot();
await db.query(`INSERT INTO builder_assessment_coverage (community_id, property_id, tenure_id, builder_company_id, fiscal_year, covered_from, covered_through, days, days_in_year, annual_assessment_cents, builder_rate_pct, base_amount_cents, amount_cents, source_type, accrual_run_id, created_by)
  VALUES ($1, $2, $3, $4, 2028, '2028-01-01', '2028-06-30', 182, 366, 49500, 50, 12307, 12307, 'scheduled_accrual', gen_random_uuid(), 'test')`, [SCR, LL.property, LL.seller, LENNAR]);
check('leap year 2028: Jan 1-Jun 30 is 182 of 366 days = $123.07; 365 is refused', /builder_assessment_coverage_period_check/.test(await err(`INSERT INTO builder_assessment_coverage (community_id, property_id, tenure_id, builder_company_id, fiscal_year, covered_from, covered_through, days, days_in_year, annual_assessment_cents, builder_rate_pct, base_amount_cents, amount_cents, source_type, accrual_run_id, created_by)
  VALUES ($1, $2, $3, $4, 2028, '2028-07-01', '2028-07-31', 31, 365, 49500, 50, 2102, 2102, 'scheduled_accrual', gen_random_uuid(), 'test')`, [SCR, LL.property, LL.seller, LENNAR]) || ''));
const LR = await lot();
await convCover(LR);
for (const [f, t] of [['07-01', '07-31'], ['08-01', '08-31'], ['09-01', '09-30'], ['10-01', '10-31'], ['11-01', '11-30']]) await cover(LR, { from: `2026-${f}`, through: `2026-${t}` });
await cover(LR, { from: '2026-12-01', through: '2026-12-31', annual: 60000 });
check('a rate changed mid-year: the December period carries NO true-up (annual x rate is not one number for that year)',
  (await one(`SELECT rounding_true_up_cents AS tu, amount_cents FROM builder_assessment_coverage WHERE tenure_id = $1 AND covered_from = '2026-12-01'`, [LR.seller])).tu == 0);

// ---------------------------------------------------------------- mid-year (the issue's example)
// Posting mechanics on a community converted in an EARLIER year: no conversion-year coverage is
// required, so the transfer bills every uncovered builder day (Jan 1 - Jun 30) itself.
await db.query("UPDATE conversion_batches SET as_of_date = '2025-12-31' WHERE id = $1", [CONV]);
const L1 = await lot();
const pv = await preview(L1, '2026-07-01');
check('mid-year 7/1/2026 preview: Lennar 181 days at 50% = $122.73; homeowner 184 days = $249.53; total $372.26',
  JSON.stringify(pick(pv, ['applies', 'blocked', 'builder', 'builder_days', 'homeowner_days', 'days_in_year', 'builder_due_cents', 'homeowner_due_cents', 'total_recognized_cents', 'builder_adjustment_cents', 'builder_period_start', 'builder_period_end', 'homeowner_period_start']))
  === JSON.stringify({ applies: true, blocked: false, builder: 'Lennar', builder_days: 181, homeowner_days: 184, days_in_year: 365, builder_due_cents: 12273, homeowner_due_cents: 24953, total_recognized_cents: 37226, builder_adjustment_cents: 12273, builder_period_start: '2026-01-01', builder_period_end: '2026-06-30', homeowner_period_start: '2026-07-01' }),
  JSON.stringify(pv));
const T1 = await approve(L1, '2026-07-01');
const dry = await post(T1, true);
const batchesBeforeDry = await tpBatches();
check('dry run writes nothing', dry.dry_run === true && (await one(`SELECT count(*)::int AS n FROM assessment_prorations WHERE proposal_id = $1`, [T1.proposal])).n === 0 && await tpBatches() === batchesBeforeDry);
const w1 = await post(T1);
const rows1 = await q(`SELECT h.tenure_id, h.amount_cents, h.txn_type, h.charge_category, h.transaction_date::text AS d, h.description, b.status FROM homeowner_transactions h JOIN transaction_upload_batches b ON b.id = h.source_batch_id WHERE h.raw_row_jsonb->>'proposal_id' = $1 ORDER BY h.source_row_index`, [T1.proposal]);
check('post: builder charge on the SELLER tenure, homeowner charge on the BUYER tenure, dated the settlement, in a DRAFT batch',
  rows1.length === 2 && rows1[0].tenure_id === T1.seller && rows1[0].amount_cents === 12273 && rows1[0].txn_type === 'charge'
    && rows1[1].tenure_id === T1.buyer && rows1[1].amount_cents === 24953 && rows1.every((x) => x.charge_category === 'assessment' && x.d === '2026-07-01' && x.status === 'draft'),
  JSON.stringify(rows1));
check('ledger text names the rule (no em-dashes)', /181\/365 days at 50% of \$495\.00 \(Jan 01 to Jun 30\)/.test(rows1[0].description) && /184\/365 days of \$495\.00 \(Jul 01 to Dec 31\)/.test(rows1[1].description) && !/—/.test(rows1.map((x) => x.description).join('')), rows1.map((x) => x.description).join(' | '));
const ap1 = await q(`SELECT role, status, prorated_amount_cents, net_responsibility_cents, prior_billed_cents, tenure_id, period_start::text AS ps, period_end::text AS pe, rate_pct::text AS pct FROM assessment_prorations WHERE proposal_id = $1 ORDER BY role`, [T1.proposal]);
check('audit: one row per role, tied to the transfer, tenure, period and rate',
  JSON.stringify(ap1) === JSON.stringify([
    { role: 'builder_adjustment', status: 'draft', prorated_amount_cents: 12273, net_responsibility_cents: 12273, prior_billed_cents: 0, tenure_id: T1.seller, ps: '2026-01-01', pe: '2026-06-30', pct: '50.00' },
    { role: 'homeowner_charge', status: 'draft', prorated_amount_cents: 24953, net_responsibility_cents: 24953, prior_billed_cents: 0, tenure_id: T1.buyer, ps: '2026-07-01', pe: '2026-12-31', pct: '100.00' }]), JSON.stringify(ap1));
const again = await post(T1);
check('re-run: returns the existing proration, writes nothing new', again.already_prorated === true && again.all_posted === false
  && (await one(`SELECT count(*)::int AS n FROM homeowner_transactions WHERE raw_row_jsonb->>'proposal_id' = $1`, [T1.proposal])).n === 2);
check('a second ledger row for the same transfer + role is impossible (unique)',
  /uq_homeowner_txn_transfer_proration/.test(await err(`INSERT INTO homeowner_transactions (source_batch_id, source_row_index, community_id, transaction_date, description, amount_cents, raw_row_jsonb)
    SELECT source_batch_id, 9, community_id, transaction_date, description, amount_cents, raw_row_jsonb FROM homeowner_transactions WHERE raw_row_jsonb->>'proposal_id' = $1 AND raw_row_jsonb->>'role' = 'homeowner_charge'`, [T1.proposal]) || ''));
// Finish as the JS does (GL is posted by postJournalEntry; here just commit + mark).
await db.query(`UPDATE transaction_upload_batches SET status = 'committed' WHERE id = $1`, [w1.batch_id]);
await db.query(`UPDATE assessment_prorations SET status = 'posted' WHERE proposal_id = $1`, [T1.proposal]);
check('after commit the re-run says all posted', (await post(T1)).all_posted === true);
const cur = await q(`SELECT amount_cents FROM v_current_owner_ledger WHERE property_id = $1`, [T1.property]);
check('the transfer billed Lennar\u2019s uncovered days, so they become a transfer_true_up coverage period (Jan 1 - Jun 30, $122.73)',
  JSON.stringify(await one(`SELECT source_type, covered_from::text AS f, covered_through::text AS t, amount_cents FROM builder_assessment_coverage WHERE proposal_id = $1`, [T1.proposal]))
    === JSON.stringify({ source_type: 'transfer_true_up', f: '2026-01-01', t: '2026-06-30', amount_cents: 12273 }));
check('current-owner ledger shows ONLY the homeowner charge (the builder adjustment stays with the seller)', cur.length === 1 && Number(cur[0].amount_cents) === 24953, JSON.stringify(cur));

// ---------------------------------------------------------------- edge dates
// Jan 1 needs converted books whose baseline is before Jan 1 (Still Creek's test conversion is 6/30/2026).
await db.query("UPDATE conversion_batches SET as_of_date = '2025-12-31' WHERE community_id = $1 AND status = 'posted'", [SCR]);
const pJan = await preview(await lot(), '2026-01-01');
check('Jan 1 transfer: Lennar $0 (0 days), homeowner the full $495.00', pJan.builder_days === 0 && pJan.builder_due_cents === 0 && pJan.homeowner_days === 365 && pJan.homeowner_due_cents === 49500 && !pJan.blocked, JSON.stringify(pJan));
const TJan = await approve(await lot(), '2026-01-01');
await post(TJan);
await db.query("UPDATE conversion_batches SET as_of_date = '2026-06-30' WHERE community_id = $1 AND status = 'posted'", [SCR]);
const jr = await q(`SELECT role, status, prorated_amount_cents, homeowner_txn_id IS NULL AS no_txn FROM assessment_prorations WHERE proposal_id = $1 ORDER BY role`, [TJan.proposal]);
check('Jan 1 post: no builder ledger row (zero), the audit row still records it; homeowner charged $495.00',
  JSON.stringify(jr) === JSON.stringify([{ role: 'builder_adjustment', status: 'posted', prorated_amount_cents: 0, no_txn: true }, { role: 'homeowner_charge', status: 'draft', prorated_amount_cents: 49500, no_txn: false }]), JSON.stringify(jr));
const pDec = await preview(await lot(), '2026-12-31');
check('Dec 31 transfer: Lennar 364/365 at 50% = $246.82; homeowner 1 day = $1.36', pDec.builder_days === 364 && pDec.builder_due_cents === 24682 && pDec.homeowner_days === 1 && pDec.homeowner_due_cents === 136, JSON.stringify(pick(pDec, ['builder_days', 'builder_due_cents', 'homeowner_days', 'homeowner_due_cents'])));
const pLeap = await preview(await lot(), '2028-07-01');
check('leap year 7/1/2028: 366 days; Lennar 182 days = $123.07; homeowner 184 days = $248.85',
  pLeap.days_in_year === 366 && pLeap.builder_days === 182 && pLeap.builder_due_cents === 12307 && pLeap.homeowner_days === 184 && pLeap.homeowner_due_cents === 24885, JSON.stringify(pick(pLeap, ['days_in_year', 'builder_days', 'builder_due_cents', 'homeowner_days', 'homeowner_due_cents'])));

// ---------------------------------------------------------------- configuration flows through
await db.query(`UPDATE community_assessment_rates SET annual_amount_cents = 60000 WHERE community_id = $1 AND owner_class = 'homeowner'`, [SCR]);
const pRate = await preview(await lot(), '2026-07-01');
check('annual rate changed to $600.00: builder follows at 50% ($148.77) and homeowner $302.47, no code change',
  pRate.annual_assessment_cents === 60000 && pRate.builder_due_cents === 14877 && pRate.homeowner_due_cents === 30247, JSON.stringify(pick(pRate, ['annual_assessment_cents', 'builder_due_cents', 'homeowner_due_cents'])));
await db.query(`UPDATE community_assessment_rates SET annual_amount_cents = 49500 WHERE community_id = $1 AND owner_class = 'homeowner'`, [SCR]);

// ---------------------------------------------------------------- not ours: untouched
const pHO = await preview(await lot({ sellers: ['Jane Smith'] }), '2026-07-01');
check('homeowner-to-homeowner transfer: not applicable (existing logic)', pHO.applies === false && pHO.reason === 'seller_not_builder', JSON.stringify(pHO));
const THO = await approve(await lot({ sellers: ['Jane Smith'] }), '2026-07-01');
const rHO = await post(THO);
check('...and posting it writes nothing', rHO.applies === false && (await one(`SELECT count(*)::int AS n FROM assessment_prorations WHERE proposal_id = $1`, [THO.proposal])).n === 0);
const pOther = await preview(await lot({ community: OTHER }), '2026-07-01');
check('another community (Lennar seller, no rule there): not applicable', pOther.applies === false && pOther.reason === 'community_not_configured', JSON.stringify(pOther));
const pBB = await preview(await lot(), '2026-07-01', 'Lennar Homes of Texas Land and Construction LTD');
check('builder-to-builder (buyer is a builder): not applicable', pBB.applies === false && pBB.reason === 'buyer_is_builder', JSON.stringify(pBB));
const pAttn = await preview(await lot({ sellers: ['Attn: Lennar Homes of Texas Land and Construction LTD'] }), '2026-07-01');
check('Lennar’s second contact form ("Attn: Lennar Homes of Texas ... LTD") is recognized', pAttn.applies === true && pAttn.builder === 'Lennar', JSON.stringify(pick(pAttn, ['applies', 'reason', 'builder'])));

// ---------------------------------------------------------------- builder already has activity
// The netting MECHANICS, on a community that recognizes assessments directly
// (no deferral account): Still Creek's rate row with its deferral cleared for
// this block, restored after.
// These previews are the NOT-CONVERTED staging preview (after a conversion only the coverage record counts).
await db.query(`UPDATE conversion_batches SET status = 'approved' WHERE id = $1`, [CONV]);
await db.query(`UPDATE community_assessment_rates SET deferral_account_number = NULL WHERE community_id = $1 AND owner_class = 'homeowner'`, [SCR]);
const pFull = await preview(await lot({ prior: [{ date: '2026-01-01', cents: 49500 }] }), '2026-07-01');
check('Lennar billed the full $495.00 on Jan 1: adjustment credits $372.27 so its net is its $122.73 share',
  !pFull.blocked && pFull.builder_prior_billed_cents === 49500 && pFull.builder_adjustment_cents === -37227 && pFull.builder_due_cents === 12273, JSON.stringify(pick(pFull, ['blocked', 'blocked_reasons', 'builder_prior_billed_cents', 'builder_adjustment_cents'])));
const pB = await preview(await lot({ prior: [{ date: '2026-01-01', cents: 24750 }] }), '2026-07-01');
check('Lennar billed the full builder rate $247.50 on Jan 1: adjustment -$124.77 (net $122.73)', !pB.blocked && pB.builder_adjustment_cents === -12477, JSON.stringify(pick(pB, ['blocked', 'builder_adjustment_cents'])));
const pUnstamped = await preview(await lot({ prior: [{ date: '2026-01-01', cents: 49500, stamped: false }] }), '2026-07-01');
check('before approval the builder’s unstamped Vantaca rows count too (read through the real ledger view)', pUnstamped.builder_prior_billed_cents === 49500 && pUnstamped.builder_adjustment_cents === -37227, JSON.stringify(pick(pUnstamped, ['builder_prior_billed_cents', 'builder_adjustment_cents'])));

// ---------------------------------------------------------------- stop, never guess
const amb = { prior: [{ date: '2026-05-13', cents: 9018 }] };   // 5450 Still Meadow Lane, live
const pAmb = await preview(await lot(amb), '2026-07-01');
check('ambiguous activity (a $90.18 assessment on 5/13): BLOCKED, the row is surfaced', pAmb.blocked === true && pAmb.blocked_reasons.includes('ambiguous_builder_assessment')
  && pAmb.builder_prior_rows.length === 1 && pAmb.builder_prior_rows[0].amount_cents === 9018, JSON.stringify(pick(pAmb, ['blocked', 'blocked_reasons', 'builder_prior_rows'])));
const TAmb = await approve(await lot(amb), '2026-07-01');
const rAmb = await post(TAmb);
check('...and posting writes nothing financial (the calculation is recorded for the queue)', rAmb.blocked === true
  && (await one(`SELECT count(*)::int AS n FROM assessment_prorations WHERE proposal_id = $1 AND status = 'staged'`, [TAmb.proposal])).n === 2
  && (await one(`SELECT count(*)::int AS n FROM homeowner_transactions WHERE raw_row_jsonb->>'proposal_id' = $1`, [TAmb.proposal])).n === 0);
const pTwo = await preview(await lot({ prior: [{ date: '2026-01-01', cents: 49500 }, { date: '2026-03-01', cents: -10000, type: 'credit', desc: 'Assessment credit' }] }), '2026-07-01');
check('two assessment rows (charge + credit): BLOCKED', pTwo.blocked && pTwo.blocked_reasons.includes('ambiguous_builder_assessment'));
const pMix = await preview(await lot({ sellers: ['Lennar Homes LLC', 'John Doe'] }), '2026-07-01');
check('mixed owners on the seller account (Lennar + a person): BLOCKED', pMix.blocked && pMix.blocked_reasons.includes('seller_mixed_owners'));
const pSpec = await preview(await lot({ prior: [{ date: '2026-01-01', cents: 49500, desc: 'Special Assessment' }] }), '2026-07-01');
check('a $495.00 SPECIAL assessment on Jan 1 is not the annual assessment: BLOCKED, not netted', pSpec.blocked && pSpec.blocked_reasons.includes('ambiguous_builder_assessment'), JSON.stringify(pick(pSpec, ['blocked', 'blocked_reasons'])));
// 5302 Sleepy Fox Lane, live: prior balance + annual assessment + late interest/fees on Lennar's account.
const sleepy = [
  { date: '2026-01-01', cents: 57128, desc: 'Prior Balance', type: 'balance_brought_forward' },
  { date: '2026-01-01', cents: 49500, desc: 'Annual Assessment' },
  { date: '2026-01-01', cents: 413, desc: 'Late Interest' }, { date: '2026-02-01', cents: 825, desc: 'Late Interest' }, { date: '2026-02-01', cents: 1000, desc: 'Late Fees' },
  { date: '2026-03-01', cents: 825, desc: 'Late Interest' }, { date: '2026-04-01', cents: 825, desc: 'Late Interest' }, { date: '2026-05-01', cents: 825, desc: 'Late Interest' }, { date: '2026-06-01', cents: 825, desc: 'Late Interest' }];
const TS = await approve(await lot({ prior: sleepy }), '2026-07-01');
const pS = await rpc('transfer_proration_plan', { p_property_id: TS.property, p_seller_tenure_id: TS.seller, p_settlement_date: '2026-07-01', p_buyer_name: 'Pat Homeowner', p_buyer_tenure_id: TS.buyer });
check('5302 Sleepy Fox shape (staging preview): only the $495.00 annual assessment counts (adjustment -$372.27); prior balance, late interest and late fees are not assessment activity',
  !pS.blocked && pS.builder_prior_rows.length === 1 && pS.builder_prior_rows[0].description === 'Annual Assessment' && pS.builder_adjustment_cents === -37227,
  JSON.stringify({ blocked: pS.blocked_reasons, prior: pS.builder_prior_rows, adj: pS.builder_adjustment_cents }));
const pLate = await preview(await lot({ prior: [{ date: '2026-02-01', cents: 825, desc: 'Late Interest' }] }), '2026-07-01');
check('late interest is not assessment activity (not counted, not blocking)', !pLate.blocked && pLate.builder_prior_billed_cents === 0);
await db.query(`UPDATE community_assessment_rates SET deferral_account_number = '2205' WHERE community_id = $1 AND owner_class = 'homeowner'`, [SCR]);
await db.query(`UPDATE conversion_batches SET status = 'posted' WHERE id = $1`, [CONV]);
const pCut = await preview(await lot(), '2026-06-15');
check('settlement on/before the conversion baseline (6/15 vs 6/30): BLOCKED (Vantaca-era activity)', pCut.blocked && pCut.blocked_reasons.includes('settlement_before_conversion_baseline'), JSON.stringify(pCut.blocked_reasons));

// ---------------------------------------------------------------- engine convention + guards
const LT = await lot({ origin: 'transfer', start: '2026-03-01' });
const pT = await preview(LT, '2026-07-01');
check('a builder that took the lot by a RECORDED transfer this year owns from that date (122 days = $82.73)', pT.builder_period_start === '2026-03-01' && pT.builder_days === 122 && pT.builder_due_cents === 8273, JSON.stringify(pick(pT, ['builder_period_start', 'builder_days', 'builder_due_cents'])));
const pend = await one(`INSERT INTO ownership_change_proposals (property_id, community_id, status, effective_start_date, proposed_owner_name) VALUES ($1, $2, 'pending', '2026-07-01', 'X') RETURNING id`, [L1.property, SCR]);
check('a future settlement is refused at post time', /is in the future/.test(await err(`SELECT post_transfer_assessment_proration($1, 'tester', false)`, [(await approve(await lot(), '2099-07-01')).proposal]) || ''));
check('a pending transfer is refused', /not an approved transfer/.test(await err(`SELECT post_transfer_assessment_proration($1, 'tester', false)`, [pend.id]) || ''));
check('the audit row is refused without its tenure/period/status when tied to a transfer',
  /assessment_prorations_transfer_complete/.test(await err(`INSERT INTO assessment_prorations (community_id, property_id, transfer_type, effective_date, fiscal_year_end, days_prorated, days_in_year, proposal_id, role) VALUES ($1, $2, 'builder_to_homeowner', '2026-07-01', '2026-12-31', 1, 365, $3, 'homeowner_charge')`, [SCR, L1.property, pend.id]) || ''));
check('a builder rate must be an amount OR a percent, not both', /community_assessment_rates_amount_or_pct/.test(await err(`UPDATE community_assessment_rates SET annual_amount_cents = 100 WHERE community_id = $1 AND owner_class = 'builder'`, [SCR]) || ''));
const priv = await one(`SELECT has_function_privilege('anon', 'post_transfer_assessment_proration(uuid,text,boolean)', 'EXECUTE') AS anon,
  has_function_privilege('authenticated', 'transfer_proration_plan(uuid,uuid,date,text,uuid)', 'EXECUTE') AS auth,
  has_function_privilege('service_role', 'post_transfer_assessment_proration(uuid,text,boolean)', 'EXECUTE') AS svc`);
check('grants: service_role only', !priv.anon && !priv.auth && priv.svc, JSON.stringify(priv));
const reapply = await A.planMigration({ ...ctx, filename: F });
check('re-apply: the plan refuses once 500 is in place', reapply.status !== 'ready');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
