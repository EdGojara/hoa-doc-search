// ============================================================================
// tests/test_1099_reporting_rule.js  (Issue #14, Ed 2026-10-02)
// ----------------------------------------------------------------------------
// Ed's 2026 W-9 rule, replacing the blanket "no W-9, no approval or payment"
// gate (which would have frozen 65 of 77 open bills):
//   - recognizing a bill (vendor creation, accrual, approval) never blocks;
//   - cumulative REPORTABLE payments per vendor, per association, per calendar
//     year; the year-aware threshold ($600 through 2025, $2,000 in 2026);
//   - only the payment Trusted DISBURSES (check run) that crosses it, to a
//     potentially reportable vendor without a W-9 + classification, is blocked;
//   - recording a payment that already happened is never blocked (warns);
//   - exemptions only from stored data with provenance; corporate exemption
//     does not cover attorney / medical payments; names are clues only;
//   - card / network payments (1099-K) are not counted.
// In-memory fakes only.
// ============================================================================
require('dotenv').config({ quiet: true });
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const R = require('../lib/tax/info_reporting');
const tests = []; const check = (n, fn) => tests.push([n, fn]);
const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const UNKNOWN = { id: 'v1', name: 'DJ (individual)', kind: 'vendor', w9_on_file: false, tax_classification: null, tax_reporting_status: 'unknown' };
const W9 = { ...UNKNOWN, id: 'v2', name: 'Lawn Pros', w9_on_file: true, tax_classification: 'individual_sole_proprietor' };
const CORP_EXEMPT = { id: 'v3', name: 'Big Pool Corp', kind: 'vendor', w9_on_file: true, tax_classification: 'c_corporation', tax_reporting_status: 'exempt_verified', tax_exemption_basis: 'corporation', tax_exemption_source: 'w9_document', tax_exemption_verified_by: 'reviewer', tax_exemption_verified_at: '2026-10-02' };
const GOV_EXEMPT = { ...CORP_EXEMPT, id: 'v4', name: 'Fort Bend County MUD 143', tax_exemption_basis: 'government', tax_exemption_source: 'government_entity_record' };
const EV = (o) => R.evaluatePayment({ vendor: UNKNOWN, year: 2026, priorReportableCents: 0, paymentCents: 30000, method: 'check', initiation: 'disburse', ...o });

// ---------------------------------------------------------------- thresholds
check('threshold is YEAR-aware: $600 through 2025, $2,000 for 2026', () => {
  assert.strictEqual(R.thresholdFor(2024).cents, 60000); assert.strictEqual(R.thresholdFor(2025).cents, 60000);
  assert.strictEqual(R.thresholdFor(2026).cents, 200000); assert.strictEqual(R.thresholdFor(2026).provisional, false);
});
check('a later (indexed) year is not guessed: NO threshold (null), flagged provisional', () => {
  const t = R.thresholdFor(2027); assert.strictEqual(t.provisional, true); assert.strictEqual(t.cents, null); assert.ok(/2027 1099 threshold for .* is not configured/.test(t.basis));
});
check('unconfigured year: a disbursement that NEEDS the threshold is a CONFIGURATION exception, never a block on last year\'s number', () => {
  const e = EV({ year: 2027, priorReportableCents: 0, paymentCents: 100 });
  assert.strictEqual(e.decision, 'config_exception'); assert.ok(/not configured/.test(e.reason));
  // ...even a tiny payment: the point is no guessed threshold controls a hard stop
});
check('unconfigured year: no threshold needed -> no exception (W-9 on file, exempt, card)', () => {
  assert.strictEqual(EV({ year: 2027, vendor: W9 }).decision, 'allow');
  assert.strictEqual(EV({ year: 2027, vendor: CORP_EXEMPT }).decision, 'allow');
  assert.strictEqual(EV({ year: 2027, method: 'credit_card' }).decision, 'allow');
});
check('unconfigured year: recording and approval only warn', () => {
  assert.strictEqual(EV({ year: 2027, initiation: 'record' }).decision, 'warn');
  assert.strictEqual(EV({ year: 2027, initiation: 'approve' }).decision, 'warn');
});
check('W-9 line 3 SUGGESTS a corporate exemption (never applies it); other classes suggest nothing', () => {
  const s = R.suggestExemptionFromW9('c_corporation'); assert.deepStrictEqual([s.basis, s.source], ['corporation', 'w9_document']); assert.ok(/attorney fees, gross proceeds paid to an attorney, or medical/.test(s.note));
  assert.ok(R.suggestExemptionFromW9('llc_s')); assert.strictEqual(R.suggestExemptionFromW9('individual_sole_proprietor'), null); assert.strictEqual(R.suggestExemptionFromW9('llc_p'), null);
  // a suggestion is not an exemption until confirmed
  assert.ok(R.vendorReportability({ ...UNKNOWN, tax_classification: 'c_corporation', w9_on_file: true }).reportable);
});
check('year boundary: the same $700 crosses in 2025 but not in 2026', () => {
  assert.strictEqual(EV({ year: 2025, priorReportableCents: 50000, paymentCents: 20000 }).decision, 'block');
  assert.strictEqual(EV({ year: 2026, priorReportableCents: 50000, paymentCents: 20000 }).decision, 'allow');
});

