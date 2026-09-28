// tests/test_ap_deposit_followup.js — vendor deposit -> balance-due follow-up
// (Ed 2026-09-28, PRYME THYME KOOKERS #2836). Offline: pure reconciler plus the
// DB layer against an in-memory fake. Proves: every final-bill form nets the
// deposit correctly (paid AND unpaid), the reminder survives the deposit being
// paid, nothing here ever pays or creates/changes a payable, and the approval
// gate refuses a bill until its reconciliation is decided at the net due.
const assert = require('assert');
const { reconcileDeposit, approvalBlockers, forceDepositLineCoding, invariantHolds } = require('../lib/ap/deposit_reconcile');
const df = require('../lib/ap/deposit_followup');

let failed = 0;
const results = [];
const t = (name, fn) => results.push((async () => {
  try { await fn(); console.log('PASS ', name); } catch (e) { failed++; console.log('FAIL ', name, '\n   ', e.message); }
})());

// PRYME THYME shape: $3,342.50 deposit, invoice states $3,342.50 balance.
const DEP = { id: 'dep-1', community_id: 'c1', vendor_id: 'v1', deposit_invoice_id: 'inv-dep', deposit_amount_cents: 334250, remaining_balance_cents: 334250, status: 'outstanding' };
const DEP_INV_UNPAID = { id: 'inv-dep', vendor_invoice_number: '2836', total_cents: 334250, amount_paid_cents: 0, status: 'awaiting_approval', file_sha256: 'aaa' };
const DEP_INV_PAID = { ...DEP_INV_UNPAID, amount_paid_cents: 334250, status: 'paid' };
const bill = (o) => ({ vendor_invoice_number: '2901', total_cents: 334250, tax_cents: 0, file_sha256: 'bbb', ...o });

// ---------------------------------------------------------------- form 1: balance only
t('form 1 balance only, deposit paid: net due = the balance; deposit untouched', () => {
  const r = reconcileDeposit({ deposit: DEP, depositInvoice: DEP_INV_PAID, incoming: bill() });
  assert.strictEqual(r.form, 'balance_only');
  assert.deepStrictEqual([r.net_due_cents, r.final_total_cents, r.deposit_still_owed_cents, r.outstanding_obligation_cents], [334250, 668500, 0, 334250]);
  assert.ok(r.invariant_ok && !r.needs_review, JSON.stringify(r.reasons));
  assert.ok(r.warnings.includes('agreed_total_is_an_estimate'), 'total derived from the deposit invoice is labeled an estimate');
});
t('form 1 balance only, deposit NOT yet paid: net due is still only the balance; the deposit bill stays owed', () => {
  const r = reconcileDeposit({ deposit: DEP, depositInvoice: DEP_INV_UNPAID, incoming: bill() });
  assert.strictEqual(r.form, 'balance_only');
  assert.deepStrictEqual([r.net_due_cents, r.deposit_still_owed_cents, r.outstanding_obligation_cents], [334250, 334250, 668500]);
  assert.ok(r.warnings.includes('deposit_not_yet_paid') && r.invariant_ok);
});

// ---------------------------------------------------------------- form 2: full total less deposit
const fullLines = [{ description: 'Burger Combo (500 servings) + Tent Setup', amount_cents: 668500 }, { description: 'Less deposit paid (inv 2836)', amount_cents: -334250 }];
t('form 2 full total with deposit credit, deposit paid: pay total less deposit, never the full total', () => {
  const r = reconcileDeposit({ deposit: DEP, depositInvoice: DEP_INV_PAID, incoming: bill({ total_cents: 334250 }), incomingLines: fullLines });
  assert.strictEqual(r.form, 'full_total_less_deposit');
  assert.deepStrictEqual([r.final_total_cents, r.credits_shown_cents, r.net_due_cents], [668500, 334250, 334250]);
  assert.ok(r.invariant_ok && !r.needs_review, JSON.stringify(r.reasons));
});
t('form 2 with credit but deposit NOT paid: flagged; final bill net stays total-less-credit; deposit bill still owed', () => {
  const r = reconcileDeposit({ deposit: DEP, depositInvoice: DEP_INV_UNPAID, incoming: bill({ total_cents: 334250 }), incomingLines: fullLines });
  assert.strictEqual(r.form, 'full_total_less_deposit');
  assert.ok(r.reasons.includes('vendor_credited_a_deposit_not_yet_paid') && r.needs_review);
  assert.deepStrictEqual([r.net_due_cents, r.deposit_still_owed_cents, r.outstanding_obligation_cents], [334250, 334250, 668500]);
  assert.ok(r.invariant_ok, 'the Association pays the $6,685 total exactly once across both bills');
});
t('form 2 full total billed WITHOUT a deposit credit: net due = face less deposit billed (the face is never paid)', () => {
  const r = reconcileDeposit({ deposit: DEP, depositInvoice: DEP_INV_PAID, incoming: bill({ total_cents: 668500 }), incomingLines: [{ description: 'Event catering + tent', amount_cents: 668500 }] });
  assert.strictEqual(r.form, 'full_total_less_deposit');
  assert.strictEqual(r.net_due_cents, 334250);
  assert.ok(r.reasons.includes('full_total_billed_without_deposit_credit') && r.needs_review);
});

