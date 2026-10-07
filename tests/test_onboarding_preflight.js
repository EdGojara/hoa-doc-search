// ============================================================================
// tests/test_onboarding_preflight.js  (Issue #15 Milestone 5) — conversion preflight
// ----------------------------------------------------------------------------
// Synthetic community, pure functions only (no database). Proves the write
// contract: every bridge item gets one treatment; legacy imports superseded,
// Trusted-native entries already in the source neutralized, decided items moved
// after the cutoff (neutralize + re-post), post-cutoff activity untouched; the
// projected cutoff TB equals the source; prior-owner balances stay on the prior
// owner's own account with no tenure and still tie the prepaid GL; the report
// hash binds everything (tamper -> different hash; a waiver is a disposition,
// never a relabel); stale inputs block.
// ============================================================================
const assert = require('assert');
const { buildConversionPlan } = require('../lib/onboarding/conversion_plan');
const PF = require('../lib/onboarding/preflight');

const tests = []; const check = (n, fn) => tests.push([n, fn]);
const A = (n, fund = 'f-opr') => ({ id: `a${n}`, account_number: String(n), fund_id: fund });
const ctxBase = () => ({
  accounts: [A(1000), A(1300), A(2000), A(2400), A(3000), A(4000)], funds: [{ id: 'f-opr', code: 'OPR' }],
  properties: [{ id: 'p1', vantaca_account_id: '10001', street_address: '1 Example Lane' }, { id: 'p2', vantaca_account_id: '10002', street_address: '2 Example Lane' }],
  tenures: [{ id: 't1', property_id: 'p1', kind: 'owner', end_date: null }, { id: 't2', property_id: 'p2', kind: 'owner', end_date: null }],
  vendors: [{ id: 'v1', name: 'Acme LLC' }], gl_cutover_date: '2026-06-01', current_trusted_fingerprint: 'f'.repeat(64), management_company_id: 'mc1',
  periods: Array.from({ length: 12 }, (_, i) => ({ id: `per${i + 1}`, period_start: `2026-${String(i + 1).padStart(2, '0')}-01`, period_end: new Date(Date.UTC(2026, i + 1, 0)).toISOString().slice(0, 10), status: 'open' })),
});
const je = (id, date, module, lines, extra = {}) => ({ id, posting_date: date, source_module: module, reference: `JE-${id}`, status: 'posted', total_debits_cents: lines.reduce((t, l) => t + (l.debit_cents || 0), 0), total_credits_cents: lines.reduce((t, l) => t + (l.credit_cents || 0), 0), ...extra });
const ln = (je_id, n, acct, dr, cr) => ({ id: `${je_id}-${n}`, journal_entry_id: je_id, line_number: n, account_id: `a${acct}`, debit_cents: dr, credit_cents: cr });
const trustedBase = () => ({
  journal_entries: [je('L1', '2026-02-01', 'vantaca_import', [{ debit_cents: 500 }]), je('S1', '2026-03-01', 'system', [{ debit_cents: 10 }]), je('D1', '2026-07-15', 'ap_invoice', [{ debit_cents: 20 }]), je('N1', '2026-08-05', 'payment_intake', [{ debit_cents: 5 }])],
  journal_entry_lines: [ln('L1', 1, 1000, 500, 0), ln('L1', 2, 3000, 0, 500), ln('S1', 1, 1300, 10, 0), ln('S1', 2, 4000, 0, 10), ln('D1', 1, 4000, 20, 0), ln('D1', 2, 2000, 0, 20), ln('N1', 1, 1000, 5, 0), ln('N1', 2, 4000, 0, 5)],
  ap_invoices: [], homeowner_transactions: [{ id: 'h1', source_batch_id: 'B0' }],
});
const snapshotBase = () => ({ completion_id: 's1', sha256: 'a'.repeat(64), roles: { ar_account: '1300', prepaid_account: '2400', ap_account: '2000' }, lines: [
  { line_no: 1, kind: 'gl_opening_balance', account_code: '1000', amount_cents: 1000 }, { line_no: 2, kind: 'gl_opening_balance', account_code: '1300', amount_cents: 300 },
  { line_no: 3, kind: 'gl_opening_balance', account_code: '2000', amount_cents: -200 }, { line_no: 4, kind: 'gl_opening_balance', account_code: '2400', amount_cents: -150 },
  { line_no: 5, kind: 'gl_opening_balance', account_code: '3000', amount_cents: -950 },
  { line_no: 6, kind: 'ar_aging_item', account_code: '1300', source_account_key: '10001', amount_cents: 300, detail: { charge_type: 'Annual Assessment' } },
  { line_no: 7, kind: 'prepaid_detail', account_code: '2400', source_account_key: '10001', amount_cents: -50, detail: {} },
  { line_no: 8, kind: 'prepaid_detail', account_code: '2400', source_account_key: '90009', amount_cents: -100, detail: { former_owner: true } },
  { line_no: 9, kind: 'ap_detail', account_code: '2000', amount_cents: -200, detail: { source_vendor_key: 'ACME LLC', invoice_number: 'X1', invoice_date: '2026-07-20' } },
] });
const bridgeBase = () => ({ completion_id: 'b1', sha256: 'b'.repeat(64), trusted_fingerprint: 'f'.repeat(64), status: 'PASS', items: [
  { item_no: 1, event_key: 'legacy', classification: 'ALREADY_IN_SOURCE', method: 'provenance_legacy_import', records: ['journal_entries:L1', 'homeowner_transactions:h1'] },
  { item_no: 2, event_key: 'je:S1', classification: 'ALREADY_IN_SOURCE', method: 'gl_entry_lines_identical_in_source', records: ['journal_entries:S1'] },
  { item_no: 3, event_key: 'je:D1', classification: 'AMBIGUOUS', method: 'in_source_period_absent_from_source', amount_cents: 20, evidence: { decision: { type: 'recording_period', recorded: { choice_key: 'record_after_cutoff', decision_id: 'dec1' } } }, records: ['journal_entries:D1', 'ap_invoices:I1'] },
  { item_no: 4, event_key: 'je:N1', classification: 'LEGITIMATE_SUBSEQUENT', method: 'after_cutoff_no_source_evidence', records: ['journal_entries:N1'] },
] });
const source = () => ({ prepaid_rows: [{ source_account_key: '90009', previous_owner: true, amount_cents: 100, provenance: { artifact_sha256: 'c'.repeat(64), locator: { line: 12 }, raw: '***90009  2 Example Lane  Old Owner Name  1.00' } }] });
const build = (o = {}) => buildConversionPlan({ batch: { id: 'batch', batch_code: 'CONV-EX-20260731', community_id: 'c1', as_of_date: '2026-07-31' }, snapshot: o.snapshot || snapshotBase(), bridge: o.bridge || bridgeBase(), source: o.source || source(), trusted: o.trusted || trustedBase(), ap_applications: o.apps || [], ctx: o.ctx || ctxBase() });
const status = (plan, code) => plan.controls.find((c) => c.code === code).status;

