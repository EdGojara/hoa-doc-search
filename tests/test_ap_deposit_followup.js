// tests/test_ap_deposit_followup.js — vendor deposit -> balance-due follow-up
// (Ed 2026-09-28, PRYME THYME KOOKERS #2836; revised after ChatGPT code review).
// Offline. Proves:
//   * every final-bill form nets the deposit correctly, paid AND unpaid;
//   * the obligation stays visible until the final bill is actually paid;
//   * the approval gate HOLDS any bill from a vendor with an outstanding deposit
//     (driven by the deposits, not by whether a proposal was written) and fails
//     closed; only a reviewed "unrelated" or an admin-recorded adjusting entry
//     (live re-check) releases it;
//   * intake -> proposal -> gate end to end on the real commitInvoice, with a
//     deposit's lines staying on 1430 and nothing paid, posted or re-amounted.
// The SQL functions' atomicity/state machine are proven in
// tests/sql/471_deposit_followups_rehearsal.mjs.
const assert = require('assert');
const path = require('path');

let failed = 0;
const results = [];
const t = (name, fn) => results.push((async () => {
  try { await fn(); console.log('PASS ', name); } catch (e) { failed++; console.log('FAIL ', name, '\n   ', e.message); }
})());

const { fakeDb } = require('./_fake_supabase_deposits');
const MONEY_TABLES = ['ap_payments', 'ap_payment_applications', 'check_register'];
const noMoneyMoved = (sb) => assert.ok(!sb._writes.some((w) => MONEY_TABLES.includes(w.table)), 'nothing paid');

// ---------------------------------------------------------------- pure reconciler
const { reconcileDeposit, approvalBlockers, forceDepositLineCoding, invariantHolds } = require('../lib/ap/deposit_reconcile');
const DEP = { id: 'dep-1', community_id: 'c1', vendor_id: 'v1', deposit_invoice_id: 'inv-dep', deposit_amount_cents: 334250, remaining_balance_cents: 334250, status: 'outstanding' };
const DEP_INV_UNPAID = { id: 'inv-dep', vendor_invoice_number: '2836', total_cents: 334250, amount_paid_cents: 0, status: 'awaiting_approval', file_sha256: 'aaa' };
const DEP_INV_PAID = { ...DEP_INV_UNPAID, amount_paid_cents: 334250, status: 'paid' };
const bill = (o) => ({ vendor_invoice_number: '2901', total_cents: 334250, tax_cents: 0, file_sha256: 'bbb', ...o });
const fullLines = [{ description: 'Burger Combo (500 servings) + Tent Setup', amount_cents: 668500 }, { description: 'Less deposit paid (inv 2836)', amount_cents: -334250 }];