// ---------------------------------------------------------------- the decision
check('disburse: under the threshold -> allow (counts toward the total)', () => {
  const e = EV({ priorReportableCents: 100000, paymentCents: 90000 }); assert.strictEqual(e.decision, 'allow'); assert.ok(e.counts); assert.strictEqual(e.cumulative_after_cents, 190000);
});
check('disburse: the payment that reaches $2,000 exactly -> BLOCK (at or above)', () => {
  const e = EV({ priorReportableCents: 170000, paymentCents: 30000 }); assert.strictEqual(e.decision, 'block'); assert.ok(/W-9/.test(e.reason) && /\$2,000/.test(e.reason));
});
check('record (already happened, e.g. an autopay draft): crossing -> WARN, never block', () => {
  const e = EV({ initiation: 'record', priorReportableCents: 190000, paymentCents: 30000 }); assert.strictEqual(e.decision, 'warn'); assert.ok(/recorded/.test(e.reason));
});
check('approve: crossing -> WARN, never block (recognition is not gated)', () => {
  assert.strictEqual(EV({ initiation: 'approve', priorReportableCents: 190000, paymentCents: 30000 }).decision, 'warn');
});
check('W-9 WITH a tax classification on file -> allow past the threshold', () => {
  assert.strictEqual(EV({ vendor: W9, priorReportableCents: 500000 }).decision, 'allow');
});
check('W-9 flag WITHOUT a classification does not satisfy the rule', () => {
  assert.strictEqual(EV({ vendor: { ...UNKNOWN, w9_on_file: true }, priorReportableCents: 190000 }).decision, 'block');
});
check('card / network payments: reported on 1099-K, not counted, never blocked', () => {
  const e = EV({ method: 'credit_card', priorReportableCents: 500000 }); assert.strictEqual(e.decision, 'allow'); assert.strictEqual(e.counts, false);
  assert.strictEqual(R.reportingChannel('credit_card'), 'form_1099k_network');
  for (const m of ['check', 'ach', 'wire', 'cash', 'other']) assert.strictEqual(R.reportingChannel(m), 'form_1099_nec_misc', m);
});

// ---------------------------------------------------------------- exemptions
check('verified-exempt corporation (stored, with provenance) -> not reportable, not counted', () => {
  const e = EV({ vendor: CORP_EXEMPT, priorReportableCents: 900000 }); assert.strictEqual(e.decision, 'allow'); assert.strictEqual(e.counts, false);
  assert.ok(/verified exempt: corporation \(w9_document, reviewer\)/.test(e.reason));
});
check('corporation that is an ATTORNEY stays reportable (exception preserved)', () => {
  const v = { ...CORP_EXEMPT, is_legal_counsel: true, w9_on_file: false, tax_classification: null };
  const rep = R.vendorReportability(v); assert.ok(rep.reportable && rep.exceptionApplied && /attorney/.test(rep.basis));
  assert.strictEqual(EV({ vendor: v, priorReportableCents: 190000 }).decision, 'block');
});
check('corporation that is a MEDICAL/health-care provider stays reportable', () => {
  assert.ok(R.vendorReportability({ ...CORP_EXEMPT, is_medical_provider: true }).reportable);
});
check('government exemption is not undone by the medical flag (only the corporate exemption has that exception)', () => {
  assert.strictEqual(R.vendorReportability({ ...GOV_EXEMPT, is_medical_provider: true }).reportable, false);
});
check('a vendor marked "exempt" without the stored status is NOT exempt (no guessing at payment time)', () => {
  assert.ok(R.vendorReportability({ ...UNKNOWN, tax_exemption_basis: 'corporation' }).reportable);
  assert.ok(R.vendorReportability({ ...UNKNOWN, tax_classification: 'c_corporation' }).reportable, 'a classification alone is not a verified exemption');
});
check('names are CLUES only: "Inc"/"Corp" suggests review; "LLC" says nothing; neither exempts', () => {
  const inc = { ...UNKNOWN, name: 'Acme Pools, Inc.' };
  assert.ok(/clue only/.test(R.nameClue(inc.name))); assert.ok(R.vendorReportability(inc).reportable);
  assert.strictEqual(EV({ vendor: inc, priorReportableCents: 190000 }).decision, 'block');
  assert.ok(/does not show corporate tax treatment/.test(R.nameClue('Renovations Near Me LLC')));
  assert.strictEqual(R.nameClue('John Smith'), null);
});
check('expense-reimbursement payees (vendors.kind = reimbursement) are not reportable', () => {
  assert.strictEqual(R.vendorReportability({ ...UNKNOWN, kind: 'reimbursement' }).reportable, false);
});

