// ============================================================================
// tests/test_onboarding_bridge.js  (Issue #15 Milestone 4) — Activity Bridge
// ----------------------------------------------------------------------------
// Synthetic source fixture + synthetic Trusted activity (no client data).
// One event per rule, proving:
//   - provenance first: legacy imports / system entries in the source period ->
//     ALREADY_IN_SOURCE; superseded -> OUT_OF_SCOPE;
//   - no money moved: test / pending payments and void pairs -> OUT_OF_SCOPE; a
//     void without its reversal -> AMBIGUOUS + structural issue;
//   - durable identifier + amount in the source -> ALREADY_IN_SOURCE even when
//     dated AFTER the cutoff (after-cutoff is not automatically subsequent);
//     identifier with a different amount -> AMBIGUOUS;
//   - amount alone (no identifier) -> AMBIGUOUS, never a duplicate; a source line
//     carrying a DIFFERENT invoice number is not a candidate;
//   - no evidence: after cutoff -> LEGITIMATE_SUBSEQUENT; inside the source
//     period -> AMBIGUOUS;
//   - structural problems on preserved events are reported, not repaired;
//   - every candidate record classified exactly once; totals reconcile;
//   - deterministic sha; fingerprint changes when Trusted changes;
//   - the loader only works through the read-only client and reads no
//     ACC / violation / certification tables; the modules hold no DB writes.
// ============================================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const E = require('../lib/onboarding/engine');
const { makeArtifact } = require('../lib/onboarding/artifacts');
const { buildBridge, trustedFingerprint } = require('../lib/onboarding/bridge');
const { loadTrustedActivity } = require('../lib/onboarding/trusted_activity');
const { readOnlyClient } = require('../lib/onboarding/write_gate');

