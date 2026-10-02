// ============================================================================
// tests/test_1099_reporting_rule.js  (Issue #14, Ed 2026-10-02)
// ----------------------------------------------------------------------------
// Ed's W-9 rule, INFORMATIONAL: "never miss/forget the W-9 requirement, but
// never hold up an otherwise valid payment because of it."
//   - cumulative REPORTABLE payments per vendor x association x calendar year x
//     reporting category; year-aware thresholds ($600 through 2025; $2,000 in
//     2026 for NEC services / attorney fees / MISC medical, rents, other; $600
//     for gross proceeds paid to an attorney, 6045(f));
//   - a payee over a threshold without a W-9 + classification is FLAGGED
//     'w9_needed' on the check run, Payables queue, vendor views, reports and the
//     payment's audit note; nothing is refused, disabled or delayed;
//   - exemptions only from stored data with provenance; corporate exemption does
//     not cover attorney fees / gross proceeds / medical; names are clues only;
//   - card payments (1099-K) not counted, by the payment's method;
//   - out of scope: books not in trustEd, and demo tenants (stored data).
// In-memory fakes only.
// ============================================================================
require('dotenv').config({ quiet: true });
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const R = require('../lib/tax/info_reporting');
const tests = []; const check = (n, fn) => tests.push([n, fn]);
const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const code = (p) => src(p).replace(/\/\/.*$/gm, '');

const UNKNOWN = { id: 'v1', name: 'DJ (individual)', kind: 'vendor', w9_on_file: false, tax_classification: null, tax_reporting_status: 'unknown' };
const W9 = { ...UNKNOWN, id: 'v2', name: 'Lawn Pros', w9_on_file: true, tax_classification: 'individual_sole_proprietor' };
const CORP_EXEMPT = { id: 'v3', name: 'Big Pool Corp', kind: 'vendor', w9_on_file: true, tax_classification: 'c_corporation', tax_reporting_status: 'exempt_verified', tax_exemption_basis: 'corporation', tax_exemption_source: 'w9_document', tax_exemption_verified_by: 'reviewer', tax_exemption_verified_at: '2026-10-02' };
const GOV_EXEMPT = { ...CORP_EXEMPT, id: 'v4', name: 'Fort Bend County MUD 143', tax_exemption_basis: 'government', tax_exemption_source: 'government_entity_record' };
const ATTY = { ...UNKNOWN, id: 'va', name: 'Daughtry & Farine, P.C.', is_legal_counsel: true };
const ATTY_CORP = { ...CORP_EXEMPT, id: 'vac', name: 'Big Law Corp', is_legal_counsel: true };
const EV = (o) => R.evaluatePayment({ vendor: UNKNOWN, year: 2026, priorReportableCents: 0, paymentCents: 30000, method: 'check', initiation: 'disburse', ...o });

// ---------------------------------------------------------------- decisions are flags, never refusals
check('the rule has only informational outcomes: allow | w9_needed | threshold_unconfigured', () => {
  const m = code('lib/tax/info_reporting.js');
  assert.ok(!/decision: 'block'|decision: 'config_exception'|decision: 'warn'/.test(m));
  const seen = new Set([EV({ paymentCents: 1 }), EV({ paymentCents: 900000 }), EV({ year: 2027 })].map((e) => e.decision));
  assert.deepStrictEqual([...seen].sort(), ['allow', 'threshold_unconfigured', 'w9_needed']);
});