// ---------------------------------------------------------------- form 3: revised total
t('form 3 revised balance with extras and tax: variance flagged for manager review with the math', () => {
  const r = reconcileDeposit({ deposit: DEP, depositInvoice: DEP_INV_PAID, incoming: bill({ total_cents: 367250, tax_cents: 5000 }),
    incomingLines: [{ description: 'Balance per agreement', amount_cents: 334250 }, { description: 'Additional 50 servings', amount_cents: 28000 }, { description: 'Sales tax', amount_cents: 5000 }] });
  assert.strictEqual(r.form, 'revised_total');
  assert.deepStrictEqual([r.net_due_cents, r.final_total_cents, r.variance_cents], [367250, 701500, 33000]);
  assert.ok(r.needs_review && r.reasons.includes('revised_total') && r.math.length >= 2 && r.extras_cents === 33000);
  assert.ok(r.invariant_ok);
});
t('form 3 revised FULL total with no credit: read as full total, net = face less deposit, still reviewed', () => {
  const r = reconcileDeposit({ deposit: DEP, depositInvoice: DEP_INV_PAID, incoming: bill({ total_cents: 700000 }), incomingLines: [{ description: 'Event total revised', amount_cents: 700000 }] });
  assert.strictEqual(r.form, 'revised_total');
  assert.deepStrictEqual([r.final_total_cents, r.net_due_cents], [700000, 700000 - 334250]);
  assert.ok(r.reasons.includes('read_as_revised_full_total_without_credit') && r.needs_review && r.invariant_ok);
});

// ---------------------------------------------------------------- form 4: duplicate / statement
t('form 4 re-sent deposit invoice (same number or same file): not payable', () => {
  for (const inc of [bill({ vendor_invoice_number: '2836' }), bill({ vendor_invoice_number: 'X-9', file_sha256: 'aaa' })]) {
    const r = reconcileDeposit({ deposit: DEP, depositInvoice: DEP_INV_UNPAID, incoming: inc });
    assert.strictEqual(r.form, 'duplicate_or_statement'); assert.strictEqual(r.net_due_cents, 0);
  }
});
t('form 4 vendor statement: linked, not payable', () => {
  const r = reconcileDeposit({ deposit: DEP, depositInvoice: DEP_INV_PAID, incoming: bill({ total_cents: 334250 }), isStatement: true });
  assert.strictEqual(r.form, 'duplicate_or_statement'); assert.strictEqual(r.net_due_cents, 0);
});

