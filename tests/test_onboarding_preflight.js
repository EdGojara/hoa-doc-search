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
  vendors: [{ id: 'v1', name: 'Acme LLC' }], gl_cutover_date: '2026-06-01', current_trusted_fingerprint: 'f'.repeat(64),
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
const build = (o = {}) => buildConversionPlan({ batch: { id: 'batch', batch_code: 'CONV-EX-20260731', community_id: 'c1', as_of_date: '2026-07-31' }, snapshot: o.snapshot || snapshotBase(), bridge: o.bridge || bridgeBase(), source: o.source || source(), trusted: o.trusted || trustedBase(), ctx: o.ctx || ctxBase() });
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
check('AP: open invoices resolve to one vendor, post by the opening entry, tie to GL AP; an invoice number already in Trusted is BLOCKED', () => {
  const p = build(); const ap = p.writes.ap_opening_invoices;
  assert.deepStrictEqual(ap.map((a) => [a.vendor_id, a.vendor_invoice_number, a.total_cents, a.posting_journal_entry_reference]), [['v1', 'X1', 200, 'CONV-EX-20260731-OPEN-OPR']]);
  const t = trustedBase(); t.ap_invoices.push({ id: 'I0', vendor_id: 'v1', vendor_invoice_number: 'X1', voided_at: null });
  assert.strictEqual(status(build({ trusted: t }), 'preflight.ap_invoices_resolved'), 'BLOCKED');
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
check('no preflight module can write: the plan builder and report have no database client', () => {
  const fs = require('fs');
  for (const f of ['lib/onboarding/conversion_plan.js', 'lib/onboarding/preflight.js']) {
    const src = fs.readFileSync(require('path').join(__dirname, '..', f), 'utf8');
    assert.ok(!/supabase|\.from\(['"`]|\.insert\(|\.upsert\(|\.delete\(|\.rpc\(/.test(src), `${f} must not touch a database`);
    assert.ok(!/require\([^)]*(supabase|write_gate|service)/.test(src), `${f} must not import a client`);
  }
});

(async () => {
  let pass = 0, fail = 0;
  console.log('Onboarding M5: conversion preflight (Issue #15)');
  for (const [n, fn] of tests) { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n      ')); } }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