// ---------------------------------------------------------------- thresholds
check('threshold is YEAR-aware: $600 through 2025, $2,000 for 2026', () => {
  assert.strictEqual(R.thresholdFor(2024).cents, 60000); assert.strictEqual(R.thresholdFor(2025).cents, 60000);
  assert.strictEqual(R.thresholdFor(2026).cents, 200000); assert.strictEqual(R.thresholdFor(2026).provisional, false);
});
check('a later (indexed) year is not guessed: NO threshold; flagged threshold_unconfigured (never last year\'s number)', () => {
  const t = R.thresholdFor(2027); assert.strictEqual(t.cents, null); assert.ok(t.provisional && /2027 1099 threshold for .* is not configured/.test(t.basis));
  for (const initiation of ['disburse', 'record', 'approve']) assert.strictEqual(EV({ year: 2027, paymentCents: 100, initiation }).decision, 'threshold_unconfigured', initiation);
  assert.strictEqual(EV({ year: 2027, vendor: W9 }).decision, 'allow'); assert.strictEqual(EV({ year: 2027, vendor: CORP_EXEMPT }).decision, 'allow'); assert.strictEqual(EV({ year: 2027, method: 'credit_card' }).decision, 'allow');
});
check('exact threshold, services 2026: $1,999.99 -> allow; $2,000.00 -> w9_needed (>=)', () => {
  assert.strictEqual(EV({ paymentCents: 199999 }).decision, 'allow');
  assert.strictEqual(EV({ paymentCents: 200000 }).decision, 'w9_needed');
  assert.strictEqual(EV({ priorReportableCents: 199999, paymentCents: 1 }).decision, 'w9_needed');
});
check('year boundary: the same $700 is flagged in 2025 but not in 2026', () => {
  assert.strictEqual(EV({ year: 2025, priorReportableCents: 50000, paymentCents: 20000 }).decision, 'w9_needed');
  assert.strictEqual(EV({ year: 2026, priorReportableCents: 50000, paymentCents: 20000 }).decision, 'allow');
});
check('wording: a disbursement may proceed; a recording is already done; both say request the W-9', () => {
  assert.ok(/W-9 needed:.*The payment can proceed; request the W-9/.test(EV({ paymentCents: 900000 }).reason));
  assert.ok(/The payment is recorded; request the W-9 now/.test(EV({ paymentCents: 900000, initiation: 'record' }).reason));
});
check('W-9 WITH a classification -> allow; W-9 flag WITHOUT a classification still flags', () => {
  assert.strictEqual(EV({ vendor: W9, priorReportableCents: 500000 }).decision, 'allow');
  assert.strictEqual(EV({ vendor: { ...UNKNOWN, w9_on_file: true }, priorReportableCents: 190000 }).decision, 'w9_needed');
});