// ---------------------------------------------------------------- ambiguity
t('a second "deposit" for the same amount (Texas Access Works pattern) is ambiguous, never auto-classified', () => {
  const r = reconcileDeposit({ deposit: DEP, depositInvoice: DEP_INV_PAID, incoming: bill({ is_deposit_invoice: true }) });
  assert.strictEqual(r.form, 'ambiguous'); assert.strictEqual(r.net_due_cents, null);
  assert.ok(r.needs_review && r.reasons.includes('looks_like_second_deposit_or_completion'));
});
t('no agreed total and no stated balance: ambiguous, a person classifies it', () => {
  const r = reconcileDeposit({ deposit: { ...DEP, remaining_balance_cents: null }, depositInvoice: DEP_INV_PAID, incoming: bill({ total_cents: 400000 }) });
  assert.strictEqual(r.form, 'ambiguous'); assert.ok(r.needs_review);
});
t('a quote/contract agreed total is not labeled an estimate; a mismatching credit is flagged', () => {
  const r = reconcileDeposit({ deposit: { ...DEP, agreed_total_cents: 668500, agreed_total_basis: 'contract' }, depositInvoice: DEP_INV_PAID,
    incoming: bill({ total_cents: 368500 }), incomingLines: [{ description: 'Event total', amount_cents: 668500 }, { description: 'Deposit received', amount_cents: -300000 }] });
  assert.ok(!r.warnings.includes('agreed_total_is_an_estimate'));
  assert.ok(r.reasons.includes('credit_differs_from_deposit_billed') && !r.invariant_ok && r.needs_review);
});
t('invariant: paid + still owed + net due = final total for every payable form', () => {
  assert.ok(invariantHolds({ form: 'balance_only', deposit_paid_cents: 100, deposit_still_owed_cents: 0, net_due_cents: 100, final_total_cents: 200 }));
  assert.ok(!invariantHolds({ form: 'balance_only', deposit_paid_cents: 100, deposit_still_owed_cents: 0, net_due_cents: 200, final_total_cents: 200 }));
});

// ---------------------------------------------------------------- approval blockers
t('approval needs the bill total to already equal the net due (the face is never approved as-is)', () => {
  const r = { form: 'full_total_less_deposit', net_due_cents: 334250, needs_review: false };
  assert.deepStrictEqual(approvalBlockers(r, { total_cents: 668500, status: 'awaiting_approval' }), ['invoice_total_not_net_due']);
  assert.deepStrictEqual(approvalBlockers(r, { total_cents: 334250, status: 'awaiting_approval' }), []);
  assert.ok(approvalBlockers({ form: 'ambiguous', needs_review: true }, null, { role: 'staff' }).includes('classify_first'));
  assert.ok(approvalBlockers({ form: 'revised_total', net_due_cents: 5, needs_review: true }, { total_cents: 5 }, { role: 'staff' }).includes('manager_review_required'));
  assert.deepStrictEqual(approvalBlockers({ form: 'revised_total', net_due_cents: 5, needs_review: true }, { total_cents: 5 }, { role: 'admin' }), []);
});
t('deposit bill lines follow the deposit (1430) account, not the line classifier (the 5900 bug)', () => {
  const lines = [{ line_number: 1, description: 'Burger Combo + Tent Setup', amount_cents: 334250, gl_account_id: 'acct-5900' }];
  const out = forceDepositLineCoding(lines, { account_id: 'acct-1430', reason: 'Deposit invoice — prepaid asset' });
  assert.strictEqual(out[0].gl_account_id, 'acct-1430'); assert.strictEqual(out[0].amount_cents, 334250); assert.ok(out[0].needs_review);
  assert.strictEqual(forceDepositLineCoding(lines, null)[0].gl_account_id, 'acct-5900', 'no deposit account -> untouched');
});

