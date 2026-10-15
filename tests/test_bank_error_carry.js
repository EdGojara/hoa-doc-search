// A confirmed bank error stays a reconciling item until the bank corrects it, so its coding carries
// from the account's latest earlier run (lib/accounting/monthly_runs.carriedBankErrors). Account codings do not.
const { carriedBankErrors } = require('../lib/accounting/monthly_runs');
let pass = 0, fail = 0;
const check = (name, ok, info) => { if (ok) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (info ? ' :: ' + info : '')); } };
const stub = (rows, seen) => ({ from: () => { const q = { _f: {} }; for (const m of ['select', 'eq', 'lt', 'in', 'order']) q[m] = (k, v) => { if (m !== 'select' && m !== 'order') q._f[`${m}:${k}`] = v; return q; };
  q.limit = async () => { seen.push(q._f); return { data: rows }; }; return q; } });
(async () => {
  const seen = [];
  const prior = { id: 'run9', period_month: '2026-09-01', preview: { codings: [
    { bank_transaction_id: 'b1025', bank_error: true, expected_cents: 422503, basis: 'check image p.5' },
    { bank_transaction_id: 'bAmz', account_number: '5720', basis: 'Amazon order' },
    { bank_transaction_id: 'bFix', bank_error_correction_of: 'b1025', basis: 'bank correction' }] } };
  const got = await carriedBankErrors(stub([prior], seen), { community_id: 'c', subject_id: 'ba', period_month: '2026-10-01', codings: [] });
  check('bank-error and correction codings carry; the account coding does not', got.map((c) => c.bank_transaction_id).sort().join(',') === 'b1025,bFix', JSON.stringify(got));
  check('each carried coding names the run it came from', got.every((c) => c.carried_from_run === 'run9'));
  check('only earlier months of the same account, never superseded or failed runs', seen[0]['lt:period_month'] === '2026-10-01' && seen[0]['eq:subject_id'] === 'ba' && !seen[0]['in:status'].includes('superseded') && !seen[0]['in:status'].includes('failed'));
  const got2 = await carriedBankErrors(stub([prior], []), { community_id: 'c', subject_id: 'ba', period_month: '2026-10-01', codings: [{ bank_transaction_id: 'b1025', bank_error: true, expected_cents: 422503, basis: 'new evidence' }] });
  check('a coding supplied for the month wins over the carried one', !got2.some((c) => c.bank_transaction_id === 'b1025'));
  const got3 = await carriedBankErrors(stub([], []), { community_id: 'c', subject_id: 'ba', period_month: '2026-08-01', codings: [] });
  check('no earlier run, nothing carried', got3.length === 0);
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