// ---------------------------------------------------------------- categories (attorney fees vs gross proceeds)
check('attorney FEES 2026: $2,000 NEC box 1; GROSS PROCEEDS (6045(f)): $600 MISC box 10 ($599.99 / $600.00); not collapsed', () => {
  const f1 = EV({ vendor: ATTY, category: 'attorney_fees', paymentCents: 199999 }); assert.strictEqual(f1.decision, 'allow'); assert.deepStrictEqual([f1.form, f1.box], ['1099-NEC', '1']);
  assert.strictEqual(EV({ vendor: ATTY, category: 'attorney_fees', paymentCents: 200000 }).decision, 'w9_needed');
  const g1 = EV({ vendor: ATTY, category: 'attorney_gross_proceeds', paymentCents: 59999 }); assert.strictEqual(g1.decision, 'allow'); assert.deepStrictEqual([g1.form, g1.box], ['1099-MISC', '10']);
  const g2 = EV({ vendor: ATTY, category: 'attorney_gross_proceeds', paymentCents: 60000 }); assert.strictEqual(g2.decision, 'w9_needed'); assert.ok(/gross proceeds paid to an attorney/.test(g2.reason));
  assert.strictEqual(EV({ vendor: ATTY, category: 'attorney_fees', paymentCents: 60000 }).decision, 'allow');
  assert.strictEqual(R.thresholdFor(2027, 'attorney_gross_proceeds').cents, null);
});
check('medical 2026: $2,000 MISC box 6, reportable even to a corporation', () => {
  const e = EV({ vendor: { ...CORP_EXEMPT, is_medical_provider: true, w9_on_file: false, tax_classification: null }, category: 'medical', paymentCents: 200000 });
  assert.strictEqual(e.decision, 'w9_needed'); assert.deepStrictEqual([e.form, e.box], ['1099-MISC', '6']);
});
check('corporate exemption: covers services/rents/other income; NOT attorney fees, gross proceeds or medical; government covers all', () => {
  for (const c of ['services', 'rents', 'other_income']) assert.strictEqual(R.vendorReportability(ATTY_CORP, c).reportable, false, c);
  for (const c of ['attorney_fees', 'attorney_gross_proceeds', 'medical']) assert.strictEqual(R.vendorReportability(ATTY_CORP, c).reportable, true, c);
  for (const c of Object.keys(R.CATEGORIES)) assert.strictEqual(R.vendorReportability(GOV_EXEMPT, c).reportable, false, c);
});
check('category: bill\'s own wins; NULL -> vendor default (attorney -> fees, medical -> medical, else services)', () => {
  assert.strictEqual(R.categoryFor('attorney_gross_proceeds', ATTY), 'attorney_gross_proceeds');
  assert.strictEqual(R.categoryFor(null, ATTY), 'attorney_fees'); assert.strictEqual(R.categoryFor(undefined, UNKNOWN), 'services');
  assert.strictEqual(R.categoryFor(null, { is_medical_provider: true }), 'medical'); assert.strictEqual(R.categoryFor('bogus', UNKNOWN), 'services');
});
check('card exclusion follows the PAYMENT\'s method, not the vendor', () => {
  const e = EV({ vendor: ATTY, category: 'attorney_gross_proceeds', paymentCents: 900000, method: 'credit_card' }); assert.strictEqual(e.decision, 'allow'); assert.strictEqual(e.counts, false);
  assert.strictEqual(EV({ vendor: { ...ATTY, name: 'Visa Card Services' }, category: 'attorney_gross_proceeds', paymentCents: 60000, method: 'check' }).decision, 'w9_needed');
  for (const m of ['check', 'ach', 'wire', 'cash', 'other']) assert.strictEqual(R.reportingChannel(m), 'form_1099_nec_misc', m);
});
check('one payment across two categories: each part against its own threshold; the most significant flag is reported', () => {
  const r = R.evaluatePaymentParts({ vendor: ATTY, year: 2026, parts: [{ category: 'attorney_fees', cents: 150000 }, { category: 'attorney_gross_proceeds', cents: 60000 }], initiation: 'disburse' });
  assert.strictEqual(r.decision, 'w9_needed'); assert.strictEqual(r.category, 'attorney_gross_proceeds'); assert.deepStrictEqual(r.parts.map((p) => p.decision), ['allow', 'w9_needed']);
});

// ---------------------------------------------------------------- exemptions / names / reimbursement
check('verified-exempt (stored, with provenance) -> not reportable; a suggestion or classification alone is not an exemption', () => {
  const e = EV({ vendor: CORP_EXEMPT, priorReportableCents: 900000 }); assert.strictEqual(e.decision, 'allow'); assert.strictEqual(e.counts, false);
  assert.ok(R.vendorReportability({ ...UNKNOWN, tax_exemption_basis: 'corporation' }).reportable);
  assert.ok(R.vendorReportability({ ...UNKNOWN, tax_classification: 'c_corporation', w9_on_file: true }).reportable);
  const s = R.suggestExemptionFromW9('c_corporation'); assert.deepStrictEqual([s.basis, s.source], ['corporation', 'w9_document']);
  assert.strictEqual(R.suggestExemptionFromW9('individual_sole_proprietor'), null);
});
check('names are CLUES only (Inc / P.C. / LLC); is_mud alone does not exempt; reimbursement payees not reportable', () => {
  const inc = { ...UNKNOWN, name: 'Acme Pools, Inc.' };
  assert.ok(/clue only/.test(R.nameClue(inc.name))); assert.strictEqual(EV({ vendor: inc, paymentCents: 900000 }).decision, 'w9_needed');
  assert.ok(/does not show corporate tax treatment/.test(R.nameClue('Renovations Near Me LLC'))); assert.ok(/professional entity/.test(R.nameClue('Winstead PC')));
  assert.ok(R.vendorReportability({ ...UNKNOWN, is_mud: true }).reportable);
  assert.strictEqual(R.vendorReportability({ ...UNKNOWN, kind: 'reimbursement' }).reportable, false);
});

