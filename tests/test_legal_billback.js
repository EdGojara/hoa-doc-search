// ============================================================================
// tests/test_legal_billback.js  (Ed 2026-08-30)
// ----------------------------------------------------------------------------
// An attorney bill-back must post as a RECEIVABLE + owner charge, never an
// expense: GL is DR 1300 / CR AP (no expense account touched), and the owner
// gets a homeowner_transactions charge tagged 'attorney_fee' with the invoice
// reference in the "Legal Fees - Collections/DRV" description. Deterministic:
// a thenable Supabase stub + an injected GL poster, no DB, no real posting.
// ============================================================================
const { postLegalBillBack } = require('../lib/ap/legal_billback');
const { postHomeownerCharge } = require('../lib/accounting/homeowner_charge');

let pass = 0, fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } }

// Supabase stub: chart_of_accounts resolves 1300 + 20100; homeowner_transactions
// returns a prior balance and captures the inserted charge; batches captured.
function stub({ captured }) {
  const make = (table) => {
    const st = { table, op: 'select', eqs: {}, single: false, maybe: false, payload: null };
    const b = {
      select() { return b; }, insert(r) { st.op = 'insert'; st.payload = r; return b; },
      eq(k, v) { st.eqs[k] = v; return b; }, order() { return b; }, limit() { return b; },
      single() { st.single = true; return b; }, maybeSingle() { st.maybe = true; return b; },
      then(res, rej) {
        let out = { data: null, error: null };
        if (st.op === 'insert') { captured.push({ table, row: st.payload }); out = { data: { id: `${table}-1`, ...st.payload }, error: null }; }
        else if (table === 'chart_of_accounts') {
          const acct = { '1300': 'ar-acct', '20100': 'ap-acct', '2000': 'ap-acct' }[st.eqs.account_number];
          out = { data: acct ? { id: acct } : null, error: null };
        } else if (table === 'homeowner_transactions') {
          // identity lookup (maybeSingle) vs balance sum (list)
          out = st.maybe ? { data: { trusted_account_number: 'WV-100', vantaca_account_id: 'V1', contact_id: 'c1' }, error: null }
                         : { data: [{ amount_cents: 500000 }], error: null };
        } else if (table === 'communities') { out = { data: { management_company_id: 'mgmt' }, error: null }; }
        else if (table === 'properties') { out = { data: { trusted_account_number: 'WV-100' }, error: null }; }
        else if (table === 'transaction_upload_batches') { out = { data: { id: 'batch-1' }, error: null }; }
        return Promise.resolve(out).then(res, rej);
      },
    };
    return b;
  };
  return { from(t) { return make(t); } };
}

(async () => {
  console.log('\nLegal bill-back posting\n');

  // capture the GL lines via an injected poster
  let jeLines = null; let jeMeta = null;
  const postJE = async (je) => { jeLines = je.lines; jeMeta = je; return { entry: { id: 'je-1' } }; };

  const captured = [];
  const out = await postLegalBillBack(stub({ captured }), {
    communityId: 'wv', propertyId: 'p-martinez', totalCents: 4200,
    vendorInvoiceNumber: 'PS-INV343615', vendorName: 'RMWBH', invoiceDate: '2026-08-30', invoiceId: 'inv-1',
  }, { postJE });

  console.log('GL entry (DR 1300 / CR AP, no expense):');
  ok(jeLines && jeLines.length === 2, 'exactly two GL lines');
  const dr = (jeLines || []).find((l) => l.debit_cents > 0);
  const cr = (jeLines || []).find((l) => l.credit_cents > 0);
  ok(dr && dr.account_id === 'ar-acct' && dr.debit_cents === 4200, 'DEBIT 1300 Accounts Receivable $42.00');
  ok(cr && cr.account_id === 'ap-acct' && cr.credit_cents === 4200, 'CREDIT Accounts Payable $42.00');
  ok(!(jeLines || []).some((l) => l.account_id === '5870' || /5870/.test(String(l.account_id))), 'NO expense account touched');
  ok(jeMeta && jeMeta.source_module === 'ap_billback', 'tagged as a bill-back');

  console.log('\nOwner ledger charge:');
  const charge = captured.find((c) => c.table === 'homeowner_transactions');
  ok(charge && charge.row.txn_type === 'charge', 'a charge is posted to the owner ledger');
  ok(charge && charge.row.charge_category === 'attorney_fee', "tagged charge_category 'attorney_fee'");
  ok(charge && /Legal Fees - Collections\/DRV/.test(charge.row.description) && /PS-INV343615/.test(charge.row.description), 'description matches the established format + invoice reference');
  ok(charge && charge.row.amount_cents === 4200, 'owner charged $42.00');
  ok(charge && charge.row.running_balance_cents === 500000 + 4200, 'running balance = prior + this charge');
  ok(out && out.jeId === 'je-1' && out.chargeId, 'returns the JE id + charge id');

  console.log(`\n${fail ? 'FAILED' : 'All'} legal bill-back cases ${fail ? '' : 'passed'} (${pass} passed, ${fail} failed).`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