check('the happy path: every preflight control PASSES', () => {
  const p = build();
  assert.deepStrictEqual(p.controls.filter((c) => c.status !== 'PASS').map((c) => [c.code, c.failures]), []);
});
check('treatments: legacy import superseded (+ its ledger batch reverted); already-in-source native entry neutralized on its own date; decided entry neutralized AND re-posted on the cutover; post-cutoff entry untouched', () => {
  const p = build(); const w = p.writes;
  assert.deepStrictEqual(w.supersede_journal_entries.map((x) => [x.id, x.set.status, x.prior_status]), [['L1', 'superseded', 'posted']]);
  assert.deepStrictEqual(w.revert_ar_batches.map((x) => [x.id, x.set.status, x.rows]), [['B0', 'reverted', 1]]);
  assert.deepStrictEqual(w.neutralize_journal_entries.map((x) => [x.original_je_id, x.posting_date, x.reference]), [['S1', '2026-03-01', 'CONV-EX-20260731-NEUT-JE-S1'], ['D1', '2026-07-15', 'CONV-EX-20260731-NEUT-JE-D1']]);
  assert.deepStrictEqual(w.repost_journal_entries.map((x) => [x.original_je_id, x.posting_date, x.source_reference]), [['D1', '2026-08-01', 'D1']]);
  assert.ok(!JSON.stringify([w.supersede_journal_entries, w.neutralize_journal_entries]).includes('"N1"'), 'post-cutover entry never touched');
  const neut = w.neutralize_journal_entries.find((x) => x.original_je_id === 'D1');
  assert.deepStrictEqual(neut.lines.map((l) => [l.account_number, l.debit_cents, l.credit_cents]), [['4000', 0, 20], ['2000', 20, 0]], 'an exact reversal, line for line');
});
check('opening entry = the source TB, balanced, dated the cutoff; the projected cutoff TB equals the source on every account', () => {
  const p = build(); const o = p.writes.opening_journal_entries;
  assert.strictEqual(o.length, 1); assert.strictEqual(o[0].reference, 'CONV-EX-20260731-OPEN-OPR'); assert.strictEqual(o[0].posting_date, '2026-07-31');
  assert.strictEqual(o[0].total_debits_cents, o[0].total_credits_cents);
  assert.strictEqual(status(p, 'preflight.projected_cutoff_tb_equals_source'), 'PASS');
  assert.strictEqual(p.writes.cutover_date.from, '2026-06-01'); assert.strictEqual(p.writes.cutover_date.to, '2026-08-01');
});
check('PRIOR-OWNER balance: kept on the prior owner\'s own source account, tied to its printed lot, NO tenure, dates not established; the prepaid GL still ties (current + prior)', () => {
  const p = build(); const rows = p.writes.ar_opening_batch.rows;
  const prior = rows.filter((r) => r.prior_owner);
  assert.strictEqual(prior.length, 1);
  assert.deepStrictEqual([prior[0].vantaca_account_id, prior[0].property_id, prior[0].tenure_id, prior[0].amount_cents, prior[0].raw_row.prior_owner.ownership_dates], ['90009', 'p2', null, -100, 'not established']);
  assert.ok(prior[0].raw_row.provenance.artifact_sha256 === 'c'.repeat(64) && prior[0].raw_row.provenance.locator.line === 12, 'source report provenance kept');
  assert.ok(rows.filter((r) => !r.prior_owner).every((r) => r.tenure_id === 't1'), 'current-owner rows on the current tenure');
  assert.strictEqual(p.writes.ar_opening_batch.current_owner_prepaid_cents, -50); assert.strictEqual(p.writes.ar_opening_batch.prior_owner_credit_cents, -100);
  assert.strictEqual(status(p, 'preflight.prepaid_subledger_ties_to_gl'), 'PASS');
});
check('prior-owner safety: a prior-owner row on a CURRENT property account (it would reach a current owner) is BLOCKED, never attached', () => {
  const s1 = source(); s1.prepaid_rows[0].source_account_key = '10002'; s1.prepaid_rows[0].provenance.raw = '***10002  2 Example Lane  Old Owner  1.00';
  const snap = snapshotBase(); snap.lines.find((l) => l.line_no === 8).source_account_key = '10002';
  assert.strictEqual(status(build({ source: s1, snapshot: snap }), 'preflight.ar_rows_resolved'), 'BLOCKED');
});
check('prior-owner lot NOT established by the source (a legacy placeholder address, or an ambiguous one): kept with NO lot (never guessed), still ties GL 2400, does not block', () => {
  const s2 = source(); s2.prepaid_rows[0].provenance.raw = '***90009  112 Filler Way  Old Owner  1.00';
  const p = build({ source: s2 }); const prior = p.writes.ar_opening_batch.rows.find((r) => r.prior_owner);
  assert.deepStrictEqual([prior.property_id, prior.tenure_id, prior.vantaca_account_id, prior.raw_row.prior_owner.lot, prior.raw_row.prior_owner.printed_as], [null, null, '90009', 'not established by the source', '112 Filler Way Old Owner']);
  assert.strictEqual(status(p, 'preflight.ar_rows_resolved'), 'PASS'); assert.strictEqual(status(p, 'preflight.prepaid_subledger_ties_to_gl'), 'PASS');
  const ctx = ctxBase(); ctx.properties.push({ id: 'p3', vantaca_account_id: '10003', street_address: '2 Example Lane' });
  assert.strictEqual(build({ ctx }).writes.ar_opening_batch.rows.find((r) => r.prior_owner).property_id, null, 'two lots with the printed address: ambiguous, so no lot');
});
check('an open question with no recorded decision, or an unhandled pre-cutover entry, BLOCKS; a TB that would not tie FAILS', () => {
  const b = bridgeBase(); delete b.items[2].evidence.decision.recorded;
  assert.strictEqual(status(build({ bridge: b }), 'preflight.every_item_has_a_treatment'), 'BLOCKED');
  const t = trustedBase(); t.journal_entries.push(je('X9', '2026-05-01', 'manual', [{ debit_cents: 7 }])); t.journal_entry_lines.push(ln('X9', 1, 1000, 7, 0), ln('X9', 2, 3000, 0, 7));
  const p = build({ trusted: t });
  assert.strictEqual(status(p, 'preflight.no_unhandled_pre_cutover_entries'), 'BLOCKED');
  assert.strictEqual(status(p, 'preflight.projected_cutoff_tb_equals_source'), 'FAIL', 'the residual would move the cutoff TB');
});
check('stale input: Trusted activity changed since the bridge -> BLOCKED; an existing conversion entry -> BLOCKED (no double post)', () => {
  const c = ctxBase(); c.current_trusted_fingerprint = '0'.repeat(64);
  assert.strictEqual(status(build({ ctx: c }), 'preflight.built_on_current_bridge'), 'BLOCKED');
  const t = trustedBase(); t.journal_entries.push(je('C1', '2026-07-31', 'conversion', [], { reference: 'CONV-EX-20260731-OPEN-OPR' }));
  assert.strictEqual(status(build({ trusted: t }), 'preflight.no_conversion_entries_exist_yet'), 'BLOCKED');
});
check('AP: open invoices resolve to one vendor, post by the opening entry, tie to GL AP; an invoice number already in Trusted is never written twice (it must be carried, and an uncarriable one BLOCKS)', () => {
  const p = build(); const ap = p.writes.ap_opening_invoices;
  assert.deepStrictEqual(ap.map((a) => [a.vendor_id, a.vendor_invoice_number, a.total_cents, a.posting_journal_entry_reference]), [['v1', 'X1', 200, 'CONV-EX-20260731-OPEN-OPR']]);
  const t = trustedBase(); t.ap_invoices.push({ id: 'I0', vendor_id: 'v1', vendor_invoice_number: 'X1', voided_at: null });
  const p2 = build({ trusted: t }); assert.strictEqual(status(p2, 'preflight.restored_ap_carried_once'), 'BLOCKED'); assert.ok(!p2.writes.ap_opening_invoices.some((a) => a.vendor_invoice_number === 'X1'), 'never a second invoice');
});
check('determinism: the same inputs build the same plan', () => {
  assert.strictEqual(JSON.stringify(build()), JSON.stringify(build()));
});

