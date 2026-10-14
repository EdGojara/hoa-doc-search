// Homeowner payments from a coded payout (lib/banking/monthly_rec): a deposit coded with the
// processor's payout contents becomes a proposal that records each payment on its owner's ledger
// on its own payment date and the deposit on the bank date. Engine rules + the post (fake DB).
// Shapes mirror Lakes of Pine Forest's August 2026 Vantaca Pay payouts.
const path = require('path');
let pass = 0, fail = 0;
const check = (name, ok, info) => { if (ok) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (info ? ' :: ' + info : '')); } };

// Stub the GL poster before the engine loads it.
const posted = [];
const postingPath = require.resolve(path.join(__dirname, '..', 'lib', 'accounting', 'posting'));
let failOn = null;
require.cache[postingPath] = { id: postingPath, filename: postingPath, loaded: true, exports: {
  postJournalEntry: async (e) => {
    if (failOn && e.source_reference === failOn) { failOn = null; throw new Error('simulated GL failure'); }
    const entry = { id: 'je' + (posted.length + 1), reference: 'JE-T-' + (posted.length + 1), source_reference: e.source_reference, community_id: e.community_id };
    posted.push({ ...e, entry }); db.journal_entries.push(entry); return { entry };
  } } };
const B = require('../lib/banking/monthly_rec');

const C = 'c1';
const account = { id: 'opr', label: 'Operating 2449', gl_account_number: '1000' };
const opening = { as_of_date: '2026-07-31', bank_balance_cents: 100000, book_balance_cents: 100000, outstanding_checks: [], deposits_in_transit: [] };
const settings = { stale_check_days: 90, stale_deposit_days: 10, match_window_days: 45 };
const gl = [{ id: 'g0', je_id: 'j0', reference: 'OPEN', posting_date: '2026-07-31', amount_cents: 100000, memo: 'Opening', description: 'Opening', source_module: 'opening_entry' }];
const s8 = { id: 'imp8', statement_period_start: '2026-08-01', statement_period_end: '2026-08-31', beginning_balance_cents: 100000, ending_balance_cents: 100000 + 81633 };
const payout = { id: 'b-payout', bank_statement_import_id: 'imp8', posting_date: '2026-08-12', amount_cents: 81633, description: 'Vantaca Payout ST-K2Z4H1W7B3S3', check_number: null, transaction_type: 'ach_in' };
const owners = { '2012884': { property_id: 'p884', tenure_id: 't884', contact_id: 'k884', trusted_account_number: 'LPF-884', address: '17715 Orchid Creek Ln' }, '2012906': { property_id: 'p906', tenure_id: 't906', contact_id: 'k906', trusted_account_number: 'LPF-906', address: '17711 Emerald Garden Ln' } };
const coding = { bank_transaction_id: 'b-payout', basis: 'Vantaca Pay Payout Contents ST-K2Z4H1W7B3S3', receipts: [
  { vantaca_account_id: '2012884', payment_date: '2026-08-06', amount_cents: 3540, method: 'eCheck', reference: 'ST-K2Z4H1W7B3S3' },
  { vantaca_account_id: '2012906', payment_date: '2026-08-10', amount_cents: 78093, method: 'Card', reference: 'ST-K2Z4H1W7B3S3' }] };
const base = { account, period_start: '2026-08-01', period_end: '2026-08-31', opening, statements: [s8], bankTxns: [payout], glLines: gl, otherBankTxns: [], homeownerPayments: [], settings, codings: [coding], receiptOwners: owners, undepositedAccount: '1020' };

console.log('engine');
const r = B.reconcileAccountMonth(base);
const p = r.proposals.find((x) => x.kind === 'homeowner_receipts');
check('a payout coded with its contents is proposed as homeowner payments', !!p, JSON.stringify(r.exceptions));
check('one payment per owner on its own payment date: Dr 1020 / Cr 1300 with the property', p && p.receipts.length === 2 && p.receipts[0].payment_date === '2026-08-06' && p.receipts[1].payment_date === '2026-08-10'
  && p.receipts.every((x) => x.lines[0].account_number === '1020' && x.lines[0].debit_cents === x.amount_cents && x.lines[1].account_number === '1300' && x.lines[1].credit_cents === x.amount_cents && x.lines[1].property_id === owners[x.vantaca_account_id].property_id));
