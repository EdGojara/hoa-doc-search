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

check('a homeowner entry: its one 1300 line is the owner charge on that lot; a lot outside the community or two AR lines are refused', () => {
  const f = facts({ accounts: { ...facts().accounts, 1300: { id: 'a1300', account_type: 'asset', is_active: true }, 4030: { id: 'a4030', account_type: 'revenue', is_active: true } }, properties: { p1: { id: 'p1', street_address: '1 Main St' } } });
  const it = item({ id: 'int-08', lines: [{ account_number: '1300', debit_cents: 1200 }, { account_number: '4030', credit_cents: 1200 }], homeowner: { property_id: 'p1', charge_category: 'interest' } });
  const ok = J.buildProposals(f, [it]);
  assert.deepStrictEqual(ok.exceptions, []);
  assert.deepStrictEqual(ok.items[0].homeowner, { property_id: 'p1', address: '1 Main St', charge_category: 'interest', kind: 'charge', amount_cents: 1200 });
  assert.strictEqual(J.buildProposals(f, [{ ...it, homeowner: { property_id: 'elsewhere', charge_category: 'interest' } }]).exceptions.length, 1);
  assert.strictEqual(J.buildProposals(f, [{ ...it, lines: [{ account_number: '1300', debit_cents: 600 }, { account_number: '1300', debit_cents: 600 }, { account_number: '4030', credit_cents: 1200 }] }]).exceptions.length, 1);
});

check('void of a system error: only a trustEd-generated posting in an open period with unpaid charges; a legitimate entry is refused', () => {
  const je = { id: 'je1', reference: 'JE-2026-00533', posting_date: '2026-10-13', status: 'posted', source_module: 'certified_letter_fee', description: 'Certified letter fee' };
  const target = { je, lines: [{ account_number: '1300', debit_cents: 3500, credit_cents: 0 }, { account_number: '2300', debit_cents: 0, credit_cents: 3500 }],
    charges: [{ id: 'ch1', status: 'open', original_amount_cents: 3500, balance_remaining_cents: 3500 }], period_open: true };
  const ev = { basis: 'Letter printed and never mailed (system error).' };
  const f = (t) => facts({ voidTargets: { je1: t } });
  const it = { id: 'void-533', void_journal_entry_id: 'je1', evidence: ev };
  const ok = J.buildProposals(f(target), [it]);
  assert.deepStrictEqual(ok.exceptions, []);
  const p = ok.items[0];
  assert.strictEqual(p.void_journal.reference, 'JE-2026-00533'); assert.strictEqual(p.amount_cents, 3500);
  assert.deepStrictEqual(p.entries[0].lines.map((l) => [l.account_number, l.debit_cents, l.credit_cents]), [['1300', 0, 3500], ['2300', 3500, 0]], 'shows the exact reversal');
  assert.strictEqual(J.buildProposals(f({ ...target, je: { ...je, source_module: 'manual' } }), [it]).exceptions.length, 1, 'a person-keyed entry is not voided as a system error');
  assert.strictEqual(J.buildProposals(f({ ...target, period_open: false }), [it]).exceptions.length, 1, 'closed period refused');
  assert.strictEqual(J.buildProposals(f({ ...target, charges: [{ ...target.charges[0], status: 'paid', balance_remaining_cents: 0 }] }), [it]).exceptions.length, 1, 'a paid charge is credited, not voided');
  assert.strictEqual(J.buildProposals(f(target), [{ ...it, evidence: {} }]).exceptions.length, 1, 'evidence required');
  assert.strictEqual(J.buildProposals(f({ ...target, je: { ...je, status: 'voided' } }), [it]).items[0].already, true, 'already voided is idempotent');
});

check('reports hide a same-month void pair and keep a later-month void visible; the owner ledger leaves out voided charges', () => {
  const { dropSameMonthVoidPairs } = require('../lib/accounting/je_status');
  const L = (id, st, d, rv) => ({ journal_entries: { id, status: st, posting_date: d, void_reversal_je_id: rv } });
  const rows = [L('o', 'voided', '2026-10-13', 'r'), L('r', 'posted', '2026-10-13', null), L('x', 'posted', '2026-10-20', null), L('o2', 'voided', '2026-09-30', 'r2'), L('r2', 'posted', '2026-10-02', null)];
  assert.deepStrictEqual(dropSameMonthVoidPairs(rows).map((r) => r.journal_entries.id), ['x', 'o2', 'r2']);
  const ar = fs.readFileSync(path.join(__dirname, '..', 'lib/accounting/ar_engine.js'), 'utf8');
  assert.ok(ar.includes("if (!include_voided) chargesQ = chargesQ.neq('status', 'voided');") && ar.includes("if (e.status !== 'voided') running += e.amount_cents;"));
  assert.ok(/dropSameMonthVoidPairs/.test(fs.readFileSync(path.join(__dirname, '..', 'lib/statements/drill.js'), 'utf8')) && /dropSameMonthVoidPairs/.test(fs.readFileSync(path.join(__dirname, '..', 'lib/statements/model.js'), 'utf8')));
});

check('wiring: runs prepare, approve and refresh journal entries; owner in-app approval still required; Today renders them', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const m = read('lib/accounting/monthly_runs.js');
  assert.ok(/process === 'journal_entry'\) \{\s*preview = await require\('\.\/journal_entry_runs'\)\.preview/.test(m));
  assert.ok(/run\.process === 'journal_entry'\) result = await require\('\.\/journal_entry_runs'\)\.postApproved/.test(m));
  assert.ok(/const approver = assertInAppApproval\(approval\);/.test(m), 'approval stays the authenticated in-app owner approval');
  assert.ok(/openJournalEntryRun/.test(m) && /items = null/.test(m));
  const jr = read('lib/accounting/journal_entry_runs.js');
  assert.ok(jr.includes("require('./homeowner_charge')") && jr.includes("contains('raw_row_jsonb', { source_reference: e.source_reference })"), 'owner line posts through the sanctioned helper, once per source reference');
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