const base = (plan) => { const { controls, ...body } = plan; return { batch: { batch_code: 'CONV-EX-20260731', community_id: 'c1', source_system: 'vantaca', stage: 'preflight' }, source_cutoff: { cutoff_date: '2026-07-31' },
  inputs: { snapshot: { completion_id: 's1', sha256: 'a'.repeat(64) }, bridge: { completion_id: 'b1', sha256: 'b'.repeat(64), trusted_fingerprint: 'f'.repeat(64), status: 'PASS', engine: 'x' }, decisions: [{ id: 'dec1', event_key: 'je:D1', choice_key: 'record_after_cutoff', actor_id: 'ed' }], bridge_waivers: [], artifacts: [] },
  plan: body, controls }; };
check('report: canonical sha256 over inputs + plan + controls; rebuilding the recorded base reproduces the hash; tampering with any proposed line changes it', () => {
  const r = PF.buildConversionPreflight(base(build()));
  assert.strictEqual(r.format, 'trusted.onboarding.preflight/v2'); assert.ok(PF.verifyPreflight(r));
  assert.strictEqual(PF.buildConversionPreflight(PF.preflightBase(r)).sha256, r.sha256);
  const t = JSON.parse(JSON.stringify(r)); t.plan.writes.opening_journal_entries[0].lines[0].debit_cents += 1;
  assert.ok(!PF.verifyPreflight(t), 'a changed amount no longer verifies');
  const d = JSON.parse(JSON.stringify(base(build()))); d.inputs.decisions[0].choice_key = 'already_in_legacy_books';
  assert.notStrictEqual(PF.buildConversionPreflight(d).sha256, r.sha256, 'a different decision is a different report');
});
check('report: a waived FAIL/BLOCKED stays FAIL/BLOCKED with separate waiver metadata (never relabelled PASS) and changes the hash; a PASS cannot be waived', () => {
  const t = trustedBase(); t.journal_entries.push(je('X9', '2026-05-01', 'manual', [{ debit_cents: 7 }])); t.journal_entry_lines.push(ln('X9', 1, 1000, 7, 0), ln('X9', 2, 3000, 0, 7));
  const b = base(build({ trusted: t })); const plain = PF.buildConversionPreflight(b);
  const waived = PF.buildConversionPreflight(b, [{ code: 'preflight.no_unhandled_pre_cutover_entries', by: 'ed', reason: 'reviewed the manual entry', at: '2026-10-03T00:00:00Z' }]);
  const c = waived.controls.find((x) => x.code === 'preflight.no_unhandled_pre_cutover_entries');
  assert.strictEqual(c.status, 'BLOCKED'); assert.strictEqual(c.disposition.disposition, 'WAIVED'); assert.strictEqual(c.disposition.waived_by, 'ed');
  assert.notStrictEqual(waived.sha256, plain.sha256); assert.strictEqual(waived.status.overall, plain.status.overall);
  assert.throws(() => PF.buildConversionPreflight(base(build()), [{ code: 'preflight.accounts_resolved', by: 'ed', reason: 'should not be allowed', at: 'x' }]), /PASS control cannot be waived/);
});
check('report renders a readable package (writes, untouched, proof plan, rollback, idempotency) from the hashed JSON', () => {
  const md = PF.renderConversionMarkdown(PF.buildConversionPreflight(base(build())));
  for (const s of ['CONV-EX-20260731-OPEN-OPR', 'Supersede 1', 'Neutralize 2', 'Re-post 1', 'prior-owner credits', 'After EXECUTE, prove', 'Rollback', 'Idempotency']) assert.ok(md.includes(s), s);
});
check('M6 insertability: entries carry the live source_module values (opening_entry / reversal / manual) and the open period of their date', () => {
  const w = build().writes;
  assert.deepStrictEqual(w.opening_journal_entries.map((j) => [j.source_module, j.period_id]), [['opening_entry', 'per7']]);
  assert.deepStrictEqual(w.neutralize_journal_entries.map((j) => [j.source_module, j.period_id]), [['reversal', 'per3'], ['reversal', 'per7']]);
  assert.deepStrictEqual(w.repost_journal_entries.map((j) => [j.source_module, j.period_id]), [['manual', 'per8']]);
  assert.strictEqual(w.ar_opening_batch.management_company_id, 'mc1');
});
check('M6 insertability: a closed or missing period BLOCKS (posting_periods_open); EXECUTE would refuse it too', () => {
  const closed = ctxBase(); closed.periods = closed.periods.map((p) => (p.id === 'per8' ? { ...p, status: 'closed' } : p));
  const p = build({ ctx: closed });
  assert.strictEqual(status(p, 'preflight.posting_periods_open'), 'BLOCKED');
  assert.ok(/closed/.test(p.controls.find((c) => c.code === 'preflight.posting_periods_open').failures[0].problem));
  const none = ctxBase(); none.periods = [];
  assert.strictEqual(status(build({ ctx: none }), 'preflight.posting_periods_open'), 'BLOCKED');
});
check('M6 insertability: an open AP line with no invoice date or a non-positive amount BLOCKS; a community with no management company BLOCKS the ledger batch', () => {
  const noDate = snapshotBase(); noDate.lines[8] = { ...noDate.lines[8], detail: { ...noDate.lines[8].detail, invoice_date: null } };
  assert.strictEqual(status(build({ snapshot: noDate }), 'preflight.ap_invoices_resolved'), 'BLOCKED');
  const credit = snapshotBase(); credit.lines[8] = { ...credit.lines[8], amount_cents: 200 };
  assert.strictEqual(status(build({ snapshot: credit }), 'preflight.ap_invoices_resolved'), 'BLOCKED');
  const noMc = ctxBase(); delete noMc.management_company_id;
  assert.strictEqual(status(build({ ctx: noMc }), 'preflight.ar_rows_resolved'), 'BLOCKED');
});
check('no preflight module can write: the plan builder and report have no database client', () => {
  const fs = require('fs');
  for (const f of ['lib/onboarding/conversion_plan.js', 'lib/onboarding/preflight.js']) {
    const src = fs.readFileSync(require('path').join(__dirname, '..', f), 'utf8');
    assert.ok(!/supabase|\.from\(['"`]|\.insert\(|\.upsert\(|\.delete\(|\.rpc\(/.test(src), `${f} must not touch a database`);
    assert.ok(!/require\([^)]*(supabase|write_gate|service)/.test(src), `${f} must not import a client`);
  }
});

// FORMER OWNERS IN THE AR AGING (Ed 2026-10-07): routed by the snapshot to a prior-owner
// receivable (1310) and a refund liability (2410); the plan carries each as PRIOR-OWNER rows on
// the former owner's own source account (no tenure), and current-owner AR still ties to 1300.
const routedSnapshot = () => {
  const s = snapshotBase();
  s.lines = s.lines.map((l) => (l.account_code === '3000' && l.kind === 'gl_opening_balance' ? { ...l, amount_cents: -930 } : l));
  s.lines.push(
    { line_no: 20, kind: 'gl_opening_balance', account_code: '1310', amount_cents: 40 },
    { line_no: 21, kind: 'gl_opening_balance', account_code: '2410', amount_cents: -60 },
    { line_no: 22, kind: 'former_owner_receivable', account_code: '1310', source_account_key: '90011', amount_cents: 40, detail: { former_owner: true } },
    { line_no: 23, kind: 'former_owner_refund', account_code: '2410', source_account_key: '90012', amount_cents: -60, detail: { former_owner: true } },
    { line_no: 24, kind: 'ar_aging_item', account_code: '1300', source_account_key: '90011', amount_cents: 40, detail: { charge_type: 'Balance Forward - Legal Fee' } },
    { line_no: 25, kind: 'ar_aging_item', account_code: '1300', source_account_key: '90012', amount_cents: -60, detail: { charge_type: 'Annual Assessment' } });
  return s;
};
const routedSource = () => ({ ...source(), aging_rows: [
  { source_account_key: '90011', previous_owner: true, balance_cents: 40, provenance: { artifact_sha256: 'd'.repeat(64), locator: { line: 987 }, raw: '      90011 - *** 2 Example Lane - Zaghmouth' } },
  { source_account_key: '90012', previous_owner: true, balance_cents: -60, provenance: { artifact_sha256: 'd'.repeat(64), locator: { line: 1566 }, raw: '      90012 - *** 9 Nowhere Road - Johnson' } }] });
const routedCtx = () => { const c = ctxBase(); c.accounts = [...c.accounts, A(1310), A(2410)]; return c; };
check('former owners in the aging: debits -> prior-owner receivable rows, credits -> named refund-liability rows, each on its own source account (no tenure, never a current owner); current-owner AR still ties to 1300', () => {
  const p = build({ snapshot: routedSnapshot(), source: routedSource(), ctx: routedCtx() });
  for (const k of ['preflight.ar_rows_resolved', 'preflight.ar_subledger_ties_to_gl', 'preflight.prepaid_subledger_ties_to_gl', 'preflight.former_owner_aging_rows_routed']) assert.strictEqual(status(p, k), 'PASS', k);
  const rows = p.writes.ar_opening_batch.rows;
  const recv = rows.find((r) => r.vantaca_account_id === '90011'); const refund = rows.find((r) => r.vantaca_account_id === '90012');
  assert.deepStrictEqual([recv.prior_owner, recv.tenure_id, recv.txn_type, recv.amount_cents, recv.raw_row.prior_owner.route, recv.raw_row.prior_owner.gl_account, recv.raw_row.prior_owner.name], [true, null, 'balance_brought_forward', 40, 'prior_owner_receivable', '1310', 'Zaghmouth']);
  assert.strictEqual(recv.property_id, 'p2', 'the exact printed lot is kept as the lot only (no tenure)');
  assert.deepStrictEqual([refund.prior_owner, refund.tenure_id, refund.txn_type, refund.charge_category, refund.amount_cents, refund.raw_row.prior_owner.route, refund.property_id, refund.raw_row.prior_owner.name], [true, null, 'credit', 'credit', -60, 'refund_liability', null, 'Johnson']);
  assert.match(refund.description, /Former-owner refund payable/);
  // execute-time totals: all receivables (current 300 + former 40); all prior-owner credits (prepaid former -100 + refund -60)
  assert.deepStrictEqual([p.writes.ar_opening_batch.receivable_cents, p.writes.ar_opening_batch.current_owner_prepaid_cents, p.writes.ar_opening_batch.prior_owner_credit_cents], [340, -50, -160]);
});
check('a routed former-owner row whose account is a CURRENT property account, or with no source row, is a problem (blocked), never a current owner’s balance', () => {
  const s = routedSource(); s.aging_rows = s.aging_rows.filter((r) => r.source_account_key !== '90012');
  assert.strictEqual(status(build({ snapshot: routedSnapshot(), source: s, ctx: routedCtx() }), 'preflight.ar_rows_resolved'), 'BLOCKED');
  const c = routedCtx(); c.properties = [...c.properties, { id: 'p9', vantaca_account_id: '90011', street_address: '2 Example Lane' }];
  assert.strictEqual(status(build({ snapshot: routedSnapshot(), source: routedSource(), ctx: c }), 'preflight.ar_rows_resolved'), 'BLOCKED');
});

// RESTORED OPEN AP (Ed 2026-10-07, Canyon Gate / Star Protection): the source booked the
// invoice's expense and then a payment that never left the bank; the approved correction
// (Dr 1000 / Cr 2000) restores it to AP. Trusted holds the invoice (July entry Dr expense /
// Cr AP) and its real August payment. Carried ONCE: July entry neutralized (expense once),
// the existing invoice is the open AP (no second invoice), the August payment pays it (cash once).
const restoredSnapshot = () => {
  const s = snapshotBase();
  s.lines = s.lines.map((l) => (l.kind !== 'gl_opening_balance' ? l : l.account_code === '1000' ? { ...l, amount_cents: 1070 } : l.account_code === '2000' ? { ...l, amount_cents: -270 } : l));
  s.lines.push({ line_no: 30, kind: 'ap_detail_restored', account_code: '2000', amount_cents: -70, detail: { source_vendor_key: 'Acme LLC', invoice_number: 'R1N', invoice_date: '2026-07-10', restored_by: { approved_by: 'Ed Gojara' } } });
  return s;
};
const restoredTrusted = () => {
  const t = trustedBase();
  t.journal_entries.push(je('R1', '2026-07-10', 'ap_invoice', [{ debit_cents: 70 }]), je('P1', '2026-08-10', 'payment_intake', [{ debit_cents: 70 }]));
  t.journal_entry_lines.push(ln('R1', 1, 4000, 70, 0), ln('R1', 2, 2000, 0, 70), ln('P1', 1, 2000, 70, 0), ln('P1', 2, 1000, 0, 70));
  t.ap_invoices.push({ id: 'R1', vendor_id: 'v1', vendor_invoice_number: 'R1N', invoice_date: '2026-07-10', total_cents: 70, posting_journal_entry_id: 'R1', voided_at: null });
  t.ap_payments = [{ id: 'P1', check_number: '1003', payment_date: '2026-08-10', amount_cents: 70, posting_journal_entry_id: 'P1' }];
  return t;
};
const restoredBridge = (inv = { classification: 'ALREADY_IN_SOURCE', method: 'invoice_number_restored_by_opening_correction' }) => { const b = bridgeBase(); b.items.push(
  { item_no: 5, event_key: 'je:R1', amount_cents: 70, records: ['journal_entries:R1', 'ap_invoices:R1'], ...inv },
  { item_no: 6, event_key: 'je:P1', classification: 'LEGITIMATE_SUBSEQUENT', method: 'pays_invoices_restored_by_opening_correction', records: ['journal_entries:P1', 'ap_payments:P1'] }); return b; };
const APPS = [{ payment_id: 'P1', invoice_id: 'R1', applied_cents: 70 }];
const buildRestored = (o = {}) => build({ snapshot: restoredSnapshot(), trusted: o.trusted || restoredTrusted(), bridge: o.bridge || restoredBridge(), apps: o.apps || APPS, ...(o.ctx ? { ctx: o.ctx } : {}) });
check('restored AP (Star): the existing Trusted invoice is carried once; its July entry is neutralized (expense once); the August payment is untouched and pays it (cash once); AP ties; every control PASSES', () => {
  const p = buildRestored();
  assert.deepStrictEqual(p.controls.filter((c) => c.status !== 'PASS').map((c) => [c.code, c.failures]), []);
  assert.deepStrictEqual(p.carried_ap_invoices.map((c) => [c.invoice_id, c.vendor_invoice_number, c.total_cents, c.entry.reference, c.paid_after_cutoff.map((a) => a.check_number), c.open_today_cents]), [['R1', 'R1N', 70, 'JE-R1', ['1003'], 0]]);
  assert.ok(p.writes.neutralize_journal_entries.some((j) => j.original_je_id === 'R1'), 'July entry neutralized');
  assert.ok(!p.writes.neutralize_journal_entries.some((j) => j.original_je_id === 'P1') && !p.writes.repost_journal_entries.some((j) => ['R1', 'P1'].includes(j.original_je_id)), 'August payment untouched; the July entry is not re-posted');
  assert.ok(!p.writes.ap_opening_invoices.some((a) => a.vendor_invoice_number === 'R1N'), 'never a second invoice');
  assert.strictEqual(p.summary.ap_carried_invoices, 1);
  assert.deepStrictEqual(p.proof_plan.find((x) => x.check === 'ap_as_of_cutoff').expected, { ap_cents: -270, carried_invoices: 1, carried_cents: 70 });
  assert.strictEqual(status(p, 'preflight.projected_cutoff_tb_equals_source'), 'PASS');
});
check('restored AP is carried once or BLOCKED: entry re-posted after the cutover (expense twice), entry not neutralized, a payment on/before the cutoff, two Trusted invoices with the number, unknown vendor, or overpaid', () => {
  const reposted = restoredBridge({ classification: 'AMBIGUOUS', method: 'x', evidence: { decision: { type: 'source_or_keep', recorded: { choice_key: 'keep_as_trusted_activity' } } } });
  assert.strictEqual(status(buildRestored({ bridge: reposted }), 'preflight.restored_ap_carried_once'), 'BLOCKED');
  const kept = restoredBridge({ classification: 'OUT_OF_SCOPE', method: 'x' });
  assert.strictEqual(status(buildRestored({ bridge: kept }), 'preflight.restored_ap_carried_once'), 'BLOCKED');
  const early = restoredTrusted(); early.ap_payments[0].payment_date = '2026-07-30';
  assert.strictEqual(status(buildRestored({ trusted: early }), 'preflight.restored_ap_carried_once'), 'BLOCKED');
  const twice = restoredTrusted(); twice.ap_invoices.push({ ...twice.ap_invoices[0], id: 'R2' });
  assert.strictEqual(status(buildRestored({ trusted: twice }), 'preflight.restored_ap_carried_once'), 'BLOCKED');
  const c = ctxBase(); c.vendors = [{ id: 'v1', name: 'Another Vendor' }];
  assert.strictEqual(status(buildRestored({ ctx: c }), 'preflight.restored_ap_carried_once'), 'BLOCKED');
  assert.strictEqual(status(buildRestored({ apps: [...APPS, { payment_id: 'P1', invoice_id: 'R1', applied_cents: 70 }] }), 'preflight.restored_ap_carried_once'), 'BLOCKED');
});
// OPEN AP THE TRUSTED BOOKS ALREADY HOLD (generic; Canyon Gate's A-Beautiful Pools): the source
// aging's open invoice was re-entered in Trusted (AP-to-AP entry, no expense) and paid after the
// cutoff. Vendor named differently in the two systems ("ACME, INC." vs "Acme LLC").
const heldSnapshot = () => { const s = snapshotBase(); s.lines[8] = { ...s.lines[8], detail: { ...s.lines[8].detail, source_vendor_key: 'ACME, INC.' } }; return s; };
const heldTrusted = () => {
  const t = trustedBase();
  t.journal_entries.push(je('A0', '2026-07-20', 'ap_invoice', [{ debit_cents: 200 }]), je('A9', '2026-08-20', 'payment_intake', [{ debit_cents: 200 }]));
  t.journal_entry_lines.push(ln('A0', 1, 2000, 200, 0), ln('A0', 2, 2000, 0, 200), ln('A9', 1, 2000, 200, 0), ln('A9', 2, 1000, 0, 200));
  t.ap_invoices.push({ id: 'I0', vendor_id: 'v1', vendor_invoice_number: 'X1', invoice_date: '2026-07-20', total_cents: 200, posting_journal_entry_id: 'A0', voided_at: null });
  t.ap_payments = [{ id: 'P9', check_number: '1036', payment_date: '2026-08-20', amount_cents: 200, posting_journal_entry_id: 'A9' }];
  return t;
};
const heldBridge = () => { const b = bridgeBase(); b.items.push({ item_no: 7, event_key: 'je:A0', classification: 'ALREADY_IN_SOURCE', method: 'invoice_number_and_amount_in_source', records: ['journal_entries:A0', 'ap_invoices:I0'] },
  { item_no: 8, event_key: 'je:A9', classification: 'LEGITIMATE_SUBSEQUENT', method: 'after_cutoff_no_source_evidence', records: ['journal_entries:A9', 'ap_payments:P9'] }); return b; };
check('open AP Trusted already holds: the source open item is the existing Trusted invoice, carried once (vendor matched by the shared normalizer, shown in the notes); AP ties; never a second invoice', () => {
  const p = build({ snapshot: heldSnapshot(), trusted: heldTrusted(), bridge: heldBridge(), apps: [{ payment_id: 'P9', invoice_id: 'I0', applied_cents: 200 }] });
  assert.deepStrictEqual(p.controls.filter((c) => c.status !== 'PASS').map((c) => [c.code, c.failures]), []);
  assert.deepStrictEqual(p.carried_ap_invoices.map((c) => [c.invoice_id, c.origin, c.entry.reference, c.paid_after_cutoff.map((a) => a.check_number)]), [['I0', 'source_open_item', 'JE-A0', ['1036']]]);
  assert.strictEqual(p.writes.ap_opening_invoices.length, 0);
  assert.ok(p.notes.some((n) => n.type === 'vendor_matched_by_normalized_name' && /ACME, INC\. -> Acme LLC \(normalized_name\)/.test(n.text)));
});
check('vendor normalizer is exactly-one or BLOCK: two active vendors that normalize alike block; an inactive duplicate is ignored', () => {
  const two = ctxBase(); two.vendors = [...two.vendors, { id: 'v2', name: 'Acme Co' }];
  assert.strictEqual(status(build({ snapshot: heldSnapshot(), ctx: two }), 'preflight.ap_invoices_resolved'), 'BLOCKED');
  const inactive = ctxBase(); inactive.vendors = [...inactive.vendors, { id: 'v2', name: 'Acme Co', is_active: false }];
  assert.strictEqual(status(build({ snapshot: heldSnapshot(), ctx: inactive }), 'preflight.ap_invoices_resolved'), 'PASS');
});
check('fund allocation: an account split across funds posts one line per fund (same account, that fund); every fund\'s opening entry balances; the cutoff TB still equals the source', () => {
  const s = snapshotBase();
  s.lines[0] = { ...s.lines[0], detail: { fund_allocation: { parts: [{ fund_code: 'OPR', amount_cents: 600 }, { fund_code: 'RES', amount_cents: 400 }] } } };
  s.lines[4] = { ...s.lines[4], detail: { fund_allocation: { parts: [{ fund_code: 'OPR', amount_cents: -550 }, { fund_code: 'RES', amount_cents: -400 }] } } };
  const c = ctxBase(); c.funds = [...c.funds, { id: 'f-res', code: 'RES' }];
  const p = build({ snapshot: s, ctx: c });
  for (const k of ['preflight.opening_entries_balance', 'preflight.accounts_resolved', 'preflight.projected_cutoff_tb_equals_source']) assert.strictEqual(status(p, k), 'PASS', k);
  const res = p.writes.opening_journal_entries.find((j) => j.fund_code === 'RES');
  assert.deepStrictEqual(res.lines.map((l) => [l.account_number, l.fund_id, l.debit_cents, l.credit_cents]), [['1000', 'f-res', 400, 0], ['3000', 'f-res', 0, 400]]);
  const unknown = snapshotBase(); unknown.lines[0] = { ...unknown.lines[0], detail: { fund_allocation: { parts: [{ fund_code: 'ZZZ', amount_cents: 1000 }] } } };
  assert.strictEqual(status(build({ snapshot: unknown }), 'preflight.accounts_resolved'), 'BLOCKED', 'an unknown fund blocks');
});
check('a void pair that straddles the cutoff (entry before, reversal after) moves across the cutover: entry neutralized on its date and re-posted on the cutover; the cutoff TB equals the source; the reversal is untouched', () => {
  const t = trustedBase();
  t.journal_entries.push(je('V1', '2026-07-22', 'ap_invoice', [{ debit_cents: 30 }], { status: 'voided', void_reversal_je_id: 'V2' }), je('V2', '2026-08-28', 'reversal', [{ debit_cents: 30 }], { reverses_je_id: 'V1' }));
  t.journal_entry_lines.push(ln('V1', 1, 4000, 30, 0), ln('V1', 2, 2000, 0, 30), ln('V2', 1, 2000, 30, 0), ln('V2', 2, 4000, 0, 30));
  const b = bridgeBase(); b.items.push({ item_no: 9, event_key: 'je:V1', classification: 'OUT_OF_SCOPE', method: 'void_pair_nets_to_zero', records: ['journal_entries:V1'] }, { item_no: 10, event_key: 'je:V2', classification: 'OUT_OF_SCOPE', method: 'void_pair_nets_to_zero', records: ['journal_entries:V2'] });
  const p = build({ trusted: t, bridge: b });
  for (const k of ['preflight.no_unhandled_pre_cutover_entries', 'preflight.projected_cutoff_tb_equals_source', 'preflight.post_cutover_activity_untouched']) assert.strictEqual(status(p, k), 'PASS', k);
  assert.ok(p.writes.neutralize_journal_entries.some((j) => j.original_je_id === 'V1') && p.writes.repost_journal_entries.some((j) => j.original_je_id === 'V1' && j.posting_date === '2026-08-01'));
  assert.ok(!p.writes.neutralize_journal_entries.some((j) => j.original_je_id === 'V2'), 'the reversal after the cutover is untouched');
});
check('accrued in the legacy books: the Trusted entry is neutralized (expense once) and the accrual moves to AP on the cutover date (Dr accrual / Cr AP) in the entries EXECUTE writes; the cutoff TB still equals the source', () => {
  const b = bridgeBase(); b.items[2] = { ...b.items[2], evidence: { decision: { type: 'recording_period', accrual: { account: '2400', amount_cents: 20 }, recorded: { choice_key: 'accrued_in_legacy_books', decision_id: 'decA' } } } };
  const p = build({ bridge: b });
  for (const k of ['preflight.every_item_has_a_treatment', 'preflight.accrual_reclasses_resolved', 'preflight.projected_cutoff_tb_equals_source', 'preflight.posting_periods_open']) assert.strictEqual(status(p, k), 'PASS', k);
  assert.ok(p.writes.neutralize_journal_entries.some((j) => j.original_je_id === 'D1'), 'the duplicate expense entry is neutralized');
  const r = p.writes.repost_journal_entries.find((j) => j.kind === 'accrual_to_ap_reclass');
  assert.deepStrictEqual([r.reference, r.posting_date, r.lines.map((l) => [l.account_number, l.debit_cents, l.credit_cents])], ['CONV-EX-20260731-RECLASS-JE-D1', '2026-08-01', [['2400', 20, 0], ['2000', 0, 20]]]);
  assert.ok(!p.writes.repost_journal_entries.some((j) => j.original_je_id === 'D1'), 'the original is not re-posted');
  const bad = bridgeBase(); bad.items[2] = { ...bad.items[2], evidence: { decision: { type: 'recording_period', accrual: { account: '9999', amount_cents: 20 }, recorded: { choice_key: 'accrued_in_legacy_books' } } } };
  assert.strictEqual(status(build({ bridge: bad }), 'preflight.accrual_reclasses_resolved'), 'BLOCKED', 'an unresolved accrual account blocks');
});
check('without restored lines nothing changes: no carried invoices, no extra control, AP ties on opening invoices alone', () => {
  const p = build();
  assert.strictEqual(p.carried_ap_invoices, undefined); assert.strictEqual(p.controls.find((c) => c.code === 'preflight.restored_ap_carried_once'), undefined);
  assert.strictEqual(p.summary.ap_carried_invoices, undefined);
});

(async () => {
  let pass = 0, fail = 0;
  console.log('Onboarding M5: conversion preflight (Issue #15)');
  for (const [n, fn] of tests) { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n      ')); } }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
