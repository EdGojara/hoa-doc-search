// tests/test_stripe_payout_rec.js  (Ed 2026-11-27)
// Stripe payout reconciliation: staging a payout's components from the webhook
// (lib/payments/stripe_payouts.js), matching it to ONE bank deposit inside Kat's
// monthly bank rec with a proposed Dr cash / Cr Stripe clearing entry (never
// posted here), and the month-end tie-out that brings Stripe clearing back to
// zero with every difference surfaced (lib/banking/stripe_clearing.js).
// Offline: fakes only. Shapes follow the design note's Waterview worked example.
// Run: node tests/test_stripe_payout_rec.js
const assert = require('assert');
const { buildPayoutRows, stagePayout, failPayout } = require('../lib/payments/stripe_payouts');
const { reconcileAccountMonth, reportText } = require('../lib/banking/monthly_rec');
const { tieOut } = require('../lib/banking/stripe_clearing');

let failed = 0;
const queue = [];
const t = (name, fn) => queue.push([name, fn]);
const quiet = { log() {}, warn() {}, error() {} };
const A = 142500;            // one $1,425.00 assessment
const COMM = 'comm-wv';
const ts = (d) => Math.floor(Date.parse(`${d}T18:00:00Z`) / 1000);

// ================================================================ staging (webhook side)
const payments = [
  { id: 'P1', community_id: COMM, payment_group_id: 'g1', processor_payment_id: 'pi_1', amount_cents: A, trusted_account_number: '10100001' },
  { id: 'P2', community_id: COMM, payment_group_id: 'g2', processor_payment_id: 'pi_2', amount_cents: A, trusted_account_number: '10100002' },
  { id: 'P3', community_id: COMM, payment_group_id: 'g3', processor_payment_id: 'pi_3', amount_cents: A, trusted_account_number: '10100003' },
  { id: 'PX', community_id: 'comm-other', payment_group_id: 'gx', processor_payment_id: 'pi_x', amount_cents: A, trusted_account_number: '20100001' },
];
const comp = (id, type, amt, pi, created = ts('2026-12-01')) => ({ balance_txn_id: id, type, amount_cents: amt, fee_cents: 0, created, platform_charge_id: pi ? `ch_${pi}` : null, payment_intent_id: pi, payment_group_id: null, resolved: !!pi });
const payout1 = { id: 'po_1', amount: A, arrival_date: ts('2026-12-04') };

t('components tie to payments by PaymentIntent and amount; a refund ties as the negative', () => {
  const rows = buildPayoutRows({ payout: payout1, communityId: COMM, payments,
    components: [comp('txn_1', 'payment', A, 'pi_1'), comp('txn_3', 'payment', A, 'pi_3'), comp('txn_3r', 'payment_refund', -A, 'pi_3', ts('2026-12-02'))] });
  assert.deepStrictEqual(rows.map((r) => [r.payment_id, r.resolution]), [['P1', 'tied'], ['P3', 'tied'], ['P3', 'tied']]);
  assert.ok(rows.every((r) => r.kind === 'stripe' && r.source_filename === 'stripe:webhook' && r.payout_date === '2026-12-04' && r.processor_payout_id === 'po_1'));
  assert.strictEqual(rows[0].account_ref, '10100001');
  assert.strictEqual(rows[2].trxn_date, '2026-12-02');
});
t('untraceable, partial, and another community\'s components stay unresolved (never guessed)', () => {
  const rows = buildPayoutRows({ payout: { ...payout1, amount: 100 }, communityId: COMM, payments,
    components: [comp('txn_a', 'payment', A, null), comp('txn_b', 'payment_refund', -50000, 'pi_2'), comp('txn_c', 'payment', A, 'pi_x')] });
  assert.ok(rows.every((r) => r.resolution === 'unresolved' && r.resolution_note));
  assert.strictEqual(rows[2].payment_id, null, 'another community\'s payment is never linked');
});
t('a payout Stripe will not itemize is staged whole and unresolved', () => {
  const rows = buildPayoutRows({ payout: payout1, communityId: COMM, payments, components: [] });
  assert.strictEqual(rows.length, 1); assert.strictEqual(rows[0].resolution, 'unresolved'); assert.strictEqual(rows[0].amount_cents, A);
});

