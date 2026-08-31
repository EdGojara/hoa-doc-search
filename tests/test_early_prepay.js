// ============================================================================
// tests/test_early_prepay.js  (Ed 2026-08-31)
// ----------------------------------------------------------------------------
// Paying a bill BEFORE its invoice month must book a PREPAID asset, not run
// straight through AP. Three entries, exact months:
//   pay month  : Dr Prepaid / Cr AP   and   Dr AP / Cr Cash   (AP nets to 0)
//   invoice mo : Dr Expense / Cr Prepaid                       (the reversal)
// So: no expense in the pay month, no negative AP at pay-month close, expense
// lands in the invoice month. Deterministic thenable Supabase stub + injected
// JE posters — no DB, nothing actually posts.
// ============================================================================
const { payInvoiceEarlyAsPrepaid, isEarlyCrossPeriod } = require('../lib/ap/early_prepay');

let pass = 0, fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } }

function stub({ captured, priorAccrual = null }) {
  const make = (table) => {
    const st = { table, op: 'select', eqs: {}, single: false, maybe: false, payload: null };
    const b = {
      select() { return b; }, insert(r) { st.op = 'insert'; st.payload = r; return b; },
      update(r) { st.op = 'update'; st.payload = r; return b; },
      eq(k, v) { st.eqs[k] = v; return b; }, ilike(k, v) { st.eqs['ilike_' + k] = v; return b; },
      order() { return b; }, limit() { return b; },
      single() { st.single = true; return b; }, maybeSingle() { st.maybe = true; return b; },
      then(res, rej) {
        let out = { data: null, error: null };
        if (st.op === 'insert') { captured.push({ table, op: 'insert', row: st.payload }); out = { data: { id: `${table}-1`, ...(Array.isArray(st.payload) ? {} : st.payload) }, error: null }; }
        else if (st.op === 'update') { captured.push({ table, op: 'update', row: st.payload, eqs: st.eqs }); out = { data: { id: `${table}-1` }, error: null }; }
        else if (table === 'chart_of_accounts') {
          const map = { '13000': 'prepaid-acct', '20100': 'ap-acct', '1000': 'cash-acct' };
          const id = map[st.eqs.account_number];
          out = { data: id ? { id, account_number: st.eqs.account_number } : null, error: null };
        } else if (table === 'ap_invoice_lines') {
          out = { data: [{ gl_account_id: 'exp-acct', amount_cents: 1503500, tax_amount_cents: 0 }], error: null };
        } else if (table === 'journal_entries') {
          out = { data: priorAccrual ? { posting_date: priorAccrual } : null, error: null };
        }
        return Promise.resolve(out).then(res, rej);
      },
    };
    return b;
  };
  return { from(t) { return make(t); } };
}