// ---------------------------------------------------------------- data access + scope
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
const COMMS = [{ id: 'c1', name: 'Waterview', financials_active: true, books_of_record: 'trusted', is_demo: false }, { id: 'cEW', name: 'Eaglewood', financials_active: false, books_of_record: 'vantaca', is_demo: false }, { id: 'cDEMO', name: 'Demo LMA', financials_active: true, books_of_record: 'trusted', is_demo: true }];
const PAYS = [
  { id: 'p1', vendor_id: 'v1', community_id: 'c1', amount_cents: 100000, payment_method: 'check', status: 'completed', payment_date: '2026-03-01' },
  { id: 'p2', vendor_id: 'v1', community_id: 'c1', amount_cents: 50000, payment_method: 'credit_card', status: 'completed', payment_date: '2026-04-01' },
  { id: 'p3', vendor_id: 'v1', community_id: 'c1', amount_cents: 70000, payment_method: 'ach', status: 'voided', payment_date: '2026-05-01' },
  { id: 'p4', vendor_id: 'v1', community_id: 'c1', amount_cents: 30000, payment_method: 'ach', status: 'pending', payment_date: '2026-06-01' },
  { id: 'p5', vendor_id: 'v1', community_id: 'c2', amount_cents: 999900, payment_method: 'check', status: 'completed', payment_date: '2026-06-01' },
  { id: 'p6', vendor_id: 'v1', community_id: 'c1', amount_cents: 888800, payment_method: 'check', status: 'completed', payment_date: '2025-12-31' },
  { id: 'p7', vendor_id: 'v1', community_id: 'cEW', amount_cents: 900000, payment_method: 'check', status: 'completed', payment_date: '2026-03-01' },
  { id: 'p8', vendor_id: 'v1', community_id: 'cDEMO', amount_cents: 900000, payment_method: 'check', status: 'completed', payment_date: '2026-03-01' },
];
const D = (extra = {}) => db({ communities: COMMS, ap_payments: PAYS, vendors: [UNKNOWN, W9, ATTY], ap_payment_applications: [], ap_invoices: [], ...extra });
check('cumulative: per vendor x association x year x category; excludes card, voided, other years, books-elsewhere and demo tenants', async () => {
  const { reportableTotals } = require('../lib/tax/reportable_payments');
  const t = await reportableTotals(D(), { vendorIds: ['v1'], year: 2026 });
  assert.strictEqual(t.get('v1|c1|services'), 130000); assert.strictEqual(t.get('v1|c2|services'), 999900);
  assert.strictEqual(t.get('v1|cEW|services'), undefined, 'books in Vantaca'); assert.strictEqual(t.get('v1|cDEMO|services'), undefined, 'is_demo');
});
check('cumulative is split by the bills each payment paid (fees vs gross proceeds)', async () => {
  const { reportableTotals, totalsByCategory } = require('../lib/tax/reportable_payments');
  const t = await reportableTotals(D({
    ap_payments: [{ id: 'q1', vendor_id: 'va', community_id: 'c1', amount_cents: 80000, payment_method: 'check', status: 'completed', payment_date: '2026-02-01' }],
    ap_payment_applications: [{ payment_id: 'q1', invoice_id: 'bf', applied_cents: 50000 }, { payment_id: 'q1', invoice_id: 'bg', applied_cents: 30000 }],
    ap_invoices: [{ id: 'bf', tax_reporting_category: null }, { id: 'bg', tax_reporting_category: 'attorney_gross_proceeds' }],
  }), { vendorIds: ['va'], year: 2026 });
  assert.deepStrictEqual(totalsByCategory(t, 'va', 'c1'), { attorney_fees: 50000, attorney_gross_proceeds: 30000 });
});
check('scope uses stored data only (books_scope rule + communities.is_demo); no community names in tax code', () => {
  const rp = code('lib/tax/reportable_payments.js');
  assert.ok(/require\('\.\.\/ap\/books_scope'\)/.test(rp) && /outsideTrustedBooks\(c\) \|\| c\.is_demo === true/.test(rp));
  for (const f of ['lib/tax/reportable_payments.js', 'lib/tax/payment_gate.js', 'lib/tax/info_reporting.js']) assert.ok(!/eaglewood|sterling/i.test(code(f)), f);
  assert.ok(/tax_scope: 'outside_trusted_books'/.test(src('api/vendors.js')));
});
check('reads work BEFORE migration 477 (vendor columns, bill category)', async () => {
  const { loadVendorsForTax, invoiceCategories } = require('../lib/tax/reportable_payments');
  const m = await loadVendorsForTax(db({ vendors: [UNKNOWN] }, { missingCols: true }), ['v1']); assert.ok(R.vendorReportability(m.get('v1')).reportable);
  const d = { from() { const q = { select() { return q; }, in() { return Promise.resolve({ data: null, error: { message: 'column ap_invoices.tax_reporting_category does not exist' } }); } }; return q; } };
  assert.strictEqual((await invoiceCategories(d, ['x'])).size, 0);
});

