// ============================================================================
// tests/test_onboarding_bridge_evidence.js  (Issue #15) — evidence the operator settles itself
// ----------------------------------------------------------------------------
// Synthetic source rows + synthetic Trusted activity (no client data). Proves:
//   - a Trusted system entry is ALREADY_IN_SOURCE only by LINE IDENTITY: every line
//     (account, side, cents) is a line of ONE source "GL Entry" of the same date,
//     each source line used once; an account, side, type, date or entry mismatch
//     keeps it AMBIGUOUS (amount alone never qualifies);
//   - an in-period invoice whose number is not a vendor invoice in the source and
//     not open in the source AP aging is a real document the legacy books lack: the
//     only open question is the recording period, asked in plain words with facts;
//   - a source line dated before the Trusted document was even issued is not a
//     duplicate candidate (the payment of that document follows it);
//   - the AP identity is invoice total = net AP credit; a header grossed up by
//     self-cancelling lines is a note, a real mismatch is still an issue.
// ============================================================================
const assert = require('assert');
const { buildBridge } = require('../lib/onboarding/bridge');

const tests = []; const check = (n, fn) => tests.push([n, fn]);
const CUT = '2026-07-31';
const ACC = { a4000: '4000', a2205: '2205', a1400: '1400', a5605: '5605', a5610: '5610', a2000: '2000', a1000: '1000', a5105: '5105', a5200: '5200', a5870: '5870' };
const prov = (line) => ({ artifact_sha256: 'a'.repeat(64), locator: { line } });
let L = 1;
const g = (date, acct, dr, cr, type, description, extra = {}) => ({ domain: 'gl_transaction', account_code: acct, date, debit_cents: dr, credit_cents: cr, source_type: type, description, ledger_id: null, provenance: prov(L++), ...extra });
const je = (id, d, mod, amt, extra = {}) => ({ id, posting_date: d, source_module: mod, status: 'posted', total_debits_cents: amt, total_credits_cents: amt, description: '', reference: id.toUpperCase(), superseded_at: null, ...extra });
const ln = (jeId, acct, dr, cr, n = 0) => ({ id: `${jeId}-${acct}-${dr}-${cr}-${n}`, journal_entry_id: jeId, account_id: acct, debit_cents: dr, credit_cents: cr });
const empty = () => ({ journal_entries: [], journal_entry_lines: [], ap_invoices: [], ap_payments: [], ar_charges: [], ar_payments: [], payments: [], homeowner_transactions: [] });
const run = (gl, t, extra = {}) => buildBridge({ gl_trial_balance: { rows: gl }, ...(extra.apOpen ? { ap_aging: { rows: extra.apOpen } } : {}) }, t, { batch_code: 'B', cutoff_date: CUT, roles: { ar_account: '1300', ap_account: '2000' }, accountNumber: (id) => ACC[id] || null, apApplications: extra.apps || [] });
const ev = (b, k) => b.items.find((i) => i.event_key === k);

const DEFREV = (date) => [g(date, '2205', 150000, 0, 'GL Entry', 'Monthly Assessment Income'), g(date, '4000', 0, 150000, 'GL Entry', 'Monthly Assessment Income')];
const sysDefrev = (t, id, date) => { t.journal_entries.push(je(id, date, 'system', 150000, { reference: `JE-DEFREV-${id}` })); t.journal_entry_lines.push(ln(id, 'a2205', 150000, 0), ln(id, 'a4000', 0, 150000)); };

