// tests/fixtures/drama_creek_statements.js  (PR C)
// ----------------------------------------------------------------------------
// Drama Creek Estates (the demo community; sample figures only): an in-memory
// ledger + a Supabase-shaped fake client, shared by tests/test_statement_model.js
// and scripts/render_statement_samples.js. Converted at 7/31/2026 (its trustEd
// books begin 1/1/2026), August closed, September open; balance-sheet mapping
// approved except one PROPOSED and one UNMAPPED account.

const CID = 'c-drama-creek';
let db;
const get = (row, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), row);
function enrich(table, r) {
  if (table !== 'journal_entry_lines') return r;
  const je = db.journal_entries.find((j) => j.id === r.journal_entry_id) || null;
  const coa = db.chart_of_accounts.find((a) => a.id === r.account_id) || null;
  return { ...r, journal_entries: je, chart_of_accounts: coa };
}
function fakeClient({ closedThrough = '2026-08-31' } = {}) {
  return {
    rpc: async (fn) => (fn === 'close_closed_through' ? { data: closedThrough, error: null } : { data: null, error: { code: 'PGRST202', message: 'not in fake' } }),
    storage: { from() { return { createSignedUrl: async () => ({ data: null, error: null }) }; } },
    from(table) {
      const st = { f: [], order: [], range: null, limit: null, head: false, ins: null, upd: null };
      // Writes (board-packet tests): insert pushes rows; update patches the filtered rows.
      const rows = () => {
        if (st.ins) { if (!db[table]) db[table] = []; const out = st.ins.map((r) => ({ id: `${table}-${++seq}`, created_at: '2026-10-09T18:00:00Z', ...r })); db[table].push(...out); st.ins = null; return out; }
        if (st.upd) { const hit = (db[table] || []).filter((r) => st.f.every((fn) => fn(r))); for (const r of hit) Object.assign(r, st.upd); st.upd = null; return hit; }
        let out = (db[table] || []).map((r) => enrich(table, r)).filter((r) => st.f.every((fn) => fn(r)));
        if (table === 'journal_entry_lines') out = out.filter((r) => r.journal_entries);
        for (const [c, asc] of st.order.slice().reverse()) out.sort((a, b) => (get(a, c) > get(b, c) ? 1 : get(a, c) < get(b, c) ? -1 : 0) * (asc ? 1 : -1));
        if (st.range) out = out.slice(st.range[0], st.range[1] + 1);
        if (st.limit != null) out = out.slice(0, st.limit);
        return out;
      };
      const q = {
        select(_c, o) { if (o && o.head) st.head = true; return q; },
        insert(r) { st.ins = Array.isArray(r) ? r : [r]; return q; }, update(p) { st.upd = p; return q; },
        eq(c, v) { st.f.push((r) => get(r, c) === v); return q; },
        in(c, vs) { st.f.push((r) => vs.includes(get(r, c))); return q; },
        gte(c, v) { st.f.push((r) => get(r, c) >= v); return q; },
        lte(c, v) { st.f.push((r) => get(r, c) <= v); return q; },
        order(c, o) { st.order.push([c, !(o && o.ascending === false)]); return q; },
        range(a, b) { st.range = [a, b]; return q; }, limit(n) { st.limit = n; return q; },
        neq() { return q; }, not() { return q; }, is() { return q; }, or() { return q; }, ilike() { return q; },
        async maybeSingle() { const r = rows(); return { data: r[0] || null, error: null }; },
        async single() { const r = rows(); return r.length ? { data: r[0], error: null } : { data: null, error: { message: 'no rows' } }; },
        then(res, rej) { const r = rows(); return Promise.resolve(st.head ? { data: null, count: r.length, error: null } : { data: r, error: null }).then(res, rej); },
      };
      return q;
    },
  };
}