t('form 1 balance only, deposit paid: net due = the balance', () => {
  const r = reconcileDeposit({ deposit: DEP, depositInvoice: DEP_INV_PAID, incoming: bill() });
  assert.deepStrictEqual([r.form, r.net_due_cents, r.final_total_cents, r.deposit_still_owed_cents], ['balance_only', 334250, 668500, 0]);
  assert.ok(r.invariant_ok && !r.needs_review && r.warnings.includes('agreed_total_is_an_estimate'));
});
t('form 1 balance only, deposit NOT paid: net is the balance; the deposit bill stays owed', () => {
  const r = reconcileDeposit({ deposit: DEP, depositInvoice: DEP_INV_UNPAID, incoming: bill() });
  assert.deepStrictEqual([r.net_due_cents, r.deposit_still_owed_cents, r.outstanding_obligation_cents], [334250, 334250, 668500]);
  assert.ok(r.warnings.includes('deposit_not_yet_paid') && r.invariant_ok);
});
t('form 2 full total with deposit credit, deposit paid: pay total less deposit, never the total', () => {
  const r = reconcileDeposit({ deposit: DEP, depositInvoice: DEP_INV_PAID, incoming: bill({ total_cents: 334250 }), incomingLines: fullLines });
  assert.deepStrictEqual([r.form, r.final_total_cents, r.credits_shown_cents, r.net_due_cents], ['full_total_less_deposit', 668500, 334250, 334250]);
  assert.ok(r.invariant_ok && !r.needs_review);
});
t('form 2 with credit but deposit NOT paid: flagged; total still paid exactly once across both bills', () => {
  const r = reconcileDeposit({ deposit: DEP, depositInvoice: DEP_INV_UNPAID, incoming: bill({ total_cents: 334250 }), incomingLines: fullLines });
  assert.ok(r.reasons.includes('vendor_credited_a_deposit_not_yet_paid') && r.needs_review && r.invariant_ok);
  assert.deepStrictEqual([r.net_due_cents, r.outstanding_obligation_cents], [334250, 668500]);
});
t('form 2 full total WITHOUT a credit: net = face less deposit billed; the face is never the payable', () => {
  const r = reconcileDeposit({ deposit: DEP, depositInvoice: DEP_INV_PAID, incoming: bill({ total_cents: 668500 }), incomingLines: [{ description: 'Event catering + tent', amount_cents: 668500 }] });
  assert.deepStrictEqual([r.form, r.net_due_cents], ['full_total_less_deposit', 334250]);
  assert.ok(r.reasons.includes('full_total_billed_without_deposit_credit'));
});
t('form 3 revised balance with extras and tax: variance flagged with the math', () => {
  const r = reconcileDeposit({ deposit: DEP, depositInvoice: DEP_INV_PAID, incoming: bill({ total_cents: 367250, tax_cents: 5000 }),
    incomingLines: [{ description: 'Balance per agreement', amount_cents: 334250 }, { description: 'Additional 50 servings', amount_cents: 28000 }, { description: 'Sales tax', amount_cents: 5000 }] });
  assert.deepStrictEqual([r.form, r.net_due_cents, r.final_total_cents, r.variance_cents], ['revised_total', 367250, 701500, 33000]);
  assert.ok(r.needs_review && r.math.length >= 2 && r.invariant_ok);
});
t('form 3 revised FULL total with no credit: read as full total, still reviewed', () => {
  const r = reconcileDeposit({ deposit: DEP, depositInvoice: DEP_INV_PAID, incoming: bill({ total_cents: 700000 }), incomingLines: [{ description: 'Event total revised', amount_cents: 700000 }] });
  assert.deepStrictEqual([r.form, r.final_total_cents, r.net_due_cents], ['revised_total', 700000, 365750]);
  assert.ok(r.reasons.includes('read_as_revised_full_total_without_credit'));
});
t('form 4 re-sent deposit invoice (same number or file) and statements: not payable', () => {
  for (const inc of [bill({ vendor_invoice_number: '2836' }), bill({ vendor_invoice_number: 'X-9', file_sha256: 'aaa' })]) {
    const r = reconcileDeposit({ deposit: DEP, depositInvoice: DEP_INV_UNPAID, incoming: inc });
    assert.deepStrictEqual([r.form, r.net_due_cents], ['duplicate_or_statement', 0]);
  }
  assert.strictEqual(reconcileDeposit({ deposit: DEP, depositInvoice: DEP_INV_PAID, incoming: bill(), isStatement: true }).form, 'duplicate_or_statement');
});
t('ambiguous: a second same-amount "deposit" (Texas Access pattern), or no agreed total to compare', () => {
  const a = reconcileDeposit({ deposit: DEP, depositInvoice: DEP_INV_PAID, incoming: bill({ is_deposit_invoice: true }) });
  assert.ok(a.form === 'ambiguous' && a.net_due_cents === null && a.reasons.includes('looks_like_second_deposit_or_completion'));
  assert.strictEqual(reconcileDeposit({ deposit: { ...DEP, remaining_balance_cents: null }, depositInvoice: DEP_INV_PAID, incoming: bill({ total_cents: 400000 }) }).form, 'ambiguous');
});
t('a zero or negative net is a credit/refund, never an ordinary payable', () => {
  const r = reconcileDeposit({ deposit: { ...DEP, agreed_total_cents: 300000, agreed_total_basis: 'contract' }, depositInvoice: DEP_INV_PAID,
    incoming: bill({ total_cents: 1 }), incomingLines: [{ description: 'Event total', amount_cents: 300000 }, { description: 'Less deposit', amount_cents: -334250 }] });
  assert.ok(r.reasons.includes('net_due_not_positive_credit_or_refund') && r.needs_review, JSON.stringify(r.reasons));
});
t('invariant and blockers', () => {
  assert.ok(invariantHolds({ form: 'balance_only', deposit_paid_cents: 100, deposit_still_owed_cents: 0, net_due_cents: 100, final_total_cents: 200 }));
  assert.ok(!invariantHolds({ form: 'balance_only', deposit_paid_cents: 100, deposit_still_owed_cents: 0, net_due_cents: 200, final_total_cents: 200 }));
  assert.deepStrictEqual(approvalBlockers({ form: 'full_total_less_deposit', net_due_cents: 334250, needs_review: false }, { total_cents: 668500 }), ['invoice_total_not_net_due']);
});
t('deposit bill lines follow the deposit (1430) account, not the line classifier', () => {
  const out = forceDepositLineCoding([{ description: 'Burger Combo', amount_cents: 334250, gl_account_id: 'acct-5900' }], { account_id: 'acct-1430', reason: 'Deposit' });
  assert.ok(out[0].gl_account_id === 'acct-1430' && out[0].needs_review);
});

