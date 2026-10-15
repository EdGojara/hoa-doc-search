// ============================================================================
// tests/test_accounting_ownership.js  (Ed 2026-10-11)
// ----------------------------------------------------------------------------
// trustEd's financial workflows process only associations whose accounting is
// enabled in trustEd. Eaglewood (books in Vantaca; trustEd runs only its
// violations and ACC) had 17 bills loaded into trustEd Payables by email
// intake, because nothing checked. These pin the rule and that every financial
// chokepoint asks it, and that the non-financial modules do not.
// ============================================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const O = require('../lib/accounting/ownership');

let pass = 0, fail = 0;
const pending = [];
const t = (n, f) => pending.push([n, f]);
const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const TODAY = '2026-10-11';
const EAGLEWOOD = { id: 'ew', name: 'Eaglewood', management_status: 'terminating', management_end_date: '2026-09-30', books_of_record: 'vantaca', financials_active: false };
const CG = { id: 'cg', name: 'Canyon Gate at Cinco Ranch', management_status: 'active', books_of_record: 'trusted', financials_active: true };

t('Eaglewood: books in Vantaca → not processed (books_elsewhere wins over every other reason)', () => {
  const s = O.accountingStatus(EAGLEWOOD, TODAY);
  assert.strictEqual(s.enabled, false); assert.strictEqual(s.code, 'books_elsewhere'); assert.ok(/Vantaca/.test(s.reason));
});
t('an active trustEd-books association is enabled', () => {
  assert.strictEqual(O.accountingStatus(CG, TODAY).enabled, true);
  assert.strictEqual(O.accountingStatus(Object.assign({}, CG, { books_of_record: null }), TODAY).enabled, true, 'unset books_of_record = trustEd (the column default)');
});
t('financials off, prospect, former client and unknown are all refused', () => {
  assert.strictEqual(O.accountingStatus(Object.assign({}, CG, { financials_active: false }), TODAY).code, 'financials_off');
  assert.strictEqual(O.accountingStatus(Object.assign({}, CG, { management_status: 'prospect' }), TODAY).code, 'prospect');
  assert.strictEqual(O.accountingStatus(Object.assign({}, CG, { management_status: 'terminating', management_end_date: '2026-09-30' }), TODAY).code, 'former_client');
  assert.strictEqual(O.accountingStatus(Object.assign({}, CG, { management_status: 'terminating', management_end_date: '2026-12-31' }), TODAY).enabled, true, 'still managed in notice');
  assert.strictEqual(O.accountingStatus(null, TODAY).enabled, false, 'fail closed');
});
t('financialsDisabledIds / assertFinancialsEnabled read the communities table', async () => {
  const rows = [EAGLEWOOD, CG, { id: 'cov', name: 'Covington Woods', management_status: 'prospect', books_of_record: 'trusted', financials_active: true }];
  const fake = { from: () => { const f = []; const q = { select() { return q; }, eq(k, v) { f.push([k, v]); return q; },
    maybeSingle() { return Promise.resolve({ data: rows.find((r) => f.every(([k, v]) => r[k] === v)) || null, error: null }); },
    then(res, rej) { return Promise.resolve({ data: rows, error: null }).then(res, rej); } }; return q; } };
  const ids = await O.financialsDisabledIds(fake, TODAY);
  assert.deepStrictEqual([...ids].sort(), ['cov', 'ew']);
  await assert.rejects(O.assertFinancialsEnabled(fake, 'ew', 'Creating a payable'), (e) => e.code === 'financials_not_enabled' && /Vantaca/.test(e.message));
  const ok = await O.assertFinancialsEnabled(fake, 'cg');
  assert.strictEqual(ok.enabled, true);
});
t('every financial chokepoint asks the ownership rule', () => {
  const must = {
    'lib/ap/intake.js': /accounting\/ownership'\)\.accountingStatusFor/,
    'api/email_triage.js': /accounting\/ownership'\)\.accountingStatusFor/,
    'lib/accounting/ap_engine.js': /ownership'\)\.assertFinancialsEnabled\(supabase, community_id, 'Creating a payable'\)[\s\S]*ownership'\)\.assertFinancialsEnabled\(supabase, community_id, 'Recording a vendor payment'\)/,
    'lib/accounting/posting.js': /\n  await require\('\.\/ownership'\)\.assertFinancialsEnabled\(supabase, community_id, `Posting \(\$\{source_module \|\| 'manual'\}\)`\);/,
    'lib/accounting/check_run.js': /ownership'\)\.accountingStatusFor[\s\S]*ownership'\)\.accountingStatusFor/,
    'lib/accounting/record_vendor_payment.js': /ownership'\)\.accountingStatusFor/,
  };
  for (const [f, re] of Object.entries(must)) assert.ok(re.test(src(f)), f);
  const ap = src('api/ap.js');
  assert.strictEqual((ap.match(/financialsDisabledIds\(supabase\)/g) || []).length, 2, 'manager + owner queues');
  assert.strictEqual((ap.match(/accounting\/ownership'\)\.accountingStatusFor\(supabase, inv\.community_id\)/g) || []).length, 2, 'approve + mark-paid');
});
t('every journal entry asks the ownership rule, not only AP (Ed 2026-10-15)', () => {
  const p = src('lib/accounting/posting.js');
  assert.ok(!/if \(ap_posting \|\| \['ap_invoice', 'ap_billback'\]\.includes\(source_module\)\) \{\s*await require\('\.\/ownership'\)/.test(p), 'the AP-only condition is gone');
  const m = src('lib/accounting/monthly_runs.js');
  assert.ok(/accountingStatusFor\(supabase, community_id\);\s*if \(!own\.enabled\) return \{ skipped: own\.reason/.test(m), 'Kat prepares no run for a closed community');
  assert.ok(/assertFinancialsEnabled\(supabase, run\.community_id, 'Approving this run'\)/.test(m), 'no run of a closed community can be approved');
});
t('migration 528 closes the ledger on the same rule as accountingStatus', () => {
  const sql = src('migrations/528_books_closed_guard.sql');
  for (const re of [/books_of_record IS DISTINCT FROM 'trusted'/, /financials_active IS FALSE/, /management_status IN \('archived', 'terminated'\)/, /management_status = 'terminating' AND c\.management_end_date IS NOT NULL\s+AND c\.management_end_date < \(now\(\) AT TIME ZONE 'America\/Chicago'\)::date/, /management_status = 'prospect'/]) assert.ok(re.test(sql), String(re));
  assert.ok(/BEFORE INSERT OR UPDATE OR DELETE ON journal_entries\s/.test(sql) && /BEFORE INSERT OR UPDATE OR DELETE ON journal_entry_lines\s/.test(sql), 'both ledger tables, every write');
  assert.ok(!/(DELETE FROM|UPDATE journal_entries|INSERT INTO journal_entries)/.test(sql), 'the migration itself changes no ledger rows');
  const O = require('../lib/accounting/ownership');
  if (O.accountingStatus) {
    const cases = [[{ name: 'E', management_status: 'archived', books_of_record: 'vantaca', financials_active: false }, false], [{ name: 'A', management_status: 'active', books_of_record: 'trusted', financials_active: true }, true], [{ name: 'T', management_status: 'terminating', management_end_date: '2026-01-01', books_of_record: 'trusted', financials_active: true }, false], [{ name: 'P', management_status: 'prospect', books_of_record: 'trusted', financials_active: true }, false], [{ name: 'O', management_status: 'onboarding', books_of_record: 'trusted', financials_active: true }, true]];
    for (const [c, open] of cases) assert.strictEqual(O.accountingStatus(c, '2026-10-15').enabled, open, c.name);
  }
});
t('#209 review: refusals are 409s, vendor merges keep closed books intact, conversions refuse early', () => {
  const O = require('../lib/accounting/ownership');
  assert.ok(O.isBooksClosed({ code: 'financials_not_enabled' }) && O.isBooksClosed({ message: 'books_closed: posting refused: Eaglewood is a former client (archived).' }) && !O.isBooksClosed({ code: 'period_closed', message: 'x' }) && !O.isBooksClosed(null));
  const n = (f) => (src(f).match(/isBooksClosed\(err\)\) return res\.status\(409\)/g) || []).length;
  assert.strictEqual(n('api/books.js'), 4, 'post, transfer, edit, void'); assert.strictEqual(n('api/ar.js'), 1); assert.strictEqual(n('api/ap.js'), 2);
  const vm = src('lib/ap/vendor_master.js');
  assert.ok(/if \(t === 'journal_entry_lines'\) \{[^\n]*continue; \}/.test(vm) && !/from\('journal_entry_lines'\)\.update/.test(vm), 'a vendor merge never rewrites ledger lines (history keeps its vendor)');
  const ob = src('lib/onboarding/service.js');
  assert.ok(/booksStatus\(view\.batch\.community_id\)[\s\S]{0,120}ServiceError\(409, 'BOOKS_CLOSED'/.test(ob) && /booksStatus = \(communityId\) => require\('\.\.\/accounting\/ownership'\)\.accountingStatusFor/.test(ob), 'execute refuses a closed community before writing');
  assert.ok(/accountingStatusFor\(s, CID\)[\s\S]{0,200}process\.exit\(1\)/.test(src('scripts/migrate_community_gl.js')), 'the GL rebuild script refuses early');
  const sql = src('migrations/528_books_closed_guard.sql');
  assert.ok(/SECURITY DEFINER\s+SET search_path = public/.test(sql) && /REVOKE ALL ON FUNCTION community_books_closed_reason\(uuid\) FROM PUBLIC/.test(sql) && !/TO service_role, authenticated/.test(sql));
});
t('violations and ACC never ask it (Eaglewood keeps both in trustEd)', () => {
  const dir = path.join(__dirname, '..', 'api');
  const nonFinancial = fs.readdirSync(dir).filter((f) => /violation|acc|arc|inspection|drv/i.test(f) && f.endsWith('.js'));
  assert.ok(nonFinancial.length > 0);
  for (const f of nonFinancial) assert.ok(!/accounting\/ownership/.test(fs.readFileSync(path.join(dir, f), 'utf8')), f);
});

(async () => {
  for (const [n, f] of pending) {
    try { await f(); pass++; console.log('  ok   ' + n); } catch (e) { fail++; console.log('  FAIL ' + n + '\n        ' + e.message); }
  }
  console.log(`\n${pass} passed${fail ? ', FAILURES above' : ''}`);
  if (fail) process.exit(1);
})();