(async () => {
  console.log('\nEarly cross-period prepayment\n');

  ok(isEarlyCrossPeriod('2026-08-31', '2026-09-01') === true, 'Aug payment vs Sept invoice = early cross-period');
  ok(isEarlyCrossPeriod('2026-09-03', '2026-09-01') === false, 'same month (pay after invoice) = not cross-period');
  ok(isEarlyCrossPeriod('2026-09-01', '2026-09-05') === false, 'same month (pay before invoice) = not cross-period');

  // ---- Core case: pay 8/31 for a 9/01 invoice, no prior accrual ----
  const jePosts = [];
  const postJE = async (je) => { jePosts.push(je); return { entry: { id: `je-${jePosts.length}` } }; };
  let reversal = null;
  const postReversal = async (args) => { reversal = args; return 'je-rev'; };
  let voidCall = null;
  const voidJE = async (args) => { voidCall = args; return { reversal_entry: { id: 'void-1' } }; };

  const captured = [];
  const invoice = {
    id: 'inv-lawn', community_id: 'wv', vendor_id: 'v-superior',
    vendor_invoice_number: '44125', invoice_date: '2026-09-01',
    total_cents: 1503500, amount_paid_cents: 0, posting_journal_entry_id: null,
  };
  const out = await payInvoiceEarlyAsPrepaid(stub({ captured }), {
    invoice, paymentDate: '2026-08-31', amountCents: 1503500, method: 'ach',
  }, { postJE, postReversal, voidJE });

  ok(jePosts.length === 2, 'exactly two pay-month journal entries');

  const jeA = jePosts[0], jeB = jePosts[1];
  const drOf = (je, acct) => je.lines.find((l) => l.account_id === acct && l.debit_cents > 0);
  const crOf = (je, acct) => je.lines.find((l) => l.account_id === acct && l.credit_cents > 0);

  console.log('JE-A — book the prepaid (pay month):');
  ok(jeA.posting_date === '2026-08-31', 'dated the payment month (August)');
  ok(!!drOf(jeA, 'prepaid-acct') && drOf(jeA, 'prepaid-acct').debit_cents === 1503500, 'DEBIT Prepaid $15,035');
  ok(!!crOf(jeA, 'ap-acct') && crOf(jeA, 'ap-acct').credit_cents === 1503500, 'CREDIT AP $15,035');

  console.log('JE-B — the check clears AP (pay month):');
  ok(jeB.posting_date === '2026-08-31', 'dated the payment month (August)');
  ok(!!drOf(jeB, 'ap-acct') && drOf(jeB, 'ap-acct').debit_cents === 1503500, 'DEBIT AP $15,035');
  ok(!!crOf(jeB, 'cash-acct') && crOf(jeB, 'cash-acct').credit_cents === 1503500, 'CREDIT Cash $15,035');

  console.log('Pay month has NO expense and AP nets to zero:');
  const touchesExpense = [jeA, jeB].some((je) => je.lines.some((l) => l.account_id === 'exp-acct'));
  ok(!touchesExpense, 'no expense account touched in the pay month');
  const apNet = (crOf(jeA, 'ap-acct').credit_cents || 0) - (drOf(jeB, 'ap-acct').debit_cents || 0);
  ok(apNet === 0, 'AP credited then debited — nets to zero in the pay month');

  console.log('JE-C — reverse prepaid into expense (invoice month):');
  ok(reversal && reversal.posting_date === '2026-09-01', 'reversal dated the invoice month (September 1)');
  const revExp = reversal.lines.find((l) => l.account_id === 'exp-acct' && l.debit_cents === 1503500);
  const revPre = reversal.lines.find((l) => l.account_id === 'prepaid-acct' && l.credit_cents === 1503500);
  ok(!!revExp, 'DEBIT Expense $15,035 in September');
  ok(!!revPre, 'CREDIT Prepaid $15,035 in September (prepaid nets to zero)');

  console.log('Invoice + payment recorded:');
  const invUpd = captured.find((c) => c.table === 'ap_invoices' && c.op === 'update');
  ok(invUpd && invUpd.row.status === 'paid', 'invoice marked paid');
  ok(invUpd && invUpd.row.posting_journal_entry_id === 'je-1', 'invoice posting entry = the prepaid accrual');
  const pay = captured.find((c) => c.table === 'ap_payments' && c.op === 'insert');
  ok(!!pay, 'an ap_payments row was written');
  ok(voidCall === null, 'no accrual to void when none had posted');
  ok(out && out.prepaid === true && out.reverses_month === '2026-09', 'returns prepaid summary with reversal month');

  // ---- Guard: same-month payment is refused (use the normal path) ----
  let threw = null;
  try {
    await payInvoiceEarlyAsPrepaid(stub({ captured: [] }), {
      invoice: { ...invoice, invoice_date: '2026-08-15' }, paymentDate: '2026-08-31', amountCents: 1503500,
    }, { postJE: async () => ({ entry: { id: 'x' } }), postReversal: async () => 'x', voidJE: async () => ({}) });
  } catch (e) { threw = e.message; }
  ok(threw && /not_early_cross_period/.test(threw), 'same-month payment is refused (normal path handles it)');

  // ---- Prior accrual case: the Sept accrual is voided on its own date first ----
  const jp2 = [];
  const captured2 = [];
  await payInvoiceEarlyAsPrepaid(stub({ captured: captured2, priorAccrual: '2026-09-01' }), {
    invoice: { ...invoice, posting_journal_entry_id: 'acc-1' }, paymentDate: '2026-08-31', amountCents: 1503500,
  }, {
    postJE: async (je) => { jp2.push(je); return { entry: { id: `j-${jp2.length}` } }; },
    postReversal: async () => 'je-rev2',
    voidJE: async (args) => { voidCall = args; return { reversal_entry: { id: 'void-2' } }; },
  });
  ok(voidCall && voidCall.journal_entry_id === 'acc-1', 'existing accrual is voided');
  ok(voidCall && voidCall.reversal_date === '2026-09-01', 'accrual voided ON its posting date (nets clean in September, no pay-month residue)');

  console.log(`\n${fail ? 'FAILED' : 'All'} early-prepay cases ${fail ? '' : 'passed'} (${pass} passed, ${fail} failed).`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FAILED:', e.message, e.stack); process.exit(1); });