function fakeSb(tables) {
  const db = JSON.parse(JSON.stringify(tables));
  const from = (table) => {
    const f = []; let op = 'select'; let payload = null; let opts = {}; let lim = null;
    const run = () => {
      db[table] = db[table] || [];
      const match = db[table].filter((r) => f.every((x) => x(r)));
      if (op === 'upsert') {
        for (const r of payload) {
          const k = opts.onConflict; const hit = db[table].find((x) => x[k] === r[k]);
          if (hit) { if (!opts.ignoreDuplicates) Object.assign(hit, r); } else db[table].push({ id: `r${db[table].length + 1}`, ...r });
        }
        return { data: null, error: null };
      }
      if (op === 'update') { match.forEach((r) => Object.assign(r, payload)); return { data: match, error: null }; }
      return { data: lim ? match.slice(0, lim) : match, error: null };
    };
    const b = { select() { return b; }, eq(c, v) { f.push((r) => String(r[c]) === String(v)); return b; }, in(c, vs) { f.push((r) => vs.includes(r[c])); return b; },
      limit(n) { lim = n; return b; }, upsert(rows, o) { op = 'upsert'; payload = rows; opts = o || {}; return b; }, update(p) { op = 'update'; payload = p; return b; },
      then(res, rej) { try { res(run()); } catch (e) { rej(e); } } };
    return b;
  };
  return { from, db };
}
const stripeFake = (components) => ({ calls: 0, async listPayoutComponents() { this.calls++; return { ok: true, components }; } });
const assessmentRows = payments.map((p) => ({ ...p, product_type: 'assessment_payment', fee_type: 'assessment' }));

t('stagePayout: a replayed payout.paid stages nothing twice', async () => {
  const sb = fakeSb({ communities: [{ id: COMM, name: 'Waterview', stripe_connected_account_id: 'acct_wv' }], payments: assessmentRows, bank_rec_payouts: [] });
  const sl = stripeFake([comp('txn_1', 'payment', A, 'pi_1')]);
  const a = await stagePayout({ supabase: sb, stripeLib: sl, log: quiet }, payout1, 'acct_wv');
  const b = await stagePayout({ supabase: sb, stripeLib: sl, log: quiet }, payout1, 'acct_wv');
  assert.strictEqual(a.action, 'staged'); assert.ok(a.ties); assert.strictEqual(b.action, 'staged');
  assert.strictEqual(sb.db.bank_rec_payouts.length, 1);
});
t('stagePayout: an unknown connected account stages nothing; a Stripe error throws (Stripe re-delivers)', async () => {
  const sb = fakeSb({ communities: [], payments: assessmentRows, bank_rec_payouts: [] });
  assert.strictEqual((await stagePayout({ supabase: sb, stripeLib: stripeFake([]), log: quiet }, payout1, 'acct_zz')).action, 'unknown_account');
  const sb2 = fakeSb({ communities: [{ id: COMM, stripe_connected_account_id: 'acct_wv' }], payments: assessmentRows, bank_rec_payouts: [] });
  await assert.rejects(stagePayout({ supabase: sb2, stripeLib: { async listPayoutComponents() { return { ok: false, error: 'rate limited' }; } }, log: quiet }, payout1, 'acct_wv'));
  assert.strictEqual(sb2.db.bank_rec_payouts.length, 0);
});
t('stagePayout: components that do not sum to the payout are reported', async () => {
  const sb = fakeSb({ communities: [{ id: COMM, stripe_connected_account_id: 'acct_wv' }], payments: assessmentRows, bank_rec_payouts: [] });
  const r = await stagePayout({ supabase: sb, stripeLib: stripeFake([comp('txn_1', 'payment', A, 'pi_1')]), log: quiet }, { ...payout1, amount: A + 1 }, 'acct_wv');
  assert.strictEqual(r.ties, false);
});
t('failPayout marks the staged rows failed', async () => {
  const sb = fakeSb({ communities: [{ id: COMM, stripe_connected_account_id: 'acct_wv' }], bank_rec_payouts: [{ id: 'x', community_id: COMM, processor_payout_id: 'po_1', payout_status: 'paid' }] });
  const r = await failPayout({ supabase: sb, log: quiet }, { id: 'po_1', failure_code: 'account_closed' }, 'acct_wv');
  assert.strictEqual(r.rows, 1); assert.strictEqual(sb.db.bank_rec_payouts[0].payout_status, 'failed');
});