// ---------------------------------------------------------------- DB layer on a fake
function fakeDb(seed) {
  const db = JSON.parse(JSON.stringify(seed));
  const writes = [];
  const table = (n) => (db[n] = db[n] || []);
  let seq = 0;
  function q(name) {
    const st = { name, filters: [], op: 'select', payload: null, one: false, maybe: false, order: null, lim: null, rng: null };
    const rows = () => table(name).filter((r) => st.filters.every((f) => f(r)));
    const api = {
      select() { return api; },
      eq(c, v) { st.filters.push((r) => r[c] === v); return api; },
      in(c, vs) { st.filters.push((r) => vs.includes(r[c])); return api; },
      order(c, o = {}) { st.order = { c, asc: o.ascending !== false }; return api; },
      range(a, b) { st.rng = [a, b]; return api; },
      limit(n) { st.lim = n; return api; },
      maybeSingle() { st.maybe = true; return api; },
      single() { st.one = true; return api; },
      insert(p) { st.op = 'insert'; st.payload = p; return api; },
      update(p) { st.op = 'update'; st.payload = p; return api; },
      then(res, rej) {
        try {
          if (st.op === 'insert') {
            const arr = (Array.isArray(st.payload) ? st.payload : [st.payload]).map((r) => ({ id: `${name}-${++seq}`, created_at: new Date(Date.now() + seq).toISOString(), ...r }));
            if (name === 'vendor_deposit_reconciliation_decisions' && arr.some((r) => table(name).some((x) => x.reconciliation_id === r.reconciliation_id))) {
              return res({ data: null, error: { code: '23505', message: 'duplicate key' } });
            }
            table(name).push(...arr); writes.push({ op: 'insert', table: name, rows: arr });
            return res({ data: st.one ? arr[0] : arr, error: null });
          }
          if (st.op === 'update') {
            const hit = rows(); hit.forEach((r) => Object.assign(r, st.payload)); writes.push({ op: 'update', table: name, patch: st.payload, n: hit.length });
            return res({ data: hit, error: null });
          }
          let out = rows();
          if (st.order) out = [...out].sort((a, b) => (String(a[st.order.c]) < String(b[st.order.c]) ? -1 : 1) * (st.order.asc ? 1 : -1));
          if (st.rng) out = out.slice(st.rng[0], st.rng[1] + 1);
          if (st.lim != null) out = out.slice(0, st.lim);
          out = out.map((r) => ({ ...r }));
          if (st.maybe || st.one) return res({ data: out[0] || null, error: null });
          return res({ data: out, error: null });
        } catch (e) { return rej ? rej(e) : res({ data: null, error: e }); }
      },
    };
    return api;
  }
  return { from: q, _db: db, _writes: writes };
}
const seed = (depInv = DEP_INV_UNPAID, finalInv = null) => ({
  vendor_deposits: [{ ...DEP }],
  ap_invoices: [{ ...depInv, community_id: 'c1', vendor_id: 'v1' }, ...(finalInv ? [{ community_id: 'c1', vendor_id: 'v1', status: 'awaiting_approval', notes: '', ...finalInv }] : [])],
  ap_invoice_lines: [], vendor_deposit_reconciliations: [], vendor_deposit_reconciliation_decisions: [], vendor_deposit_events: [],
});
const MONEY_TABLES = ['ap_payments', 'ap_payment_applications', 'check_register', 'journal_entries', 'journal_entry_lines'];
const noMoneyMoved = (sb) => {
  assert.ok(!sb._writes.some((w) => MONEY_TABLES.includes(w.table)), 'nothing paid or posted');
  assert.ok(!sb._writes.some((w) => w.table === 'ap_invoices'), 'no AP bill created or changed');
};