const FX = path.join(__dirname, 'fixtures', 'onboarding', 'synthetic-vantaca');
const parsed = E.normalize('vantaca', ['gl_trial_balance', 'balance_sheet', 'ar_aging', 'homeowner_transactions'].map((t) => { const buffer = fs.readFileSync(path.join(FX, `${t}.txt`)); return { artifact: makeArtifact(buffer, { batch_code: 'B', community_id: 'c', source_system: 'vantaca', artifact_type: t, filename: t, cutoff_date: '2026-03-31' }), buffer }; })).parsed;
const ACC = { a1300: '1300', a4030: '4030', a2000: '2000', a5200: '5200', a1000: '1000' };
const je = (id, d, mod, amt, extra = {}) => ({ id, posting_date: d, source_module: mod, status: 'posted', total_debits_cents: amt, total_credits_cents: amt, description: '', reference: id.toUpperCase(), superseded_at: null, ...extra });
const ln = (jeId, acct, dr, cr) => ({ id: `${jeId}-${acct}-${dr}-${cr}`, journal_entry_id: jeId, account_id: acct, debit_cents: dr, credit_cents: cr });
function trusted() {
  return {
    journal_entries: [
      je('je1', '2026-02-01', 'vantaca_import', 61000), je('je2', '2026-03-01', 'system', 2188),
      je('je3', '2026-03-15', 'ap_invoice', 5000, { superseded_at: '2026-04-01T00:00:00Z' }),
      je('je4', '2026-04-03', 'payment_intake', 10000, { status: 'voided', void_reversal_je_id: 'je5', description: 'AP payment check #29' }),
      je('je5', '2026-04-04', 'reversal', 10000, { reverses_je_id: 'je4' }),
      je('je6', '2026-04-04', 'payment_intake', 7000, { status: 'voided', void_reversal_je_id: null }),
      je('je7', '2026-04-05', 'ap_invoice', 15000, { description: 'AP invoice EX-0001 — Example Landscaping LLC' }),
      je('je8', '2026-04-10', 'ap_invoice', 9900, { description: 'AP invoice EX-0001 — Example Landscaping LLC' }),
      je('je9', '2026-03-10', 'ap_invoice', 15000, { description: 'AP invoice EX-0099 — Example Landscaping LLC' }),
      je('je10', '2026-04-15', 'ap_invoice', 15000, { description: 'AP invoice ZZ-77 — Other Vendor' }),
      je('je11', '2026-03-05', 'payment_intake', 15000, { description: 'AP payment ach' }),
      je('je12', '2026-04-20', 'certified_letter_fee', 2500, { description: 'Certified letter fee' }),
      je('je13', '2026-04-25', 'ap_invoice', 40000, { description: 'AP invoice Q-1 — Vendor' }),
      je('je14', '2026-04-26', 'payment_intake', 10000, { description: 'AP payment check #1001' }),
    ],
    journal_entry_lines: [ln('je7', 'a5200', 15000, 0), ln('je7', 'a2000', 0, 15000), ln('je10', 'a5200', 15000, 0), ln('je10', 'a2000', 0, 15000),
      ln('je12', 'a1300', 2500, 0), ln('je12', 'a4030', 0, 2500), ln('je13', 'a5200', 40000, 0), ln('je13', 'a2000', 0, 40000), ln('je14', 'a2000', 10000, 0), ln('je14', 'a1000', 0, 9000)],
    ap_invoices: [{ id: 'inv7', vendor_invoice_number: 'EX-0001', invoice_date: '2026-04-05', total_cents: 15000, posting_journal_entry_id: 'je7' },
      { id: 'inv13', vendor_invoice_number: 'Q-1', invoice_date: '2026-04-25', total_cents: 30000, posting_journal_entry_id: 'je13' }],
    ap_payments: [{ id: 'pay14', check_number: '1001', payment_date: '2026-04-26', amount_cents: 10000, posting_journal_entry_id: 'je14' }],
    ar_charges: [{ id: 'arc12', property_id: 'P1', charge_date: '2026-04-20', original_amount_cents: 2500, source_module: 'certified_letter_fee', posting_journal_entry_id: 'je12' },
      ...[1, 2, 3].map((i) => ({ id: `arcm${i}`, property_id: 'P1', charge_date: '2026-01-01', original_amount_cents: 1000, source_module: 'vantaca_migration', posting_journal_entry_id: null }))],
    ar_payments: [{ id: 'arp1', property_id: 'P1', payment_date: '2026-04-02', amount_cents: 21000, source: 'portal', posting_journal_entry_id: null }],
    payments: [{ id: 'p1', amount_cents: 100, status: 'pending', livemode: null, journal_entry_id: null, created_at: '2026-03-20T00:00:00Z' }],
    homeowner_transactions: [1, 2, 3, 4].map((i) => ({ id: `ht${i}`, source_batch_id: 'batchA', transaction_date: '2026-01-01', amount_cents: 100 })),
  };
}
const ctx = { batch_code: 'B', cutoff_date: '2026-03-31', roles: { ar_account: '1300', prepaid_account: '2400' }, snapshot: { completion_id: 'snap-1', stale: false }, accountOfProperty: (p) => ({ P1: '90000001' }[p] || null), accountNumber: (id) => ACC[id] || null };
const run = (t = trusted()) => buildBridge(parsed, t, ctx);
const ev = (b, k) => b.items.find((it) => it.event_key === k);
const tests = []; const check = (n, fn) => tests.push([n, fn]);