let seq = 0;
const FUND = { OPR: 'f-opr', RES: 'f-res' };
const ACCTS = [
  [1000, 'asset', 'Operating Checking', 'OPR'], [1200, 'asset', 'Reserve Money Market', 'RES'], [1300, 'asset', 'Accounts Receivable', 'OPR'],
  [1400, 'asset', 'Prepaid Insurance', 'OPR'], [1405, 'asset', 'Utility Deposits', 'OPR'], [1415, 'asset', 'Gate Project Escrow', 'OPR'],
  [2000, 'liability', 'Accounts Payable', 'OPR'], [2205, 'liability', 'Deferred Assessments', 'OPR'], [2400, 'liability', 'Prepaid Owner Assessments', 'OPR'],
  [2410, 'liability', 'Former Owner Refunds Payable', 'OPR'], [3050, 'equity', 'Accumulated Fund Balance', 'OPR'], [3020, 'equity', 'Reserve Fund Balance', 'RES'],
  [4000, 'revenue', 'Assessment Income', 'OPR'], [4100, 'revenue', 'Late Fees & Interest', 'OPR'], [4200, 'revenue', 'Amenity Income', 'OPR'], [4900, 'revenue', 'Reserve Contribution Income', 'RES'],
  [5200, 'expense', 'Landscape Contract', 'OPR'], [5210, 'expense', 'Irrigation Repairs', 'OPR'], [5300, 'expense', 'Utilities', 'OPR'], [5400, 'expense', 'Pool & Amenities', 'OPR'],
  [5500, 'expense', 'Management Fee', 'OPR'], [5600, 'expense', 'Insurance', 'OPR'], [5900, 'expense', 'Reserve Contribution', 'OPR'],
];
const aid = (n) => `a-${n}`;
function je(ref, date, module, lines, extra = {}) {
  const id = `je-${++seq}`;
  db.journal_entries.push({ id, community_id: CID, reference: ref, posting_date: date, source_module: module, status: 'posted', void_reversal_je_id: null, reverses_je_id: null, description: extra.description || ref, ...extra });
  let n = 0;
  for (const [acct, d, c, memo] of lines) {
    const a = ACCTS.find((x) => x[0] === acct);
    db.journal_entry_lines.push({ id: `jl-${++seq}`, journal_entry_id: id, line_number: ++n, account_id: aid(acct), fund_id: FUND[a[3]], debit_cents: d, credit_cents: c, memo: memo || null, vendor_id: null, property_id: null });
  }
  return id;
}
const $ = (dollars) => Math.round(dollars * 100);

