// tests/test_journal_entry_runs.js — Kat prepares ordinary journal entries (Ed 2026-11-01).
// lib/accounting/journal_entry_runs.buildProposals: a balanced entry with evidence becomes one
// proposal posting exactly its lines; unbalanced, unknown/inactive accounts, a date before the
// cutover, missing evidence or a one-sided line are blocking; the item id is the idempotency key.
// Also checks the run wiring: prepare/approve/refresh route 'journal_entry', the API accepts it,
// the owner's in-app approval is still required, and the Today queue renders it.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const J = require('../lib/accounting/journal_entry_runs');

const tests = []; const check = (n, fn) => tests.push([n, fn]);
const facts = (over = {}) => ({ community_id: 'c1', cutover_date: '2026-08-01', posted_refs: new Set(),
  accounts: { 2205: { id: 'a2205', account_type: 'liability', is_active: true }, 4000: { id: 'a4000', account_type: 'revenue', is_active: true }, 9999: { id: 'a9999', account_type: 'revenue', is_active: false } }, ...over });
const item = (over = {}) => ({ id: 'scr-2205-residue', label: '2205 residue', posting_date: '2026-08-01', description: 'Recognize $2.00 residue',
  lines: [{ account_number: '2205', debit_cents: 200 }, { account_number: '4000', credit_cents: 200 }], evidence: { basis: 'Residue from the 4/30/2025 opening import, no activity since.' }, ...over });

check('a balanced entry with evidence becomes one proposal that posts exactly its lines', () => {
  const r = J.buildProposals(facts(), [item()]);
  assert.deepStrictEqual(r.exceptions, []);
  assert.strictEqual(r.items.length, 1);
  const p = r.items[0];
  assert.strictEqual(p.amount_cents, 200);
  assert.strictEqual(p.source_reference, 'KATJE:c1:scr-2205-residue');
  assert.deepStrictEqual(p.entries[0].lines.map((l) => [l.account_number, l.debit_cents, l.credit_cents]), [['2205', 200, 0], ['4000', 0, 200]]);
  assert.deepStrictEqual(p.effects, { 2205: 200, 4000: -200 });
  assert.strictEqual(r.totals.proposals, 1);
});

check('blocking: unbalanced, unknown or inactive account, one-sided line, before cutover, no evidence, one line', () => {
  const cases = [
    item({ lines: [{ account_number: '2205', debit_cents: 200 }, { account_number: '4000', credit_cents: 199 }] }),
    item({ lines: [{ account_number: '2205', debit_cents: 200 }, { account_number: '7777', credit_cents: 200 }] }),
    item({ lines: [{ account_number: '2205', debit_cents: 200 }, { account_number: '9999', credit_cents: 200 }] }),
    item({ lines: [{ account_number: '2205', debit_cents: 200, credit_cents: 200 }, { account_number: '4000', credit_cents: 200 }] }),
    item({ posting_date: '2026-07-31' }),
    item({ evidence: { basis: '' } }),
    item({ lines: [{ account_number: '2205', debit_cents: 200 }] }),
  ];
  for (const c of cases) {
    const r = J.buildProposals(facts(), [c]);
    assert.strictEqual(r.items.length, 0, JSON.stringify(c));
    assert.strictEqual(r.exceptions[0].severity, 'blocking');
  }
});

check('idempotent: an entry already posted under its id is marked already and not counted again', () => {
  const r = J.buildProposals(facts({ posted_refs: new Set(['KATJE:c1:scr-2205-residue']) }), [item()]);
  assert.strictEqual(r.items[0].already, true);
  assert.strictEqual(r.totals.proposals, 0);
});

check('wiring: runs prepare, approve and refresh journal entries; owner in-app approval still required; Today renders them', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const m = read('lib/accounting/monthly_runs.js');
  assert.ok(/process === 'journal_entry'\) \{\s*preview = await require\('\.\/journal_entry_runs'\)\.preview/.test(m));
  assert.ok(/run\.process === 'journal_entry'\) result = await require\('\.\/journal_entry_runs'\)\.postApproved/.test(m));
  assert.ok(/const approver = assertInAppApproval\(approval\);/.test(m), 'approval stays the authenticated in-app owner approval');
  assert.ok(/openJournalEntryRun/.test(m) && /items = null/.test(m));
  const api = read('api/accounting_runs.js');
  assert.ok(/'journal_entry'\]\.includes\(b\.process\)/.test(api) && /items: b\.items \|\| null/.test(api));
  assert.ok(/router\.post\('\/run\/:id\/approve'[\s\S]{0,200}requireOwner/.test(api), 'approve is owner-only');
  const ed = read('public/ed.html');
  assert.ok(/journal_entry: 'Journal entries'/.test(ed) && /run\.process==='journal_entry'/.test(ed) && /proc==='journal_entry'/.test(ed));
  assert.ok(/'journal_entry'/.test(read('migrations/558_kat_journal_entry_runs.sql')));
});

(async () => {
  let pass = 0, fail = 0;
  for (const [n, fn] of tests) { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n    ' + e.message); } }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