check('system entry, every line a line of one source GL Entry of the same date -> ALREADY_IN_SOURCE by line identity (with provenance)', () => {
  const t = empty(); sysDefrev(t, 's1', '2026-01-01');
  t.journal_entries.push(je('s2', '2026-01-01', 'system', 27000)); t.journal_entry_lines.push(ln('s2', 'a5605', 10000, 0), ln('s2', 'a5610', 5000, 0), ln('s2', 'a5605', 12000, 0, 1), ln('s2', 'a1400', 0, 27000));
  const gl = [...DEFREV('2026-01-01'), g('2026-01-01', '5605', 10000, 0, 'GL Entry', 'Ins amortization'), g('2026-01-01', '5610', 5000, 0, 'GL Entry', 'Ins amortization'), g('2026-01-01', '5605', 12000, 0, 'GL Entry', 'Ins amortization'), g('2026-01-01', '1400', 0, 27000, 'GL Entry', 'Ins amortization')];
  const b = run(gl, t);
  for (const k of ['je:s1', 'je:s2']) { const it = ev(b, k); assert.deepStrictEqual([it.classification, it.method], ['ALREADY_IN_SOURCE', 'gl_entry_lines_identical_in_source'], k); assert.ok(it.evidence.source_matches.every((m) => m.artifact_sha256 && m.locator.line)); }
  assert.strictEqual(ev(b, 'je:s2').evidence.source_matches.length, 4);
  assert.strictEqual(b.controls.find((c) => c.code === 'bridge.no_duplicate_on_amount_alone').status, 'PASS');
});
check('line identity is strict: a different account, side, source type, date, or lines split across two source entries keep it AMBIGUOUS', () => {
  const cases = {
    account: [g('2026-01-01', '2205', 150000, 0, 'GL Entry', 'X'), g('2026-01-01', '4010', 0, 150000, 'GL Entry', 'X')],
    side: [g('2026-01-01', '2205', 0, 150000, 'GL Entry', 'X'), g('2026-01-01', '4000', 150000, 0, 'GL Entry', 'X')],
    type: [g('2026-01-01', '2205', 150000, 0, 'Invoice', 'X'), g('2026-01-01', '4000', 0, 150000, 'Invoice', 'X')],
    date: DEFREV('2026-01-02'),
    split: [g('2026-01-01', '2205', 150000, 0, 'GL Entry', 'One'), g('2026-01-01', '4000', 0, 150000, 'GL Entry', 'Two')],
  };
  for (const [name, gl] of Object.entries(cases)) {
    const t = empty(); sysDefrev(t, 's1', '2026-01-01');
    assert.deepStrictEqual([ev(run(gl, t), 'je:s1').classification, ev(run(gl, t), 'je:s1').method], ['AMBIGUOUS', 'system_entry_in_source_period_unproven'], name);
  }
});
check('each source line is used once: two identical Trusted entries against ONE source entry -> one matched, the other stays AMBIGUOUS', () => {
  const t = empty(); sysDefrev(t, 's1', '2026-03-01'); sysDefrev(t, 's2', '2026-03-01');
  const b = run(DEFREV('2026-03-01'), t);
  assert.deepStrictEqual([ev(b, 'je:s1').classification, ev(b, 'je:s2').classification].sort(), ['ALREADY_IN_SOURCE', 'AMBIGUOUS']);
  const t2 = empty(); sysDefrev(t2, 's1', '2026-03-01');
  assert.strictEqual(ev(run([...DEFREV('2026-03-01'), ...DEFREV('2026-03-01')], t2), 'je:s1').classification, 'ALREADY_IN_SOURCE', 'a source with two such entries still matches one');
});
check('in-period invoice the legacy books lack -> the only question is the period, in plain words with the facts (bill-back seen, not paid)', () => {
  const t = empty();
  t.journal_entries.push(je('i1', '2026-07-31', 'ap_invoice', 6150, { description: 'AP invoice EX-5501 — Example Law Firm' })); t.journal_entry_lines.push(ln('i1', 'a5870', 6150, 0), ln('i1', 'a2000', 0, 6150));
  t.ap_invoices.push({ id: 'inv1', vendor_invoice_number: 'EX-5501', invoice_date: '2026-07-31', total_cents: 6150, status: 'approved', posting_journal_entry_id: 'i1' });
  const gl = [g('2026-07-31', '1300', 6150, 0, 'Owner Charge', '101 Example Lane: Legal Fees / EX-5501'), g('2026-07-31', '5870', 0, 6150, 'Owner Charge', '101 Example Lane: Legal Fees / EX-5501'), g('2026-06-01', '5200', 52000, 0, 'Invoice', 'EX-4100 - Example Lawn - June')];
  const b = run(gl, t, { apOpen: [{ domain: 'ap_open_item', invoice_number: 'EX-OPEN', amount_cents: 60000 }] });
  const it = ev(b, 'je:i1');
  assert.deepStrictEqual([it.classification, it.method, it.confidence], ['AMBIGUOUS', 'in_source_period_absent_from_source', 'high']);
  assert.strictEqual(it.evidence.open_in_source_ap_aging, false);
  assert.ok(it.evidence.identifier_elsewhere_in_source.length === 2 && it.evidence.identifier_elsewhere_in_source.every((r) => r.source_type === 'Owner Charge'));
  const d = it.evidence.decision;
  assert.strictEqual(d.question, 'Example Law Firm invoice EX-5501 ($61.50, dated 7/31/2026) is real but is not in the legacy books. Record it after the cutoff, or on 7/31/2026?');
  assert.deepStrictEqual(d.choices.map((c) => c.key), ['record_after_cutoff', 'record_on_document_date']); assert.strictEqual(d.recommended, 'record_after_cutoff');
  assert.ok(d.context.some((c) => /appear in the legacy books on 7\/31\/2026 as Owner Charge/.test(c)) && d.context.some((c) => /not yet paid \(approved\)/.test(c)));
  assert.ok(!/—/.test(JSON.stringify(d)), 'no em-dashes in the question');
});
check('an invoice still open in the source AP aging is NOT called absent; without an AP aging the claim is not made either', () => {
  const t = empty(); t.journal_entries.push(je('i1', '2026-07-15', 'ap_invoice', 1000, { description: 'AP invoice X-9 — V' })); t.ap_invoices.push({ id: 'inv1', vendor_invoice_number: 'X-9', invoice_date: '2026-07-15', total_cents: 1000, posting_journal_entry_id: 'i1' });
  assert.strictEqual(ev(run([], t, { apOpen: [{ domain: 'ap_open_item', invoice_number: 'X-9', amount_cents: 1000 }] }), 'je:i1').method, 'in_source_period_not_found_in_source');
  assert.strictEqual(ev(run([], t), 'je:i1').method, 'in_source_period_not_found_in_source');
});
check('a source line dated before the Trusted document was issued is not a candidate: a later bill of the same amount (and its payment) is subsequent activity', () => {
  const t = empty();
  t.journal_entries.push(je('i1', '2026-08-12', 'ap_invoice', 31000, { description: 'AP invoice EXP-1001 — Example Power' }), je('p1', '2026-08-28', 'payment_intake', 31000, { description: 'AP payment ach' }));
  t.journal_entry_lines.push(ln('i1', 'a5105', 31000, 0), ln('i1', 'a2000', 0, 31000), ln('p1', 'a2000', 31000, 0), ln('p1', 'a1000', 0, 31000));
  t.ap_invoices.push({ id: 'inv1', vendor_invoice_number: 'EXP-1001', invoice_date: '2026-08-12', total_cents: 31000, posting_journal_entry_id: 'i1' });
  t.ap_payments.push({ id: 'pay1', payment_date: '2026-08-28', amount_cents: 31000, posting_journal_entry_id: 'p1' });
  const gl = [g('2026-07-30', '1000', 0, 31000, 'Invoice', 'Example Power Co', { ledger_id: '9001' }), g('2026-07-30', '5105', 31000, 0, 'Invoice', 'Example Power Co')];
  const b = run(gl, t, { apps: [{ payment_id: 'pay1', invoice_id: 'inv1', applied_cents: 31000 }] });
  for (const k of ['je:i1', 'je:p1']) { const it = ev(b, k); assert.deepStrictEqual([it.classification, it.method], ['LEGITIMATE_SUBSEQUENT', 'after_cutoff_no_source_evidence'], k); assert.ok(it.evidence.rejected_source_candidates.length && /predates the document issued 2026-08-12/.test(it.evidence.rejected_source_candidates[0].rejected_because), k); }
  // without the payment -> invoice link the payment stays a human question (amount alone never decides)
  assert.strictEqual(ev(run(gl, t), 'je:p1').classification, 'AMBIGUOUS');
});
check('AP identity: a header grossed up by a self-cancelling pair is a note (net AP credit = invoice); a real AP mismatch is still a structural issue', () => {
  const t = empty();
  t.journal_entries.push(je('i1', '2026-09-11', 'ap_invoice', 61500, { description: 'AP invoice EXP-1002 — Example Power' }));
  t.journal_entry_lines.push(ln('i1', 'a5105', 31000, 0), ln('i1', 'a5105', 0, 31000, 1), ln('i1', 'a5105', 9000, 0, 2), ln('i1', 'a5105', 21500, 0, 3), ln('i1', 'a2000', 0, 30500));
  t.ap_invoices.push({ id: 'inv1', vendor_invoice_number: 'EXP-1002', invoice_date: '2026-09-11', total_cents: 30500, posting_journal_entry_id: 'i1' });
  let it = ev(run([], t), 'je:i1');
  assert.deepStrictEqual([it.classification, it.structural_issues], ['LEGITIMATE_SUBSEQUENT', []]);
  assert.match(it.evidence.notes[0], /grossed up by self-cancelling lines; net AP credit 30500 = invoice total 30500/);
  t.ap_invoices[0].total_cents = 40000;
  it = ev(run([], t), 'je:i1');
  assert.ok(it.structural_issues.some((s) => /AP invoice total \(40000\) != journal entry \(61500\)/.test(s)));
});