// ---------------------------------------------------------------- data access
function db(tables, { failOn, missingCols } = {}) {
  return { from(t) {
    const f = []; let sel = '';
    const q = {
      select(s) { sel = s || ''; return q; }, eq(c, v) { f.push((r) => r[c] === v); return q; }, in(c, vs) { f.push((r) => vs.includes(r[c])); return q; },
      gte(c, v) { f.push((r) => String(r[c]) >= v); return q; }, lte(c, v) { f.push((r) => String(r[c]) <= v); return q; },
      order() { return q; }, range() { return q; },
      then(res, rej) {
        if (failOn === t) return Promise.resolve({ data: null, error: { message: 'boom' } }).then(res, rej);
        if (missingCols && t === 'vendors' && /tax_reporting_status/.test(sel)) return Promise.resolve({ data: null, error: { message: 'column vendors.tax_reporting_status does not exist' } }).then(res, rej);
        return Promise.resolve({ data: (tables[t] || []).filter((r) => f.every((p) => p(r))), error: null }).then(res, rej);
      },
    };
    return q;
  } };
}
const PAYS = [
  { id: 'p1', vendor_id: 'v1', community_id: 'c1', amount_cents: 100000, payment_method: 'check', status: 'completed', payment_date: '2026-03-01' },
  { id: 'p2', vendor_id: 'v1', community_id: 'c1', amount_cents: 50000, payment_method: 'credit_card', status: 'completed', payment_date: '2026-04-01' },
  { id: 'p3', vendor_id: 'v1', community_id: 'c1', amount_cents: 70000, payment_method: 'ach', status: 'voided', payment_date: '2026-05-01' },
  { id: 'p4', vendor_id: 'v1', community_id: 'c1', amount_cents: 30000, payment_method: 'ach', status: 'pending', payment_date: '2026-06-01' },
  { id: 'p5', vendor_id: 'v1', community_id: 'c2', amount_cents: 999900, payment_method: 'check', status: 'completed', payment_date: '2026-06-01' },
  { id: 'p6', vendor_id: 'v1', community_id: 'c1', amount_cents: 888800, payment_method: 'check', status: 'completed', payment_date: '2025-12-31' },
];
check('cumulative: per vendor + association + year; excludes card, voided and other years; includes pending', async () => {
  const { reportableTotals } = require('../lib/tax/reportable_payments');
  const t = await reportableTotals(db({ ap_payments: PAYS, vendors: [UNKNOWN] }), { vendorIds: ['v1'], year: 2026 });
  assert.strictEqual(t.get('v1|c1|services'), 130000, 'check 1000 + pending ach 300; card, voided and 2025 excluded');
  assert.strictEqual(t.get('v1|c2|services'), 999900, 'each association is its own filer');
});
check('vendor read works BEFORE migration 477 (falls back to existing columns; nothing is exempt)', async () => {
  const { loadVendorsForTax } = require('../lib/tax/reportable_payments');
  const m = await loadVendorsForTax(db({ vendors: [UNKNOWN] }, { missingCols: true }), ['v1']);
  assert.ok(m.get('v1') && R.vendorReportability(m.get('v1')).reportable);
});
check('check run: crossing vendor is refused with a plain reason; under-threshold vendor passes', async () => {
  const assertCheckRunAllowed = (d, o) => require('../lib/tax/payment_gate').assertCheckRunAllowed(d, o, { env: { TAX_W9_GATE: 'enforce' } }); // these cases test ENFORCE
  const d = db({ ap_payments: PAYS, vendors: [UNKNOWN, W9] });
  await assert.rejects(assertCheckRunAllowed(d, { community_id: 'c1', vendorBills: new Map([['v1', [{ invoice_id: 'i-x', cents: 70000 }]]]), payment_date: '2026-10-02' }),
    (e) => e.code === 'w9_required_for_payment' && /\$2,000\.00/.test(e.detail) && e.vendors[0].vendor_id === 'v1');
  await assertCheckRunAllowed(d, { community_id: 'c1', vendorBills: new Map([['v1', [{ invoice_id: 'i-x', cents: 60000 }]]]), payment_date: '2026-10-02' });
  await assertCheckRunAllowed(d, { community_id: 'c1', vendorBills: new Map([['v2', [{ invoice_id: 'i-y', cents: 900000 }]]]), payment_date: '2026-10-02' });
});
check('check run fails CLOSED: a read error refuses the run (no check cut on an unknown)', async () => {
  const assertCheckRunAllowed = (d, o) => require('../lib/tax/payment_gate').assertCheckRunAllowed(d, o, { env: { TAX_W9_GATE: 'enforce' } }); // these cases test ENFORCE
  await assert.rejects(assertCheckRunAllowed(db({}, { failOn: 'ap_payments' }), { community_id: 'c1', vendorBills: new Map([['v1', [{ invoice_id: 'i-x', cents: 100 }]]]), payment_date: '2026-10-02' }), (e) => e.code === 'tax_check_failed');
});
check('recording fails OPEN: a read error never stops recording real bank activity', async () => {
  const { evaluateRecordedPayment } = require('../lib/tax/payment_gate');
  const e = await evaluateRecordedPayment(db({}, { failOn: 'ap_payments' }), { community_id: 'c1', vendor_id: 'v1', amount_cents: 100, payment_date: '2026-10-02', payment_method: 'ach' });
  assert.strictEqual(e.decision, 'unknown');
  const w = await evaluateRecordedPayment(db({ ap_payments: PAYS, vendors: [UNKNOWN] }), { community_id: 'c1', vendor_id: 'v1', amount_cents: 90000, payment_date: '2026-10-02', payment_method: 'ach' });
  assert.strictEqual(w.decision, 'warn');
});
check('list projection: a bill that could not be paid today is flagged; projection never throws', async () => {
  const { projectBills } = require('../lib/tax/payment_gate');
  const m = await projectBills(db({ ap_payments: PAYS, vendors: [UNKNOWN] }), [{ id: 'b1', vendor_id: 'v1', community_id: 'c1', balance_cents: 70000 }], { initiation: 'disburse', payment_date: '2026-10-02' });
  assert.strictEqual(m.get('b1').decision, 'block');
  const empty = await projectBills(db({}, { failOn: 'vendors' }), [{ id: 'b1', vendor_id: 'v1', community_id: 'c1', balance_cents: 1 }]);
  assert.strictEqual(empty.size, 0);
});