// ================================================================ the bank rec (Kat's run)
// The design note's week: Mon C1, C3 (cards) and A2 (ACH); Tue C3 refunded; Thu payout po_1
// (C1 + C3 - C3 refund = $1,425); next Tue payout po_2 (A2).
const account = { id: 'ba1', label: 'Operating 5313', gl_account_number: '1000' };
const opening = { as_of_date: '2026-11-30', bank_balance_cents: 0, outstanding_checks: [], deposits_in_transit: [] };
let n = 0;
const bk = (date, amt, desc) => ({ id: `b${++n}`, bank_statement_import_id: 'imp12', posting_date: date, amount_cents: amt, description: desc, check_number: null, transaction_type: 'ach_in' });
const cl = (date, amt, ref) => ({ id: `l${++n}`, posting_date: date, amount_cents: amt, source_reference: ref, reference: `JE-${n}` });
const stage = (po, arrival, rows) => rows.map(([bt, type, amt, pid], i) => ({ id: `${po}-${i}`, kind: 'stripe', processor_payout_id: po, balance_txn_id: bt, txn_type: type, amount_cents: amt, payment_id: pid,
  payout_status: 'paid', arrival_date: arrival, payout_date: arrival, payout_amount_cents: rows.reduce((s, r) => s + r[2], 0), resolution: pid ? 'tied' : 'unresolved', resolution_note: pid ? null : 'untraced' }));
const PAY = { C1: { id: 'C1', confirmation_number: 'BP-AAAA-0001', posting_state: 'posted', amount_cents: A }, C3: { id: 'C3', confirmation_number: 'BP-AAAA-0003', posting_state: 'reversed', amount_cents: A },
  A2: { id: 'A2', confirmation_number: 'BP-AAAA-0002', posting_state: 'posted', amount_cents: A } };
const payoutRows = [
  ...stage('po_1', '2026-12-04', [['txn_c1', 'payment', A, 'C1'], ['txn_c3', 'payment', A, 'C3'], ['txn_c3r', 'payment_refund', -A, 'C3']]),
  ...stage('po_2', '2026-12-08', [['txn_a2', 'payment', A, 'A2']]),
];
const clearing0 = [cl('2026-12-01', A, 'stripe:pay:C1'), cl('2026-12-01', A, 'stripe:pay:C3'), cl('2026-12-02', -A, 'stripe:rev:C3'), cl('2026-12-01', A, 'stripe:pay:A2')];
function input({ bank, glLines = [], clearing = clearing0, payouts = payoutRows, pay = PAY, codings = [] }) {
  const stmt = { id: 'imp12', statement_period_start: '2026-12-01', statement_period_end: '2026-12-31', beginning_balance_cents: 0, ending_balance_cents: bank.reduce((s, x) => s + x.amount_cents, 0) };
  return { account, period_start: '2026-12-01', period_end: '2026-12-31', opening, statements: [stmt], bankTxns: bank, glLines, otherBankTxns: [], homeownerPayments: [], settings: {}, codings,
    payouts, deposits: [], stripeClearing: { operating_cash_account_number: '1000', clearing_account_number: '1090', clearingLines: clearing, payouts, payments: pay } };
}
const bankWeek = () => [bk('2026-12-04', A, 'STRIPE TRANSFER ST-P1'), bk('2026-12-09', A, 'STRIPE TRANSFER ST-P2')];