check('provenance: legacy import JE and grouped legacy rows -> ALREADY_IN_SOURCE; superseded -> OUT_OF_SCOPE', () => {
  const b = run();
  assert.deepStrictEqual([ev(b, 'je:je1').classification, ev(b, 'je:je1').method], ['ALREADY_IN_SOURCE', 'provenance_legacy_import']);
  assert.deepStrictEqual([ev(b, 'je:je3').classification, ev(b, 'je:je3').method], ['OUT_OF_SCOPE', 'superseded_by_prior_conversion']);
  const mig = ev(b, 'loose:ar_charges:vantaca_migration'); assert.strictEqual(mig.classification, 'ALREADY_IN_SOURCE'); assert.strictEqual(mig.records.length, 3);
  const ht = ev(b, 'loose:homeowner_transactions:batch:batchA'); assert.strictEqual(ht.classification, 'ALREADY_IN_SOURCE'); assert.strictEqual(ht.records.length, 4);
});
check('REGRESSION (Ed, M4 review): a generic in-period system entry can never be ALREADY_IN_SOURCE from date + module alone; it is AMBIGUOUS with its reference and description', () => {
  const b = run();
  const sys = ev(b, 'je:je2');
  assert.deepStrictEqual([sys.classification, sys.method, sys.confidence], ['AMBIGUOUS', 'system_entry_in_source_period_unproven', 'low']);
  assert.strictEqual(sys.evidence.reference, 'JE2');
  // even many of them, any amount, any month inside the period: never ALREADY
  const t = trusted(); for (let m = 1; m <= 3; m++) t.journal_entries.push(je('sys' + m, '2026-0' + m + '-15', 'system', 15000 * m));
  const b2 = run(t);
  assert.ok(b2.items.filter((it) => it.kind === 'system').every((it) => it.classification === 'AMBIGUOUS'));
  assert.ok(!b2.items.some((it) => it.classification === 'ALREADY_IN_SOURCE' && /system/.test(it.method)));
});
check('no money moved: test/pending payment and a void pair -> OUT_OF_SCOPE; a void with no matching reversal -> AMBIGUOUS + structural issue', () => {
  const b = run();
  assert.strictEqual(ev(b, 'loose:payments:p1').classification, 'OUT_OF_SCOPE');
  assert.deepStrictEqual([ev(b, 'je:je4').classification, ev(b, 'je:je4').method, ev(b, 'je:je5').classification], ['OUT_OF_SCOPE', 'void_pair_nets_to_zero', 'OUT_OF_SCOPE']);
  assert.strictEqual(ev(b, 'je:je6').classification, 'AMBIGUOUS'); assert.ok(ev(b, 'je:je6').structural_issues.length);
});
check('identifier + amount in the source -> ALREADY_IN_SOURCE even though dated AFTER the cutoff; identifier with a different amount -> AMBIGUOUS', () => {
  const b = run();
  const a = ev(b, 'je:je7'); assert.deepStrictEqual([a.classification, a.method, a.evidence.identifier], ['ALREADY_IN_SOURCE', 'invoice_number_and_amount_in_source', 'EX-0001']);
  assert.ok(a.evidence.source_matches[0].artifact_sha256 && a.evidence.source_matches[0].locator.line > 0, 'source provenance in the evidence');
  assert.strictEqual(a.records.includes('ap_invoices:inv7'), true);
  assert.deepStrictEqual([ev(b, 'je:je8').classification, ev(b, 'je:je8').method], ['AMBIGUOUS', 'identifier_in_source_amount_differs']);
});
check('amount alone never makes a duplicate: same amount near the date without an identifier -> AMBIGUOUS; a source line with a DIFFERENT invoice number is not a candidate', () => {
  const b = run();
  assert.deepStrictEqual([ev(b, 'je:je11').classification, ev(b, 'je:je11').method, ev(b, 'je:je11').confidence], ['AMBIGUOUS', 'amount_match_without_identifier', 'low']);
  assert.deepStrictEqual([ev(b, 'je:je9').classification, ev(b, 'je:je9').method], ['AMBIGUOUS', 'in_source_period_not_found_in_source'], 'EX-0001 in the source contradicts EX-0099');
  assert.ok(!b.items.some((it) => it.classification === 'ALREADY_IN_SOURCE' && /^amount/.test(it.method)), 'never ALREADY_IN_SOURCE on an amount-only method');
  assert.strictEqual(b.controls.find((c) => c.code === 'bridge.no_duplicate_on_amount_alone').status, 'PASS');
});
check('no source evidence: after cutoff -> LEGITIMATE_SUBSEQUENT (with structural checks); the certified-letter AR charge is preserved', () => {
  const b = run();
  assert.deepStrictEqual([ev(b, 'je:je10').classification, ev(b, 'je:je10').structural_issues], ['LEGITIMATE_SUBSEQUENT', []]);
  const fee = ev(b, 'je:je12'); assert.deepStrictEqual([fee.classification, fee.structural_issues], ['LEGITIMATE_SUBSEQUENT', []]);
  assert.ok(fee.records.includes('ar_charges:arc12'));
});
check('structural problems on preserved events are REPORTED (never repaired): invoice != entry, unbalanced lines, AR record with no journal entry', () => {
  const b = run();
  assert.ok(ev(b, 'je:je13').structural_issues.some((s) => /AP invoice total \(30000\) != journal entry \(40000\)/.test(s)));
  assert.ok(ev(b, 'je:je14').structural_issues.some((s) => /lines do not balance/.test(s)));
  assert.ok(ev(b, 'loose:ar_payments:arp1').structural_issues.some((s) => /no journal entry/.test(s)));
  const c = b.controls.find((x) => x.code === 'bridge.preserved_events_structurally_complete');
  assert.strictEqual(c.status, 'FAIL'); assert.ok(c.failures.length >= 3);
});
check('exactly once: every candidate record (not JE lines) is in exactly one event; totals reconcile; ambiguous items BLOCK the stage', () => {
  const t = trusted(); const b = run(t);
  const candidates = Object.entries(t).filter(([k]) => k !== 'journal_entry_lines').reduce((n, [, v]) => n + v.length, 0);
  assert.strictEqual(b.candidate_records, candidates);
  const all = b.items.flatMap((it) => it.records); assert.strictEqual(all.length, new Set(all).size); assert.strictEqual(all.length, candidates);
  assert.strictEqual(b.controls.find((c) => c.code === 'bridge.every_record_classified_exactly_once').status, 'PASS');
  assert.strictEqual(b.controls.find((c) => c.code === 'bridge.record_count_reconciles').status, 'PASS');
  const sumT = Object.values(b.totals).reduce((n, x) => n + x.records, 0); assert.strictEqual(sumT, candidates);
  const amb = b.controls.find((c) => c.code === 'bridge.ambiguous_items_reviewed'); assert.strictEqual(amb.status, 'BLOCKED');
  assert.strictEqual(amb.left_cents, b.totals.AMBIGUOUS.amount_cents);
  assert.ok(b.items.every((it) => it.method && it.evidence && it.batch_code === 'B' && it.cutoff_date === '2026-03-31'));
});
check('built on the current snapshot: missing or stale snapshot is not a PASS', () => {
  assert.strictEqual(buildBridge(parsed, trusted(), { ...ctx, snapshot: null }).controls.find((c) => c.code === 'bridge.built_on_current_snapshot').status, 'BLOCKED');
  assert.strictEqual(buildBridge(parsed, trusted(), { ...ctx, snapshot: { completion_id: 's', stale: true } }).controls.find((c) => c.code === 'bridge.built_on_current_snapshot').status, 'FAIL');
});
check('deterministic sha; the Trusted fingerprint changes when any record changes (stale on source change)', () => {
  assert.strictEqual(run().sha256, run().sha256);
  const t = trusted(); const f1 = trustedFingerprint(t);
  t.ap_invoices[0] = { ...t.ap_invoices[0], total_cents: 15001 };
  assert.notStrictEqual(trustedFingerprint(t), f1);
  assert.notStrictEqual(run(t).sha256, run().sha256);
});
check('loader: only through the read-only client; reads only financial tables, community-scoped and ordered; a write through it is impossible', async () => {
  const reads = []; const rows = trusted();
  const tableRows = { ...rows, chart_of_accounts: Object.entries(ACC).map(([id, n]) => ({ id, account_number: n })), properties: [{ id: 'P1', vantaca_account_id: '90000001' }] };
  const builder = (table) => { const st = { table, filters: [], ordered: false }; const b = {
    select() { return b; }, eq(c, v) { st.filters.push([c, v]); return b; }, in(c, v) { st.filters.push([c, v]); return b; }, order() { st.ordered = true; return b; },
    range(a, z) { reads.push(st); return Promise.resolve({ data: (tableRows[table] || []).slice(a, z + 1), error: null }); },
    insert() { throw new Error('reached the database'); } }; return b; };
  const fake = { from: builder, rpc() { throw new Error('reached the database'); }, storage: { from() { return {}; } } };
  await assert.rejects(() => loadTrustedActivity(fake, 'c'), /read-only client/);
  const ro = readOnlyClient(fake);
  assert.throws(() => ro.from('journal_entries').insert({}), (e) => e.code === 'WRITE_BLOCKED');
  const L = await loadTrustedActivity(ro, 'c');
  assert.strictEqual(L.trusted.journal_entries.length, 14); assert.strictEqual(L.accountNumber('a1300'), '1300'); assert.strictEqual(L.accountOfProperty('P1'), '90000001');
  const tables = new Set(reads.map((r) => r.table));
  for (const t of tables) assert.ok(!/violation|acc_|arc|certif|interaction/.test(t), t);
  assert.ok(reads.every((r) => r.ordered), 'every read ordered');
  assert.ok(reads.filter((r) => r.table !== 'journal_entry_lines' && r.table !== 'ap_payment_applications').every((r) => r.filters.some(([c, v]) => c === 'community_id' && v === 'c')), 'community-scoped');
});
check('bridge and loader modules hold no DB client and no write calls', () => {
  for (const f of ['bridge.js', 'trusted_activity.js']) {
    const s = fs.readFileSync(path.join(__dirname, '..', 'lib', 'onboarding', f), 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/supabase-js|createClient|\.insert\(|\.upsert\(|\.delete\(|\.rpc\(|\.update\(\s*\{/.test(s), f);
  }
});

// RESTORED OPEN AP (Ed 2026-10-07, Canyon Gate / Star Protection): an approved opening
// correction restored invoice ST-1 to AP at the cutoff (the source's payment was book-only).
const withStar = () => {
  const t = trusted();
  t.journal_entries.push(je('jeS', '2026-03-20', 'ap_invoice', 7000, { description: 'AP invoice ST-1 — Star' }), je('jeP', '2026-04-08', 'payment_intake', 7000, { description: 'AP payment check #1003' }),
    je('jeQ', '2026-04-09', 'payment_intake', 9000, { description: 'AP payment check #1004' }));
  t.journal_entry_lines.push(ln('jeS', 'a5200', 7000, 0), ln('jeS', 'a2000', 0, 7000), ln('jeP', 'a2000', 7000, 0), ln('jeP', 'a1000', 0, 7000), ln('jeQ', 'a2000', 9000, 0), ln('jeQ', 'a1000', 0, 9000));
  t.ap_invoices.push({ id: 'invS', vendor_invoice_number: 'ST-1', invoice_date: '2026-03-20', total_cents: 7000, posting_journal_entry_id: 'jeS' });
  t.ap_payments.push({ id: 'payS', check_number: '1003', payment_date: '2026-04-08', amount_cents: 7000, posting_journal_entry_id: 'jeP' }, { id: 'payQ', check_number: '1004', payment_date: '2026-04-09', amount_cents: 9000, posting_journal_entry_id: 'jeQ' });
  return t;
};
const STAR_APPS = [{ payment_id: 'payS', invoice_id: 'invS', applied_cents: 7000 }, { payment_id: 'payQ', invoice_id: 'invS', applied_cents: 2000 }, { payment_id: 'payQ', invoice_id: 'inv7', applied_cents: 7000 }];
const RESTORED = [{ line_no: 9, vendor: 'Star', invoice_number: 'ST-1', invoice_date: '2026-03-20', amount_cents: 7000 }];
check('restored open AP: the Trusted invoice named by an approved correction (number + amount) is ALREADY_IN_SOURCE; a later payment of ONLY such invoices is LEGITIMATE_SUBSEQUENT; a payment that also pays another invoice is not', () => {
  const plain = buildBridge(parsed, withStar(), { ...ctx, apApplications: STAR_APPS });
  assert.strictEqual(ev(plain, 'je:jeS').classification, 'AMBIGUOUS', 'without the correction it is an open question');
  const b = buildBridge(parsed, withStar(), { ...ctx, apApplications: STAR_APPS, restoredAp: RESTORED });
  assert.deepStrictEqual([ev(b, 'je:jeS').classification, ev(b, 'je:jeS').method, ev(b, 'je:jeS').evidence.identifier, ev(b, 'je:jeS').evidence.snapshot_lines], ['ALREADY_IN_SOURCE', 'invoice_number_restored_by_opening_correction', 'ST-1', [9]]);
  assert.deepStrictEqual([ev(b, 'je:jeP').classification, ev(b, 'je:jeP').method, ev(b, 'je:jeP').evidence.invoices], ['LEGITIMATE_SUBSEQUENT', 'pays_invoices_restored_by_opening_correction', ['ST-1']]);
  assert.notStrictEqual(ev(b, 'je:jeQ').method, 'pays_invoices_restored_by_opening_correction', 'a mixed payment is not explained by the correction');
  assert.strictEqual(b.controls.find((c) => c.code === 'bridge.no_duplicate_on_amount_alone').status, 'PASS');
  assert.notStrictEqual(b.sha256, plain.sha256, 'the restored items are part of what the bridge result binds');
});
check('restored open AP never matches on amount alone: a different number, a different amount, or two Trusted invoices with the number restore nothing', () => {
  for (const r of [[{ ...RESTORED[0], invoice_number: 'ST-2' }], [{ ...RESTORED[0], amount_cents: 7001 }]]) {
    assert.notStrictEqual(ev(buildBridge(parsed, withStar(), { ...ctx, apApplications: STAR_APPS, restoredAp: r }), 'je:jeS').method, 'invoice_number_restored_by_opening_correction');
  }
  const t = withStar(); t.ap_invoices.push({ id: 'invS2', vendor_invoice_number: 'ST-1', invoice_date: '2026-03-21', total_cents: 7000, posting_journal_entry_id: null });
  assert.notStrictEqual(ev(buildBridge(parsed, t, { ...ctx, apApplications: STAR_APPS, restoredAp: RESTORED }), 'je:jeS').method, 'invoice_number_restored_by_opening_correction');
});

// YEAR-END CLOSE of legacy history (Canyon Gate JE-2025-CLOSE) and VOIDED never-posted documents.
const withClose = (closeExpense = 61000, nativeExpense = 0) => {
  const t = trusted();
  t.journal_entry_lines.push(ln('je1', 'a5200', 61000, 0), ln('je1', 'a1000', 0, 61000));
  if (nativeExpense) { t.journal_entries.push(je('jeN', '2026-01-20', 'ap_invoice', nativeExpense, { description: 'AP invoice NAT-1 — Vendor' })); t.journal_entry_lines.push(ln('jeN', 'a5200', nativeExpense, 0), ln('jeN', 'a2000', 0, nativeExpense)); }
  t.journal_entries.push(je('jeC', '2026-02-28', 'closing_entry', closeExpense, { description: 'Year-end close' }));
  t.journal_entry_lines.push(ln('jeC', 'a5200', 0, closeExpense), ln('jeC', 'a3000', closeExpense, 0));
  t.ap_invoices.push({ id: 'invV', vendor_invoice_number: 'V-9', invoice_date: '2026-03-02', total_cents: 500, status: 'voided', voided_at: '2026-03-05T00:00:00Z', posting_journal_entry_id: null });
  return t;
};
const ctxC = { ...ctx, accountNumber: (id) => ({ ...ACC, a3000: '3000' }[id] || null) };
check('a year-end close that closes ONLY legacy-imported history is retired with the legacy imports (provenance); a close that moves Trusted-native activity is not', () => {
  const b = buildBridge(parsed, withClose(), ctxC);
  assert.deepStrictEqual([ev(b, 'je:jeC').classification, ev(b, 'je:jeC').method], ['ALREADY_IN_SOURCE', 'provenance_legacy_import_closing_entry']);
  const leftOpen = buildBridge(parsed, withClose(61000, 7000), ctxC);
  assert.strictEqual(ev(leftOpen, 'je:jeC').method, 'provenance_legacy_import_closing_entry', 'native activity left open by the close is allowed');
  assert.deepStrictEqual(ev(leftOpen, 'je:jeC').evidence.native_entries_left_open.map((x) => [x.account, x.native_cents]), [['5200', 7000]]);
  const movesNative = buildBridge(parsed, withClose(68000, 7000), ctxC);
  assert.notStrictEqual(ev(movesNative, 'je:jeC').method, 'provenance_legacy_import_closing_entry', 'a close that closes native activity is a question, not provenance');
});
check('a document voided without ever posting is OUT_OF_SCOPE (nothing to carry)', () => {
  const b = buildBridge(parsed, withClose(), ctxC);
  assert.deepStrictEqual([ev(b, 'loose:ap_invoices:invV').classification, ev(b, 'loose:ap_invoices:invV').method], ['OUT_OF_SCOPE', 'voided_document_never_posted']);
});

(async () => {
  let pass = 0, fail = 0;
  console.log('Onboarding activity bridge (Issue #15 Milestone 4)');
  for (const [n, fn] of tests) { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n      ')); } }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