check('the deposit is one Dr 1000 / Cr 1020 for the bank amount on the bank date', p && p.posting_date === '2026-08-12' && p.lines[0].account_number === '1000' && p.lines[0].debit_cents === 81633 && p.lines[1].account_number === '1020' && p.lines[1].credit_cents === 81633);
check('the line is an exception tied to the proposal, not unexplained', r.exceptions.some((e) => e.code === 'homeowner_receipts' && e.proposal_id === p.id) && !r.exceptions.some((e) => e.code === 'unrecorded_receipt'));

const short = B.reconcileAccountMonth({ ...base, codings: [{ ...coding, receipts: coding.receipts.slice(0, 1) }] });
check('contents that do not tie to the bank line: no proposal, exception says why', !short.proposals.some((x) => x.kind === 'homeowner_receipts') && short.exceptions.some((e) => e.code === 'receipts_not_proposed' && /total/.test(e.text)));
const unk = B.reconcileAccountMonth({ ...base, receiptOwners: { '2012884': owners['2012884'] } });
check('an account without one current owner: no proposal', !unk.proposals.some((x) => x.kind === 'homeowner_receipts') && unk.exceptions.some((e) => /2012906 does not resolve/.test(e.text)));
const dup = B.reconcileAccountMonth({ ...base, homeownerPayments: [{ id: 'h1', property_id: 'p906', vantaca_account_id: '2012906', transaction_date: '2026-08-11', amount_cents: -78093, description: 'Vantaca import' }] });
check('a payment of the same amount already on the owner ledger nearby: no proposal (possible duplicate)', !dup.proposals.some((x) => x.kind === 'homeowner_receipts') && dup.exceptions.some((e) => /possible duplicate/.test(e.text)));
const late = B.reconcileAccountMonth({ ...base, codings: [{ ...coding, receipts: [coding.receipts[0], { ...coding.receipts[1], payment_date: '2026-08-14' }] }] });
check('a payment dated after the deposit: no proposal', !late.proposals.some((x) => x.kind === 'homeowner_receipts'));
const noUnd = B.reconcileAccountMonth({ ...base, undepositedAccount: null });
check('no undeposited funds account: no proposal, nothing invented', !noUnd.proposals.some((x) => x.kind === 'homeowner_receipts') && noUnd.exceptions.some((e) => /undeposited/.test(e.text)));
const plain = B.reconcileAccountMonth({ ...base, codings: [] });
check('without contents the payout stays an unrecorded receipt for a person', plain.exceptions.some((e) => e.code === 'unrecorded_receipt') && !plain.proposals.length);

// After posting, the deposit entry matches the bank line and the payments do not touch cash.
const glAfter = [...gl, { id: 'g1', je_id: 'jd', reference: 'JE-DEP', posting_date: '2026-08-12', amount_cents: 81633, memo: 'deposit', description: 'deposit', source_module: 'bank_reconciliation' }];
const after = B.reconcileAccountMonth({ ...base, glLines: glAfter, codings: [] });
check('once posted the deposit matches the bank line and the month reconciles', after.totals.difference_cents === 0 && after.items.some((i) => i.category === 'matched' && i.gl_ref === 'JE-DEP') && !after.proposals.length, JSON.stringify(after.totals));

// ---- the post, against a small fake database
console.log('post');
const db = { transaction_upload_batches: [], homeowner_transactions: [], journal_entries: [], communities: [{ id: C, management_company_id: 'mc' }],
  chart_of_accounts: ['1000', '1020', '1300'].map((n) => ({ id: 'a' + n, account_number: n, fund_id: 'f1', community_id: C })) };