t('prepare: each payout becomes ONE proposed Dr 1000 / Cr 1090 entry keyed stripe:payout:<po>; nothing posts', () => {
  const r = reconcileAccountMonth(input({ bank: bankWeek() }));
  const ps = r.proposals.filter((p) => p.id.startsWith('stripe_payout:'));
  assert.deepStrictEqual(ps.map((p) => p.source_reference), ['stripe:payout:po_1', 'stripe:payout:po_2']);
  for (const p of ps) {
    assert.strictEqual(p.kind, 'journal_entry');
    assert.deepStrictEqual(p.lines.map((l) => [l.account_number, l.debit_cents, l.credit_cents]), [['1000', A, 0], ['1090', 0, A]]);
    assert.ok(p.evidence.basis.includes('BP-AAAA-0001') || p.evidence.basis.includes('BP-AAAA-0002'));
    assert.ok(p.evidence.bank_transaction_id);
  }
  assert.ok(r.items.filter((i) => i.match_method === 'stripe_payout').length === 2);
  assert.notStrictEqual(r.status, 'reconciled', 'an unapproved proposal keeps the month open');
  assert.strictEqual(r.stripe_clearing.untied_cents, 0);
  assert.strictEqual(r.stripe_clearing.balance_cents, 2 * A);
});
t('after approval: the posted payouts clear their bank lines and Stripe clearing is back to zero, reconciled', () => {
  const glLines = [
    { id: 'g1', je_id: 'je1', reference: 'JE-101', posting_date: '2026-12-04', amount_cents: A, memo: 'Stripe payout po_1 2026-12-04', description: 'Stripe payout po_1', source_module: 'bank_reconciliation' },
    { id: 'g2', je_id: 'je2', reference: 'JE-102', posting_date: '2026-12-09', amount_cents: A, memo: 'Stripe payout po_2 2026-12-09', description: 'Stripe payout po_2', source_module: 'bank_reconciliation' },
  ];
  const clearing = [...clearing0, cl('2026-12-04', -A, 'stripe:payout:po_1'), cl('2026-12-09', -A, 'stripe:payout:po_2')];
  const r = reconcileAccountMonth(input({ bank: bankWeek(), glLines, clearing }));
  assert.strictEqual(r.proposals.length, 0);
  assert.strictEqual(r.stripe_clearing.balance_cents, 0); assert.strictEqual(r.stripe_clearing.untied_cents, 0);
  assert.strictEqual(r.status, 'reconciled', JSON.stringify(r.exceptions.filter((e) => e.severity !== 'info')));
  assert.ok(r.exceptions.find((e) => e.code === 'stripe_clearing_position').text.includes('Back to zero'));
  assert.ok(reportText(r).includes('Stripe clearing 1090'));
});
t('a payout with a component not tied to a payment is an exception, not a proposal', () => {
  const payouts = [...stage('po_9', '2026-12-04', [['txn_c1', 'payment', A, 'C1'], ['txn_zz', 'payment', 5000, null]])];
  const r = reconcileAccountMonth(input({ bank: [bk('2026-12-04', A + 5000, 'STRIPE TRANSFER')], payouts, clearing: [cl('2026-12-01', A, 'stripe:pay:C1')] }));
  assert.strictEqual(r.proposals.length, 0);
  const e = r.exceptions.find((x) => x.code === 'stripe_payout_untied');
  assert.ok(e && /not tied/.test(e.text), JSON.stringify(r.exceptions));
});
t('a payout containing a payment not posted to the GL is an exception', () => {
  const pay = { ...PAY, C1: { ...PAY.C1, posting_state: 'blocked' } };
  const payouts = stage('po_1', '2026-12-04', [['txn_c1', 'payment', A, 'C1']]);
  const r = reconcileAccountMonth(input({ bank: [bk('2026-12-04', A, 'STRIPE TRANSFER')], payouts, pay, clearing: [] }));
  assert.strictEqual(r.proposals.length, 0);
  assert.ok(r.exceptions.some((x) => x.code === 'stripe_payout_untied' && /not posted/.test(x.text)));
});
t('a refund in a payout without its posted reversal is an exception', () => {
  const pay = { ...PAY, C3: { ...PAY.C3, posting_state: 'posted' } };
  const r = reconcileAccountMonth(input({ bank: bankWeek(), pay }));
  assert.ok(r.exceptions.some((x) => x.code === 'stripe_payout_untied' && /no reversal is posted/.test(x.text)));
  assert.deepStrictEqual(r.proposals.map((p) => p.payout_id), ['po_2']);
});
t('two deposits equally near the arrival date: ambiguous, nothing proposed', () => {
  const payouts = stage('po_2', '2026-12-08', [['txn_a2', 'payment', A, 'A2']]);
  const r = reconcileAccountMonth(input({ bank: [bk('2026-12-07', A, 'STRIPE TRANSFER'), bk('2026-12-09', A, 'STRIPE TRANSFER')], payouts, clearing: [cl('2026-12-01', A, 'stripe:pay:A2')] }));
  assert.strictEqual(r.proposals.length, 0);
  assert.ok(r.exceptions.some((x) => x.code === 'stripe_payout_ambiguous'));
});
t('a deposit on the arrival date wins over a later one of the same amount', () => {
  const payouts = stage('po_2', '2026-12-08', [['txn_a2', 'payment', A, 'A2']]);
  const bank = [bk('2026-12-08', A, 'STRIPE TRANSFER'), bk('2026-12-09', A, 'STRIPE TRANSFER')];
  const r = reconcileAccountMonth(input({ bank, payouts, clearing: [cl('2026-12-01', A, 'stripe:pay:A2')] }));
  assert.deepStrictEqual(r.proposals.map((p) => p.evidence.bank_transaction_id), [bank[0].id]);
});
t('a week of daily $1,425 payouts: each takes its own deposit', () => {
  const ids = ['P1', 'P2', 'P3', 'P4', 'P5'];
  const pay = Object.fromEntries(ids.map((id, i) => [id, { id, confirmation_number: `BP-AAAA-000${i}`, posting_state: 'posted', amount_cents: A }]));
  const payouts = ids.flatMap((id, i) => stage(`po_d${i}`, `2026-12-0${i + 1}`, [[`txn_${id}`, 'payment', A, id]]));
  const bank = ids.map((_, i) => bk(`2026-12-0${i + 1}`, A, 'STRIPE TRANSFER'));
  const r = reconcileAccountMonth(input({ bank, payouts, pay, clearing: ids.map((id) => cl('2026-11-30', A, `stripe:pay:${id}`)).map((l) => ({ ...l, posting_date: '2026-12-01' })) }));
  assert.deepStrictEqual(r.proposals.map((p) => [p.payout_id, p.posting_date]), ids.map((_, i) => [`po_d${i}`, `2026-12-0${i + 1}`]));
});
t('a deposit naming another channel (Vantaca, ProPay, lockbox) is never taken as a Stripe payout', () => {
  const payouts = stage('po_2', '2026-12-08', [['txn_a2', 'payment', A, 'A2']]);
  const r = reconcileAccountMonth(input({ bank: [bk('2026-12-08', A, 'VANTACA - PAYOUT')], payouts, clearing: [cl('2026-12-01', A, 'stripe:pay:A2')] }));
  assert.strictEqual(r.proposals.length, 0);
});
t('a deposit outside the arrival window is not matched; the payout is flagged as not matched', () => {
  const payouts = stage('po_2', '2026-12-08', [['txn_a2', 'payment', A, 'A2']]);
  const r = reconcileAccountMonth(input({ bank: [bk('2026-12-20', A, 'STRIPE TRANSFER')], payouts, clearing: [cl('2026-12-01', A, 'stripe:pay:A2')] }));
  assert.strictEqual(r.proposals.length, 0);
  assert.ok(r.exceptions.some((x) => x.code === 'stripe_payout_not_matched'));
});
t('a coding supplied by a person wins over the automatic match', () => {
  const bank = bankWeek();
  const r = reconcileAccountMonth(input({ bank, codings: [{ bank_transaction_id: bank[0].id, account_number: '4999', basis: 'owner said so' }] }));
  assert.ok(!r.proposals.some((p) => p.payout_id === 'po_1'));
  assert.ok(r.proposals.some((p) => p.id === `coded:${bank[0].id}`));
});
t('Stripe rows are never fed to the Vantaca payout-contents pass', () => {
  // Without stripeClearing (e.g. a reserve account), the STRIPE deposit is just a receipt to identify.
  const inp = input({ bank: bankWeek() }); delete inp.stripeClearing;
  const r = reconcileAccountMonth(inp);
  assert.ok(!r.items.some((i) => i.match_method === 'payout_group'));
  assert.strictEqual(r.proposals.length, 0);
});

