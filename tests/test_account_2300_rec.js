// tests/test_account_2300_rec.js — Kat's read-only monthly 2300 control (Ed 2026-11-03).
// reconcileMonth must tie exactly (beginning + every classified line = ending), split owner fees,
// voids, Bedrock settlements and conversion lines, take ownership from the rate card, report
// collections only from recorded allocations, and raise the agreed exceptions. Nothing posts.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const A = require('../lib/accounting/account_2300_rec');
const tests = []; const check = (n, fn) => tests.push([n, fn]);
let seq = 0;
const L = (o) => ({ id: 'l' + (++seq), memo: o.memo || '', property_id: o.lot || null, debit_cents: o.dr || 0, credit_cents: o.cr || 0, bedrock: !!o.bedrock, charge: o.charge || null,
  journal_entries: { id: o.je || 'j' + seq, reference: o.ref || 'JE-' + seq, posting_date: o.d, status: o.status || 'posted', source_module: o.src || 'manual', description: o.desc || '', void_reversal_je_id: o.rv || null, superseded_at: null } });
const rate = [{ category: 'drv_certified_demand' }, { category: 'nsf_charge' }];

check('ties exactly and classifies each line once; conversion balance and debit balance are exceptions', () => {
  const lines = [L({ d: '2026-07-31', src: 'opening_entry', ref: 'CONV-X-OPEN', cr: 1000, desc: 'opening' }),
    L({ d: '2026-08-05', src: 'certified_letter_fee', cr: 3500, memo: 'Certified letter', lot: 'p1', charge: { id: 'c1', applied_cents: null } }),
    L({ d: '2026-08-20', src: 'ap_invoice', dr: 6000, memo: 'Certified letter', bedrock: true })];
  const r = A.reconcileMonth({ lines, period_month: '2026-08-01', rateCard: rate, cutover: '2026-08-01' });
  assert.strictEqual(r.totals.beginning_cents, 1000); assert.strictEqual(r.totals.ending_cents, -1500); assert.strictEqual(r.totals.ties, true);
  assert.strictEqual(r.totals.assessed_cents, 3500); assert.strictEqual(r.totals.settlements_cents, -6000);
  const codes = r.exceptions.map((e) => e.code);
  for (const c of ['debit_balance', 'conversion_detail_missing', 'billed_not_assessed', 'no_allocation_recorded']) assert.ok(codes.includes(c), c);
  assert.strictEqual(r.totals.collected_cents, 0, 'nothing counted as collected without a recorded allocation');
});

check('a void pair is a void, not a fee or a settlement, and is not owed to Bedrock', () => {
  const lines = [L({ d: '2026-10-13', je: 'o', status: 'voided', rv: 'r', src: 'certified_letter_fee', cr: 3500, memo: 'Certified letter' }), L({ d: '2026-10-13', je: 'r', src: 'reversal', dr: 3500, memo: 'Reversal of certified letter' })];
  const r = A.reconcileMonth({ lines, period_month: '2026-10-01', rateCard: rate, cutover: '2026-08-01' });
  assert.strictEqual(r.totals.voids_cents, 0); assert.strictEqual(r.classes.voids.length, 2); assert.strictEqual(r.totals.owed_to_bedrock_cents, 0); assert.strictEqual(r.totals.ties, true);
});

check('ownership comes from the rate card; recorded allocations count as collected', () => {
  const lines = [L({ d: '2026-09-02', src: 'manual', cr: 5000, memo: 'Payment plan fee', charge: { id: 'c2', applied_cents: 5000 } })];
  const r = A.reconcileMonth({ lines, period_month: '2026-09-01', rateCard: rate, cutover: '2026-08-01' });
  assert.ok(r.exceptions.some((e) => e.code === 'not_on_rate_card'), 'a fee type not on the rate card is flagged');
  assert.strictEqual(r.totals.collected_cents, 5000);
});

check('wiring: read-only run, monthly prepare of the month just closed, Today renders it, approval posts nothing', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const m = read('lib/accounting/monthly_runs.js');
  assert.ok(/process === 'account_reconciliation'\) \{\s*preview = await require\('\.\/account_2300_rec'\)\.prepare/.test(m));
  assert.ok(m.includes("run.process === 'account_reconciliation') result = { reviewed: true") && m.includes('posted_entries: []'), 'approval records a review, nothing posts');
  assert.ok(m.includes("a.process === 'account_reconciliation'") && m.includes('Number(p.month) - 2'), 'the tick prepares the month just closed');
  const lib = read('lib/accounting/account_2300_rec.js');
  assert.ok(!/postJournalEntry|\.insert\(|\.update\(|\.delete\(/.test(lib), 'the reconciliation never writes');
  const ed = read('public/ed.html');
  assert.ok(ed.includes("account_reconciliation: '2300 reconciliation'") && ed.includes("run.process==='account_reconciliation'") && ed.includes('Mark reviewed'));
  assert.ok(read('migrations/559_kat_account_reconciliation.sql').includes("'account_reconciliation'"));
  const api = read('api/accounting_runs.js');
  assert.ok(api.includes("r.process !== 'account_reconciliation' || r.status !== 'prepared' || Number((r.totals || {}).material_exceptions || 0) > 0"), 'a routine reconciliation never waits on the owner');
  assert.ok(lib.includes("const MATERIAL = new Set(['does_not_tie', 'debit_balance'"), 'material exceptions are named');
});

(async () => {
  let pass = 0, fail = 0;
  for (const [n, fn] of tests) { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n    ' + e.message); } }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