function seed() {
  seq = 0;
  db = {
    communities: [{ id: CID, name: 'Drama Creek Estates', legal_name: 'Drama Creek Estates Homeowners Association', gl_cutover_date: '2026-08-01' }],
    chart_of_accounts: ACCTS.map(([n, t, name, f]) => ({ id: aid(n), community_id: CID, account_number: String(n), account_name: name, account_type: t, normal_balance: ['asset', 'expense'].includes(t) ? 'debit' : 'credit', is_active: true, is_summary: false, fund_id: FUND[f], account_subtype: null, account_funds: { fund_code: f, fund_name: f === 'OPR' ? 'Operating' : 'Reserve', fund_type: f === 'OPR' ? 'operating' : 'reserve' } })),
    account_funds: [{ id: FUND.OPR, community_id: CID, fund_code: 'OPR', fund_name: 'Operating', is_active: true, display_order: 1 }, { id: FUND.RES, community_id: CID, fund_code: 'RES', fund_name: 'Reserve', is_active: true, display_order: 2 }],
    journal_entries: [], journal_entry_lines: [],
    accounting_periods: [], period_closes: [], community_budgets: [], budget_line_items: [],
    report_categories: [], account_report_map: [], bank_accounts: [], bank_statement_imports: [],
    ap_invoices: [], ap_payments: [], ap_payment_applications: [], check_register: [], ar_charges: [], ar_payments: [],
    library_documents: [], vendors: [{ id: 'v-greenline', name: 'Greenline Irrigation' }],
  };
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0'); const end = new Date(Date.UTC(2026, m, 0)).toISOString().slice(0, 10);
    db.accounting_periods.push({ id: `p-2026-${mm}`, community_id: CID, fiscal_year: 2026, period_number: m, period_type: 'monthly', period_start: `2026-${mm}-01`, period_end: end, status: m <= 8 ? 'closed' : 'open', closed_at: m === 8 ? '2026-09-12T21:18:00Z' : null });
  }
  db.period_closes.push({ id: 'pc-aug', community_id: CID, period_id: 'p-2026-08', status: 'closed', close_label: 'closed', closed_at: '2026-09-12T21:18:00Z', closed_by: 'Association Manager' });

  // Conversion opening entry, 7/31/2026: balances + Jan-Jul revenue/expense carried as one amount.
  je('CONV-DCE-20260731-OPEN-OPR', '2026-07-31', 'opening_entry', [
    [1000, $(171800.40), 0], [1300, $(41850.00), 0], [1400, $(15750.00), 0], [1405, $(1000), 0], [1415, $(1500), 0],
    [2000, 0, $(17400.10)], [2205, 0, $(144000.00)], [2400, 0, $(13500.00)], [2410, 0, $(1250.00)], [3050, 0, $(34265.30)],
    [5200, $(92900), 0], [5210, $(3900), 0], [5300, $(68440), 0], [5400, $(44640), 0], [5500, $(48230), 0], [5600, $(11025), 0], [5900, $(87500), 0],
    [4000, 0, $(364700)], [4100, 0, $(7190)], [4200, 0, $(6230)],
  ]);
  je('CONV-DCE-20260731-OPEN-RES', '2026-07-31', 'opening_entry', [[1200, $(408600.00), 0], [3020, 0, $(321100.00)], [4900, 0, $(87500)]]);
  // August (closed)
  je('AUG-ASSESS', '2026-08-01', 'assessment_billing', [[1300, $(52100), 0], [4000, 0, $(52100)]]);
  je('AUG-RCPT', '2026-08-20', 'payment_intake', [[1000, $(53000), 0], [1300, 0, $(53000)]]);
  je('AUG-LATE', '2026-08-25', 'system', [[1300, $(1340), 0], [4100, 0, $(1340)]]);
  je('AUG-AMEN', '2026-08-18', 'payment_intake', [[1000, $(610), 0], [4200, 0, $(610)]]);
  for (const [acct, amt, ref] of [[5200, 12900, 'AUG-LAND'], [5210, 0, null], [5300, 9840, 'AUG-UTIL'], [5400, 7150, 'AUG-POOL'], [5500, 6890, 'AUG-MGMT'], [5600, 1575, 'AUG-INS']]) if (amt) je(ref, '2026-08-15', 'ap_invoice', [[acct, $(amt), 0], [1000, 0, $(amt)]]);
  je('AUG-RESXFER', '2026-08-28', 'manual', [[5900, $(12500), 0], [1000, 0, $(12500)]]);
  je('AUG-RESXFER-R', '2026-08-28', 'manual', [[1200, $(12500), 0], [4900, 0, $(12500)]]);
  // September (open)
  je('SEP-ASSESS', '2026-09-01', 'assessment_billing', [[1300, $(52100), 0], [4000, 0, $(52100)]]);
  je('SEP-RCPT', '2026-09-22', 'payment_intake', [[1000, $(56475), 0], [1300, 0, $(56475)]]);
  je('SEP-LATE', '2026-09-25', 'system', [[1300, $(1340), 0], [4100, 0, $(1340)]]);
  je('SEP-AMEN', '2026-09-18', 'payment_intake', [[1000, $(610), 0], [4200, 0, $(610)]]);
  je('SEP-LAND', '2026-09-15', 'ap_invoice', [[5200, $(12900), 0], [2000, 0, $(12900)]]);
  const inv1 = je('JE-2026-00412', '2026-09-04', 'ap_invoice', [[5210, $(820), 0, 'Valve replacement, sections 3-4'], [2000, 0, $(820)]], { description: 'Greenline Irrigation INV-4471' });
  je('JE-2026-00455', '2026-09-22', 'ap_invoice', [[5210, $(480), 0, 'Controller repair, front entry'], [2000, 0, $(480)]], { description: 'Greenline Irrigation INV-4519' });
  je('SEP-UTIL', '2026-09-16', 'ap_invoice', [[5300, $(9840), 0], [2000, 0, $(9840)]]);
  je('SEP-POOL', '2026-09-16', 'ap_invoice', [[5400, $(7150), 0], [2000, 0, $(7150)]]);
  je('SEP-MGMT', '2026-09-01', 'ap_invoice', [[5500, $(6890), 0], [2000, 0, $(6890)]]);
  je('SEP-INS', '2026-09-30', 'recognition', [[5600, $(1575), 0], [1400, 0, $(1575)]]);
  je('SEP-RESXFER', '2026-09-28', 'manual', [[5900, $(12500), 0], [1000, 0, $(12500)]]);
  je('SEP-RESXFER-R', '2026-09-28', 'manual', [[1200, $(12500), 0], [4900, 0, $(12500)]]);
  je('SEP-AP-PAY', '2026-09-26', 'payment_intake', [[2000, $(17470.10), 0], [1000, 0, $(17470.10)]]);
  db.ap_invoices.push({ id: 'inv-4471', community_id: CID, vendor_id: 'v-greenline', vendor_invoice_number: 'INV-4471', invoice_date: '2026-09-02', due_date: '2026-10-02', total_cents: $(820), amount_paid_cents: 0, status: 'approved', posting_journal_entry_id: inv1, source_storage_path: 'invoices/drama-creek/INV-4471.pdf' });

  // Budget FY2026 (monthly)
  db.community_budgets.push({ id: 'b-2026', community_id: CID, fiscal_year: 2026, status: 'approved' });
  for (const [acct, monthly] of [[4000, 52000], [4100, 1000], [4200, 900], [4900, 12500], [5200, 12900], [5210, 600], [5300, 10200], [5400, 7000], [5500, 6900], [5600, 1575], [5900, 12500]]) {
    db.budget_line_items.push({ budget_id: 'b-2026', account_id: aid(acct), fund_id: null, annual_amount_cents: $(monthly * 12), monthly_amounts_cents: Array(12).fill($(monthly)) });
  }

  // Income-statement categories (approved, as today)
  const cat = (id, statement, section, name, order) => db.report_categories.push({ id, community_id: CID, statement, section, name, report_label: null, parent_category_id: null, display_order: order, is_active: true });
  cat('ic-assess', 'income_statement', 'revenue', 'Assessments', 1); cat('ic-late', 'income_statement', 'revenue', 'Late fees & interest', 2); cat('ic-other', 'income_statement', 'revenue', 'Amenity & other income', 3); cat('ic-resinc', 'income_statement', 'revenue', 'Reserve contributions', 4);
  cat('ic-land', 'income_statement', 'expense', 'Landscaping', 1); cat('ic-util', 'income_statement', 'expense', 'Utilities', 2); cat('ic-pool', 'income_statement', 'expense', 'Pool & amenities', 3); cat('ic-mgmt', 'income_statement', 'expense', 'Management & administration', 4); cat('ic-ins', 'income_statement', 'expense', 'Insurance', 5); cat('ic-resx', 'income_statement', 'expense', 'Reserve contribution', 6);
  const map = (acct, statement, category, status = 'approved') => db.account_report_map.push({ community_id: CID, account_id: aid(acct), statement, category_id: category, display_order: null, approval_status: status, approved_by: status === 'approved' ? 'Ed Gojara' : null, approved_at: status === 'approved' ? '2026-10-09T15:00:00Z' : null });
  for (const [a, c] of [[4000, 'ic-assess'], [4100, 'ic-late'], [4200, 'ic-other'], [4900, 'ic-resinc'], [5200, 'ic-land'], [5210, 'ic-land'], [5300, 'ic-util'], [5400, 'ic-pool'], [5500, 'ic-mgmt'], [5600, 'ic-ins'], [5900, 'ic-resx']]) map(a, 'income_statement', c);
  // Balance-sheet categories: approved except 1405 PROPOSED and 1415 UNMAPPED.
  cat('bc-cash', 'balance_sheet', 'asset', 'Cash & cash equivalents', 1); cat('bc-res', 'balance_sheet', 'asset', 'Reserve & investment accounts', 2); cat('bc-ar', 'balance_sheet', 'asset', 'Homeowner receivables', 3); cat('bc-pre', 'balance_sheet', 'asset', 'Prepaids', 4); cat('bc-oth', 'balance_sheet', 'asset', 'Other assets', 5);
  cat('bc-ap', 'balance_sheet', 'liability', 'Accounts payable', 1); cat('bc-def', 'balance_sheet', 'liability', 'Deferred assessments', 2); cat('bc-oc', 'balance_sheet', 'liability', 'Owner credits & prepaid assessments', 3); cat('bc-ref', 'balance_sheet', 'liability', 'Refunds payable', 4); cat('bc-ol', 'balance_sheet', 'liability', 'Other liabilities', 5);
  cat('bc-fb', 'balance_sheet', 'equity', 'Fund balance', 1);
  for (const [a, c] of [[1000, 'bc-cash'], [1200, 'bc-res'], [1300, 'bc-ar'], [1400, 'bc-pre'], [2000, 'bc-ap'], [2205, 'bc-def'], [2400, 'bc-oc'], [2410, 'bc-ref'], [3050, 'bc-fb'], [3020, 'bc-fb']]) map(a, 'balance_sheet', c);
  map(1405, 'balance_sheet', 'bc-oth', 'proposed');
  db.bank_accounts.push({ id: 'ba-opr', community_id: CID, account_nickname: 'Operating Checking', account_last4: '5313', gl_account_number: '1000' });
  db.bank_statement_imports.push({ id: 'bsi-sep', bank_account_id: 'ba-opr', community_id: CID, statement_period_start: '2026-09-01', statement_period_end: '2026-09-30', ending_balance_cents: $(160000), source_filename: 'Operating-2026-09.pdf', status: 'completed' });
  return db;
}

module.exports = { CID, seed, fakeClient, getDb: () => db, aid };