// ---------------------------------------------------------------- check run: reports, never refuses
const G = () => require('../lib/tax/payment_gate');
check('check run: the W-9 status NEVER throws and NEVER refuses; it lists who needs a W-9', async () => {
  const r = await G().checkRunW9Status(D({ ap_invoices: [{ id: 'g1', tax_reporting_category: 'attorney_gross_proceeds' }] }), { community_id: 'c1', vendorBills: new Map([['va', [{ invoice_id: 'g1', cents: 60000 }]], ['v2', [{ invoice_id: 'ok', cents: 900000 }]]]), payment_date: '2026-10-02' });
  assert.strictEqual(r.needs_w9.length, 1); assert.strictEqual(r.needs_w9[0].vendor_id, 'va'); assert.strictEqual(r.needs_w9[0].decision, 'w9_needed');
  assert.ok(!('ok' in r && r.ok === false));
});
check('check run: unconfigured year is flagged threshold_unconfigured, not refused', async () => {
  const r = await G().checkRunW9Status(D(), { community_id: 'c1', vendorBills: new Map([['v1', [{ invoice_id: 'x', cents: 100 }]]]), payment_date: '2027-01-15' });
  assert.strictEqual(r.needs_w9[0].decision, 'threshold_unconfigured');
});
check('check run: a read failure is surfaced (check_failed + console.error) and NEVER blocks', async () => {
  const errs = []; const orig = console.error; console.error = (...a) => errs.push(a.join(' '));
  try {
    const r = await G().checkRunW9Status(db({}, { failOn: 'communities' }), { community_id: 'c1', vendorBills: new Map([['v1', [{ invoice_id: 'x', cents: 100 }]]]), payment_date: '2026-10-02' });
    assert.ok(r.check_failed); assert.deepStrictEqual(r.needs_w9, []);
  } finally { console.error = orig; }
  assert.ok(errs.some((e) => /W-9 compliance check FAILED/.test(e)));
});
check('check run: books-elsewhere and demo associations are out of scope', async () => {
  for (const cid of ['cEW', 'cDEMO']) { const r = await G().checkRunW9Status(D(), { community_id: cid, vendorBills: new Map([['v1', [{ invoice_id: 'x', cents: 900000 }]]]), payment_date: '2026-10-02' }); assert.ok(r.out_of_scope, cid); }
});
check('check run code: never throws for tax; returns tax_compliance; no 409/503 tax codes; selection never disabled', () => {
  const cr = code('lib/accounting/check_run.js');
  assert.ok(/checkRunW9Status\(supabase, \{ community_id, vendorBills, payment_date \}\)/.test(cr) && /tax_compliance: taxCompliance \?/.test(cr));
  assert.ok(!/assertCheckRunAllowed|w9_required_before_payment|gate_mode/.test(cr));
  const ck = code('api/checks.js'); assert.ok(!/w9_required_for_payment|threshold_unconfigured|tax_check_failed/.test(ck));
  const ui = src('public/accounting.html');
  assert.ok(!/<input type="checkbox" disabled title="\$\{esc\(i\.w9_reason/.test(ui), 'no disabled checkbox for W-9');
  assert.ok(/i\.w9_needed \? ` <span/.test(ui) && />W-9 needed<\/span>/.test(ui) && /the checks were issued/.test(ui));
});
check('gate module cannot refuse: no throw paths, no enforce, TAX_W9_GATE retired (ignored + logged)', () => {
  const g = code('lib/tax/payment_gate.js');
  assert.ok(!/\bthrow\b/.test(g), 'no throw anywhere in the gate');
  assert.ok(!/enforce|gateMode/.test(g));
  assert.ok(/TAX_W9_GATE.*is retired and ignored/.test(src('lib/tax/payment_gate.js')));
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'lib/tax/gate_mode.js')), 'the warn/enforce module is removed');
});

// ---------------------------------------------------------------- lists, approval, recording, audit
check('lists/projections flag w9_needed; out-of-scope bills are not flagged; projection never throws', async () => {
  const m = await G().projectBills(D(), [{ id: 'b1', vendor_id: 'v1', community_id: 'c1', balance_cents: 70000 }, { id: 'b-ew', vendor_id: 'v1', community_id: 'cEW', balance_cents: 900000 }, { id: 'b-demo', vendor_id: 'v1', community_id: 'cDEMO', balance_cents: 900000 }], { payment_date: '2026-10-02' });
  assert.strictEqual(m.get('b1').decision, 'w9_needed'); assert.strictEqual(m.has('b-ew'), false); assert.strictEqual(m.has('b-demo'), false);
  assert.strictEqual((await G().projectBills(db({}, { failOn: 'communities' }), [{ id: 'x', vendor_id: 'v1', community_id: 'c1', balance_cents: 1 }])).size, 0);
});
check('Payables queue and check-run list carry the W-9 flag; vendor list / reports keep needs_w9', () => {
  const q = code('api/ap_intake.js'); assert.ok(/r\.w9_needed = true; r\.w9_reason = ev\.reason;/.test(q));
  // vendor + paid come from the queue's own (error-checked) query, never an unchecked second read
  assert.ok(/\.select\('id, vendor_id, amount_paid_cents, vendor_invoice_number/.test(q) && /vendor_id: r\.vendor_id, community_id: r\.community_id/.test(q));
  assert.ok(!/const \{ data: vrows \}/.test(q), 'no unchecked { data } read');
  assert.ok(/r0\.w9_needed \?/.test(src('public/ap-invoices.html')));
  assert.ok(/return \{ w9_needed: flag, w9_reason: flag \? ev\.reason : null \}/.test(code('lib/accounting/check_run.js')));
  assert.ok(/needs_w9: st\.needs_w9/.test(src('api/vendors.js')) && /if \(v\.needs_w9\) b\.push\(chip\('#fff4e0', '#a06400', 'W-9 needed'\)\)/.test(src('public/index.html')));
});
check('recording: evaluates, NEVER throws for tax, attaches the result, and writes the W-9 note into the payment (audit trail)', async () => {
  const s = code('lib/accounting/ap_engine.js');
  assert.ok(/evaluateRecordedPayment\(supabase, \{ community_id, vendor_id, amount_cents, payment_date, payment_method, applications \}\)/.test(s));
  assert.ok(/notes: \[notes, require\('\.\.\/tax\/payment_gate'\)\.auditNote\(tax_reporting\)\]\.filter\(Boolean\)\.join\(' '\)/.test(s));
  assert.ok(/return \{ payment, applications, tax_reporting \};/.test(s));
  const w = await G().evaluateRecordedPayment(D(), { community_id: 'c1', vendor_id: 'v1', amount_cents: 90000, payment_date: '2026-10-02', payment_method: 'ach' });
  assert.strictEqual(w.decision, 'w9_needed'); assert.ok(/^\[W-9 compliance: W-9 needed:/.test(G().auditNote(w)));
  const f = await G().evaluateRecordedPayment(db({}, { failOn: 'communities' }), { community_id: 'c1', vendor_id: 'v1', amount_cents: 1, payment_date: '2026-10-02', payment_method: 'ach' });
  assert.strictEqual(f.decision, 'check_failed'); assert.ok(/W-9 compliance check failed/.test(G().auditNote(f)));
  assert.strictEqual(G().auditNote({ decision: 'allow' }), null);
});
check('approval never blocks; its response carries the flag', () => {
  const s = code('api/ap.js');
  assert.strictEqual((s.match(/tax_reporting: await approvalTaxNote\(id\)/g) || []).length, 2);
  assert.ok(/FLAG\.has\(ev\.decision\) \? \{ decision: ev\.decision, reason: ev\.reason \} : null/.test(s));
});
check('intake / vendor creation / accrual: no W-9 or 1099 evaluation at all', () => {
  for (const f of ['lib/ap/intake.js', 'lib/ap/vendor_master.js', 'lib/ap/email_bill_intake.js']) assert.ok(!/payment_gate|info_reporting|w9_gate/.test(src(f)), f);
});

// ---------------------------------------------------------------- provenance, workflow, audit, history
check('bill category: admin only; locked once paid/voided OR any payment application exists; audited and DB-locked (477)', () => {
  const ap = src('api/ap.js'); const ep = ap.slice(ap.indexOf("router.post('/invoices/:id/tax-category'"), ap.indexOf('// POST /invoices/:id/approve'));
  assert.ok(ep.includes('requireAdmin(req, res)') && /invalid_category/.test(ep) && /category_locked/.test(ep) && ep.includes("['paid', 'partially_paid', 'voided']"));
  assert.ok(ep.includes("from('ap_payment_applications').select('id').eq('invoice_id', inv.id)") && ep.includes('(apps && apps.length)'));
  const m = src('migrations/477_vendor_tax_reporting_status.sql');
  for (const x of ['ADD COLUMN IF NOT EXISTS tax_reporting_category TEXT', 'ap_invoices_tax_reporting_category_check', 'trg_ap_invoice_tax_category_audit', 'ap_invoice_tax_category_lock']) assert.ok(m.includes(x), x);
});
check('NULL categories -> vendor default; 477 rewrites no bill, payment or vendor', () => {
  const m = code('migrations/477_vendor_tax_reporting_status.sql').replace(/--.*$/gm, '');
  assert.ok(!/UPDATE\s+(vendors|ap_payments|ap_invoices)\b/i.test(m));
});
check('W-9 shortcut CLOSED; exemption CONFIRMED by an admin with provenance; reimbursement relabel audited', () => {
  const v = src('api/vendors.js');
  const patch = v.slice(v.indexOf("router.patch('/:vendorId'"), v.indexOf("router.patch('/:vendorId'") + 5000);
  assert.ok(/w9_document_required/.test(patch) && /if \(cur && cur\.w9_on_file === true\) \{ delete update\.w9_on_file; \}/.test(patch));
  const allowed = patch.slice(patch.indexOf('const allowed'), patch.indexOf('];', patch.indexOf('const allowed')));
  assert.ok(!/tax_reporting_status|tax_exemption_|'kind'/.test(allowed));
  const ep = v.slice(v.indexOf("router.post('/:vendorId/tax-exemption'"), v.indexOf('// GET /api/vendors/documents/:docId/file'));
  assert.ok(/requireAdmin\(req, res\)/.test(ep) && /tax_exemption_verified_by: who/.test(ep) && /document_mismatch/.test(ep) && /note_required/.test(ep));
  assert.ok(/'kind', OLD\.kind, 'reimbursee_contact_id', OLD\.reimbursee_contact_id/.test(src('migrations/477_vendor_tax_reporting_status.sql')));
});
check('no hard-coded $600; Bedrock gets no special treatment; no override', () => {
  const v = src('api/vendors.js'); assert.ok(!/ytd >= 60000|CENTS_1099_THRESHOLD = 60000/.test(v));
  for (const f of ['lib/tax/reportable_payments.js', 'lib/tax/payment_gate.js', 'lib/tax/info_reporting.js']) {
    assert.ok(!/bedrock|BEDROCK_MGMT_CO_ID|management_compan/i.test(code(f)), f);
    assert.ok(!/override|bypass\s*[:=]|force\s*[:=]/i.test(code(f)), f);
  }
});

(async () => {
  let pass = 0, fail = 0;
  console.log('1099 W-9 compliance (informational) (Issue #14)');
  for (const [n, fn] of tests) { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + e.message); } }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