// ---------------------------------------------------------------- DB layer on the fake
const df = require('../lib/ap/deposit_followup');
const seed = (depInv = DEP_INV_UNPAID, extraInvoices = [], more = {}) => ({
  vendor_deposits: [{ ...DEP }],
  ap_invoices: [{ ...depInv, community_id: 'c1', vendor_id: 'v1', notes: 'Emma: DEPOSIT invoice' }, ...extraInvoices.map((i) => ({ community_id: 'c1', vendor_id: 'v1', status: 'awaiting_approval', notes: '', amount_paid_cents: 0, tax_cents: 0, ...i }))],
  ap_invoice_lines: [], ap_invoice_documents: [], vendor_deposit_reconciliations: [], vendor_deposit_reconciliation_decisions: [], vendor_deposit_events: [],
  journal_entries: [{ id: 'je-adj', community_id: 'c1', status: 'posted', reference: 'JE-2026-00340' }],
  ...more,
});
const inv = (sb, id) => sb._db.ap_invoices.find((i) => i.id === id);

t('gate: a bill from a vendor with an outstanding deposit is HELD even with no proposal at all', async () => {
  const sb = fakeDb(seed(DEP_INV_PAID, [{ id: 'inv-final', vendor_invoice_number: '2901', total_cents: 334250 }]));
  assert.strictEqual((await df.approvalGateForInvoice(sb, inv(sb, 'inv-final'))).reason, 'deposit_reconciliation_missing');
  assert.strictEqual((await df.approvalGateForInvoice(sb, inv(sb, 'inv-dep'))).block, false, "the deposit's own bill is not held by its own deposit");
  const other = { id: 'x', community_id: 'c1', vendor_id: 'v-other', total_cents: 5 };
  assert.strictEqual((await df.approvalGateForInvoice(sb, other)).block, false, 'unrelated vendors are untouched');
});
t('gate never fails open on a partial invoice row (the route-bypass class): it reloads vendor/community', async () => {
  const sb = fakeDb(seed(DEP_INV_PAID, [{ id: 'inv-final', vendor_invoice_number: '2901', total_cents: 334250 }]));
  const partial = { id: 'inv-final', status: 'awaiting_approval', total_cents: 334250, posting_journal_entry_id: 'je-x' };   // no vendor_id / community_id
  assert.strictEqual((await df.approvalGateForInvoice(sb, partial)).reason, 'deposit_reconciliation_missing');
  assert.strictEqual((await df.approvalGateForInvoice(sb, { id: 'nope' })).reason, 'deposit_check_unavailable');
  assert.strictEqual((await df.approvalGateForInvoice(sb, null)).block, true);
});
t('a re-proposal on a changed bill keeps the ORIGINAL billed amount in the record', async () => {
  const sb = fakeDb(seed(DEP_INV_PAID, [{ id: 'inv-final', vendor_invoice_number: '2901', total_cents: 668500 }]));
  await df.proposeReconciliation(sb, { depositId: 'dep-1', invoiceId: 'inv-final', actor: 'emma' });
  inv(sb, 'inv-final').total_cents = 334250;
  const p2 = await df.proposeReconciliation(sb, { depositId: 'dep-1', invoiceId: 'inv-final', actor: 'emma' });
  assert.ok(p2.reconciliation.warnings.includes('bill_amount_changed_since_first_proposal'));
  assert.ok(p2.reconciliation.math.some((m) => /Originally billed \$6685\.00/.test(m)), JSON.stringify(p2.reconciliation.math));
});
t('gate fails CLOSED when the reconciliation ledger (migration 471) is missing', async () => {
  const sb = fakeDb({ ...seed(DEP_INV_PAID, [{ id: 'inv-final', total_cents: 334250 }]), _missing: ['vendor_deposit_reconciliations'] });
  assert.strictEqual((await df.approvalGateForInvoice(sb, inv(sb, 'inv-final'))).reason, 'deposit_check_unavailable');
});
t('gate: confirmed match / pending stays HELD (Emma cannot release); reject and duplicate stay held', async () => {
  const sb = fakeDb(seed(DEP_INV_PAID, [{ id: 'inv-final', vendor_invoice_number: '2901', total_cents: 334250 }]));
  const p = await df.proposeReconciliation(sb, { depositId: 'dep-1', invoiceId: 'inv-final', actor: 'emma' });
  assert.ok(p.ok, JSON.stringify(p));
  assert.strictEqual((await df.approvalGateForInvoice(sb, inv(sb, 'inv-final'))).reason, 'deposit_accounting_pending');
  await df.decideReconciliation(sb, { reconciliationId: p.reconciliation_id, decision: 'confirmed_match', actor: 'Martha', actorUserId: 'u-m', role: 'staff' });
  assert.strictEqual((await df.approvalGateForInvoice(sb, inv(sb, 'inv-final'))).reason, 'deposit_accounting_pending', 'confirming the match does not release the bill');
  const p2 = await df.proposeReconciliation(sb, { depositId: 'dep-1', invoiceId: 'inv-final', actor: 'emma' });
  await df.decideReconciliation(sb, { reconciliationId: p2.reconciliation_id, decision: 'reject', note: 'wrong event', actor: 'Ed', actorUserId: 'u-ed', role: 'admin' });
  assert.strictEqual((await df.approvalGateForInvoice(sb, inv(sb, 'inv-final'))).reason, 'deposit_reconciliation_rejected', 'the NEWEST proposal governs');
  const p3 = await df.proposeReconciliation(sb, { depositId: 'dep-1', invoiceId: 'inv-final', actor: 'emma' });
  await df.decideReconciliation(sb, { reconciliationId: p3.reconciliation_id, decision: 'duplicate_confirmed', note: 'copy', actor: 'Ed', actorUserId: 'u-ed', role: 'admin' });
  assert.strictEqual((await df.approvalGateForInvoice(sb, inv(sb, 'inv-final'))).reason, 'duplicate_or_statement_void_it');
  noMoneyMoved(sb);
});
t('gate: admin "unrelated" releases it; multiple open deposits each need resolving', async () => {
  const sb = fakeDb(seed(DEP_INV_PAID, [{ id: 'inv-other', vendor_invoice_number: '3001', total_cents: 99900 }, { id: 'inv-dep2', vendor_invoice_number: '2837', total_cents: 50000, amount_paid_cents: 50000, status: 'paid' }],
    { vendor_deposits: [{ ...DEP }, { ...DEP, id: 'dep-2', deposit_invoice_id: 'inv-dep2', deposit_amount_cents: 50000, remaining_balance_cents: 50000 }] }));
  const a = await df.proposeReconciliation(sb, { depositId: 'dep-1', invoiceId: 'inv-other', actor: 'emma' });
  const b = await df.proposeReconciliation(sb, { depositId: 'dep-2', invoiceId: 'inv-other', actor: 'emma' });
  assert.strictEqual((await df.decideReconciliation(sb, { reconciliationId: a.reconciliation_id, decision: 'unrelated', note: 'holiday lights', actor: 'Martha', actorUserId: 'u-m', role: 'staff' })).error, 'admin_required');
  assert.strictEqual((await df.decideReconciliation(sb, { reconciliationId: a.reconciliation_id, decision: 'unrelated', actor: 'Ed', actorUserId: 'u-ed', role: 'admin' })).error, 'note_required');
  assert.strictEqual(sb._db.vendor_deposit_reconciliation_decisions.length, 0, 'refused decisions write nothing');
  await df.decideReconciliation(sb, { reconciliationId: a.reconciliation_id, decision: 'unrelated', note: 'holiday lights', actor: 'Ed', actorUserId: 'u-ed', role: 'admin' });
  assert.strictEqual((await df.approvalGateForInvoice(sb, inv(sb, 'inv-other'))).deposit_id, 'dep-2', 'still held by the second deposit');
  await df.decideReconciliation(sb, { reconciliationId: b.reconciliation_id, decision: 'unrelated', note: 'holiday lights', actor: 'Ed', actorUserId: 'u-ed', role: 'admin' });
  assert.strictEqual((await df.approvalGateForInvoice(sb, inv(sb, 'inv-other'))).block, false);
  assert.strictEqual(sb._db.vendor_deposits[0].status, 'outstanding', 'an unrelated bill never touches the deposit');
});
t('manual accounting: admin only, identity required, JE required, live re-check, stale proposals refused', async () => {
  const sb = fakeDb(seed(DEP_INV_UNPAID, [{ id: 'inv-final', vendor_invoice_number: '2901', total_cents: 334250 }]));
  const p = await df.proposeReconciliation(sb, { depositId: 'dep-1', invoiceId: 'inv-final', actor: 'emma' });
  const base = { reconciliationId: p.reconciliation_id, decision: 'manual_accounting_recorded', note: 'Dr 5900 / Cr 1430', accountingJeRef: 'JE-2026-00340' };
  assert.strictEqual((await df.decideReconciliation(sb, { ...base, actor: 'Ed', actorUserId: null, role: 'admin' })).error, 'identity_required');
  assert.strictEqual((await df.decideReconciliation(sb, { ...base, actor: 'Martha', actorUserId: 'u-m', role: 'staff' })).error, 'admin_required');
  assert.strictEqual((await df.decideReconciliation(sb, { ...base, accountingJeRef: 'JE-NOPE', actor: 'Ed', actorUserId: 'u-ed', role: 'admin' })).error, 'accounting_je_not_found');
  // The deposit gets paid after the proposal: the proposal is stale and must be re-run.
  inv(sb, 'inv-dep').amount_paid_cents = 334250; inv(sb, 'inv-dep').status = 'paid';
  assert.strictEqual((await df.decideReconciliation(sb, { ...base, actor: 'Ed', actorUserId: 'u-ed', role: 'admin' })).error, 'stale_reconciliation');
  const p2 = await df.proposeReconciliation(sb, { depositId: 'dep-1', invoiceId: 'inv-final', actor: 'emma' });
  const ok = await df.decideReconciliation(sb, { ...base, reconciliationId: p2.reconciliation_id, actor: 'Ed', actorUserId: 'u-ed', role: 'admin' });
  assert.ok(ok.ok, JSON.stringify(ok));
  const call = sb._rpc.filter((c) => c.fn === 'vendor_deposit_decide').pop().args;
  assert.deepStrictEqual([call.p_accounting_je_id, call.p_expected_net_cents, call.p_live_deposit_paid_cents], ['je-adj', 334250, 334250]);
  assert.strictEqual((await df.approvalGateForInvoice(sb, inv(sb, 'inv-final'))).block, false, 'released only after the recorded, re-checked accounting');
  inv(sb, 'inv-final').total_cents = 668500;
  assert.strictEqual((await df.approvalGateForInvoice(sb, inv(sb, 'inv-final'))).reason, 'invoice_changed_after_accounting');
  noMoneyMoved(sb);
  assert.ok(!sb._writes.some((w) => w.table === 'ap_invoices' || w.table === 'journal_entries' || w.table === 'vendor_deposits'), 'no AP amount, JE or deposit status written by this layer');
});
t('manual accounting refuses a full-face bill (must be netted first) and a non-positive net', async () => {
  const sb = fakeDb(seed(DEP_INV_PAID, [{ id: 'inv-final', vendor_invoice_number: '2901', total_cents: 668500 }]));
  sb._db.ap_invoice_lines.push({ invoice_id: 'inv-final', line_number: 1, description: 'Event total', amount_cents: 668500 });
  const p = await df.proposeReconciliation(sb, { depositId: 'dep-1', invoiceId: 'inv-final', actor: 'emma' });
  assert.strictEqual(p.reconciliation.net_due_cents, 334250);
  const r = await df.decideReconciliation(sb, { reconciliationId: p.reconciliation_id, decision: 'manual_accounting_recorded', note: 'x', accountingJeRef: 'JE-2026-00340', actor: 'Ed', actorUserId: 'u-ed', role: 'admin' });
  assert.strictEqual(r.error, 'invoice_total_not_net_due', JSON.stringify(r));
  assert.ok(!sb._rpc.some((c) => c.fn === 'vendor_deposit_decide'), 'refused before anything is written');
  // A credit (net <= 0): never recorded as a payable.
  const sb2 = fakeDb(seed(DEP_INV_PAID, [{ id: 'inv-cr', vendor_invoice_number: '2999', total_cents: 1 }], { vendor_deposits: [{ ...DEP, agreed_total_cents: 300000, agreed_total_basis: 'contract' }] }));
  sb2._db.ap_invoice_lines.push({ invoice_id: 'inv-cr', line_number: 1, description: 'Event total', amount_cents: 300000 }, { invoice_id: 'inv-cr', line_number: 2, description: 'Less deposit', amount_cents: -334250 });
  const p2 = await df.proposeReconciliation(sb2, { depositId: 'dep-1', invoiceId: 'inv-cr', actor: 'emma' });
  const r2 = await df.decideReconciliation(sb2, { reconciliationId: p2.reconciliation_id, decision: 'manual_accounting_recorded', note: 'x', accountingJeRef: 'JE-2026-00340', actor: 'Ed', actorUserId: 'u-ed', role: 'admin' });
  assert.strictEqual(r2.error, 'net_due_not_positive');
});
t('a real "full total less deposit" bill is NOT mistaken for a statement in the deposit context', async () => {
  const sb = fakeDb(seed(DEP_INV_PAID, [{ id: 'inv-final', vendor_invoice_number: '2901', total_cents: 334250 }]));
  sb._db.ap_invoice_lines.push({ invoice_id: 'inv-final', line_number: 1, description: 'Burger Combo + Tent Setup', amount_cents: 668500 }, { invoice_id: 'inv-final', line_number: 2, description: 'Less deposit paid', amount_cents: -334250 });
  assert.ok(require('../lib/ap/statement_lines').classifyStatement(sb._db.ap_invoice_lines).is_statement, 'the generic classifier would call it a statement');
  const p = await df.proposeReconciliation(sb, { depositId: 'dep-1', invoiceId: 'inv-final', actor: 'emma' });
  assert.deepStrictEqual([p.reconciliation.form, p.reconciliation.net_due_cents], ['full_total_less_deposit', 334250]);
  const s2 = await df.proposeReconciliation(sb, { depositId: 'dep-1', invoiceId: 'inv-final', actor: 'Martha', isStatement: true });
  assert.strictEqual(s2.reconciliation.form, 'duplicate_or_statement', 'a person can still call it a statement');
});
t('obligation stays in the queue until the final bill is PAID (not when reconciled or approved)', async () => {
  const sb = fakeDb(seed(DEP_INV_PAID, [{ id: 'inv-final', vendor_invoice_number: '2901', total_cents: 334250 }]));
  let [row] = await df.upcomingBalances(sb, { communityId: 'c1' });
  assert.strictEqual(row.obligation_state, 'waiting_for_final_bill');
  const p = await df.proposeReconciliation(sb, { depositId: 'dep-1', invoiceId: 'inv-final', actor: 'emma' });
  [row] = await df.upcomingBalances(sb, {}); assert.strictEqual(row.obligation_state, 'final_bill_held');
  await df.decideReconciliation(sb, { reconciliationId: p.reconciliation_id, decision: 'manual_accounting_recorded', note: 'adj', accountingJeRef: 'JE-2026-00340', actor: 'Ed', actorUserId: 'u-ed', role: 'admin' });
  [row] = await df.upcomingBalances(sb, {}); assert.strictEqual(row.obligation_state, 'final_bill_accounted_awaiting_payment', 'still listed while unpaid');
  inv(sb, 'inv-final').amount_paid_cents = 334250; inv(sb, 'inv-final').status = 'paid';
  [row] = await df.upcomingBalances(sb, {}); assert.strictEqual(row.obligation_state, 'final_bill_paid');
  assert.ok(/ESTIMATE/.test(row.expected_balance_label));
});
t('follow-up goes through the audited function (no bare UPDATE); identity and basis required', async () => {
  const sb = fakeDb(seed());
  assert.strictEqual((await df.setFollowup(sb, { depositId: 'dep-1', fields: { balance_due_date: '2026-10-10' }, actor: 'Ed', actorUserId: null })).error, 'identity_required');
  assert.strictEqual((await df.setFollowup(sb, { depositId: 'dep-1', fields: { agreed_total_cents: 668500 }, actor: 'Ed', actorUserId: 'u-ed' })).error, 'agreed_total_basis_required');
  const ok = await df.setFollowup(sb, { depositId: 'dep-1', fields: { event_date: '2026-10-10', balance_due_date: '2026-10-10', agreed_total_cents: 668500, agreed_total_basis: 'invoice_estimate' }, actor: 'Ed', actorUserId: 'u-ed' });
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.strictEqual(sb._rpc[0].fn, 'vendor_deposit_set_followup');
  assert.strictEqual(sb._rpc[0].args.p_patch.balance_due_basis, 'staff_entered');
  assert.ok(!sb._writes.some((w) => w.op === 'update' && w.table === 'vendor_deposits'), 'no direct UPDATE of vendor_deposits');
});