// ================================================================ month-end tie-out (pure)
t('tie-out: payments waiting on a payout are explained, not a difference', () => {
  const r = tieOut({ periodEnd: '2026-12-03', sc: { clearing_account_number: '1090', clearingLines: clearing0, payouts: payoutRows, payments: PAY } });
  assert.strictEqual(r.summary.balance_cents, 2 * A); assert.strictEqual(r.summary.untied_cents, 0);
  assert.ok(!r.exceptions.some((e) => e.severity === 'open'));
});
t('tie-out: a booked payout that does not equal its payments is stripe_clearing_untied', () => {
  const clearing = [...clearing0, cl('2026-12-04', -(A - 100), 'stripe:payout:po_1')];
  const r = tieOut({ periodEnd: '2026-12-31', sc: { clearing_account_number: '1090', clearingLines: clearing, payouts: payoutRows, payments: PAY } });
  assert.strictEqual(r.summary.untied_cents, 100);
  assert.ok(r.exceptions.some((e) => e.code === 'stripe_clearing_untied' && e.severity === 'open'));
});
t('tie-out: a payment with no payout after 10 days is overdue', () => {
  const r = tieOut({ periodEnd: '2026-12-31', sc: { clearing_account_number: '1090', clearingLines: [cl('2026-12-01', A, 'stripe:pay:C1')], payouts: [], payments: PAY } });
  const e = r.exceptions.find((x) => x.code === 'stripe_payout_overdue');
  assert.ok(e && e.text.includes('BP-AAAA-0001'));
});
t('tie-out: a non-Stripe entry in 1090 is surfaced', () => {
  const r = tieOut({ periodEnd: '2026-12-31', sc: { clearing_account_number: '1090', clearingLines: [{ id: 'm', posting_date: '2026-12-15', amount_cents: 500, source_reference: null, reference: 'JE-900' }], payouts: [], payments: {} } });
  assert.ok(r.exceptions.some((x) => x.code === 'stripe_clearing_foreign_entry'));
  assert.ok(r.exceptions.some((x) => x.code === 'stripe_clearing_untied'));
});
t('tie-out: a payout that failed after it was booked is surfaced', () => {
  const failedRows = payoutRows.map((r) => (r.processor_payout_id === 'po_2' ? { ...r, payout_status: 'failed' } : r));
  const clearing = [...clearing0, cl('2026-12-04', -A, 'stripe:payout:po_1'), cl('2026-12-09', -A, 'stripe:payout:po_2')];
  const r = tieOut({ periodEnd: '2026-12-31', sc: { clearing_account_number: '1090', clearingLines: clearing, payouts: failedRows, payments: PAY } });
  assert.ok(r.exceptions.some((x) => x.code === 'stripe_payout_failed_after_posting'));
});
t('tie-out: a failed payout is never proposed', () => {
  const failedRows = payoutRows.map((r) => (r.processor_payout_id === 'po_2' ? { ...r, payout_status: 'failed' } : r));
  const r = reconcileAccountMonth(input({ bank: bankWeek(), payouts: failedRows }));
  assert.deepStrictEqual(r.proposals.map((p) => p.payout_id), ['po_1']);
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); console.log('PASS ', name); } catch (e) { failed++; console.log('FAIL ', name, '\n   ', e.message); }
  }
  console.log(failed ? `\n${failed} FAILED` : `\nall ${queue.length} passed`);
  process.exit(failed ? 1 : 0);
})();