t('reminder survives the deposit being approved and paid (queue keyed on the deposit, live paid status)', async () => {
  const sb = fakeDb(seed(DEP_INV_PAID));
  const [row] = await df.upcomingBalances(sb, { communityId: 'c1' });
  assert.ok(row, 'still listed after the deposit is paid');
  assert.deepStrictEqual([row.deposit_paid_cents, row.deposit_still_owed_cents, row.expected_balance_cents], [334250, 0, 334250]);
  assert.ok(/ESTIMATE/.test(row.expected_balance_label));
  noMoneyMoved(sb);
});
t('follow-up: due date and agreed total are recorded with their basis and an audit event; no payable', async () => {
  const sb = fakeDb(seed());
  const bad = await df.setFollowup(sb, { depositId: 'dep-1', fields: { agreed_total_cents: 668500 }, actor: 'Ed' });
  assert.strictEqual(bad.error, 'agreed_total_basis_required');
  const ok = await df.setFollowup(sb, { depositId: 'dep-1', fields: { event_date: '2026-10-10', balance_due_date: '2026-10-10', agreed_total_cents: 668500, agreed_total_basis: 'invoice_estimate' }, actor: 'Ed' });
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.strictEqual(sb._db.vendor_deposits[0].balance_due_basis, 'staff_entered');
  assert.strictEqual(sb._db.vendor_deposit_events[0].event_type, 'followup_set');
  const [row] = await df.upcomingBalances(sb, {});
  assert.strictEqual(row.balance_due_date, '2026-10-10'); assert.ok(/ESTIMATE/.test(row.expected_balance_label));
  noMoneyMoved(sb);
});
t('a final bill creates a reconciliation proposal only: no duplicate payable, no payment, no JE', async () => {
  const sb = fakeDb(seed(DEP_INV_PAID, { id: 'inv-final', vendor_invoice_number: '2901', total_cents: 334250, tax_cents: 0 }));
  const out = await df.proposeReconciliation(sb, { depositId: 'dep-1', invoiceId: 'inv-final', actor: 'emma' });
  assert.ok(out.ok, JSON.stringify(out));
  assert.strictEqual(sb._db.vendor_deposit_reconciliations[0].form, 'balance_only');
  assert.strictEqual(sb._db.vendor_deposit_reconciliations[0].net_due_cents, 334250);
  assert.strictEqual(sb._db.ap_invoices.length, 2, 'no extra bill was created from the reminder or the reconciliation');
  noMoneyMoved(sb);
  assert.strictEqual((await df.proposeReconciliation(sb, { depositId: 'dep-1', invoiceId: 'inv-dep', actor: 'emma' })).error, 'same_as_deposit_invoice');
});
t('approval gate: pending blocks; approve only at net due; reject blocks; unrelated releases the gate', async () => {
  // Full-total bill ($6,685 face) with no credit: net due $3,342.50, so approving must be refused until the bill is netted.
  const sb = fakeDb(seed(DEP_INV_PAID, { id: 'inv-final', vendor_invoice_number: '2901', total_cents: 668500, tax_cents: 0 }));
  await df.proposeReconciliation(sb, { depositId: 'dep-1', invoiceId: 'inv-final', actor: 'emma' });
  const rec = sb._db.vendor_deposit_reconciliations[0];
  assert.strictEqual(rec.net_due_cents, 334250);
  assert.strictEqual((await df.approvalGateForInvoice(sb, 'inv-final', 668500)).reason, 'deposit_reconciliation_pending');
  const refused = await df.decideReconciliation(sb, { reconciliationId: rec.id, decision: 'approve', actor: 'Ed', actorUserId: 'u-ed', role: 'admin' });
  assert.deepStrictEqual(refused.blockers, ['invoice_total_not_net_due']);
  assert.strictEqual(sb._db.vendor_deposits[0].status, 'outstanding');
  // Staff net the deposit on the bill through the normal recode path (simulated): now it can be approved.
  sb._db.ap_invoices[1].total_cents = 334250;
  const ok = await df.decideReconciliation(sb, { reconciliationId: rec.id, decision: 'approve', actor: 'Ed', actorUserId: 'u-ed', role: 'admin' });
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.strictEqual(sb._db.vendor_deposits[0].status, 'applied');
  assert.strictEqual(sb._db.vendor_deposits[0].applied_invoice_id, 'inv-final');
  assert.strictEqual((await df.approvalGateForInvoice(sb, 'inv-final', 334250)).block, false);
  assert.strictEqual((await df.approvalGateForInvoice(sb, 'inv-final', 668500)).reason, 'invoice_total_not_reconciled_net_due');
  assert.strictEqual((await df.decideReconciliation(sb, { reconciliationId: rec.id, decision: 'reject', note: 'x', actor: 'Ed' })).error, 'already_decided');
  assert.ok(!sb._writes.some((w) => MONEY_TABLES.includes(w.table)), 'approving the reconciliation paid nothing');

  const sb2 = fakeDb(seed(DEP_INV_PAID, { id: 'inv-final', vendor_invoice_number: '2901', total_cents: 334250, tax_cents: 0 }));
  await df.proposeReconciliation(sb2, { depositId: 'dep-1', invoiceId: 'inv-final', actor: 'emma' });
  const rec2 = sb2._db.vendor_deposit_reconciliations[0];
  assert.strictEqual((await df.decideReconciliation(sb2, { reconciliationId: rec2.id, decision: 'reject', actor: 'Ed' })).error, 'note_required');
  await df.decideReconciliation(sb2, { reconciliationId: rec2.id, decision: 'reject', note: 'wrong event', actor: 'Ed' });
  assert.strictEqual((await df.approvalGateForInvoice(sb2, 'inv-final', 334250)).reason, 'deposit_reconciliation_rejected');

  const sb3 = fakeDb(seed(DEP_INV_PAID, { id: 'inv-final', vendor_invoice_number: '2901', total_cents: 99900, tax_cents: 0 }));
  await df.proposeReconciliation(sb3, { depositId: 'dep-1', invoiceId: 'inv-final', actor: 'emma' });
  const rec3 = sb3._db.vendor_deposit_reconciliations[0];
  await df.decideReconciliation(sb3, { reconciliationId: rec3.id, decision: 'unrelated', note: 'different job (holiday lights)', actor: 'Ed' });
  assert.strictEqual((await df.approvalGateForInvoice(sb3, 'inv-final', 99900)).block, false);
  assert.strictEqual(sb3._db.vendor_deposits[0].status, 'outstanding', 'an unrelated bill leaves the deposit waiting for its real final bill');
});
t('final amount needs a person: the proposer cannot decide their own reconciliation; flagged ones need an admin', async () => {
  const sb = fakeDb(seed(DEP_INV_PAID, { id: 'inv-final', vendor_invoice_number: '2901', total_cents: 367250, tax_cents: 5000 }));
  await df.proposeReconciliation(sb, { depositId: 'dep-1', invoiceId: 'inv-final', actor: 'Celina', actorUserId: 'u-celina' });
  const rec = sb._db.vendor_deposit_reconciliations[0];
  assert.strictEqual(rec.form, 'revised_total'); assert.strictEqual(rec.needs_review, true);
  assert.strictEqual((await df.decideReconciliation(sb, { reconciliationId: rec.id, decision: 'approve', actor: 'Celina', actorUserId: 'u-celina', role: 'staff' })).error, 'proposer_cannot_decide');
  const staff = await df.decideReconciliation(sb, { reconciliationId: rec.id, decision: 'approve', actor: 'Martha', actorUserId: 'u-m', role: 'staff' });
  assert.ok(staff.blockers.includes('manager_review_required'));
  assert.ok((await df.decideReconciliation(sb, { reconciliationId: rec.id, decision: 'approve', actor: 'Ed', actorUserId: 'u-ed', role: 'admin' })).ok);
  noMoneyMoved(sb);
});
t('duplicate copy of the deposit bill: reconciled as not payable; approving it keeps the bill blocked', async () => {
  const sb = fakeDb(seed(DEP_INV_UNPAID, { id: 'inv-copy', vendor_invoice_number: '2836-R', total_cents: 334250, tax_cents: 0, file_sha256: 'aaa' }));
  await df.proposeReconciliation(sb, { depositId: 'dep-1', invoiceId: 'inv-copy', actor: 'emma' });
  const rec = sb._db.vendor_deposit_reconciliations[0];
  assert.strictEqual(rec.form, 'duplicate_or_statement'); assert.strictEqual(rec.net_due_cents, 0);
  await df.decideReconciliation(sb, { reconciliationId: rec.id, decision: 'approve', actor: 'Ed', actorUserId: 'u-ed', role: 'admin' });
  assert.strictEqual((await df.approvalGateForInvoice(sb, 'inv-copy', 334250)).reason, 'reconciled_as_duplicate_or_statement');
  assert.strictEqual(sb._db.vendor_deposits[0].status, 'outstanding');
  noMoneyMoved(sb);
});
t('before migration 471: the approval gate degrades open (no reconciliation tables) and upcoming still lists deposits', async () => {
  const sb = fakeDb(seed());
  const orig = sb.from;
  sb.from = (n) => (n.startsWith('vendor_deposit_') ? { select() { return this; }, eq() { return this; }, in() { return this; }, order() { return this; },
    then(res) { return res({ data: null, error: { message: 'relation "vendor_deposit_reconciliations" does not exist' } }); } } : orig(n));
  assert.strictEqual((await df.approvalGateForInvoice(sb, 'x', 1)).block, false);
  assert.strictEqual((await df.upcomingBalances(sb, {})).length, 1);
});

(async () => {
  await Promise.all(results);
  console.log(failed ? `\n${failed} FAILED` : '\nall deposit follow-up checks passed');
  process.exitCode = failed ? 1 : 0;
})();