// ---------------------------------------------------------------- intake end to end (real commitInvoice, faked deps)
t('intake: deposit bill books to 1430; completion bill gets proposals and is HELD; nothing paid', async () => {
  const shared = fakeDb({
    vendors: [{ id: 'v1', auto_pay_ach: false }],
    chart_of_accounts: [
      { id: 'acct-1430', community_id: 'c1', account_number: '1430', account_name: 'Prepaid Vendor Deposits', is_active: true },
      { id: 'acct-5900', community_id: 'c1', account_number: '5900', account_name: 'Community Events', is_active: true },
      { id: 'acct-2000', community_id: 'c1', account_number: '2000', account_name: 'Accounts Payable', is_active: true },
    ],
    ap_invoices: [], ap_invoice_lines: [], vendor_deposits: [], vendor_deposit_reconciliations: [], vendor_deposit_reconciliation_decisions: [], vendor_deposit_events: [], journal_entries: [],
  });
  const posted = [];
  const mock = (rel, exports) => { const p = require.resolve(path.join('..', 'lib', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  const sbPath = require.resolve('@supabase/supabase-js');
  const realSb = require.cache[sbPath];
  require.cache[sbPath] = { id: sbPath, filename: sbPath, loaded: true, exports: { createClient: () => shared } };
  mock('ap/invoice_extract', { extractInvoice: async () => ({}) });
  mock('ap/dedup', { findDuplicates: async () => ({ verdict: 'unique', matches: [] }) });
  mock('ap/convenience_fee', { getVendorConvenienceFee: async () => ({ cents: 0 }), applyConvenienceFee: () => {} });
  mock('accounting/gl_classifier', { suggestClassification: async () => ({ account_id: 'acct-5900', confidence: 'high', reason: 'vendor history' }) });
  mock('ap/decide_path', { decideApprovalPath: async () => ({ approval_path: 'release', approval_path_reason: 'recurring' }) });
  mock('ap/code_lines', { codeInvoiceLines: async ({ lineItems }) => lineItems.map((l, i) => ({ line_number: i + 1, description: l.description, amount_cents: l.amount_cents, gl_account_id: 'acct-5900', reason: 'line classifier' })) });
  mock('ap/cutover_review', { preCutoverHold: async () => ({ hold: false }), markPendingReview: async () => {} });
  mock('accounting/posting', { postJournalEntry: async (e) => { posted.push(e); shared._db.journal_entries.push({ id: `je-${posted.length}`, community_id: e.community_id, status: 'posted' }); return { entry: { id: `je-${posted.length}` } }; } });
  delete require.cache[require.resolve('../lib/ap/intake')];
  try {
    const { commitInvoice } = require('../lib/ap/intake');
    const dep = await commitInvoice({ vendorId: 'v1', communityId: 'c1', sha256: 'aaa', intakeMethod: 'email', extracted: {
      invoice_number: '2836', invoice_date: '2026-09-22', total_cents: 334250, vendor_name: 'PRYME THYME KOOKERS', is_deposit_invoice: true, remaining_balance_cents: 334250,
      terms: '50% Non-Refundable Deposit. Balance due day of set-up', line_items: [{ description: '50% deposit — Burger Combo (500 servings) and Tent Setup', amount_cents: 334250 }] } });
    assert.strictEqual(dep.outcome, 'loaded', JSON.stringify(dep));
    assert.strictEqual(shared._db.vendor_deposits.length, 1);
    assert.strictEqual(shared._db.ap_invoice_lines[0].gl_account_id, 'acct-1430', 'deposit line stays on 1430, not the classifier 5900');
    assert.strictEqual(posted[0].lines.find((l) => l.debit_cents > 0).account_id, 'acct-1430', 'accrual debits 1430');

    const fin = await commitInvoice({ vendorId: 'v1', communityId: 'c1', sha256: 'bbb', intakeMethod: 'email', extracted: {
      invoice_number: '2901', invoice_date: '2026-10-10', total_cents: 334250, vendor_name: 'PRYME THYME KOOKERS', is_deposit_invoice: false,
      line_items: [{ description: 'Balance — Burger Combo and Tent Setup', amount_cents: 334250 }] } });
    assert.strictEqual(fin.outcome, 'loaded');
    const finalRow = shared._db.ap_invoices.find((i) => i.vendor_invoice_number === '2901');
    assert.strictEqual(finalRow.approval_path, 'manager_review', 'never on the light release path');
    assert.ok(/APPLY DEPOSIT/.test(finalRow.notes));
    assert.strictEqual(shared._db.vendor_deposit_reconciliations.length, 1);
    assert.strictEqual(shared._db.vendor_deposit_reconciliations[0].form, 'balance_only');
    assert.strictEqual((await df.approvalGateForInvoice(shared, finalRow)).reason, 'deposit_accounting_pending');

    // A second same-amount "deposit" from the same vendor: flagged, NOT a new deposit, held.
    const second = await commitInvoice({ vendorId: 'v1', communityId: 'c1', sha256: 'ccc', intakeMethod: 'email', extracted: {
      invoice_number: '2950', invoice_date: '2026-10-11', total_cents: 334250, vendor_name: 'PRYME THYME KOOKERS', is_deposit_invoice: true, remaining_balance_cents: 0,
      line_items: [{ description: '50% at completion', amount_cents: 334250 }] } });
    assert.strictEqual(second.outcome, 'loaded');
    assert.strictEqual(shared._db.vendor_deposits.length, 1, 'not recorded as a second deposit');
    const secondRow = shared._db.ap_invoices.find((i) => i.vendor_invoice_number === '2950');
    assert.ok(/DEPOSIT OR COMPLETION/.test(secondRow.notes));
    assert.strictEqual((await df.approvalGateForInvoice(shared, secondRow)).block, true);
    noMoneyMoved(shared);
    assert.strictEqual(shared._db.ap_invoices.length, 3, 'no payable created beyond the three bills received');
  } finally {
    if (realSb) require.cache[sbPath] = realSb; else delete require.cache[sbPath];
    delete require.cache[require.resolve('../lib/ap/intake')];
  }
});

(async () => {
  await Promise.all(results);
  console.log(failed ? `\n${failed} FAILED` : '\nall deposit follow-up checks passed');
  process.exitCode = failed ? 1 : 0;
})();