// ---------------------------------------------------------------- reporting categories (attorney fees vs gross proceeds)
const ATTY = { ...UNKNOWN, id: 'va', name: 'Daughtry & Farine, P.C.', is_legal_counsel: true };
const ATTY_CORP = { ...CORP_EXEMPT, id: 'vac', name: 'Big Law Corp', is_legal_counsel: true };
check('exact threshold, services 2026: $1,999.99 allows; $2,000.00 blocks (>=)', () => {
  assert.strictEqual(EV({ priorReportableCents: 0, paymentCents: 199999 }).decision, 'allow');
  assert.strictEqual(EV({ priorReportableCents: 0, paymentCents: 200000 }).decision, 'block');
  assert.strictEqual(EV({ priorReportableCents: 199999, paymentCents: 1 }).decision, 'block');
});
check('attorney FEES for services 2026 follow the $2,000 NEC threshold (1099-NEC box 1)', () => {
  const a = EV({ vendor: ATTY, category: 'attorney_fees', paymentCents: 199999 }); assert.strictEqual(a.decision, 'allow'); assert.deepStrictEqual([a.form, a.box], ['1099-NEC', '1']);
  assert.strictEqual(EV({ vendor: ATTY, category: 'attorney_fees', paymentCents: 200000 }).decision, 'block');
});
check('GROSS PROCEEDS paid to an attorney (6045(f)) keep the $600 MISC threshold in 2026: $599.99 allows; $600.00 blocks', () => {
  const a = EV({ vendor: ATTY, category: 'attorney_gross_proceeds', paymentCents: 59999 }); assert.strictEqual(a.decision, 'allow'); assert.deepStrictEqual([a.form, a.box], ['1099-MISC', '10']);
  const b = EV({ vendor: ATTY, category: 'attorney_gross_proceeds', paymentCents: 60000 }); assert.strictEqual(b.decision, 'block'); assert.ok(/gross proceeds paid to an attorney/.test(b.reason));
  assert.strictEqual(R.thresholdFor(2026, 'attorney_gross_proceeds').cents, 60000);
  assert.strictEqual(EV({ vendor: ATTY, category: 'attorney_fees', paymentCents: 60000 }).decision, 'allow', 'the same $600 as FEES is under the $2,000 threshold: not collapsed');
});
check('gross proceeds in an unconfigured year is a configuration exception (fail-safe kept)', () => {
  assert.strictEqual(R.thresholdFor(2027, 'attorney_gross_proceeds').cents, null);
  assert.strictEqual(EV({ year: 2027, vendor: ATTY, category: 'attorney_gross_proceeds', paymentCents: 100 }).decision, 'config_exception');
});
check('medical/health care 2026: $2,000 MISC (box 6), reportable even to a corporation', () => {
  const med = { ...CORP_EXEMPT, is_medical_provider: true };
  const e = EV({ vendor: { ...med, w9_on_file: false, tax_classification: null }, category: 'medical', paymentCents: 200000 });
  assert.strictEqual(e.decision, 'block'); assert.deepStrictEqual([e.form, e.box], ['1099-MISC', '6']);
  assert.strictEqual(R.thresholdFor(2026, 'medical').cents, 200000);
});
check('corporate exemption: covers services/rents/other income; NOT attorney fees, gross proceeds or medical', () => {
  for (const c of ['services', 'rents', 'other_income']) assert.strictEqual(R.vendorReportability(ATTY_CORP, c).reportable, false, c);
  for (const c of ['attorney_fees', 'attorney_gross_proceeds', 'medical']) assert.strictEqual(R.vendorReportability(ATTY_CORP, c).reportable, true, c);
});
check('government exemption covers every category (incl. gross proceeds / medical)', () => {
  for (const c of Object.keys(R.CATEGORIES)) assert.strictEqual(R.vendorReportability(GOV_EXEMPT, c).reportable, false, c);
});
check('category: the bill\'s own category wins; else the vendor default (attorney -> fees, medical -> medical, else services)', () => {
  assert.strictEqual(R.categoryFor('attorney_gross_proceeds', ATTY), 'attorney_gross_proceeds');
  assert.strictEqual(R.categoryFor(null, ATTY), 'attorney_fees');
  assert.strictEqual(R.categoryFor(null, { is_medical_provider: true }), 'medical');
  assert.strictEqual(R.categoryFor(null, UNKNOWN), 'services');
  assert.strictEqual(R.categoryFor('bogus', UNKNOWN), 'services');
});
check('card exclusion follows the PAYMENT\'s method, not the vendor: an attorney paid by card is not counted', () => {
  const e = EV({ vendor: ATTY, category: 'attorney_gross_proceeds', paymentCents: 900000, method: 'credit_card' });
  assert.strictEqual(e.decision, 'allow'); assert.strictEqual(e.counts, false);
  const e2 = EV({ vendor: { ...ATTY, name: 'Visa Card Services' }, category: 'attorney_gross_proceeds', paymentCents: 60000, method: 'check' });
  assert.strictEqual(e2.decision, 'block', 'a card-sounding vendor paid by check still counts');
});
check('one payment across two categories: each part against its own threshold; the worst decides', () => {
  const r = R.evaluatePaymentParts({ vendor: ATTY, year: 2026, parts: [{ category: 'attorney_fees', cents: 150000 }, { category: 'attorney_gross_proceeds', cents: 60000 }], method: 'check', initiation: 'disburse' });
  assert.strictEqual(r.decision, 'block'); assert.strictEqual(r.category, 'attorney_gross_proceeds');
  assert.deepStrictEqual(r.parts.map((p) => p.decision), ['allow', 'block']);
});
check('cumulative is split by the bills each payment paid (fees vs gross proceeds)', async () => {
  const { reportableTotals, totalsByCategory } = require('../lib/tax/reportable_payments');
  const d = db({
    ap_payments: [{ id: 'q1', vendor_id: 'va', community_id: 'c1', amount_cents: 80000, payment_method: 'check', status: 'completed', payment_date: '2026-02-01' }],
    ap_payment_applications: [{ payment_id: 'q1', invoice_id: 'bf', applied_cents: 50000 }, { payment_id: 'q1', invoice_id: 'bg', applied_cents: 30000 }],
    ap_invoices: [{ id: 'bf', tax_reporting_category: null }, { id: 'bg', tax_reporting_category: 'attorney_gross_proceeds' }],
    vendors: [ATTY],
  });
  const t = await reportableTotals(d, { vendorIds: ['va'], year: 2026 });
  assert.deepStrictEqual(totalsByCategory(t, 'va', 'c1'), { attorney_fees: 50000, attorney_gross_proceeds: 30000 });
});
check('check run: a gross-proceeds bill that reaches $600 is refused; the same amount as fees is not', async () => {
  const assertCheckRunAllowed = (d, o) => require('../lib/tax/payment_gate').assertCheckRunAllowed(d, o, { env: { TAX_W9_GATE: 'enforce' } }); // these cases test ENFORCE
  const base = { ap_payments: [], ap_payment_applications: [], vendors: [ATTY] };
  await assert.rejects(assertCheckRunAllowed(db({ ...base, ap_invoices: [{ id: 'g1', tax_reporting_category: 'attorney_gross_proceeds' }] }), { community_id: 'c1', vendorBills: new Map([['va', [{ invoice_id: 'g1', cents: 60000 }]]]), payment_date: '2026-10-02' }),
    (e) => e.code === 'w9_required_for_payment' && /gross proceeds paid to an attorney/.test(e.detail));
  await assertCheckRunAllowed(db({ ...base, ap_invoices: [{ id: 'f1', tax_reporting_category: null }] }), { community_id: 'c1', vendorBills: new Map([['va', [{ invoice_id: 'f1', cents: 60000 }]]]), payment_date: '2026-10-02' });
});
check('bill category is set only by an admin, never on a paid/voided bill, and is audited (477)', () => {
  const ap = src('api/ap.js'); const ep = ap.slice(ap.indexOf("router.post('/invoices/:id/tax-category'"), ap.indexOf('// POST /invoices/:id/approve'));
  assert.ok(ep.includes('requireAdmin(req, res)') && /invalid_category/.test(ep) && /category_locked/.test(ep) && ep.includes("['paid', 'partially_paid', 'voided']"));
  const m = src('migrations/477_vendor_tax_reporting_status.sql');
  assert.ok(/ADD COLUMN IF NOT EXISTS tax_reporting_category TEXT/.test(m) && /ap_invoices_tax_reporting_category_check/.test(m) && /trg_ap_invoice_tax_category_audit/.test(m));
  assert.ok(/'attorney_gross_proceeds'/.test(m) && /'attorney_fees'/.test(m));
});
check('check run is ATOMIC: one blocked vendor/category refuses the WHOLE run before any check number or payment', async () => {
  const assertCheckRunAllowed = (d, o) => require('../lib/tax/payment_gate').assertCheckRunAllowed(d, o, { env: { TAX_W9_GATE: 'enforce' } }); // these cases test ENFORCE
  const d = db({ ap_payments: [], ap_payment_applications: [], vendors: [ATTY, W9], ap_invoices: [{ id: 'g1', tax_reporting_category: 'attorney_gross_proceeds' }, { id: 'ok1', tax_reporting_category: null }] });
  // vendor W9 alone would pass; the attorney's gross-proceeds bill blocks -> the whole run is refused
  await assert.rejects(assertCheckRunAllowed(d, { community_id: 'c1', vendorBills: new Map([['v2', [{ invoice_id: 'ok1', cents: 900000 }]], ['va', [{ invoice_id: 'g1', cents: 60000 }]]]), payment_date: '2026-10-02' }),
    (e) => e.code === 'w9_required_for_payment' && e.vendors.length === 1 && e.vendors[0].vendor_id === 'va');
  // a multi-bill check where only ONE bill's category crosses is refused as a whole check
  await assert.rejects(assertCheckRunAllowed(d, { community_id: 'c1', vendorBills: new Map([['va', [{ invoice_id: 'ok1', cents: 1000 }, { invoice_id: 'g1', cents: 60000 }]]]), payment_date: '2026-10-02' }), (e) => e.code === 'w9_required_for_payment');
  const s = src('lib/accounting/check_run.js');
  const gate = s.indexOf('assertCheckRunAllowed(supabase, { community_id, vendorBills, payment_date })');
  assert.ok(gate > 0 && gate < s.indexOf("rpc('reserve_next_check_number'") && gate < s.indexOf("await recordPayment({ community_id, vendor_id, amount_cents, payment_date, payment_method: 'check'"), 'gate runs before any check number or payment');
});
check('category lock does not trust the status: the endpoint also refuses when ANY payment application exists', () => {
  const ap = src('api/ap.js'); const ep = ap.slice(ap.indexOf("router.post('/invoices/:id/tax-category'"), ap.indexOf('// POST /invoices/:id/approve'));
  assert.ok(ep.includes("from('ap_payment_applications').select('id').eq('invoice_id', inv.id)") && ep.includes('(apps && apps.length)'));
  assert.ok(/ap_invoice_tax_category_lock/.test(src('migrations/477_vendor_tax_reporting_status.sql')), 'and the DB refuses it (477 trigger)');
});
check('NULL bill categories resolve to the vendor default; 477 rewrites no bill', () => {
  assert.strictEqual(R.categoryFor(null, ATTY), 'attorney_fees'); assert.strictEqual(R.categoryFor(undefined, UNKNOWN), 'services');
  const m = src('migrations/477_vendor_tax_reporting_status.sql').replace(/--.*$/gm, '');
  assert.ok(!/UPDATE\s+ap_invoices/i.test(m) && /ADD COLUMN IF NOT EXISTS tax_reporting_category TEXT;/.test(m), 'nullable, no default, no backfill');
});
// ---------------------------------------------------------------- rollout mode (TAX_W9_GATE)
const { gateMode } = require('../lib/tax/gate_mode');
check('mode: unset -> WARN (rollout default); warn/enforce accepted, case and spaces forgiven', () => {
  assert.deepStrictEqual(gateMode({}), { mode: 'warn', configured: false, error: null });
  assert.strictEqual(gateMode({ TAX_W9_GATE: 'enforce' }).mode, 'enforce');
  assert.strictEqual(gateMode({ TAX_W9_GATE: ' ENFORCE ' }).mode, 'enforce');
  assert.strictEqual(gateMode({ TAX_W9_GATE: 'Warn' }).mode, 'warn');
});
check('mode: a malformed value is a CONFIGURATION ERROR, runs in warn, and says so', () => {
  for (const v of ['enforced', 'true', '1', 'block', 'on']) { const g = gateMode({ TAX_W9_GATE: v }); assert.strictEqual(g.mode, 'warn', v); assert.ok(/not warn or enforce/.test(g.error), v); }
});
const WARN_ENV = { env: {} };
const gateDb = () => db({ ap_payments: [], ap_payment_applications: [], vendors: [ATTY], ap_invoices: [{ id: 'g1', tax_reporting_category: 'attorney_gross_proceeds' }] });
const RUN = { community_id: 'c1', vendorBills: new Map([['va', [{ invoice_id: 'g1', cents: 60000 }]]]), payment_date: '2026-10-02' };
check('WARN mode computes the SAME decision as enforce but refuses nothing', async () => {
  const { assertCheckRunAllowed: gate } = require('../lib/tax/payment_gate');
  let enforceErr = null; try { await gate(gateDb(), RUN, { env: { TAX_W9_GATE: 'enforce' } }); } catch (e) { enforceErr = e; }
  assert.ok(enforceErr && enforceErr.code === 'w9_required_for_payment');
  const w = await gate(gateDb(), RUN, WARN_ENV);
  assert.strictEqual(w.ok, true); assert.strictEqual(w.mode, 'warn');
  assert.strictEqual(w.would_block.length, 1); assert.strictEqual(w.would_block[0].vendor_id, 'va');
  assert.strictEqual(w.detail, enforceErr.detail, 'identical decision text');
});
check('WARN mode with a malformed setting: same, plus the configuration error in the result', async () => {
  const { assertCheckRunAllowed: gate } = require('../lib/tax/payment_gate');
  const w = await gate(gateDb(), RUN, { env: { TAX_W9_GATE: 'enforced' } });
  assert.strictEqual(w.ok, true); assert.ok(/not warn or enforce/.test(w.config_error)); assert.strictEqual(w.would_block.length, 1);
});
check('read error: ENFORCE fails closed; WARN continues (logged), never refusing for W-9 reasons', async () => {
  const { assertCheckRunAllowed: gate } = require('../lib/tax/payment_gate');
  await assert.rejects(gate(db({}, { failOn: 'ap_payments' }), RUN, { env: { TAX_W9_GATE: 'enforce' } }), (e) => e.code === 'tax_check_failed');
  const w = await gate(db({}, { failOn: 'ap_payments' }), RUN, WARN_ENV);
  assert.strictEqual(w.ok, true); assert.ok(w.check_failed);
});
check('check run surfaces warn-mode results: run result carries tax_gate; list shows a warning badge, checkbox stays enabled', () => {
  const s = src('lib/accounting/check_run.js');
  assert.ok(/tax_gate: taxGate \? \{ mode: taxGate\.mode, would_block: taxGate\.would_block \|\| \[\]/.test(s));
  const ui = src('public/accounting.html');
  assert.ok(/W-9 needed \(warn\)/.test(ui) && /would be refused once the gate is enforced/.test(ui));
});

// ---------------------------------------------------------------- books-of-record scope
const SCOPE_DB = (extra = {}) => db({ communities: [{ id: 'c1', name: 'Waterview', financials_active: true, books_of_record: 'trusted' }, { id: 'cEW', name: 'Eaglewood', financials_active: false, books_of_record: 'vantaca' }], vendors: [UNKNOWN], ap_payment_applications: [], ap_invoices: [], ...extra });
check('scope: payments at an association whose books are not in trustEd are NOT counted (data-driven rule)', async () => {
  const { reportableTotals } = require('../lib/tax/reportable_payments');
  const t = await reportableTotals(SCOPE_DB({ ap_payments: [
    { id: 'w1', vendor_id: 'v1', community_id: 'c1', amount_cents: 50000, payment_method: 'check', status: 'completed', payment_date: '2026-03-01' },
    { id: 'e1', vendor_id: 'v1', community_id: 'cEW', amount_cents: 900000, payment_method: 'check', status: 'completed', payment_date: '2026-03-01' }] }), { vendorIds: ['v1'], year: 2026 });
  assert.strictEqual(t.get('v1|c1|services'), 50000); assert.strictEqual(t.get('v1|cEW|services'), undefined);
});
check('scope: a check run for an out-of-scope association is not evaluated (even in enforce)', async () => {
  const { assertCheckRunAllowed: gate } = require('../lib/tax/payment_gate');
  const r = await gate(SCOPE_DB({ ap_payments: [] }), { community_id: 'cEW', vendorBills: new Map([['v1', [{ invoice_id: 'x', cents: 900000 }]]]), payment_date: '2026-10-02' }, { env: { TAX_W9_GATE: 'enforce' } });
  assert.ok(r.ok && r.out_of_scope);
});
check('scope: projections and recorded-payment checks skip out-of-scope associations', async () => {
  const { projectBills, evaluateRecordedPayment } = require('../lib/tax/payment_gate');
  const m = await projectBills(SCOPE_DB({ ap_payments: [] }), [{ id: 'b-ew', vendor_id: 'v1', community_id: 'cEW', balance_cents: 900000 }, { id: 'b-wv', vendor_id: 'v1', community_id: 'c1', balance_cents: 900000 }]);
  assert.strictEqual(m.has('b-ew'), false); assert.strictEqual(m.get('b-wv').decision, 'block');
  const r = await evaluateRecordedPayment(SCOPE_DB({ ap_payments: [] }), { community_id: 'cEW', vendor_id: 'v1', amount_cents: 900000, payment_date: '2026-10-02', payment_method: 'ach' });
  assert.ok(r.out_of_scope && r.decision === 'allow');
});
check('scope uses the SAME rule as AP recovery (lib/ap/books_scope), no community names in code; spend report labels the rows', () => {
  const rp = src('lib/tax/reportable_payments.js');
  assert.ok(/require\('\.\.\/ap\/books_scope'\)/.test(rp) && /outsideTrustedBooks\(c\)/.test(rp));
  for (const f of ['lib/tax/reportable_payments.js', 'lib/tax/payment_gate.js', 'lib/tax/info_reporting.js']) assert.ok(!/eaglewood/i.test(src(f).replace(/\/\/.*$/gm, '')), f);
  assert.ok(/tax_scope: 'outside_trusted_books'/.test(src('api/vendors.js')));
});
check('Bedrock Association Management gets NO special treatment in the tax code', () => {
  for (const f of ['lib/tax/reportable_payments.js', 'lib/tax/payment_gate.js', 'lib/tax/info_reporting.js', 'lib/tax/gate_mode.js']) {
    assert.ok(!/bedrock|BEDROCK_MGMT_CO_ID|management_compan/i.test(src(f).replace(/\/\/.*$/gm, '')), f);
  }
});
check('bill category read is tolerant before 477 (no column -> vendor default, no failure)', async () => {
  const { invoiceCategories } = require('../lib/tax/reportable_payments');
  const d = { from() { const q = { select() { return q; }, in() { return Promise.resolve({ data: null, error: { message: 'column ap_invoices.tax_reporting_category does not exist' } }); } }; return q; } };
  const m = await invoiceCategories(d, ['x']); assert.strictEqual(m.size, 0);
});

// ---------------------------------------------------------------- where it acts (paths)
check('PATH check run: the 1099 gate runs BEFORE any check number is reserved', () => {
  const s = src('lib/accounting/check_run.js');
  assert.ok(s.indexOf('assertCheckRunAllowed(supabase, { community_id, vendorBills, payment_date })') < s.indexOf("rpc('reserve_next_check_number'"));
  assert.ok(s.includes('return { w9_required_before_payment: stop && enforce, w9_warning: stop && !enforce, w9_reason: stop ? ev.reason : null }'), 'list flags the bill (disabled only in enforce; warning badge in warn)');
  assert.ok(/i\.w9_required_before_payment \? `<input type="checkbox" disabled/.test(src('public/accounting.html')), 'UI: not selectable, with the reason');
  assert.ok(/err\.code === 'w9_required_for_payment' \|\| err\.code === 'threshold_unconfigured'\) return res\.status\(409\)/.test(src('api/checks.js')) && /tax_check_failed'\) return res\.status\(503\)/.test(src('api/checks.js')));
});
check('PATH recordPayment (mark-paid, POST /payments, early prepay, autopay drafts): evaluates, attaches, NEVER throws for tax', () => {
  const s = src('lib/accounting/ap_engine.js');
  assert.ok(/const tax_reporting = await require\('\.\.\/tax\/payment_gate'\)\.evaluateRecordedPayment\(/.test(s));
  assert.ok(/return \{ payment, applications, tax_reporting \};/.test(s) && /return \{ \.\.\.early, tax_reporting \};/.test(s));
  assert.ok(!/assertCheckRunAllowed|w9_required/.test(s), 'no blocking call in the recording engine');
});
check('PATH approval (manager key + admin release): never blocks; response carries a warning', () => {
  const s = src('api/ap.js');
  assert.ok(!/assertW9Cleared|assertCheckRunAllowed/.test(s));
  assert.strictEqual((s.match(/tax_reporting: await approvalTaxNote\(id\)/g) || []).length, 2);
});
check('PATH intake / vendor creation / accrual: no W-9 or 1099 evaluation at all', () => {
  for (const f of ['lib/ap/intake.js', 'lib/ap/vendor_master.js', 'lib/ap/email_bill_intake.js']) assert.ok(!/payment_gate|info_reporting|w9_gate/.test(src(f)), f);
});
check('history is untouched: no migration backfill, no rewrite of existing payments', () => {
  const m = src('migrations/477_vendor_tax_reporting_status.sql');
  assert.ok(!/UPDATE\s+(vendors|ap_payments|ap_invoices)\b/i.test(m.replace(/--.*$/gm, '')));
});
check('no hard-coded $600 left in the 1099 / W-9 logic; thresholds come from thresholdFor(year)', () => {
  const v = src('api/vendors.js');
  assert.ok(!/ytd >= 60000|CENTS_1099_THRESHOLD = 60000/.test(v));
  assert.ok(/const thr = thresholdFor\(year\);/.test(v) && /const CENTS_1099_THRESHOLD = thr\.cents;/.test(v));
  const ui = src('public/index.html');
  assert.ok(!/\$600 per community/.test(ui) && !/c\.ytd_cents>=60000/.test(ui));
});
check('check run: an unconfigured year refuses with its OWN code (threshold_unconfigured), not "W-9 needed"', async () => {
  const assertCheckRunAllowed = (d, o) => require('../lib/tax/payment_gate').assertCheckRunAllowed(d, o, { env: { TAX_W9_GATE: 'enforce' } }); // these cases test ENFORCE
  await assert.rejects(assertCheckRunAllowed(db({ ap_payments: [], vendors: [UNKNOWN] }), { community_id: 'c1', vendorBills: new Map([['v1', [{ invoice_id: 'i-x', cents: 100 }]]]), payment_date: '2027-01-15' }),
    (e) => e.code === 'threshold_unconfigured' && /1099 threshold not configured/.test(e.detail));
  assert.ok(/'w9_required_for_payment' \|\| err\.code === 'threshold_unconfigured'\) return res\.status\(409\)/.test(src('api/checks.js')));
  assert.ok(/ev\.decision === 'block' \|\| ev\.decision === 'config_exception'/.test(src('lib/accounting/check_run.js')), 'the list flags it too');
});
check('W-9 shortcut CLOSED: PATCH can switch w9_on_file ON only with a current W-9 document; re-sending ON is a no-op; OFF allowed', () => {
  const v = src('api/vendors.js');
  const patch = v.slice(v.indexOf("router.patch('/:vendorId'"), v.indexOf('// GET /api/vendors/', v.indexOf("router.patch('/:vendorId'")) > 0 ? v.indexOf('// GET /api/vendors/', v.indexOf("router.patch('/:vendorId'")) : v.indexOf("router.patch('/:vendorId'") + 4000);
  assert.ok(/eq\('doc_type', 'w9'\)\.eq\('is_current', true\)/.test(patch) && /w9_document_required/.test(patch));
  assert.ok(/if \(cur && cur\.w9_on_file === true\) \{ delete update\.w9_on_file; \}/.test(patch));
  const allowed = patch.slice(patch.indexOf('const allowed'), patch.indexOf('];', patch.indexOf('const allowed')));
  assert.ok(!/tax_reporting_status|tax_exemption_/.test(allowed), 'exemption fields are not editable via PATCH');
  assert.ok(/'is_legal_counsel','is_medical_provider'/.test(allowed), 'attorney/medical flags (which only ADD reporting) are editable');
  const ui = src('public/index.html');
  assert.ok(/id="ven-f-w9_on_file" \$\{v\.w9_on_file\?'checked':'disabled'\}/.test(ui) && /id="ve-w9" \$\{v\.w9_on_file \? 'checked' : 'disabled'\}/.test(ui), 'UI checkboxes cannot switch it on');
});
check('exemption is CONFIRMED by a person (admin, session identity) with provenance; W-9 upload only suggests', () => {
  const v = src('api/vendors.js');
  const ep = v.slice(v.indexOf("router.post('/:vendorId/tax-exemption'"), v.indexOf('// GET /api/vendors/documents/:docId/file'));
  assert.ok(/requireAdmin\(req, res\)/.test(ep) && /const who = admin\.email \|\| admin\.full_name/.test(ep), 'admin only; verified-by from the session');
  assert.ok(/tax_exemption_verified_by: who/.test(ep) && !/b\.verified_by/.test(ep), 'never from the body');
  assert.ok(/document_mismatch/.test(ep) && /not_corporate_on_w9/.test(ep) && /note_required/.test(ep), 'proof checks');
  assert.ok(/tax_reporting_status: 'unknown'/.test(ep), 'revoke returns the vendor to potentially reportable');
  assert.ok(/suggested_exemption = sug \? \{ \.\.\.sug, document_id: doc\.id \} : null/.test(v), 'upload returns a suggestion');
  assert.ok(!/tax_reporting_status/.test(v.slice(v.indexOf('// Flip w9_on_file + capture tax fields'), v.indexOf('suggested_exemption'))), 'upload never sets the status');
  assert.ok(/function venTaxPanel\(v, docs\)/.test(src('public/index.html')) && /Confirm corporate exemption \(from the W-9\)/.test(src('public/index.html')));
});
check('government/MUD exemption is stored + verified, not inferred: is_mud alone does not exempt', () => {
  assert.ok(R.vendorReportability({ ...UNKNOWN, is_mud: true }).reportable);
  assert.strictEqual(R.vendorReportability(GOV_EXEMPT).reportable, false);
});
check('reimbursement exclusion is evidence-backed and audited (relabeling leaves a trail)', () => {
  assert.ok(/kind = 'reimbursement'[\s\S]{0,200}set only by the reimbursement flow/.test(src('lib/tax/info_reporting.js')));
  const m = src('migrations/477_vendor_tax_reporting_status.sql');
  assert.ok(/'kind', OLD\.kind, 'reimbursee_contact_id', OLD\.reimbursee_contact_id/.test(m) && /'kind', NEW\.kind/.test(m));
  const v = src('api/vendors.js'); const allowed = v.slice(v.indexOf('const allowed = ['), v.indexOf('];', v.indexOf('const allowed = [')));
  assert.ok(!/'kind'/.test(allowed), 'staff edits cannot relabel a vendor as a reimbursement payee');
});
check('no override exists', () => {
  for (const f of ['lib/tax/info_reporting.js', 'lib/tax/payment_gate.js']) assert.ok(!/override|bypass\s*[:=]|force\s*[:=]/i.test(src(f).replace(/\/\/.*$/gm, '')), f);
});

(async () => {
  let pass = 0, fail = 0;
  console.log('1099 W-9 threshold rule (Issue #14)');
  for (const [n, fn] of tests) { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + e.message); } }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