let seq = 0;
function q(table) {
  const f = []; let op = 'select', payload = null, single = false, maybe = false;
  const get = (row, k) => k === 'transaction_upload_batches.status' ? (db.transaction_upload_batches.find((b) => b.id === row.source_batch_id) || {}).status : row[k];
  const run = () => {
    if (op === 'insert') { const rows = (Array.isArray(payload) ? payload : [payload]).map((x) => ({ id: table.slice(0, 3) + (++seq), ...x })); db[table].push(...rows); return { data: single ? rows[0] : rows, error: null }; }
    let rows = db[table].filter((row) => f.every(([k, t, v]) => t === 'eq' ? get(row, k) === v : t === 'in' ? v.includes(get(row, k)) : t === 'gte' ? get(row, k) >= v : t === 'lte' ? get(row, k) <= v : true));
    if (op === 'update') { rows.forEach((x) => Object.assign(x, payload)); return { data: rows, error: null }; }
    return { data: single || maybe ? (rows[0] || null) : rows, error: null };
  };
  const b = { select() { return b; }, eq(k, v) { f.push([k, 'eq', v]); return b; }, in(k, v) { f.push([k, 'in', v]); return b; }, gte(k, v) { f.push([k, 'gte', v]); return b; }, lte(k, v) { f.push([k, 'lte', v]); return b; },
    is() { return b; }, limit() { return b; }, order() { return b; }, insert(x) { op = 'insert'; payload = x; return b; }, update(x) { op = 'update'; payload = x; return b; },
    single() { single = true; return b; }, maybeSingle() { maybe = true; return b; }, then(res, rej) { return Promise.resolve(run()).then(res, rej); } };
  return b;
}
const supabase = { from: q };

(async () => {
  // interrupted after the first payment entry: nothing visible, retry finishes, nothing duplicates
  failOn = p.receipts[1].source_reference;
  let threw = false; try { await B.postProposals(supabase, { community_id: C, proposals: [p], actor: 'Kat', approver: 'owner@example.test' }); } catch (e) { threw = /simulated/.test(e.message); }
  check('an interrupted post throws and leaves the batch a draft (no owner sees a credit)', threw && db.transaction_upload_batches.length === 1 && db.transaction_upload_batches[0].status === 'draft' && db.homeowner_transactions.length === 2);
  const out = await B.postProposals(supabase, { community_id: C, proposals: [p], actor: 'Kat', approver: 'owner@example.test' });
  check('approving again finishes it: 2 payment entries + 1 deposit, one batch, two ledger rows', posted.length === 3 && db.transaction_upload_batches.length === 1 && db.transaction_upload_batches[0].status === 'committed' && db.homeowner_transactions.length === 2 && out[0].reference, JSON.stringify({ posted: posted.length, out }));
  const rows = db.homeowner_transactions;
  check('ledger rows: negative payments on each owner tenure, dated the payment date', rows.every((x) => x.txn_type === 'payment' && x.amount_cents < 0) && rows.find((x) => x.vantaca_account_id === '2012906').transaction_date === '2026-08-10' && rows.find((x) => x.vantaca_account_id === '2012884').tenure_id === 't884');
  check('payment entries dated the payment date; deposit dated the bank date', posted[0].posting_date === '2026-08-06' && posted.find((x) => x.source_reference === p.source_reference).posting_date === '2026-08-12');
  const again = await B.postProposals(supabase, { community_id: C, proposals: [p], actor: 'Kat', approver: 'owner@example.test' });
  check('a third approval posts nothing and reports what was posted', posted.length === 3 && again[0].already_posted, JSON.stringify(again));

  // a different payout carrying a payment already on the ledger is blocked at post time
  const p2 = JSON.parse(JSON.stringify(p)); p2.id = 'receipts:b2'; p2.source_reference = 'bankrec:b2'; p2.receipts.forEach((x, k) => { x.source_reference = 'bankrec:b2:r' + (k + 1); });
  let blocked = false; try { await B.postProposals(supabase, { community_id: C, proposals: [p2], actor: 'Kat', approver: 'owner@example.test' }); } catch (e) { blocked = e.code === 'blocked'; }
  check('a payment already committed on that owner ledger blocks a second post', blocked && posted.length === 3 && db.transaction_upload_batches.length === 1);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