check('every open item carries a typed question; a recorded decision settles it only for the SAME transaction and question', () => {
  const t = empty();
  t.journal_entries.push(je('i1', '2026-07-01', 'ap_invoice', 2000, { description: 'AP invoice X-2 — Example Vendor' })); t.journal_entry_lines.push(ln('i1', 'a5200', 2000, 0), ln('i1', 'a2000', 0, 2000));
  t.ap_invoices.push({ id: 'inv1', vendor_invoice_number: 'X-2', invoice_date: '2026-07-01', total_cents: 2000, status: 'paid', posting_journal_entry_id: 'i1' });
  t.journal_entries.push(je('p9', '2026-07-05', 'payment_intake', 999, { description: 'AP payment ach' })); t.journal_entry_lines.push(ln('p9', 'a2000', 999, 0), ln('p9', 'a1000', 0, 999));
  const gl = [g('2026-07-06', '1000', 0, 999, 'Invoice', 'Something')];
  const ap = { apOpen: [{ domain: 'ap_open_item', invoice_number: 'OTHER', amount_cents: 1 }] };
  let b = buildBridge({ gl_trial_balance: { rows: gl }, ap_aging: { rows: ap.apOpen } }, t, { batch_code: 'B', cutoff_date: CUT, roles: { ap_account: '2000' }, accountNumber: (id) => ACC[id] || null });
  assert.strictEqual(ev(b, 'je:i1').evidence.decision.type, 'recording_period');
  assert.strictEqual(ev(b, 'je:p9').evidence.decision.type, 'source_or_keep', 'a generic question for any other open item');
  assert.strictEqual(b.controls.find((c) => c.code === 'bridge.ambiguous_items_reviewed').status, 'BLOCKED');
  const dec = (event_key, type, amount, date, choice) => ({ id: `d-${event_key}`, event_key, decision_type: type, item_amount_cents: amount, item_event_date: date, choice_key: choice, choice_label: choice, actor_id: 'ed', decided_at: '2026-10-03T17:00:00Z', bridge_completion_id: 'old' });
  const run2 = (decisions) => buildBridge({ gl_trial_balance: { rows: gl }, ap_aging: { rows: ap.apOpen } }, t, { batch_code: 'B', cutoff_date: CUT, roles: { ap_account: '2000' }, accountNumber: (id) => ACC[id] || null, decisions });
  b = run2([dec('je:i1', 'recording_period', 2000, '2026-07-01', 'record_after_cutoff'), dec('je:p9', 'source_or_keep', 999, '2026-07-05', 'keep_as_trusted_activity')]);
  assert.strictEqual(ev(b, 'je:i1').evidence.decision.recorded.choice_key, 'record_after_cutoff');
  assert.strictEqual(ev(b, 'je:i1').classification, 'AMBIGUOUS', 'the evidence classification is unchanged; the decision is policy on top');
  assert.strictEqual(b.controls.find((c) => c.code === 'bridge.ambiguous_items_reviewed').status, 'PASS');
  b = run2([dec('je:i1', 'recording_period', 2100, '2026-07-01', 'record_after_cutoff'), dec('je:p9', 'source_or_keep', 999, '2026-07-05', 'keep_as_trusted_activity')]);
  assert.ok(!ev(b, 'je:i1').evidence.decision.recorded, 'a decision about a different amount does not carry over');
  assert.strictEqual(b.controls.find((c) => c.code === 'bridge.ambiguous_items_reviewed').status, 'BLOCKED');
  b = run2([dec('je:i1', 'recording_period', 2000, '2026-07-01', 'not_offered'), dec('je:p9', 'recording_period', 999, '2026-07-05', 'record_after_cutoff')]);
  assert.ok(!ev(b, 'je:i1').evidence.decision.recorded && !ev(b, 'je:p9').evidence.decision.recorded, 'a choice not offered, or another question type, never settles an item');
});
check('source anomaly note: the same GL Entry recorded twice on one date is surfaced for post-conversion review (never a blocker, no change)', () => {
  const t = empty();
  const dup = [...DEFREV('2026-03-01'), ...DEFREV('2026-03-01'), ...DEFREV('2026-04-01')];
  const b = run(dup, t);
  assert.strictEqual(b.source_notes.length, 1);
  const n = b.source_notes[0];
  assert.deepStrictEqual([n.kind, n.date, n.times, n.amount_cents], ['duplicate_source_gl_entry', '2026-03-01', 2, 150000]);
  assert.match(n.text, /The legacy GL records the same entry 2 times on 3\/1\/2026 \("Monthly Assessment Income", \$1,500\.00 each time\)\. The cutoff position is kept exactly as the legacy books show it; review this after conversion\./);
  assert.ok(b.controls.every((c) => c.code === 'bridge.ambiguous_items_reviewed' || c.status === 'PASS' || c.code === 'bridge.built_on_current_snapshot'), 'no control fails because of a note');
  assert.strictEqual(run(DEFREV('2026-03-01'), t).source_notes.length, 0, 'a single entry is not an anomaly');
});

(async () => {
  let pass = 0, fail = 0;
  console.log('Onboarding: bridge evidence the operator settles itself (Issue #15)');
  for (const [n, fn] of tests) { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n      ')); } }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
